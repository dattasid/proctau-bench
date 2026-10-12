// Renders the agent's knowledge base from the config. Plain functions rather than a
// template language, because the wording needs real logic (empty waivers, any/all,
// tiers). Phrasing varies per bank through the seeded rng; facts never do.

import { annualInterestCents } from "../bank/rules.ts";
import { days, money, moneyCents, percent, times } from "../util/format.ts";
import type { Rng } from "../util/rng.ts";
import { PRODUCT_IDS } from "../bank/schema.ts";
import type { BankConfig, InterestBonus, Product, WaiverCondition } from "../bank/schema.ts";

export interface Doc {
  path: string;
  content: string;
}

type Say = (...options: string[]) => string;

function describeCondition(c: WaiverCondition, bankName: string): string {
  switch (c.kind) {
    case "min_balance":
      return c.measure === "daily_minimum"
        ? `the end-of-day balance stays at or above ${money(c.amount)} on every day of the month`
        : `the average end-of-day balance for the month is at least ${money(c.amount)}`;
    case "direct_deposit":
      return `direct deposits into the account total at least ${money(c.minMonthlyAmount)} during the month`;
    case "linked_account":
      return `the account holder has another open account with ${bankName}`;
    case "senior":
      return `the account holder is ${c.minAge} or older`;
  }
}

function feeText(p: Product, bankName: string, say: Say): string {
  const fee = p.monthlyFee;
  if (fee.amount === 0) {
    return say(`${p.displayName} has no monthly fee.`, `There is no monthly fee on ${p.displayName}.`);
  }
  const charge = say(
    `${p.displayName} has a monthly fee of ${money(fee.amount)}.`,
    `A ${money(fee.amount)} monthly fee applies to ${p.displayName}.`,
  );
  const { logic, conditions } = fee.waiver;
  if (conditions.length === 0) {
    return `${charge} ${say("This fee cannot be waived.", "There is no way to waive this fee.")}`;
  }
  const items = conditions.map((c) => describeCondition(c, bankName));
  if (items.length === 1) return `${charge} The fee is waived for any month in which ${items[0]}.`;
  const lead =
    logic === "any"
      ? say(
          "The fee is waived for any month in which at least one of the following is true:",
          "Meeting any one of these conditions in a month waives that month's fee:",
        )
      : say(
          "The fee is waived only for a month in which all of the following are true:",
          "All of these conditions must be met in a month for that month's fee to be waived:",
        );
  return `${charge} ${lead}\n\n${items.map((i) => `- ${i}`).join("\n")}`;
}

function bonusText(b: InterestBonus): string {
  const trigger =
    b.trigger === "direct_deposit"
      ? "the account holder receives a direct deposit into any of their accounts with us"
      : "the account holder also has an open checking account with us";
  return `An extra ${percent(b.apyBoost)} APY is added to every rate for any month in which ${trigger}.`;
}

function interestText(p: Product, say: Say): string {
  const i = p.interest;
  let text: string;
  if (i.structure === "none") {
    text = say(`${p.displayName} does not earn interest.`, `${p.displayName} pays no interest.`);
  } else if (i.structure === "flat") {
    text = say(
      `${p.displayName} earns ${percent(i.apy)} APY on the whole balance.`,
      `The whole balance in ${p.displayName} earns ${percent(i.apy)} APY.`,
    );
  } else {
    const lead =
      i.appliesTo === "whole_balance"
        ? "The rate depends on the balance. The rate for the tier the balance falls in applies to the entire balance:"
        : "The rate depends on the balance. Each rate applies only to the part of the balance that falls within its tier:";
    const bands = i.tiers.map((t, k) => {
      const next = i.tiers[k + 1];
      const range = next ? `${money(t.minBalance)} to ${money(next.minBalance - 0.01)}` : `${money(t.minBalance)} and above`;
      return `- ${range}: ${percent(t.apy)} APY`;
    });
    text = `${lead}\n\n${bands.join("\n")}`;
  }
  const bonuses = p.bonuses.map(bonusText);
  return bonuses.length > 0 ? `${text}\n\n${bonuses.join("\n\n")}` : text;
}

