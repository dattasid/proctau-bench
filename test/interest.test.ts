// Interest: each method on a hand-worked month, the bonus rules, and the interest tasks (the gold path
// passes, and each tempting wrong ticket fails evaluation).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bonusEarned, interestForMonth } from "../src/bank/rules.ts";
import type { BankConfig } from "../src/bank/schema.ts";
import { callTool } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { addAccount, addCustomer, addTransaction, emptyDatabase } from "../src/gen/fixtures.ts";
import { generateBank } from "../src/gen/generate.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import type { ExpectedCall, Task } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

// One flat 2.4% account: $1,000 from February 15, $3,000 from March 10, $500 from March 25.
function march() {
  const config: BankConfig = structuredClone(generateBank(1).bank!.config);
  const product = config.products["savings_basic"]!;
  product.interest = { structure: "flat", apy: 2.4 };
  product.bonuses = [{ trigger: "direct_deposit", apyBoost: 0.6 }];
  const db = emptyDatabase();
  const customer = addCustomer(db, { name: "Test Person", dateOfBirth: "1980-05-05", ssnLast4: "1111" });
  const account = addAccount(db, customer, product.id, "2026-02-15", 100_000);
  addTransaction(db, account, "2026-03-10", "deposit", 200_000, "Deposit");
  addTransaction(db, account, "2026-03-25", "card_purchase", -250_000, "Withdrawal");
  return { config, db, customer, account };
}

describe("interest methods", () => {
  it("work out March as by hand", () => {
    const { config, db, account } = march();
    const cents = (method: Parameters<typeof interestForMonth>[4]) => interestForMonth(config, db, account, "2026-03", method, 0).cents;
    // Average: (9 x 1000 + 15 x 3000 + 7 x 500) / 31 = 1854.84; x 2.4% / 12 = 3.71.
    assert.equal(cents("average_daily_balance"), 371);
    // Every day at 2.4% / 365: 57,500 dollar-days x 0.024 / 365 = 3.78.
    assert.equal(cents("daily_accrual"), 378);
    // Lowest and last day both $500: 1.00. Start: $1,000 at the end of February: 2.00.
    assert.equal(cents("minimum_daily_balance"), 100);
    assert.equal(cents("month_end_balance"), 100);
    assert.equal(cents("month_start_balance"), 200);
    // The bonus adds to the rate: 1854.84 x 3% / 12 = 4.64.
    assert.equal(interestForMonth(config, db, account, "2026-03", "average_daily_balance", 0.6).cents, 464);
  });

  it("earn a direct deposit bonus only in a month with a direct deposit into any account", () => {
    const { config, db, customer, account } = march();
    const checking = addAccount(db, customer, "checking_basic", "2026-01-05", 50_000);
    addTransaction(db, checking, "2026-04-15", "direct_deposit", 150_000, "Payroll direct deposit");
    const bonus = config.products["savings_basic"]!.bonuses[0]!;
    assert.equal(bonusEarned(config, db, account, "2026-03", bonus), false);
    assert.equal(bonusEarned(config, db, account, "2026-04", bonus), true);
  });

  it("earn a linked account bonus only with that account open at the month's end", () => {
    const { config, db, customer, account } = march();
    const bonus = { trigger: "linked_account" as const, accountType: "checking", apyBoost: 0.5 };
    addAccount(db, customer, "checking_basic", "2026-04-02", 50_000);
    assert.equal(bonusEarned(config, db, account, "2026-03", bonus), false);
    assert.equal(bonusEarned(config, db, account, "2026-04", bonus), true);
  });
});

const banks = Array.from({ length: 60 }, (_, i) => generateBank(i + 1).bank!);
const tasksOf = (template: string) => banks.flatMap((bank) => buildTasks(bank).filter((t) => t.template === template).map((task) => ({ bank, task })));

function run(bank: (typeof banks)[number], task: Task, calls: ExpectedCall[]) {
  const s = createSession(bank.config, task.db);
  for (const c of calls) callTool(s, c.tool, c.args);
  return evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
}

// The gold ticket with another expected amount.
const withAmount = (ticket: ExpectedCall, dollars: number): ExpectedCall => ({ ...ticket, args: { ...ticket.args, expectedInterest: dollars } });

describe("interest tasks", () => {
  for (const template of ["interest_bonus_missed", "interest_wrong_method"]) {
    it(`${template}: the gold ticket passes; a ticket for what was paid, or none, fails`, () => {
      const found = tasksOf(template);
      assert.ok(found.length > 20, `${found.length} tasks`);
      for (const { bank, task } of found) {
        assert.deepEqual(task.planted.map((p) => p.kind), ["wrong_interest"]);
        assert.ok(run(bank, task, task.goldCalls).pass, task.id);
        const [find, verify, ticket] = task.goldCalls;
        const paid = (task.script.truth as { paid: number }).paid;
        assert.deepEqual(run(bank, task, [find!, verify!, withAmount(ticket!, paid)]).violations.map((v) => v.rule), ["ticket.interest_amount"]);
        assert.equal(run(bank, task, [find!, verify!]).dbMatch, false);
      }
    });
  }

  it("interest_bonus_not_earned: no ticket passes; a ticket claiming the bonus is a violation", () => {
    const found = tasksOf("interest_bonus_not_earned");
    assert.ok(found.length > 20, `${found.length} tasks`);
    for (const { bank, task } of found) {
      assert.deepEqual(task.planted, []);
      assert.ok(run(bank, task, task.goldCalls).pass, task.id);
      const e = run(bank, task, [...task.goldCalls, ...task.forbiddenCalls!]);
      assert.deepEqual(e.violations.map((v) => v.rule), ["ticket.interest_wrong", "ticket.interest_amount"]);
    }
  });
});
