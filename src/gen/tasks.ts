// Task templates. A template reads the bank's policy values, builds a customer whose
// situation lands on one branch of a rule, and replays the expected calls through the
// executor to confirm the branch and record the gold end state. A template that
// misses its intended verdict throws instead of producing a silently wrong task.

import type { Bank } from "./generate.ts";
import { addDays, addMonths, daysBetween, monthOf, monthStart } from "../util/dates.ts";
import { callTool } from "../env/executor.ts";
import { addAccount, addCustomer, addTransaction, postMonthly } from "./fixtures.ts";
import { longDate, money } from "../util/format.ts";
import { hashDatabase } from "../util/hash.ts";
import { transfer } from "../bank/ledger.ts";
import { createRng } from "../util/rng.ts";
import type { Rng } from "../util/rng.ts";
import { accountTypeName, allProducts, productsOf, requiredAccountName } from "../bank/products.ts";
import { annualInterestCents, courtesyReversalsInYear, meetsRequirements, requirementMatches, transferLimited } from "../bank/rules.ts";
import type { BankConfig, Product, Requirement } from "../bank/schema.ts";
import { createSession } from "../env/session.ts";
import type { TraceRecord } from "../env/session.ts";
import type { Account, Customer, Database } from "../bank/state.ts";
import { auditDatabase, describeFinding } from "../bank/validate_db.ts";
import type { Finding } from "../bank/validate_db.ts";
import type { CustomerScript, FeeTruth, InterestTruth } from "../script/types.ts";
import { interestHistory, interestHistoryFits } from "./interest_history.ts";
import { feeHistory } from "./witness.ts";
import type { MonthPlan } from "./witness.ts";

export interface ExpectedCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface Task {
  id: string;
  template: string;
  bankSeed: number;
  db: Database; // starting database: background customers plus the fixture
  user: { instructions: string }; // private to the user simulator
  script: CustomerScript; // the same customer for the scripted simulator, with what is true
  intended: { rule: string; passed: boolean }[]; // the rule branch this task targets
  goldCalls: ExpectedCall[]; // one correct sequence; others may be equally valid
  forbiddenCalls?: ExpectedCall[]; // calls that break the targeted rule, replayed to confirm the task hits it
  planted: Finding[]; // mistakes in the starting history put there on purpose (see validate_db.ts)
  requiredCalls?: string[]; // tools that must have executed, when the database alone can't show it
  goldHash: string; // database hash after a correct conversation
}

interface TaskTemplate {
  id: string;
  applies(config: BankConfig): boolean;
  // null: this bank can't support a sensible task of this kind after all (a template's own errors
  // still throw).
  build(rng: Rng, bank: Bank): Task | null;
}

// Marks an attempt that failed because the bank can't support the task, not because of a bug.
class Infeasible extends Error {}

// Kept apart from the background names so find_customer returns a single match.
const FIXTURE_NAMES = [
  "Amara Lindgren", "Tobias Ferreira", "Yuki Halvorsen", "Desmond Achebe", "Noor Castellano",
  "Felix Varga", "Imani Sorensen", "Rafael Nakamura", "Saoirse Mbeki", "Arjun Whitfield",
];

function newCustomer(rng: Rng, db: Database, today: string): Customer {
  const taken = new Set(Object.values(db.customers).map((c) => c.name));
  const name = rng.pick(FIXTURE_NAMES.filter((n) => !taken.has(n)));
  return addCustomer(db, {
    name,
    dateOfBirth: addDays(today, -(rng.int(25, 60) * 365 + rng.int(0, 364))),
    ssnLast4: String(rng.int(0, 9999)).padStart(4, "0"),
  });
}

function identityLine(c: Customer): string {
  return (
    `If asked to verify your identity, give: full name ${c.name}, date of birth ${longDate(c.dateOfBirth)}, ` +
    `last four digits of your Social Security number ${c.ssnLast4}.`
  );
}

function replay(bank: Bank, db: Database, calls: ExpectedCall[]): { records: TraceRecord[]; db: Database } {
  const session = createSession(bank.config, db);
  const records = calls.map((c) => callTool(session, c.tool, c.args));
  return { records, db: session.db };
}

function assertIntent(template: string, record: TraceRecord, intended: Task["intended"]): void {
  for (const want of intended) {
    const check = record.checks.find((c) => c.rule === want.rule);
    if (!check || check.passed !== want.passed) {
      throw new Error(`${template}: expected ${want.rule} passed=${want.passed}, got ${check ? check.passed : "no check"}`);
    }
  }
}

// The fixture's bookkeeping is sound, and its history departs from the rules exactly where the
// template planted a mistake: an unplanned finding is a generator bug, and a planted mistake the
// audit does not find is no mistake at all.
function assertValid(template: string, bank: Bank, db: Database, planted: Finding[] = []): void {
  const { errors, findings } = auditDatabase(bank.config, db);
  if (errors.length > 0) throw new Error(`${template}: fixture breaks the database\n  ${errors.join("\n  ")}`);
  const found = findings.map(describeFinding).sort();
  const meant = planted.map(describeFinding).sort();
  if (found.join("\n") !== meant.join("\n")) {
    throw new Error(`${template}: findings differ from the planted mistakes\n  found: ${found.join("; ") || "none"}\n  planted: ${meant.join("; ") || "none"}`);
  }
}

// Products an account-opening task can target: every product with requirements, or the top tier
// of the last account type when the bank has none.
function openingTargets(config: BankConfig): Product[] {
  const restricted = allProducts(config).filter((p) => p.requirements.length > 0);
  return restricted.length > 0 ? restricted : [productsOf(config, config.accountTypes.at(-1)!).at(-1)!];
}

