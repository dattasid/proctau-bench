// The benchmark ships with two tiers, but nothing in the code may assume that. These tests
// generate three-tier banks and run them through validation, documents, tasks and the executor.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountTypeTitle, productsOf } from "../src/bank/products.ts";
import { callTool, toolList } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { SPEC } from "../src/gen/spec.ts";
import type { Spec } from "../src/gen/spec.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

const THREE_TIERS: Spec = { ...SPEC, tiers: ["basic", "plus", "premium"] };
const FIVE_TIERS: Spec = { ...SPEC, tiers: ["t1", "t2", "t3", "t4", "t5"] };

describe("three tiers", () => {
  const banks = Array.from({ length: 150 }, (_, i) => generateBank(i + 1, THREE_TIERS));

  it("every bank validates, with documents covering every product", () => {
    for (const { bank, errors } of banks) assert.ok(bank, errors.join("; "));
    const config = banks[0]!.bank!.config;
    assert.deepEqual(config.tiers, ["basic", "plus", "premium"]);
    assert.equal(Object.keys(config.products).length, 3 * config.accountTypes.length);
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
    assert.equal((open.parameters.properties.productId as { enum: string[] }).enum.length, 3 * config.accountTypes.length);
    const held = new Set(banks.flatMap(({ bank }) => Object.values(bank!.db.accounts).map((a) => a.productId)));
    for (const id of Object.keys(config.products)) assert.ok(held.has(id), `no background account in ${id}`);
  });

  it("describes a middle tier as a step up from the one below, on ordered banks", () => {
    const { config, docs } = banks.find(({ bank }) => !bank!.config.unorderedTiers)!.bank!;
    const [low, mid] = productsOf(config, "savings");
    assert.match(docs.find((d) => d.path === `products/${mid!.id}.md`)!.content, new RegExp(`above ${low!.displayName}|up from ${low!.displayName}`));
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

describe("five tiers", () => {
  const banks = Array.from({ length: 100 }, (_, i) => generateBank(i + 1, FIVE_TIERS));

  it("every bank validates, with names in ladder order and numbered ladders from the start", () => {
    for (const { bank, errors } of banks) assert.ok(bank, errors.join("; "));
    for (const { bank } of banks) {
      for (const t of bank!.config.accountTypes) {
        const names = productsOf(bank!.config, t).map((p) => p.displayName.slice(0, -accountTypeTitle(t).length - 1));
        assert.ok(SPEC.bank.nameLadders.some((l) => l.names.join() === names.join()), `seed ${bank!.seed}: ${names}`);
      }
    }
  });

  it("refuses more tiers than a ladder has names", () => {
    assert.throws(() => generateBank(1, { ...SPEC, tiers: ["a", "b", "c", "d", "e", "f"] }), /name ladder/);
  });
});
