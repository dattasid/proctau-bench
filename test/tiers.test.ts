// The benchmark ships with two tiers, but nothing in the code may assume that. These tests
// generate three-tier banks and run them through validation, documents, tasks and the executor.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productsOf } from "../src/bank/products.ts";
import { callTool, toolList } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { SPEC } from "../src/gen/spec.ts";
import type { Spec } from "../src/gen/spec.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

const THREE_TIERS: Spec = {
  ...SPEC,
  tiers: ["basic", "plus", "premium"],
  bank: {
    ...SPEC.bank,
    nameSchemes: [
      [["Bronze"], ["Silver"], ["Gold"]],
      [["Blue"], ["Teal"], ["Navy"]],
    ],
  },
};

describe("three tiers", () => {
  const banks = Array.from({ length: 150 }, (_, i) => generateBank(i + 1, THREE_TIERS));

  it("every bank validates, with documents covering every product", () => {
    for (const { bank, errors } of banks) assert.ok(bank, errors.join("; "));
    const config = banks[0]!.bank!.config;
    assert.deepEqual(config.tiers, ["basic", "plus", "premium"]);
    assert.equal(Object.keys(config.products).length, 6);
    assert.ok(banks[0]!.bank!.docs.some((d) => d.path === "products/savings_plus.md"));
  });

  it("ordered banks step up across all three tiers", () => {
    for (const { bank } of banks) {
      if (bank!.config.unorderedTiers) continue;
      for (const t of ["checking", "savings"] as const) {
        const deposits = productsOf(bank!.config, t).map((p) => p.minOpeningDeposit);
        assert.ok(deposits[0]! < deposits[1]! && deposits[1]! < deposits[2]!, `seed ${bank!.seed} ${t}: ${deposits}`);
      }
    }
  });

  it("offers every product to open_account and holds background accounts in every tier", () => {
    const config = banks[0]!.bank!.config;
    const open = toolList(config).find((t) => t.name === "open_account")!;
    assert.equal((open.parameters.properties.productId as { enum: string[] }).enum.length, 6);
    const held = new Set(banks.flatMap(({ bank }) => Object.values(bank!.db.accounts).map((a) => a.productId)));
    for (const id of Object.keys(config.products)) assert.ok(held.has(id), `no background account in ${id}`);
  });

  it("builds tasks whose gold calls pass and reach the gold end state", () => {
    let built = 0;
    for (const { bank } of banks) {
      for (const task of buildTasks(bank!)) {
        built++;
        const s = createSession(bank!.config, task.db);
        for (const c of task.goldCalls) callTool(s, c.tool, c.args);
        const e = evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
        assert.ok(e.pass, `${task.id}: ${JSON.stringify(e)}`);
      }
    }
    assert.ok(built >= 150, `${built} tasks`);
  });
});
