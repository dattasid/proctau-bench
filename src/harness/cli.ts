// Usage: npm run harness -- [--seed N] [--count K] [--template ID] [--agent-model M]
//          [--user-model M] [--server URL] [--out DIR]
// Generates banks and tasks, runs each task as a conversation against the executor
// (an in-process server unless --server is given) and writes one JSON file per run.
// A batch directory also holds meta.json and, under banks/, each bank's config, documents
// and the agent's system prompt, so the viewer never has to regenerate a bank.

import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateBank } from "../gen/generate.ts";
import { createEnvServer } from "../env/server.ts";
import { buildTasks } from "../gen/tasks.ts";
import { DEFAULT_MODEL, readApiKey } from "./llm.ts";
import { agentSystemPrompt } from "./prompts.ts";
import { runTask } from "./run.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    count: { type: "string", default: "1" },
    template: { type: "string" },
    "agent-model": { type: "string", default: DEFAULT_MODEL },
    "user-model": { type: "string", default: DEFAULT_MODEL },
    server: { type: "string" },
    out: { type: "string", default: "out/runs" },
  },
});

const apiKey = readApiKey();
let baseUrl = values.server;
const server = baseUrl ? null : createEnvServer();
if (server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const runDir = join(values.out, new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(join(runDir, "banks"), { recursive: true });
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const meta: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  seed: Number(values.seed),
  count: Number(values.count),
  template: values.template ?? null,
  agentModel: values["agent-model"],
  userModel: values["user-model"],
};
writeJson(join(runDir, "meta.json"), meta);

let passed = 0;
let total = 0;
try {
  for (let seed = Number(values.seed); seed < Number(values.seed) + Number(values.count); seed++) {
    const { bank, errors } = generateBank(seed);
    if (!bank) {
      console.error(`seed ${seed}: invalid bank\n  ${errors.join("\n  ")}`);
      continue;
    }
    const tasks = buildTasks(bank).filter((t) => !values.template || t.template === values.template);
    const { config, docs } = bank;
    writeJson(join(runDir, "banks", `${seed}.json`), { seed, config, docs, agentPrompt: agentSystemPrompt(config, docs) });
    for (const task of tasks) {
      total++;
      try {
        const result = await runTask(bank, task, {
          baseUrl: baseUrl!,
          apiKey,
          agentModel: values["agent-model"],
          userModel: values["user-model"],
        });
        writeJson(join(runDir, `${task.id.replace(/:/g, "_")}.json`), { task, result });
        const e = result.evaluation;
        if (e.pass) passed++;
        const issues = [
          e.dbMatch ? "" : "end state differs",
          ...e.violations.map((v) => `violated ${v.rule}`),
          ...e.blockedAttempts.map((v) => `blocked ${v.rule}`),
        ].filter(Boolean);
        console.log(`${e.pass ? "PASS" : "FAIL"} ${task.id} (${e.endReason}, ${e.counts.calls} calls)${issues.length ? ": " + issues.join("; ") : ""}`);
      } catch (err) {
        console.error(`ERROR ${task.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
} finally {
  server?.close();
  writeJson(join(runDir, "meta.json"), { ...meta, finishedAt: new Date().toISOString(), passed, total });
}
console.log(`${passed}/${total} passed; runs written to ${runDir}`);
