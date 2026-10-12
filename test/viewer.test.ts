import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { generateBank } from "../src/bank.ts";
import { callTool } from "../src/executor.ts";
import { evaluate } from "../src/harness/evaluate.ts";
import type { RunResult } from "../src/harness/run.ts";
import { hashDatabase } from "../src/hash.ts";
import { createSession } from "../src/session.ts";
import { buildTasks } from "../src/tasks.ts";
import { createViewerServer } from "../src/viewer/server.ts";
import type { Batch } from "../src/viewer/server.ts";

// A batch laid out like the harness writes it, with gold replays standing in for LLM runs.
function writeBatch(dir: string, withBank: boolean): void {
  mkdirSync(join(dir, "banks"), { recursive: true });
  const { bank } = generateBank(1);
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ agentModel: "m", finishedAt: "x" }));
  if (withBank) writeFileSync(join(dir, "banks", "1.json"), JSON.stringify({ seed: 1, config: bank!.config, docs: bank!.docs, agentPrompt: "p" }));
  for (const task of buildTasks(bank!)) {
    const s = createSession(bank!.config, task.db);
    for (const c of task.goldCalls) callTool(s, c.tool, c.args);
    const finalHash = hashDatabase(s.db);
    const result: RunResult = {
      taskId: task.id, agentModel: "m", userModel: "m", prompts: { agent: "a", user: "u" }, turns: [], trace: s.trace, notes: s.notes, finalHash,
      evaluation: evaluate(task, s.trace, finalHash, "user_stop"),
    };
    writeFileSync(join(dir, `${task.id.replace(/:/g, "_")}.json`), JSON.stringify({ task, result }));
  }
}

describe("viewer server", () => {
  const root = mkdtempSync(join(tmpdir(), "procbank-viewer-"));
  writeBatch(join(root, "2026-01-01T00-00-00-000Z"), true);
  writeBatch(join(root, "sweeps", "old"), false);
  const server = createViewerServer(root);
  let base = "";
  before(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the page", async () => {
    const res = await fetch(base + "/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<title>procbank runs<\/title>/);
  });

  it("lists nested batches with run summaries", async () => {
    const { batches } = (await (await fetch(base + "/api/index")).json()) as { batches: Batch[] };
    assert.deepEqual(batches.map((b) => b.path), ["sweeps/old", "2026-01-01T00-00-00-000Z"]);
    const runs = batches[1]!.runs;
    assert.ok(runs.length >= 1);
    assert.ok(runs.every((r) => r.pass && r.bankSeed === 1));
    assert.equal(batches[1]!.meta?.agentModel, "m");
  });

  it("returns a run with its bank snapshot, or null when none was saved", async () => {
    const { batches } = (await (await fetch(base + "/api/index")).json()) as { batches: Batch[] };
    const get = async (b: Batch) =>
      (await (await fetch(`${base}/api/run?batch=${encodeURIComponent(b.path)}&file=${b.runs[0]!.file}`)).json()) as { bank: { seed: number } | null };
    assert.equal((await get(batches[1]!)).bank?.seed, 1);
    assert.equal((await get(batches[0]!)).bank, null);
  });

  it("refuses paths outside the root", async () => {
    assert.equal((await fetch(`${base}/api/run?batch=..&file=package.json`)).status, 400);
    assert.equal((await fetch(`${base}/api/run?batch=.&file=..%2Fx.json`)).status, 400);
  });
});
