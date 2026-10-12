// Fee refund tasks: the gold path passes, and each tempting wrong move fails evaluation.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callTool } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import type { ExpectedCall, Task } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

const banks = Array.from({ length: 60 }, (_, i) => generateBank(i + 1).bank!);
const tasksOf = (template: string) => banks.flatMap((bank) => buildTasks(bank).filter((t) => t.template === template).map((task) => ({ bank, task })));

function run(bank: (typeof banks)[number], task: Task, calls: ExpectedCall[]) {
  const s = createSession(bank.config, task.db);
  for (const c of calls) callTool(s, c.tool, c.args);
  return evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
}

describe("fee refund tasks", () => {
  it("charged in error: the fee is a planted wrong fee; a courtesy refund instead of a correction fails", () => {
    const found = tasksOf("fee_charged_in_error");
    assert.ok(found.length > 40, `${found.length} tasks`);
    for (const { bank, task } of found) {
      assert.equal(task.planted.length, 1);
      assert.equal(task.planted[0]!.kind, "wrong_fee");
      assert.ok(run(bank, task, task.goldCalls).pass, task.id);
      const [find, verify, refund] = task.goldCalls;
      const asCourtesy = { ...refund!, args: { ...refund!.args, reason: "courtesy" } };
      assert.equal(run(bank, task, [find!, verify!, asCourtesy]).dbMatch, false, task.id);
    }
  });

  it("valid with courtesy left: a correction refund is a violation", () => {
    const found = tasksOf("fee_valid_courtesy");
    assert.ok(found.length > 30, `${found.length} tasks`);
    for (const { bank, task } of found) {
      assert.deepEqual(task.planted, []);
      assert.ok(run(bank, task, task.goldCalls).pass, task.id);
      const e = run(bank, task, [...task.goldCalls.slice(0, 2), ...task.forbiddenCalls!]);
      assert.deepEqual(e.violations.map((v) => v.rule), ["refund.correction_valid"]);
    }
  });

  it("cap reached: refunding is a violation, and declining without a transfer misses the required call", () => {
    const found = tasksOf("fee_valid_cap_reached");
    assert.ok(found.length > 40, `${found.length} tasks`);
    for (const { bank, task } of found) {
      assert.ok(run(bank, task, task.goldCalls).pass, task.id);
      const refunded = run(bank, task, [...task.goldCalls.slice(0, 2), ...task.forbiddenCalls!]);
      assert.deepEqual(refunded.violations.map((v) => v.rule), ["refund.courtesy_cap"]);
      const declinedOnly = run(bank, task, task.goldCalls.slice(0, 2));
      assert.equal(declinedOnly.dbMatch, true);
      assert.deepEqual(declinedOnly.missingCalls, ["transfer_to_human"]);
      assert.equal(declinedOnly.pass, false);
    }
  });
});