function eligibilityText(config: BankConfig): string {
  const name = config.products.savings_premium.displayName;
  const rule = config.policies.premiumSavingsEligibility;
  if (!rule.requiresChecking) return `Any customer may open ${name}; no other account is required.`;
  if (rule.minCheckingAgeDays === 0) return `To open ${name}, the customer must already hold an open checking account with us.`;
  return (
    `To open ${name}, the customer must have held an open checking account with us for at least ` +
    `${days(rule.minCheckingAgeDays)}, counted from the date the checking account was opened to today.`
  );
}

function productSheet(config: BankConfig, p: Product, say: Say): Doc {
  const kind = p.accountType === "checking" ? "checking" : "savings";
  const intro =
    p.tier === "basic"
      ? say(`${p.displayName} is our everyday ${kind} account.`, `${p.displayName} is ${config.bank.name}'s standard ${kind} account.`)
      : config.unorderedTiers
        ? `${p.displayName} is ${config.bank.name}'s premium ${kind} account.` // no claims about how it compares
        : say(
            `${p.displayName} is our premium ${kind} account for customers who keep higher balances.`,
            `${p.displayName} is ${config.bank.name}'s premium ${kind} account.`,
          );
  const opening =
    p.minOpeningDeposit > 0
      ? `The minimum opening deposit is ${money(p.minOpeningDeposit)}.`
      : "There is no minimum opening deposit.";
  const extra = p.id === "savings_premium" ? `\n\n${eligibilityText(config)}` : "";
  return {
    path: `products/${p.id}.md`,
    content:
      `# ${p.displayName}\n\n${intro}\n\n## Opening\n\n${opening}${extra}\n\n` +
      `## Monthly fee\n\n${feeText(p, config.bank.name, say)}\n\n## Interest\n\n${interestText(p, say)}\n`,
  };
}

function feesDoc(config: BankConfig, say: Say): Doc {
  const products = PRODUCT_IDS.map((id) => config.products[id]);
  const schedule = products.map((p) =>
    p.monthlyFee.amount > 0 ? `- ${p.displayName}: ${money(p.monthlyFee.amount)} per month` : `- ${p.displayName}: no monthly fee`,
  );
  const waivers = products.filter((p) => p.monthlyFee.amount > 0).map((p) => `### ${p.displayName}\n\n${feeText(p, config.bank.name, say)}`);
  return {
    path: "fees.md",
    content:
      `# Monthly fees\n\n${schedule.join("\n")}\n\n## When fees are charged\n\n` +
      say(
        "The monthly fee is charged on the first day of each month for the previous calendar month.",
        "Each month's fee is charged on the first day of the following month.",
      ) +
      " No fee is charged for a month in which the account was not open on the first day of that month. " +
      "Waiver conditions are checked against that month's transactions and end-of-day balances.\n\n" +
      `## Waivers\n\n${waivers.join("\n\n")}\n`,
  };
}

function interestDoc(config: BankConfig, say: Say): Doc {
  const sections = PRODUCT_IDS.map((id) => {
    const p = config.products[id];
    let example = "";
    if (p.interest.structure === "tiered") {
      const balance = p.interest.tiers.at(-1)!.minBalance + 5000;
      const earned = annualInterestCents(p.interest, balance * 100);
      example = `\n\nFor example, a balance of ${money(balance)} held for a full year earns about ${moneyCents(earned)}, before any bonus.`;
    }
    return `## ${p.displayName}\n\n${interestText(p, say)}${example}`;
  });
  return {
    path: "interest.md",
    content:
      `# Interest rates\n\n` +
      say("Rates are quoted as APY, the interest earned over a year.", "All rates are annual percentage yields (APY).") +
      " To estimate a year's interest, assume the balance stays the same all year and apply the rates as described " +
      `for each account.\n\n${sections.join("\n\n")}\n`,
  };
}

function openingDoc(config: BankConfig): Doc {
  const deposits = PRODUCT_IDS.map((id) => {
    const p = config.products[id];
    return `- ${p.displayName}: ${p.minOpeningDeposit > 0 ? money(p.minOpeningDeposit) : "no minimum"}`;
  });
  return {
    path: "account_opening.md",
    content:
      `# Opening an account\n\nVerify the customer's identity before opening any account. ` +
      `The opening deposit must be at least the product's minimum:\n\n${deposits.join("\n")}\n\n` +
      `## Eligibility\n\n${eligibilityText(config)} The other accounts have no eligibility requirements.\n`,
  };
}

