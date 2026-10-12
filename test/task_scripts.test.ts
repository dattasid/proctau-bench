// Every task carries a customer script whose goal matches its gold call and whose truth holds:
// a held-too-briefly task's eligible date is the first day the bank's own rules let it open.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { meetsRequirements } from "../src/bank/rules.ts";
import { addDays } from "../src/util/dates.ts";
import { generateBank } from "../src/gen/generate.ts";
import { buildTasks } from "../src/gen/tasks.ts";

describe("task scripts", () => {
  const banks = Array.from({ length: 120 }, (_, i) => generateBank(i + 1).bank!);

  it("the goal is the open_account call the task is about", () => {
    for (const bank of banks) {
      for (const task of buildTasks(bank).filter((t) => t.template.startsWith("open_account"))) {
        const open = (task.forbiddenCalls?.[0] ?? task.goldCalls.at(-1))!.args;
        const { goal, knows } = task.script;
        assert.equal(goal.action, "open_account");
        if (goal.action !== "open_account") continue;
        assert.equal(goal.product, bank.config.products[open.productId as string]!.displayName);
        assert.equal(goal.amount, open.initialDeposit);
        const funding = task.db.accounts[open.fundingAccountId as string]!;
        assert.equal(goal.funding_account, bank.config.products[funding.productId]!.displayName);
        assert.equal(knows.date_of_birth, task.db.customers[funding.customerId]!.dateOfBirth);
      }
    }
  });

  it("a held-too-briefly task's eligible date is the first day the rules allow the opening", () => {
    let checked = 0;
    for (const bank of banks) {
      for (const task of buildTasks(bank).filter((t) => t.template === "open_account_held_too_briefly")) {
        const open = task.forbiddenCalls![0]!.args;
        const product = bank.config.products[open.productId as string]!;
        const customer = task.db.accounts[open.fundingAccountId as string]!.customerId;
        const truth = task.script.truth;
        assert.equal(truth.kind, "opening");
        const date = truth.kind === "opening" ? truth.eligible_date! : "";
        assert.ok(date > bank.config.bank.simulatedDate, task.id);
        assert.ok(meetsRequirements(bank.config, task.db, customer, product, date), `${task.id}: not eligible on ${date}`);
        assert.ok(!meetsRequirements(bank.config, task.db, customer, product, addDays(date, -1)), `${task.id}: already eligible before ${date}`);
        checked++;
      }
    }
    assert.ok(checked > 100, `${checked} tasks`);
  });
});
