// Task templates. A template reads the bank's policy values, builds a customer whose
// situation lands on one branch of a rule, and replays the expected calls through the
// executor to confirm the branch and record the gold end state. A template that
// misses its intended verdict throws instead of producing a silently wrong task.

import type { Bank } from "./generate.ts";
import { addDays } from "../util/dates.ts";
import { callTool } from "../env/executor.ts";
import { addAccount, addCustomer, chargeMonthlyFees } from "./fixtures.ts";
import { longDate, money } from "../util/format.ts";
import { hashDatabase } from "../util/hash.ts";
import { createRng } from "../util/rng.ts";
import type { Rng } from "../util/rng.ts";
import type { BankConfig } from "../bank/schema.ts";
import { createSession } from "../env/session.ts";
import type { TraceRecord } from "../env/session.ts";
import type { Customer, Database } from "../bank/state.ts";
import { validateDatabase } from "../bank/validate_db.ts";

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
  intended: { rule: string; passed: boolean }[]; // the rule branch this task targets
  goldCalls: ExpectedCall[]; // one correct sequence; others may be equally valid
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

// A customer with a checking account `ageDays` old who wants Premium savings
// funded from it with `deposit` dollars.
function premiumSavingsFixture(rng: Rng, bank: Bank, ageDays: number) {
  const { config } = bank;
  const today = config.bank.simulatedDate;
  const db = structuredClone(bank.db);
  const customer = newCustomer(rng, db, today);
  const deposit = config.products.savings_premium.minOpeningDeposit + rng.money(0, 3000, 500);
  const checking = addAccount(db, customer, "checking_basic", addDays(today, -ageDays), (deposit + rng.money(500, 5000, 100)) * 100);
  chargeMonthlyFees(config, db, checking, today);
  const verify = { tool: "verify_identity", args: { customerId: customer.id, dateOfBirth: customer.dateOfBirth, ssnLast4: customer.ssnLast4 } };
  const open = {
    tool: "open_account",
    args: { customerId: customer.id, productId: "savings_premium", initialDeposit: deposit, fundingAccountId: checking.id },
  };
  const want =
    `You are ${customer.name}. You want to open a ${config.products.savings_premium.displayName} account ` +
    `and fund it with ${money(deposit)} from your ${config.products.checking_basic.displayName} account. ` +
    `${identityLine(customer)} You do not know any account numbers.`;
  return { db, customer, checking, deposit, verify, open, want, find: { tool: "find_customer", args: { name: customer.name } } };
}

const premiumSavingsEligible: TaskTemplate = {
  id: "premium_savings_eligible",
  applies: () => true,
  build(rng, bank) {
    const rule = bank.config.policies.premiumSavingsEligibility;
    const ageDays = (rule.requiresChecking ? rule.minCheckingAgeDays : 0) + rng.int(5, 300);
    const f = premiumSavingsFixture(rng, bank, ageDays);
    assertValid(this.id, bank, f.db);
    const goldCalls = [f.find, f.verify, f.open];
    const { records, db } = replay(bank, f.db, goldCalls);
    const intended = rule.requiresChecking ? [{ rule: "premium_savings.eligibility", passed: true }] : [];
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
      intended,
      goldCalls,
      goldHash: hashDatabase(db),
    };
  },
};

const premiumSavingsTooNew: TaskTemplate = {
  id: "premium_savings_checking_too_new",
  applies: (config) => {
    const rule = config.policies.premiumSavingsEligibility;
    return rule.requiresChecking && rule.minCheckingAgeDays >= 2;
  },
  build(rng, bank) {
    const minDays = bank.config.policies.premiumSavingsEligibility.minCheckingAgeDays;
    const f = premiumSavingsFixture(rng, bank, rng.int(1, minDays - 1));
    assertValid(this.id, bank, f.db);
    const goldCalls = [f.find, f.verify];
    const { records, db } = replay(bank, f.db, goldCalls);
    if (records.some((r) => r.outcome !== "executed")) throw new Error(`${this.id}: gold calls failed`);
    // Probe the call the agent must not make, to confirm the fixture hits the rule.
    const intended = [{ rule: "premium_savings.eligibility", passed: false }];
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
      intended,
      goldCalls,
      goldHash: hashDatabase(db),
    };
  },
};

export const TEMPLATES: TaskTemplate[] = [premiumSavingsEligible, premiumSavingsTooNew];

// Every applicable template for one bank, each with its own rng stream.
export function buildTasks(bank: Bank): Task[] {
  return TEMPLATES.flatMap((t, i) => (t.applies(bank.config) ? [t.build(createRng(bank.seed, 100 + i), bank)] : []));
}