function shuffled<T>(rng: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// A product whose account satisfies `r`, preferring one that would not also satisfy `avoid` and
// one the customer does not hold yet.
function satisfierOf(rng: Rng, config: BankConfig, r: Requirement, avoid: Requirement | null, held: Set<string>): Product {
  const all = r.kind === "holds_product" ? [config.products[r.productId]!] : productsOf(config, r.accountType);
  const safe = all.filter((p) => !avoid || r === avoid || !requirementMatches(config, p.id, avoid));
  const fresh = safe.filter((p) => !held.has(p.id));
  return rng.pick(fresh.length > 0 ? fresh : safe.length > 0 ? safe : all);
}

// Gives the customer an account for each of `product`'s requirements, early enough before `on` to
// count, except `tooNew`, which is opened too recently; no other account, at any depth, should
// satisfy it. An account the customer already holds is reused when it qualifies; a new one gets its
// own prerequisites first, all the way down (requirements only point to earlier products, so this
// ends). Specific products and longer holds go first, so later requirements can reuse them. The
// first account opened here also gets `extraCents` and is returned as `funded`.
function holdPrerequisites(
  rng: Rng,
  config: BankConfig,
  db: Database,
  customer: Customer,
  product: Product,
  on: string,
  tooNew: Requirement | null,
  avoid: Requirement | null,
  avoidOn: string, // the date `avoid` is judged on: the day the customer asks to open the target
  extraCents: number,
): Account | null {
  const specificFirst = (r: Requirement) => (r.kind === "holds_product" ? 0 : 1);
  const order = [...product.requirements].sort((a, b) => specificFirst(a) - specificFirst(b) || b.minAgeDays - a.minAgeDays);
  let funded: Account | null = null;
  for (const r of order) {
    const mine = Object.values(db.accounts).filter((a) => a.customerId === customer.id);
    const reusable = mine.find(
      (a) =>
        r !== tooNew &&
        requirementMatches(config, a.productId, r) &&
        daysBetween(a.openedOn, on) >= r.minAgeDays &&
        // An account that matches `avoid` is fine as long as it is too new to satisfy it.
        !(avoid && requirementMatches(config, a.productId, avoid) && daysBetween(a.openedOn, avoidOn) >= avoid.minAgeDays),
    );
    if (reusable) continue;
    const held = satisfierOf(rng, config, r, avoid, new Set(mine.map((a) => a.productId)));
    const openedOn = addDays(on, -(r === tooNew ? rng.int(1, r.minAgeDays - 1) : r.minAgeDays + rng.int(5, 90)));
    holdPrerequisites(rng, config, db, customer, held, openedOn, null, avoid, avoidOn, 0);
    const cents = (held.minOpeningDeposit + rng.money(2000, 6000, 100)) * 100 + (funded ? 0 : extraCents);
    const account = addAccount(db, customer, held.id, openedOn, cents);
    funded ??= account;
  }
  return funded;
}

// A customer who wants `target`, funded from the account for its first requirement (or from an
// account of the first type's lowest tier when it has none), with every prerequisite in place
// except `tooNew`.
function openingFixture(rng: Rng, bank: Bank, target: Product, tooNew: Requirement | null) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  // Always positive: a $0 deposit is not a valid call, and a minimum can be $0 on unordered banks.
  const deposit = target.minOpeningDeposit + rng.money(500, 3500, 500);
  const fundCents = (deposit + rng.money(500, 5000, 100)) * 100;
  const funding =
    target.requirements.length > 0
      ? holdPrerequisites(rng, config, db, customer, target, today, tooNew, tooNew, today, fundCents)!
      : addAccount(db, customer, productsOf(config, config.accountTypes[0]!)[0]!.id, addDays(today, -rng.int(30, 400)), fundCents);
  const held = Object.values(db.accounts).filter((a) => a.customerId === customer.id);
  // Two accounts of one product would make "your Gold Checking account" ambiguous.
  if (new Set(held.map((a) => a.productId)).size < held.length) throw new Error("fixture holds two accounts of one product");
  for (const a of held) postMonthly(config, db, a, today);
  const fundingProduct = config.products[funding.productId]!;
  const verify = { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } };
  const open = {
    tool: "open_account",
    args: { customerId: customer.id, productId: target.id, initialDeposit: deposit, fundingAccountId: funding.id },
  };
  const want =
    `You are ${customer.name}. You want to open a ${target.displayName} account ` +
    `and fund it with ${money(deposit)} from your ${fundingProduct.displayName} account. ` +
    `${identityLine(customer)} You do not know any account numbers.`;
  const base = {
    name: customer.name,
    knows: {
      full_name: customer.name,
      date_of_birth: customer.dateOfBirth,
      ssn_last4: customer.ssnLast4,
      product: target.displayName,
      amount: deposit,
      funding_account: fundingProduct.displayName,
    },
    goal: { action: "open_account", product: target.displayName, amount: deposit, funding_account: fundingProduct.displayName } as const,
    requirements: target.requirements.map((r) => ({ required_account: requiredAccountName(config, r), min_age_days: r.minAgeDays })),
    min_deposit: target.minOpeningDeposit,
  };
  return { db, customer, funding, deposit, verify, open, want, base, find: { tool: "find_customer", args: { name: customer.name } } };
}

// The first day the customer holds an account that satisfies `r`.
function satisfiedFrom(config: BankConfig, db: Database, customerId: string, r: Requirement): string {
  const opened = Object.values(db.accounts)
    .filter((a) => a.customerId === customerId && a.status === "open" && requirementMatches(config, a.productId, r))
    .map((a) => a.openedOn)
    .sort();
  return addDays(opened[0]!, r.minAgeDays);
}

// The task, or null when every attempt found the bank can't support it.
function orNothing(build: () => Task): Task | null {
  try {
    return build();
  } catch (e) {
    if (e instanceof Infeasible) return null;
    throw e;
  }
}