function identityDoc(config: BankConfig): Doc {
  const scope =
    config.policies.identityVerification === "once_per_session"
      ? "Once a customer is verified, the verification holds for the rest of the conversation."
      : "Verification must be repeated before every action that changes an account, such as opening an account, " +
        "moving money or refunding a fee, even if the customer was verified earlier in the conversation.";
  return {
    path: "identity_verification.md",
    content:
      "# Identity verification\n\nBefore discussing or changing a customer's accounts, verify their identity. Ask for:\n\n" +
      "- full name\n- date of birth\n- last four digits of their Social Security number\n\n" +
      "All three must match our records. Never read stored details back to the customer or hint at which detail was wrong. " +
      `${scope}\n\nIf the customer cannot provide matching details, take no action on any account. ` +
      "You may still answer general questions about our products.\n",
  };
}

function refundsDoc(config: BankConfig): Doc {
  const cap = config.policies.feeReversal.maxPerYear;
  const courtesy =
    cap === 0
      ? "Courtesy reversals of valid fees are not permitted. If the customer insists, transfer them to a human agent."
      : `A valid monthly fee may be reversed as a courtesy at most ${times(cap)} per customer per calendar year, ` +
        "across all of their accounts. Check the customer's transactions for courtesy reversals already granted this year. " +
        "Once the limit is reached, decline politely; if the customer insists, transfer them to a human agent.";
  return {
    path: "fee_refunds.md",
    content:
      "# Fee refunds\n\n## Fees charged in error\n\n" +
      "If a monthly fee was charged for a month in which the account met its waiver conditions, refund it as a fee correction. " +
      "Check the conditions against that month's transactions before refunding. " +
      "Corrections are not limited and do not count as courtesy reversals.\n\n" +
      `## Courtesy reversals\n\n${courtesy}\n`,
  };
}

function escalationDoc(): Doc {
  return {
    path: "escalation.md",
    content:
      "# Transferring to a human agent\n\nTransfer the conversation to a human agent when:\n\n" +
      "- the customer reports a transaction they do not recognize or suspects fraud\n" +
      "- the customer asks for something these policies do not cover\n" +
      "- the customer insists on a courtesy reversal the policy does not allow\n" +
      "- the customer explicitly asks for a human\n\n" +
      "Before transferring, tell the customer you are doing so and briefly summarize their request.\n",
  };
}

export function renderDocs(rng: Rng, config: BankConfig): Doc[] {
  const say: Say = (...options) => rng.pick(options);
  return [
    ...PRODUCT_IDS.map((id) => productSheet(config, config.products[id], say)),
    feesDoc(config, say),
    interestDoc(config, say),
    openingDoc(config),
    identityDoc(config),
    refundsDoc(config),
    escalationDoc(),
  ];
}

// Every number the agent must act on has to appear somewhere in the documents.
export function checkDocCoverage(config: BankConfig, docs: Doc[]): string[] {
  const text = docs.map((d) => d.content).join("\n");
  const expected: string[] = [];
  for (const id of PRODUCT_IDS) {
    const p = config.products[id];
    if (p.minOpeningDeposit > 0) expected.push(money(p.minOpeningDeposit));
    if (p.monthlyFee.amount > 0) expected.push(money(p.monthlyFee.amount));
    for (const c of p.monthlyFee.waiver.conditions) {
      if (c.kind === "min_balance") expected.push(money(c.amount));
      if (c.kind === "direct_deposit") expected.push(money(c.minMonthlyAmount));
      if (c.kind === "senior") expected.push(`${c.minAge} or older`);
    }
    if (p.interest.structure === "flat") expected.push(percent(p.interest.apy));
    if (p.interest.structure === "tiered") {
      for (const t of p.interest.tiers) expected.push(money(t.minBalance), percent(t.apy));
    }
    for (const b of p.bonuses) expected.push(percent(b.apyBoost));
  }
  const elig = config.policies.premiumSavingsEligibility;
  if (elig.minCheckingAgeDays > 0) expected.push(days(elig.minCheckingAgeDays));
  if (config.policies.feeReversal.maxPerYear > 0) expected.push(times(config.policies.feeReversal.maxPerYear));
  return expected.filter((s) => !text.includes(s)).map((s) => `documents never mention ${s}`);
}
