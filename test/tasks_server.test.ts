import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { generateBank } from "../src/bank.ts";
import { EnvClient } from "../src/harness/env_client.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import { createEnvServer } from "../src/server.ts";
import { buildTasks } from "../src/tasks.ts";

describe("task templates", () => {
  it("build for many banks, each hitting its intended rule branch", () => {
    const counts: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed++) {
      const { bank, errors } = generateBank(seed);
      assert.ok(bank, `seed ${seed}: ${errors.join("; ")}`);
      for (const task of buildTasks(bank)) counts[task.template] = (counts[task.template] ?? 0) + 1;
    }
    assert.equal(counts.premium_savings_eligible, 300);
    assert.ok((counts.premium_savings_checking_too_new ?? 0) > 50, JSON.stringify(counts));
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
    assert.equal((await EnvClient.tools(baseUrl)).length, 9);
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

  it("fails evaluation when the agent opens premium savings too early", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { bank } = generateBank(seed);
      const task = buildTasks(bank!).find((t) => t.template === "premium_savings_checking_too_new");
      if (!task) continue;
      const env = await EnvClient.create(baseUrl, bank!.config, task.db);
      for (const call of task.goldCalls) await env.call(call.tool, call.args);
      const customerId = task.goldCalls[1]!.args.customerId as string;
      const checking = Object.values(task.db.accounts).find((a) => a.customerId === customerId)!;
      const r = await env.call("open_account", {
        customerId,
        productId: "savings_premium",
        initialDeposit: bank!.config.products.savings_premium.minOpeningDeposit,
        fundingAccountId: checking.id,
      });
      const { hash } = await env.state();
      const e = evaluate(task, (await env.trace()).trace, hash, "user_stop");
      assert.equal(e.pass, false);
      if (bank!.config.policies.premiumSavingsEligibility.enforcement === "api") {
        assert.equal(r.outcome, "blocked");
        assert.equal(e.blockedAttempts[0]?.rule, "premium_savings.eligibility");
      } else {
        assert.equal(r.outcome, "executed");
        assert.equal(e.violations[0]?.rule, "premium_savings.eligibility");
      }
      await env.close();
    }
  });
});
