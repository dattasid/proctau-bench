// The benchmark ships with checking and savings, but nothing in the code may assume that. These
// tests add a business checking type that requires personal checking, and run the banks through
// validation, documents, background histories and tasks.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productsOf } from "../src/bank/products.ts";
import { callTool } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { SPEC } from "../src/gen/spec.ts";
import type { Spec } from "../src/gen/spec.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

const WITH_BUSINESS: Spec = {
  ...SPEC,
  accountTypes: {
    ...SPEC.accountTypes,
    business_checking: {
      ...SPEC.accountTypes.checking!,
      waiver: { kinds: ["min_balance", "linked_account"], minBalance: [2000, 5000, 500], minBalanceGrowth: 5 },
      requirement: { chance: { bottom: 1, top: 1 }, accountType: "checking", minAgeDays: [30, 90] },
      background: {
        holdChance: 0.4,
        tierWeight: { bottom: 0.5, top: 0.5 },
        startingBalanceMax: { bottom: 10000, top: 50000 },
        payroll: false,
        spending: false,
        receivesTransfers: false,
      },
    },
  },
};

describe("a third account type", () => {
  const banks = Array.from({ length: 150 }, (_, i) => generateBank(i + 1, WITH_BUSINESS));

  it("every bank validates, with business products named and described as such", () => {
    for (const { bank, errors } of banks) assert.ok(bank, errors.join("; "));
    const { config, docs } = banks[0]!.bank!;
    assert.deepEqual(config.accountTypes, ["checking", "savings", "business_checking"]);
    assert.equal(Object.keys(config.products).length, 6);
    const premium = productsOf(config, "business_checking").at(-1)!;
    assert.match(premium.displayName, / Business Checking$/);
    const sheet = docs.find((d) => d.path === `products/${premium.id}.md`)!.content;
    assert.match(sheet, /business checking account/);
    assert.match(sheet, /open checking account with us/);
  });

  it("background customers hold business accounts, and everyone holds something", () => {
    let business = 0;
    for (const { bank } of banks) {
      const { config, db } = bank!;
      for (const c of Object.values(db.customers)) {
        assert.ok(Object.values(db.accounts).some((a) => a.customerId === c.id), `seed ${bank!.seed}: ${c.id} holds nothing`);
      }
      business += Object.values(db.accounts).filter((a) => config.products[a.productId]!.accountType === "business_checking").length;
    }
    assert.ok(business > 100, `${business} business accounts`);
  });

  it("builds business opening tasks whose gold calls pass", () => {
    let business = 0;
    for (const { bank } of banks) {
      for (const task of buildTasks(bank!)) {
        const s = createSession(bank!.config, task.db);
        for (const c of task.goldCalls) callTool(s, c.tool, c.args);
        const e = evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
        assert.ok(e.pass, `${task.id}: ${JSON.stringify(e)}`);
        if (task.user.instructions.includes("Business Checking")) business++;
      }
    }
    assert.ok(business > 20, `${business} business tasks`);
  });
});