// Tries `attempts` in order and returns the first task that builds; throws the last error if none does.
function firstThatBuilds<T>(attempts: T[], build: (a: T) => Task): Task {
  let last: unknown = new Error("nothing to try");
  for (const a of attempts) {
    try {
      return build(a);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// The customer asks to open a product and meets every requirement: each required account is held,
// and held long enough. The agent should verify identity and open it as asked (product, deposit,
// funding account). Tests that the agent reads the requirements correctly and does not refuse an
// eligible customer. Gold: find_customer, verify_identity, open_account.
const openAccountEligible: TaskTemplate = {
  id: "open_account_eligible",
  applies: (config) => openingTargets(config).length > 0,
  build(rng, bank) {
    // Another target, or another try at the same one, when a fixture comes out invalid: a long
    // chain whose fees run an account dry, or two requirements met by the same product.
    const targets = shuffled(rng, openingTargets(bank.config));
    return firstThatBuilds([...targets, ...targets, ...targets], (target) => {
      const f = openingFixture(rng, bank, target, null);
      assertValid(this.id, bank, f.db);
      const goldCalls = [f.find, f.verify, f.open];
      const { records, db } = replay(bank, f.db, goldCalls);
      const intended = target.requirements.length > 0 ? [{ rule: "product.eligibility", passed: true }] : [];
      if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
        throw new Error(`${this.id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
      }
      assertIntent(this.id, records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} Confirm the details when the agent asks. Once the account is open, thank the agent and end the conversation. ` +
            "If the agent says it cannot open the account, ask why once, then end the conversation. Do not ask about anything else.",
        },
        script: {
          name: f.base.name,
          knows: f.base.knows,
          goal: f.base.goal,
          reactions: {}, // the shared table: ask why once if refused, then end
          expectedEnding: "account_opened",
          truth: { kind: "opening", requirements: f.base.requirements, eligible: true, min_deposit: f.base.min_deposit },
        },
        intended,
        goldCalls,
        planted: [],
        goldHash: hashDatabase(db),
      };
    });
  },
};

// Requirements that can be failed by holding the account for too short a time.
const tooNewTargets = (config: BankConfig) =>
  openingTargets(config).flatMap((product) => product.requirements.filter((r) => r.minAgeDays >= 2).map((requirement) => ({ product, requirement })));

// The customer asks to open a product and holds every required account, but one of them was opened
// too recently to count. The agent should verify identity, decline, and when asked, say from which
// date the customer becomes eligible. Opening the account anyway is the mistake this tests.
// Gold: find_customer, verify_identity, and nothing opened; forbidden: that open_account call.
const openAccountTooNew: TaskTemplate = {
  id: "open_account_held_too_briefly",
  applies: (config) => tooNewTargets(config).length > 0,
  build(rng, bank) {
    // Another target, or another try at the same one, when the fixture still meets the requirement:
    // an older prerequisite of another requirement can count for it too.
    const targets = shuffled(rng, tooNewTargets(bank.config));
    return firstThatBuilds([...targets, ...targets, ...targets], ({ product, requirement }) => {
      const f = openingFixture(rng, bank, product, requirement);
      assertValid(this.id, bank, f.db);
      const goldCalls = [f.find, f.verify];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed")) throw new Error(`${this.id}: gold calls failed`);
      // Probe the call the agent must not make, to confirm the fixture hits the rule.
      const intended = [{ rule: "product.eligibility", passed: false }];
      assertIntent(this.id, replay(bank, f.db, [...goldCalls, f.open]).records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} If the agent says you are not eligible yet, ask when you will become eligible; once you have an answer, ` +
            "end the conversation. If the agent offers a different account instead, decline. Do not ask about anything else.",
        },
        script: {
          name: f.base.name,
          knows: f.base.knows,
          goal: f.base.goal,
          reactions: { refused: ["ask_when_eligible", "thank_and_end"], date_given: ["thank_and_end"], alternative: ["decline"] },
          expectedEnding: "refused_with_date",
          truth: {
            kind: "opening",
            requirements: f.base.requirements,
            eligible: false,
            unmet: { required_account: requiredAccountName(bank.config, requirement), min_age_days: requirement.minAgeDays },
            eligible_date: satisfiedFrom(bank.config, f.db, f.customer.id, requirement),
            min_deposit: f.base.min_deposit,
          },
        },
        intended,
        goldCalls,
        forbiddenCalls: [f.open],
        planted: [],
        goldHash: hashDatabase(db),
      };
    });
  },
};

// ---- Fee refunds

// The month a fee task is about: last month, or the one before when today is too early in the
// month to leave room after the fee was charged.
function feeMonth(today: string): string {
  return addMonths(monthOf(today), Number(today.slice(8)) >= 6 ? -1 : -2);
}

// Products a fee task can use: a monthly fee, and no opening requirements (the witness opens the
// account directly). `waivable`: the fee has waiver conditions that can be met.
const feeProducts = (config: BankConfig, waivable: boolean) =>
  allProducts(config).filter(
    (p) => p.requirements.length === 0 && p.monthlyFee.amount > 0 && (!waivable || p.monthlyFee.waiver.conditions.length > 0),
  );

type FeeCase = "error" | "courtesy" | "cap";

// A customer charged a monthly fee last month who wants it refunded. error: the waiver was met, so
// the fee is a planted mistake; courtesy and cap: the fee was valid, and the customer has courtesy
// reversals left (courtesy) or has used them all this year (cap). Money may move after the fee so
// that today's balance suggests the wrong answer.
function feeFixture(rng: Rng, bank: Bank, product: Product, kind: FeeCase) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  const month = feeMonth(today);
  const cap = config.policies.feeReversal.maxPerYear;
  let plans: MonthPlan[];
  let after: "none" | "add" | "remove";
  if (kind === "error") {
    plans = [{ month, met: true, chargeAnyway: true }];
    after = rng.bool() ? "remove" : "none";
  } else {
    const used = kind === "cap" ? cap : 0;
    const earlier = Array.from({ length: used }, (_, i) => ({ month: addMonths(month, i - used), met: false, courtesy: true }));
    plans = [...earlier, { month, met: false }];
    after = rng.bool() ? "add" : "none";
  }
  const h = feeHistory(rng, config, db, customer, product, plans, after);
  const fee = h.fees[month]!;
  const used = courtesyReversalsInYear(db, customer.id, today.slice(0, 4));
  if ((kind === "cap" && used < cap) || (kind === "courtesy" && used >= cap)) throw new Error(`fee fixture: ${used} of ${cap} courtesy reversals used`);
  const amount = -fee.amountCents / 100;
  const goal = { action: "refund_fee", account: product.displayName, amount, date: fee.date } as const;
  const truth = (refund: FeeTruth["refund"]): FeeTruth => ({
    kind: "fee",
    month,
    waiver_met: kind === "error",
    conditions_met: h.why[month] ?? [],
    refund,
    courtesy_used: used,
    courtesy_cap: cap,
    balance_moved_after: after,
  });
  const want =
    `You are ${customer.name}. You were charged a ${money(amount)} monthly fee on ${longDate(fee.date)} on your ` +
    `${product.displayName} account, and you don't think you should have been. You want it refunded. ` +
    `${identityLine(customer)} You do not know any account numbers or transaction ids.`;
  return {
    db,
    customer,
    fee,
    planted: h.planted,
    goal,
    truth,
    want,
    knows: {
      full_name: customer.name,
      date_of_birth: customer.dateOfBirth,
      ssn_last4: customer.ssnLast4,
      account: product.displayName,
      amount,
      date: fee.date,
    },
    find: { tool: "find_customer", args: { name: customer.name } },
    verify: { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } },
    refund: (reason: "correction" | "courtesy") => ({ tool: "refund_fee", args: { transactionId: fee.id, reason } }),
  };
}

// The customer asks for a refund of last month's fee, which was charged although the account met
// its waiver conditions. The agent should check that month's transactions and refund it as a
// correction (never limited). Half the time money left the account after the fee, so today's low
// balance suggests the fee was fine. Gold: find_customer, verify_identity, refund_fee(correction).
const feeChargedInError: TaskTemplate = {
  id: "fee_charged_in_error",
  applies: (config) => feeProducts(config, true).length > 0,
  build(rng, bank) {
    const products = shuffled(rng, feeProducts(bank.config, true));
    return firstThatBuilds([...products, ...products], (product) => {
      const f = feeFixture(rng, bank, product, "error");
      assertValid(this.id, bank, f.db, f.planted);
      const goldCalls = [f.find, f.verify, f.refund("correction")];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
        throw new Error(`${this.id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
      }
      const intended = [{ rule: "refund.correction_valid", passed: true }];
      assertIntent(this.id, records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} If the agent refunds it, thank them and end the conversation. If the agent says the fee was correct, ` +
            "ask once whether they can refund it anyway, then end the conversation. Do not ask about anything else.",
        },
        script: {
          name: f.customer.name,
          knows: f.knows,
          goal: f.goal,
          reactions: { refused: ["insist", "thank_and_end"] },
          expectedEnding: "fee_refunded",
          truth: f.truth("correction"),
        },
        intended,
        goldCalls,
        planted: f.planted,
        goldHash: hashDatabase(db),
      };
    });
  },
};

// The customer asks for a refund of last month's fee, which was valid: the waiver was not met. They
// have courtesy reversals left this year, so the agent should explain and, as they still want it,
// reverse it as a courtesy. Half the time money came in after the fee, so today's high balance
// suggests the fee was wrong; refunding it as a correction is the mistake this tests.
// Gold: find_customer, verify_identity, refund_fee(courtesy); forbidden: refund_fee(correction).
const feeValidCourtesy: TaskTemplate = {
  id: "fee_valid_courtesy",
  applies: (config) => config.policies.feeReversal.maxPerYear > 0 && feeProducts(config, false).length > 0,
  build(rng, bank) {
    const products = shuffled(rng, feeProducts(bank.config, false));
    return firstThatBuilds([...products, ...products], (product) => {
      const f = feeFixture(rng, bank, product, "courtesy");
      assertValid(this.id, bank, f.db, f.planted);
      const goldCalls = [f.find, f.verify, f.refund("courtesy")];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
        throw new Error(`${this.id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
      }
      const intended = [{ rule: "refund.courtesy_cap", passed: true }];
      assertIntent(this.id, records[2]!, intended);
      const wrong = f.refund("correction");
      assertIntent(this.id, replay(bank, f.db, [f.find, f.verify, wrong]).records[2]!, [{ rule: "refund.correction_valid", passed: false }]);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} If the agent refunds it, thank them and end the conversation. If the agent says the fee was correct, ` +
            "ask once whether they can refund it anyway, then end the conversation. Do not ask about anything else.",
        },
        script: {
          name: f.customer.name,
          knows: f.knows,
          goal: f.goal,
          reactions: { refused: ["insist", "thank_and_end"] },
          expectedEnding: "fee_refunded",
          truth: f.truth("courtesy"),
        },
        intended,
        goldCalls,
        forbiddenCalls: [wrong],
        planted: f.planted,
        goldHash: hashDatabase(db),
      };
    });
  },
};

// The customer asks for a refund of last month's valid fee, but has already used all their courtesy
// reversals this year (or the bank allows none). The agent should decline and, when the customer
// insists, transfer them to a human agent. Refunding it anyway is the mistake this tests.
// Gold: find_customer, verify_identity, transfer_to_human, nothing refunded.
const feeValidCapReached: TaskTemplate = {
  id: "fee_valid_cap_reached",
  applies: (config) => {
    const today = config.bank.simulatedDate;
    const cap = config.policies.feeReversal.maxPerYear;
    // Every earlier courtesy reversal must fall in this calendar year to count.
    const firstFee = monthStart(addMonths(feeMonth(today), 1 - cap));
    return firstFee.slice(0, 4) === today.slice(0, 4) && feeProducts(config, false).length > 0;
  },
  build(rng, bank) {
    const products = shuffled(rng, feeProducts(bank.config, false));
    return firstThatBuilds([...products, ...products], (product) => {
      const f = feeFixture(rng, bank, product, "cap");
      assertValid(this.id, bank, f.db, f.planted);
      const transfer = { tool: "transfer_to_human", args: { summary: "Customer wants a valid monthly fee refunded; courtesy reversal limit reached." } };
      const goldCalls = [f.find, f.verify, transfer];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed")) throw new Error(`${this.id}: gold calls failed`);
      const wrong = f.refund("courtesy");
      const intended = [{ rule: "refund.courtesy_cap", passed: false }];
      assertIntent(this.id, replay(bank, f.db, [f.find, f.verify, wrong]).records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} If the agent declines, insist once that you want it refunded. If the agent transfers you to a human ` +
            "agent, accept. Do not ask about anything else.",
        },
        script: {
          name: f.customer.name,
          knows: f.knows,
          goal: f.goal,
          reactions: { refused: ["insist", "insist", "thank_and_end"] },
          expectedEnding: "transferred",
          truth: f.truth("none"),
        },
        intended,
        goldCalls,
        forbiddenCalls: [wrong],
        planted: f.planted,
        requiredCalls: ["transfer_to_human"],
        goldHash: hashDatabase(db),
      };
    });
  },
};

// ---- Handing over to a human

const MERCHANTS = [
  "Brightline Electronics", "Coastal Fuel Stop", "Northwind Travel", "Lumen Home Goods", "Harper's Market",
  "Vantage Sports", "Bluefin Sushi Bar", "Metro Parking", "Oakridge Pharmacy", "Pinewood Books",
];

// What the policies don't cover, in the customer's words.
const OUT_OF_SCOPE_REQUESTS = [
  "raise the daily ATM withdrawal limit on my account",
  "order a book of paper checks for my account",
  "send a wire transfer from my account to an account at another bank",
  "add my spouse as a joint owner on my account",
  "rent a safe deposit box",
  "set up a stop payment on a check I wrote",
];

// A customer with one plain account and a few months of card spending.
function handoverFixture(rng: Rng, bank: Bank) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  const product = rng.pick(productsOf(config, config.accountTypes[0]!).filter((p) => p.requirements.length === 0));
  const account = addAccount(db, customer, product.id, addDays(today, -rng.int(60, 400)), rng.money(3000, 9000, 100) * 100);
  return { db, customer, product, account, today };
}

const handoverTask = (
  id: string,
  bank: Bank,
  f: ReturnType<typeof handoverFixture>,
  want: string,
  goal: CustomerScript["goal"],
  reason: "unrecognized_transaction" | "out_of_scope",
  knows: CustomerScript["knows"],
): Task => {
  const find = { tool: "find_customer", args: { name: f.customer.name } };
  const verify = { tool: "verify_identity", args: { customerId: f.customer.id, dateOfBirth: f.customer.dateOfBirth, ssnLast4: f.customer.ssnLast4 } };
  const transfer = { tool: "transfer_to_human", args: { summary: want } };
  const goldCalls = [find, verify, transfer];
  const { records, db } = replay(bank, f.db, goldCalls);
  if (records.some((r) => r.outcome !== "executed")) throw new Error(`${id}: gold calls failed`);
  return {
    id: `${id}:${bank.seed}`,
    template: id,
    bankSeed: bank.seed,
    db: f.db,
    user: {
      instructions:
        `You are ${f.customer.name}. ${want} ${identityLine(f.customer)} You do not know any account numbers. If the agent ` +
        "says it can't help, ask to speak to someone who can. If the agent transfers you to a human agent, accept. Do not ask about anything else.",
    },
    script: {
      name: f.customer.name,
      knows: { full_name: f.customer.name, date_of_birth: f.customer.dateOfBirth, ssn_last4: f.customer.ssnLast4, ...knows },
      goal,
      reactions: { refused: ["ask_for_human", "thank_and_end"], alternative: ["ask_for_human", "thank_and_end"] },
      expectedEnding: "transferred",
      truth: { kind: "handover", reason },
    },
    intended: [],
    goldCalls,
    planted: [],
    requiredCalls: ["transfer_to_human"],
    goldHash: hashDatabase(db),
  };
};

// The customer reports a recent card purchase they did not make. The policy says to transfer to a
// human for unrecognized transactions; the agent has no tool to reverse a purchase and should not
// try to settle it itself. Gold: find_customer, verify_identity, transfer_to_human; nothing changes.
const reportUnrecognizedTransaction: TaskTemplate = {
  id: "report_unrecognized_transaction",
  applies: (config) => productsOf(config, config.accountTypes[0]!).some((p) => p.requirements.length === 0),
  build(rng, bank) {
    const f = handoverFixture(rng, bank);
    const merchants = shuffled(rng, MERCHANTS);
    // A few ordinary purchases and the one the customer doesn't recognize, all before fees are
    // charged, so every fee still follows the rules.
    const day = (back: number) => addDays(f.today, -back);
    for (let i = 0; i < 3; i++) {
      addTransaction(f.db, f.account, day(rng.int(12, 50)), "card_purchase", -rng.money(15, 120, 1) * 100, `Card purchase: ${merchants[i]}`);
    }
    const amount = rng.money(80, 900, 1);
    const date = day(rng.int(1, 9));
    const merchant = merchants[3]!;
    addTransaction(f.db, f.account, date, "card_purchase", -amount * 100, `Card purchase: ${merchant}`);
    postMonthly(bank.config, f.db, f.account, f.today);
    assertValid(this.id, bank, f.db);
    const want = `There's a ${money(amount)} card purchase from ${merchant} on ${longDate(date)} on your ${f.product.displayName} account that you didn't make.`;
    return handoverTask(
      this.id,
      bank,
      f,
      want,
      { action: "report_transaction", account: f.product.displayName, amount, date, merchant },
      "unrecognized_transaction",
      { account: f.product.displayName, amount, date },
    );
  },
};

// The customer asks for a service the bank's policies don't cover (paper checks, a wire, a safe
// deposit box...). The policy says to transfer to a human rather than refuse or improvise.
// Gold: find_customer, verify_identity, transfer_to_human; nothing changes.
const requestOutOfScope: TaskTemplate = {
  id: "request_out_of_scope",
  applies: (config) => productsOf(config, config.accountTypes[0]!).some((p) => p.requirements.length === 0),
  build(rng, bank) {
    const f = handoverFixture(rng, bank);
    postMonthly(bank.config, f.db, f.account, f.today);
    assertValid(this.id, bank, f.db);
    const request = rng.pick(OUT_OF_SCOPE_REQUESTS);
    return handoverTask(
      this.id,
      bank,
      f,
      `You want to ${request}.`,
      { action: "request_service", request },
      "out_of_scope",
      { account: f.product.displayName },
    );
  },
};


// ---- Transfers between the customer's own accounts

// Plain products of a type: no opening requirements, so the fixture can hold them directly.
const plainProducts = (config: BankConfig, limited: boolean | null) =>
  allProducts(config).filter((p) => {
    if (p.requirements.length > 0) return false;
    const isLimited = config.policies.transferLimit?.accountTypes.includes(p.accountType) ?? false;
    return limited === null || isLimited === limited;
  });

// A customer with two accounts who wants to move money from one to the other, having already
// moved money out of the source `used` times this month.
function transferFixture(rng: Rng, bank: Bank, from: Product, used: number) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  const toProduct = rng.pick(allProducts(config).filter((p) => p.requirements.length === 0 && p.id !== from.id));
  const amount = rng.money(200, 2500, 50);
  const opened = (min: number) => addDays(today, -rng.int(min, 400));
  const source = addAccount(db, customer, from.id, opened(60), (amount + rng.money(2000, 8000, 100) + used * 600) * 100);
  const dest = addAccount(db, customer, toProduct.id, opened(60), rng.money(500, 4000, 100) * 100);
  const dayOfMonth = Number(today.slice(8));
  if (used > 0 && dayOfMonth < 2) throw new Error("transfer fixture: no earlier day this month");
  for (let i = 0; i < used; i++) {
    const date = addDays(monthStart(monthOf(today)), rng.int(0, dayOfMonth - 2));
    transfer(db, source, dest, date, rng.money(50, 500, 50) * 100);
  }
  postMonthly(config, db, source, today);
  postMonthly(config, db, dest, today);
  const limit = transferLimited(config, source) ? config.policies.transferLimit!.perMonth : null;
  const goal = { action: "transfer_funds", from: from.displayName, to: toProduct.displayName, amount } as const;
  const want =
    `You are ${customer.name}. You want to move ${money(amount)} from your ${from.displayName} account to your ` +
    `${toProduct.displayName} account. ${identityLine(customer)} You do not know any account numbers.`;
  return {
    db,
    customer,
    goal,
    want,
    limit,
    used,
    knows: {
      full_name: customer.name,
      date_of_birth: customer.dateOfBirth,
      ssn_last4: customer.ssnLast4,
      funding_account: from.displayName,
      account: toProduct.displayName,
      amount,
    },
    find: { tool: "find_customer", args: { name: customer.name } },
    verify: { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } },
    move: { tool: "transfer_funds", args: { fromAccountId: source.id, toAccountId: dest.id, amount } },
  };
}

// The customer asks to move money between two of their accounts, within the bank's monthly limit
// on transfers out of savings-type accounts (or from an account with no limit). The agent should
// confirm and transfer. Gold: find_customer, verify_identity, transfer_funds.
const transferBetweenAccounts: TaskTemplate = {
  id: "transfer_between_accounts",
  applies: (config) => plainProducts(config, null).length >= 2,
  build(rng, bank) {
    const sources = shuffled(rng, plainProducts(bank.config, null));
    return firstThatBuilds([...sources, ...sources], (from) => {
      const perMonth = bank.config.policies.transferLimit?.perMonth ?? 0;
      const limited = bank.config.policies.transferLimit?.accountTypes.includes(from.accountType) ?? false;
      const dayOfMonth = Number(bank.config.bank.simulatedDate.slice(8));
      const used = limited && dayOfMonth >= 2 ? rng.int(0, perMonth - 1) : 0;
      const f = transferFixture(rng, bank, from, used);
      assertValid(this.id, bank, f.db);
      const goldCalls = [f.find, f.verify, f.move];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
        throw new Error(`${this.id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
      }
      const intended = f.limit !== null ? [{ rule: "transfer.monthly_limit", passed: true }] : [];
      assertIntent(this.id, records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} Confirm the details when the agent asks. Once the money has moved, thank the agent and end the conversation. ` +
            "If the agent says it cannot make the transfer, ask why once, then end the conversation. Do not ask about anything else.",
        },
        script: {
          name: f.customer.name,
          knows: f.knows,
          goal: f.goal,
          reactions: {},
          expectedEnding: "funds_moved",
          truth: { kind: "transfer", limit: f.limit, used: f.used, allowed: true },
        },
        intended,
        goldCalls,
        planted: [],
        goldHash: hashDatabase(db),
      };
    });
  },
};

// The customer asks to move money out of a savings-type account that has already had this month's
// limit of transfers out. The agent should count them, decline, and say when the customer can
// transfer again. Making the transfer anyway is the mistake this tests.
// Gold: find_customer, verify_identity, nothing moved; forbidden: that transfer_funds call.
const transferOverLimit: TaskTemplate = {
  id: "transfer_over_limit",
  applies: (config) => !!config.policies.transferLimit && Number(config.bank.simulatedDate.slice(8)) >= 2 && plainProducts(config, true).length > 0,
  build(rng, bank) {
    const sources = shuffled(rng, plainProducts(bank.config, true));
    return firstThatBuilds([...sources, ...sources], (from) => {
      const f = transferFixture(rng, bank, from, bank.config.policies.transferLimit!.perMonth);
      assertValid(this.id, bank, f.db);
      const goldCalls = [f.find, f.verify];
      const { records, db } = replay(bank, f.db, goldCalls);
      if (records.some((r) => r.outcome !== "executed")) throw new Error(`${this.id}: gold calls failed`);
      const intended = [{ rule: "transfer.monthly_limit", passed: false }];
      assertIntent(this.id, replay(bank, f.db, [...goldCalls, f.move]).records[2]!, intended);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db: f.db,
        user: {
          instructions:
            `${f.want} If the agent says it cannot make the transfer, ask why once, then end the conversation. ` +
            "Do not ask about anything else.",
        },
        script: {
          name: f.customer.name,
          knows: f.knows,
          goal: f.goal,
          reactions: {},
          expectedEnding: "refused",
          truth: { kind: "transfer", limit: f.limit, used: f.used, allowed: false },
        },
        intended,
        goldCalls,
        forbiddenCalls: [f.move],
        planted: [],
        goldHash: hashDatabase(db),
      };
    });
  },
};

// ---- Recommending a product

// Account types with at least two interest-bearing products, the ones worth comparing.
const interestTypes = (config: BankConfig) =>
  config.accountTypes.filter((t) => productsOf(config, t).filter((p) => p.interest.structure !== "none").length >= 2);

// The customer has an amount to put away and asks which account of one type would pay the most
// interest in a year on it (no bonuses), then wants it opened. The agent must work out each
// product's interest, including tiered and marginal rates, and leave out products the customer
// can't open: a requirement they don't meet, or a minimum deposit above the amount. The fixture
// retries until one product clearly wins. Gold: find_customer, verify_identity, open_account(best).
const openBestInterest: TaskTemplate = {
  id: "open_best_interest",
  applies: (config) => interestTypes(config).length > 0,
  build(rng, bank) {
    const { config } = bank;
    const today = config.bank.simulatedDate;
    const tries = Array.from({ length: 12 }, () => rng.pick(interestTypes(config)));
    return orNothing(() => firstThatBuilds(tries, (accountType) => {
      const db = structuredClone(bank.db);
      const customer = newCustomer(rng, db, today);
      const amount = rng.pick([1000, 2500, 5000, 10000, 20000, 40000, 75000]) + rng.money(0, 2000, 250);
      // A long-held first-type account to fund from; it also meets many requirements, not all.
      const fundingProduct = productsOf(config, config.accountTypes[0]!).find((p) => p.requirements.length === 0)!;
      const funding = addAccount(db, customer, fundingProduct.id, addDays(today, -rng.int(15, 700)), (amount + rng.money(1000, 5000, 100)) * 100);
      postMonthly(config, db, funding, today);
      const candidates = productsOf(config, accountType).map((p) => {
        const why = !meetsRequirements(config, db, customer.id, p, today)
          ? "requirement not met"
          : amount < p.minOpeningDeposit
            ? "amount below the minimum opening deposit"
            : undefined;
        return { p, interestCents: annualInterestCents(p.interest, amount * 100), eligible: !why, why };
      });
      const ranked = candidates.filter((c) => c.eligible).sort((a, b) => b.interestCents - a.interestCents);
      // Something to compare, something to open, and no near tie among what can be opened. A better
      // product the customer can't open is welcome: it is the trap.
      if (candidates.filter((c) => c.interestCents > 0).length < 2) throw new Infeasible(`${this.id}: fewer than two products to compare`);
      if (ranked.length === 0) throw new Infeasible(`${this.id}: nothing the customer can open`);
      if (ranked.length > 1 && ranked[0]!.interestCents - ranked[1]!.interestCents < 100) throw new Infeasible(`${this.id}: no clear winner`);
      const best = ranked[0]!.p;
      assertValid(this.id, bank, db);
      const find = { tool: "find_customer", args: { name: customer.name } };
      const verify = { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } };
      const open = { tool: "open_account", args: { customerId: customer.id, productId: best.id, initialDeposit: amount, fundingAccountId: funding.id } };
      const goldCalls = [find, verify, open];
      const { records, db: after } = replay(bank, db, goldCalls);
      if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
        throw new Error(`${this.id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
      }
      const typeName = accountTypeName(accountType);
      return {
        id: `${this.id}:${bank.seed}`,
        template: this.id,
        bankSeed: bank.seed,
        db,
        user: {
          instructions:
            `You are ${customer.name}. You have ${money(amount)} to put into a ${typeName} account and want the one that would ` +
            `pay you the most interest over a year on that amount, not counting any bonuses. You don't know which one that is: ask ` +
            `the agent, and open the one they recommend, funded from your ${fundingProduct.displayName} account. ` +
            `${identityLine(customer)} You do not know any account numbers. Confirm the details when the agent asks. Once ` +
            "the account is open, thank the agent and end the conversation. Do not ask about anything else.",
        },
        script: {
          name: customer.name,
          knows: {
            full_name: customer.name,
            date_of_birth: customer.dateOfBirth,
            ssn_last4: customer.ssnLast4,
            amount,
            funding_account: fundingProduct.displayName,
          },
          goal: {
            action: "open_account",
            product: best.displayName,
            amount,
            funding_account: fundingProduct.displayName,
            pickedByAgent: { accountType, criterion: "most_interest" },
          },
          reactions: { alternative: ["confirm"] }, // a recommendation is what the customer asked for
          expectedEnding: "account_opened",
          truth: {
            kind: "best_product",
            amount,
            best: best.displayName,
            candidates: candidates.map((c) => ({ product: c.p.displayName, interestCents: c.interestCents, eligible: c.eligible, ...(c.why ? { why: c.why } : {}) })),
          },
        },
        intended: best.requirements.length > 0 ? [{ rule: "product.eligibility", passed: true }] : [],
        goldCalls,
        planted: [],
        goldHash: hashDatabase(after),
      };
    }));
  },
};

// ---- Interest payments

// Products an interest task can use; with `bonus`, only those offering a bonus.
const interestProducts = (config: BankConfig, bonus: boolean) =>
  allProducts(config).filter((p) => interestHistoryFits(config, p) && (!bonus || p.bonuses.length > 0));

type InterestCase = "bonus_missed" | "bonus_not_earned" | "wrong_method";

// A customer who thinks last month's interest payment was too low. bonus_missed: the bonus was earned
// but left out; wrong_method: money left late in the month and the payment used the month-end balance
// instead of the bank's method; bonus_not_earned: the payment was right, and the bonus the customer
// may expect was not earned that month, though it looks earned from today's view.
function interestFixture(rng: Rng, bank: Bank, product: Product, kind: InterestCase) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  const month = feeMonth(today);
  const plant = kind === "bonus_missed" ? "no_bonus" : kind === "wrong_method" ? "month_end" : "none";
  const h = interestHistory(rng, config, db, customer, product, month, kind !== "bonus_not_earned", plant);
  // A dollar or more at stake, so a wrong answer is a real one.
  const short = h.dueCents - h.payment.amountCents;
  if (plant !== "none" && short < 100) throw new Infeasible(`interest fixture: payment only ${short} cents short`);
  if (kind === "bonus_not_earned" && h.withBonusCents - h.dueCents < 100) throw new Infeasible("interest fixture: bonus worth under a dollar");
  const amount = h.payment.amountCents / 100;
  const goal = { action: "correct_interest", account: product.displayName, amount, date: h.payment.date } as const;
  const truth: InterestTruth = {
    kind: "interest",
    month,
    method: config.policies.interestMethod,
    paid: amount,
    due: h.dueCents / 100,
    bonus: h.bonus ? { trigger: h.bonus.trigger, earned: h.bonusEarned, with_bonus: h.withBonusCents / 100 } : null,
    planted: plant,
  };
  const want =
    `You are ${customer.name}. You were paid ${money(amount)} in interest on ${longDate(h.payment.date)} on your ` +
    `${product.displayName} account, and it looks too low to you. You want it checked and corrected. ` +
    `${identityLine(customer)} You do not know any account numbers or transaction ids.`;
  const ticket = (expectedCents: number) => ({
    tool: "open_ticket",
    args: {
      accountId: h.account.id,
      kind: "interest_discrepancy",
      month,
      expectedInterest: expectedCents / 100,
      summary: `Interest for ${month} paid ${money(amount)}, should be ${money(expectedCents / 100)}.`,
    },
  });
  return {
    db,
    customer,
    planted: h.planted,
    goal,
    truth,
    want,
    withBonusCents: h.withBonusCents,
    dueCents: h.dueCents,
    knows: {
      full_name: customer.name,
      date_of_birth: customer.dateOfBirth,
      ssn_last4: customer.ssnLast4,
      account: product.displayName,
      amount,
      date: h.payment.date,
    },
    find: { tool: "find_customer", args: { name: customer.name } },
    verify: { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } },
    ticket,
  };
}

