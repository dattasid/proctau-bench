// Business accounts and product requirements: some banks offer business checking (which requires
// personal checking) and business savings (which requires business checking), and some let a
// product require one specific earlier product. Every chain must still validate, be described in
// the documents and yield account-opening tasks whose gold calls pass.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allProducts, productsOf } from "../src/bank/products.ts";
import { callTool } from "../src/env/executor.ts";
import { createSession } from "../src/env/session.ts";
import { generateBank } from "../src/gen/generate.ts";
import { buildTasks } from "../src/gen/tasks.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { hashDatabase } from "../src/util/hash.ts";

describe("business accounts and product requirements", () => {
  const banks = Array.from({ length: 200 }, (_, i) => generateBank(i + 1)).map(({ bank, errors }) => {
    assert.ok(bank, errors.join("; "));
    return bank;
  });

  it("offers business types on some banks, business savings only with business checking", () => {
    const business = banks.filter((b) => b.config.accountTypes.includes("business_checking"));
    assert.ok(business.length > 60 && business.length < 140, `${business.length} of 200`);
    for (const b of banks) {
      if (b.config.accountTypes.includes("business_savings")) assert.ok(b.config.accountTypes.includes("business_checking"));
    }
  });

  it("names and describes business products, with the chain in the documents", () => {
    const { config, docs } = banks.find((b) => b.config.accountTypes.includes("business_savings"))!;
    const top = productsOf(config, "business_savings").at(-1)!;
    assert.match(top.displayName, / Business Savings$/);
    const sheet = docs.find((d) => d.path === `products/${top.id}.md`)!.content;
    assert.match(sheet, /business savings account/);
    assert.match(sheet, /open business checking account with us/);
  });

  it("some banks require specific earlier products, named in the documents", () => {
    const flagged = banks.filter((b) => b.config.productRequirements);
    assert.ok(flagged.length > 25, `${flagged.length} banks`);
    let sameType = 0;
    for (const { config, docs } of flagged) {
      for (const p of allProducts(config)) {
        for (const r of p.requirements) {
          if (r.kind !== "holds_product") continue;
          if (config.products[r.productId]!.accountType === p.accountType) sameType++;
          const sheet = docs.find((d) => d.path === `products/${p.id}.md`)!.content;
          assert.ok(sheet.includes(`${config.products[r.productId]!.displayName} account`), `${p.id} sheet never names ${r.productId}`);
        }
      }
    }
    assert.ok(sameType > 10, `${sameType} same-type product requirements`);
  });

  it("background customers hold business accounts, and everyone holds something", () => {
    let business = 0;
    for (const { config, db, seed } of banks) {
      for (const c of Object.values(db.customers)) {
        assert.ok(Object.values(db.accounts).some((a) => a.customerId === c.id), `seed ${seed}: ${c.id} holds nothing`);
      }
      business += Object.values(db.accounts).filter((a) => config.products[a.productId]!.accountType.startsWith("business_")).length;
    }
    assert.ok(business > 50, `${business} business accounts`);
  });

  it("builds opening tasks along chains, including two-step ones, whose gold calls pass", () => {
    let chained = 0;
    for (const bank of banks) {
      for (const task of buildTasks(bank)) {
        const s = createSession(bank.config, task.db);
        for (const c of task.goldCalls) callTool(s, c.tool, c.args);
        const e = evaluate(task, s.trace, hashDatabase(s.db), "user_stop");
        assert.ok(e.pass, `${task.id}: ${JSON.stringify(e)}`);
        // A fixture customer holding a business checking account that itself needed personal checking.
        const customer = task.goldCalls[1]!.args.customerId as string;
        const held = Object.values(task.db.accounts).filter((a) => a.customerId === customer).map((a) => bank.config.products[a.productId]!);
        if (held.some((p) => p.accountType === "business_checking") && held.some((p) => p.accountType === "checking")) chained++;
      }
    }
    assert.ok(chained > 20, `${chained} two-step fixtures`);
  });
});
