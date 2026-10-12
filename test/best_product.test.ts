// Best-product tasks: the gold product earns the most interest among the products the customer
// can open, and opening any other one fails.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callTool } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { newState, step } from "../src/script/engine.ts";
import { hashDatabase } from "../src/util/hash.ts";

describe("open_best_interest", () => {
  const found = Array.from({ length: 60 }, (_, i) => generateBank(i + 1).bank!).flatMap((bank) =>
    buildTasks(bank).filter((t) => t.template === "open_best_interest").map((task) => ({ bank, task })),
  );

  it("the answer is the clear best among products the customer can open", () => {
    assert.ok(found.length > 40, `${found.length} tasks`);
    let excludedBetter = 0;
    for (const { task } of found) {
      const truth = task.script.truth;
      assert.equal(truth.kind, "best_product");
      if (truth.kind !== "best_product") continue;
      const open = truth.candidates.filter((c) => c.eligible).sort((a, b) => b.interestCents - a.interestCents);
      assert.equal(open[0]!.product, truth.best);
      if (open.length > 1) assert.ok(open[0]!.interestCents - open[1]!.interestCents >= 100, task.id);
      if (truth.candidates.some((c) => !c.eligible && c.interestCents > open[0]!.interestCents)) excludedBetter++;
    }
    // Often a product the customer can't open would pay more: the trap this task sets.
    assert.ok(excludedBetter > 5, `${excludedBetter} tasks where a better product is out of reach`);
  });

  it("gold passes, and opening any other product fails", () => {
    for (const { bank, task } of found) {
      const run = (productId: string) => {
        const s = createSession(bank.config, task.db);
        const [find, verify, open] = task.goldCalls;
        callTool(s, find!.tool, find!.args);
        callTool(s, verify!.tool, verify!.args);
        callTool(s, open!.tool, { ...open!.args, productId });
        return evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
      };
      const gold = task.goldCalls[2]!.args.productId as string;
      assert.ok(run(gold).pass, task.id);
      const other = Object.values(bank.config.products).find((p) => p.id !== gold && p.accountType === bank.config.products[gold]!.accountType)!;
      assert.equal(run(other.id).pass, false, task.id);
    }
  });

  it("the scripted customer accepts whatever product the agent proposes", () => {
    const { task } = found[0]!;
    const s = step(task.script, newState(), [
      { act: "ask_confirmation", args: { action: "open_account", product: "Some Other Savings", amount: task.script.knows.amount }, quote: "" },
    ]);
    assert.deepEqual(s.acts, [{ act: "confirm" }]);
  });
});