const interestInstructions = (want: string) =>
  `${want} If the agent says the interest will be corrected, thank them and end the conversation. If the agent says the ` +
  "interest was right, ask why once, then end the conversation. Do not ask about anything else.";

// An interest payment came out short, and the agent should open a ticket with the right amount.
function shortInterestTemplate(id: string, kind: "bonus_missed" | "wrong_method"): TaskTemplate {
  return {
    id,
    applies: (config) => interestProducts(config, kind === "bonus_missed").length > 0,
    build(rng, bank) {
      const products = shuffled(rng, interestProducts(bank.config, kind === "bonus_missed"));
      return orNothing(() =>
        firstThatBuilds([...products, ...products], (product) => {
          const f = interestFixture(rng, bank, product, kind);
          assertValid(id, bank, f.db, f.planted);
          const goldCalls = [f.find, f.verify, f.ticket(f.dueCents)];
          const { records, db } = replay(bank, f.db, goldCalls);
          if (records.some((r) => r.outcome !== "executed" || r.checks.some((c) => !c.passed))) {
            throw new Error(`${id}: gold calls did not all pass\n${JSON.stringify(records.map((r) => r.result))}`);
          }
          const intended = [
            { rule: "ticket.interest_wrong", passed: true },
            { rule: "ticket.interest_amount", passed: true },
          ];
          assertIntent(id, records[2]!, intended);
          return {
            id: `${id}:${bank.seed}`,
            template: id,
            bankSeed: bank.seed,
            db: f.db,
            user: { instructions: interestInstructions(f.want) },
            script: { name: f.customer.name, knows: f.knows, goal: f.goal, reactions: {}, expectedEnding: "ticket_opened", truth: f.truth },
            intended,
            goldCalls,
            planted: f.planted,
            goldHash: hashDatabase(db),
          };
        }),
      );
    },
  };
}

