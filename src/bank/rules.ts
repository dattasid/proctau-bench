// Rule evaluation shared by the database generator, its validator, the documents'
// worked examples and (next) the executor, so every layer agrees on what a rule means.

import { addDays, ageOn, daysBetween, monthEnd, monthStart } from "../util/dates.ts";
import type { BankConfig, Interest, WaiverCondition } from "./schema.ts";
import type { Account, Database, Transaction } from "./state.ts";

const byDate = (a: Transaction, b: Transaction): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function endOfDayBalances(db: Database, accountId: string, from: string, to: string): number[] {
  const txns = db.transactions.filter((t) => t.accountId === accountId && t.date <= to).sort(byDate);
  const balances: number[] = [];
  let balance = 0;
  let i = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    while (i < txns.length && txns[i]!.date <= day) balance += txns[i++]!.amountCents;
    balances.push(balance);
  }
  return balances;
}

// A month is charged only if the account was open on its first day.
export function isFullMonth(account: Account, month: string): boolean {
  return account.openedOn <= monthStart(month);
}

export interface ConditionResult {
  condition: WaiverCondition;
  met: boolean;
  observed: number; // cents for balances and deposits, years for age, 1/0 for a linked account
}

function evaluateCondition(db: Database, account: Account, month: string, c: WaiverCondition): ConditionResult {
  const start = monthStart(month);
  const end = monthEnd(month);
  switch (c.kind) {
    case "min_balance": {
      const balances = endOfDayBalances(db, account.id, start, end);
      const observed =
        c.measure === "daily_minimum" ? Math.min(...balances) : balances.reduce((s, b) => s + b, 0) / balances.length;
      return { condition: c, met: observed >= c.amount * 100, observed: Math.floor(observed) };
    }
    case "direct_deposit": {
      const observed = db.transactions
        .filter((t) => t.accountId === account.id && t.kind === "direct_deposit" && t.date >= start && t.date <= end)
        .reduce((s, t) => s + t.amountCents, 0);
      return { condition: c, met: observed >= c.minMonthlyAmount * 100, observed };
    }
    case "linked_account": {
      const linked = Object.values(db.accounts).some(
        (a) => a.id !== account.id && a.customerId === account.customerId && a.status === "open" && a.openedOn <= end,
      );
      return { condition: c, met: linked, observed: linked ? 1 : 0 };
    }
    case "senior": {
      const age = ageOn(db.customers[account.customerId]!.dateOfBirth, end);
      return { condition: c, met: age >= c.minAge, observed: age };
    }
  }
}

export function evaluateWaiver(
  config: BankConfig,
  db: Database,
  account: Account,
  month: string,
): { waived: boolean; results: ConditionResult[] } {
  const { logic, conditions } = config.products[account.productId].monthlyFee.waiver;
  const results = conditions.map((c) => evaluateCondition(db, account, month, c));
  const waived = results.length > 0 && (logic === "any" ? results.some((r) => r.met) : results.every((r) => r.met));
  return { waived, results };
}

// Fee in cents owed for `month`. It is charged on the first day of the next month.
export function monthlyFeeDue(config: BankConfig, db: Database, account: Account, month: string): number {
  const fee = config.products[account.productId].monthlyFee.amount;
  if (fee === 0 || !isFullMonth(account, month)) return 0;
  return evaluateWaiver(config, db, account, month).waived ? 0 : fee * 100;
}

// Courtesy reversals count per customer, across all their accounts, per calendar year.
export function courtesyReversalsInYear(db: Database, customerId: string, year: string): number {
  const owned = new Set(Object.values(db.accounts).filter((a) => a.customerId === customerId).map((a) => a.id));
  return db.transactions.filter((t) => t.kind === "fee_reversal" && owned.has(t.accountId) && t.date.startsWith(year))
    .length;
}

export function premiumSavingsEligible(config: BankConfig, db: Database, customerId: string, onDate: string): boolean {
  const rule = config.policies.premiumSavingsEligibility;
  if (!rule.requiresChecking) return true;
  return Object.values(db.accounts).some(
    (a) =>
      a.customerId === customerId &&
      a.status === "open" &&
      a.productId.startsWith("checking") &&
      daysBetween(a.openedOn, onDate) >= rule.minCheckingAgeDays,
  );
}

// A year's interest at a constant balance: the quote the agent is expected to give.
export function annualInterestCents(interest: Interest, balanceCents: number, apyBoost = 0): number {
  if (interest.structure === "none") return 0;
  if (interest.structure === "flat") return Math.round((balanceCents * (interest.apy + apyBoost)) / 100);
  const tiers = interest.tiers;
  if (interest.appliesTo === "whole_balance") {
    const tier = tiers.filter((t) => t.minBalance * 100 <= balanceCents).at(-1)!;
    return Math.round((balanceCents * (tier.apy + apyBoost)) / 100);
  }
  let total = 0;
  tiers.forEach((tier, i) => {
    const lo = tier.minBalance * 100;
    const hi = i + 1 < tiers.length ? tiers[i + 1]!.minBalance * 100 : Infinity;
    total += (Math.max(0, Math.min(balanceCents, hi) - lo) * (tier.apy + apyBoost)) / 100;
  });
  return Math.round(total);
}
