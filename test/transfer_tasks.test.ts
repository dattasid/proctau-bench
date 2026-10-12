// Transfer tasks: the gold path passes; over the monthly limit, transferring anyway is a violation.

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

function run(bank: (typeof banks)[number], task: Task, calls: ExpectedCall[]) {
  const s = createSession(bank.config, task.db);
  for (const c of calls) callTool(s, c.tool, c.args);
  return evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
}

describe("transfer tasks", () => {
  it("within the limit, the transfer passes; over it, transferring is a violation", () => {
    let within = 0;
    let over = 0;
    for (const bank of banks) {
      for (const task of buildTasks(bank)) {
        if (task.template === "transfer_between_accounts") {
          within++;
          assert.ok(run(bank, task, task.goldCalls).pass, task.id);
        }
        if (task.template === "transfer_over_limit") {
          over++;
          assert.ok(run(bank, task, task.goldCalls).pass, task.id);
          const e = run(bank, task, [...task.goldCalls, ...task.forbiddenCalls!]);
          assert.deepEqual(e.violations.map((v) => v.rule), ["transfer.monthly_limit"]);
          assert.equal(e.pass, false);
        }
      }
    }
    assert.ok(within > 50 && over > 25, `${within} within, ${over} over`);
  });
});