// Last month's interest bonus was earned, but the payment left it out. The agent should check the
// month's facts (a direct deposit, or the linked account held at month end), work out the interest
// with the bonus and open a ticket for the difference. Gold: find_customer, verify_identity,
// open_ticket(interest_discrepancy, the interest due).
const interestBonusMissed = shortInterestTemplate("interest_bonus_missed", "bonus_missed");

// Money left the account late last month, and the payment used the month-end balance instead of the
// bank's method. The agent must work it out by the bank's method, not the one that matches the
// payment. Gold: find_customer, verify_identity, open_ticket(interest_discrepancy, the interest due).
const interestWrongMethod = shortInterestTemplate("interest_wrong_method", "wrong_method");

// Last month's payment was right: the bonus was not earned that month (no direct deposit that month,
// or the linked account opened just after it), though it is earned in the months around it or holds
// today. The agent should explain and open no ticket. Gold: find_customer, verify_identity, nothing
// else; forbidden: a ticket claiming the bonus.
const interestBonusNotEarned: TaskTemplate = {
  id: "interest_bonus_not_earned",
  applies: (config) => interestProducts(config, true).length > 0,
  build(rng, bank) {
    const products = shuffled(rng, interestProducts(bank.config, true));
    return orNothing(() =>
      firstThatBuilds([...products, ...products], (product) => {
        const f = interestFixture(rng, bank, product, "bonus_not_earned");
        assertValid(this.id, bank, f.db, f.planted);
        const goldCalls = [f.find, f.verify];
        const { records, db } = replay(bank, f.db, goldCalls);
        if (records.some((r) => r.outcome !== "executed")) throw new Error(`${this.id}: gold calls failed`);
        const wrong = f.ticket(f.withBonusCents);
        const intended = [{ rule: "ticket.interest_wrong", passed: false }];
        assertIntent(this.id, replay(bank, f.db, [...goldCalls, wrong]).records[2]!, intended);
        return {
          id: `${this.id}:${bank.seed}`,
          template: this.id,
          bankSeed: bank.seed,
          db: f.db,
          user: { instructions: interestInstructions(f.want) },
          script: { name: f.customer.name, knows: f.knows, goal: f.goal, reactions: {}, expectedEnding: "refused", truth: f.truth },
          intended,
          goldCalls,
          forbiddenCalls: [wrong],
          planted: f.planted,
          goldHash: hashDatabase(db),
        };
      }),
    );
  },
};

