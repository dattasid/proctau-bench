import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { generateBank } from "../src/gen/generate.ts";
import { EnvClient } from "../src/harness/env_client.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { createEnvServer } from "../src/env/server.ts";
import { buildTasks } from "../src/gen/tasks.ts";

describe("task templates", () => {
  it("build for many banks, each hitting its intended rule branch", () => {
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const { bank, errors } = generateBank(seed);
      assert.ok(bank, `seed ${seed}: ${errors.join("; ")}`);
      for (const task of buildTasks(bank)) counts[task.template] = (counts[task.template] ?? 0) + 1;
    }
    assert.equal(counts.open_account_eligible, 300);
    assert.ok((counts.open_account_held_too_briefly ?? 0) > 50, JSON.stringify(counts));
  });
});

describe("REST server", () => {
  const server = createEnvServer();
  let baseUrl = "";
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("lists tools", async () => {
    const { bank } = generateBank(1);
    const env = await EnvClient.create(baseUrl, bank!.config, bank!.db);
    assert.equal((await env.tools()).length, 9);
    await env.close();
  });

  it("rejects an invalid environment", async () => {
    const { bank } = generateBank(1);
    const db = structuredClone(bank!.db);
    Object.values(db.accounts)[0]!.balanceCents += 1;
    await assert.rejects(EnvClient.create(baseUrl, bank!.config, db), /HTTP 400/);
  });

  it("replaying the gold calls reaches the gold end state and passes evaluation", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { bank } = generateBank(seed);
      for (const task of buildTasks(bank!)) {
        const env = await EnvClient.create(baseUrl, bank!.config, task.db);
        for (const call of task.goldCalls) await env.call(call.tool, call.args);
        const { hash } = await env.state();
        const { trace } = await env.trace();
        const e = evaluate(task, trace, hash, "user_stop");
        assert.ok(e.pass, `${task.id}: ${JSON.stringify(e)}`);
        await env.close();
      }
    }
  });

  it("fails evaluation when the agent opens a product the customer is not yet eligible for", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { bank } = generateBank(seed);
      const task = buildTasks(bank!).find((t) => t.template === "open_account_held_too_briefly");
      if (!task) continue;
      const env = await EnvClient.create(baseUrl, bank!.config, task.db);
      for (const call of task.goldCalls) await env.call(call.tool, call.args);
      const customerId = task.goldCalls[1]!.args.customerId as string;
      const funding = Object.values(task.db.accounts).find((a) => a.customerId === customerId)!;
      const target = Object.values(bank!.config.products).find((p) => p.requirements.length > 0)!;
      const r = await env.call("open_account", {
        customerId,
        productId: target.id,
        initialDeposit: Math.max(target.minOpeningDeposit, 100),
        fundingAccountId: funding.id,
      });
      const { hash } = await env.state();
      const e = evaluate(task, (await env.trace()).trace, hash, "user_stop");
      assert.equal(e.pass, false);
      assert.equal(r.outcome, "executed");
      assert.equal(e.dbMatch, false);
      assert.equal(e.violations[0]?.rule, "product.eligibility");
      await env.close();
    }
  });
});
