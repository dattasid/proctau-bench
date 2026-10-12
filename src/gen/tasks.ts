// Task templates. A template reads the bank's policy values, builds a customer whose
// situation lands on one branch of a rule, and replays the expected calls through the
// executor to confirm the branch and record the gold end state. A template that
// misses its intended verdict throws instead of producing a silently wrong task.

import type { Bank } from "./generate.ts";
import { addDays, daysBetween } from "../util/dates.ts";
import { callTool } from "../env/executor.ts";
import { addAccount, addCustomer, chargeMonthlyFees } from "./fixtures.ts";
import { longDate, money } from "../util/format.ts";
import { hashDatabase } from "../util/hash.ts";
import { createRng } from "../util/rng.ts";
import type { Rng } from "../util/rng.ts";
import { allProducts, productsOf, requiredAccountName } from "../bank/products.ts";
import { requirementMatches } from "../bank/rules.ts";
import type { BankConfig, Product, Requirement } from "../bank/schema.ts";
import { createSession } from "../env/session.ts";
import type { TraceRecord } from "../env/session.ts";
import type { Account, Customer, Database } from "../bank/state.ts";
import { validateDatabase } from "../bank/validate_db.ts";
import type { CustomerScript } from "../script/types.ts";

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
  goldHash: string; // database hash after a correct conversation
}

interface TaskTemplate {
  id: string;
  applies(config: BankConfig): boolean;
  build(rng: Rng, bank: Bank): Task;
}

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

function assertValid(template: string, bank: Bank, db: Database): void {
  const errors = validateDatabase(bank.config, db);
  if (errors.length > 0) throw new Error(`${template}: fixture breaks the database\n  ${errors.join("\n  ")}`);
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
  for (const a of held) chargeMonthlyFees(config, db, a, today);
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
          truth: { requirements: f.base.requirements, eligible: true, min_deposit: f.base.min_deposit },
        },
        intended,
        goldCalls,
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
        goldHash: hashDatabase(db),
      };
    });
  },
};

export const TEMPLATES: TaskTemplate[] = [openAccountEligible, openAccountTooNew];

// Every applicable template for one bank, each with its own rng stream. A `variant` above 0 draws
// each template again from another stream: a different target and customer, and an id ending in
// `:<variant>`.
export function buildTasks(bank: Bank, variant = 0): Task[] {
  return TEMPLATES.flatMap((t, i) => {
    if (!t.applies(bank.config)) return [];
    const task = t.build(createRng(bank.seed, 100 + i + 1000 * variant), bank);
    return [variant > 0 ? { ...task, id: `${task.id}:${variant}` } : task];
  });
}