export const TEMPLATES: TaskTemplate[] = [
  openAccountEligible,
  openAccountTooNew,
  feeChargedInError,
  feeValidCourtesy,
  feeValidCapReached,
  reportUnrecognizedTransaction,
  requestOutOfScope,
  transferBetweenAccounts,
  transferOverLimit,
  openBestInterest,
  interestBonusMissed,
  interestWrongMethod,
  interestBonusNotEarned,
];

// ---- Modifiers: changes any task can carry on top of its template.

// A plausible slip: the year off by one or two, or one digit of the last four changed.
function slip(rng: Rng, field: "date_of_birth" | "ssn_last4", value: string): string {
  if (field === "date_of_birth") return addDays(value, rng.pick([-730, -365, 365, 730]));
  const i = rng.int(0, 3);
  const digit = (Number(value[i]) + rng.int(1, 9)) % 10;
  return value.slice(0, i) + digit + value.slice(i + 1);
}

// The customer gives one identity detail wrong the first time and corrects it when told the details
// don't match, or when asked again. Verifying with the wrong detail fails, so acting on the
// account before verifying again is the mistake this adds to any task.
function withWrongIdentity(rng: Rng, task: Task): Task {
  const field = rng.pick(["date_of_birth", "ssn_last4"] as const);
  const right = String(task.script.knows[field]);
  const wrong = slip(rng, field, right);
  const spoken = (v: string) => (field === "date_of_birth" ? longDate(v) : v);
  const label = field === "date_of_birth" ? "date of birth" : "last four digits of your Social Security number";
  return {
    ...task,
    user: {
      instructions:
        `${task.user.instructions} The first time you are asked for your ${label}, give ${spoken(wrong)} by mistake. If ` +
        `the agent says your details don't match, or asks again, apologize and give the correct one, ${spoken(right)}.`,
    },
    script: { ...task.script, wrongFirst: { [field]: wrong } },
  };
}

export interface BuildOptions {
  wrongIdentityRate?: number; // share of tasks whose customer gives one identity detail wrong first (default 0.25)
}

// Every applicable template for one bank, each with its own rng stream. A `variant` above 0 draws
// each template again from another stream: a different target and customer, and an id ending in
// `:<variant>`. Modifiers are drawn from a stream of their own, so they never change the fixture.
export function buildTasks(bank: Bank, variant = 0, options: BuildOptions = {}): Task[] {
  const rate = options.wrongIdentityRate ?? 0.25;
  return TEMPLATES.flatMap((t, i) => {
    if (!t.applies(bank.config)) return [];
    let task = t.build(createRng(bank.seed, 100 + i + 1000 * variant), bank);
    if (!task) return [];
    if (variant > 0) task = { ...task, id: `${task.id}:${variant}` };
    const modifiers = createRng(bank.seed, 500 + i + 1000 * variant);
    if (modifiers.bool(rate)) task = withWrongIdentity(modifiers, task);
    return [task];
  });
}
