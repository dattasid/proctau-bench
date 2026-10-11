// Usage: npm run harness -- [--seed N] [--count K] [--template ID] [--agent-model M]
//          [--user-model M] [--server URL] [--out DIR]
// Generates banks and tasks, runs each task as a conversation against the executor
// (an in-process server unless --server is given) and writes one JSON file per run.

import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { generateBank } from "../bank.ts";
import { createEnvServer } from "../server.ts";
import { buildTasks } from "../tasks.ts";
import { EnvClient } from "./env_client.ts";
import { DEFAULT_MODEL, readApiKey } from "./llm.ts";
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
mkdirSync(runDir, { recursive: true });
const tools = await EnvClient.tools(baseUrl!);

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
    for (const task of tasks) {
      total++;
      try {
        const result = await runTask(bank, task, {
          baseUrl: baseUrl!,
          apiKey,
          agentModel: values["agent-model"],
          userModel: values["user-model"],
          tools,
        });
        writeFileSync(join(runDir, `${task.id.replace(/:/g, "_")}.json`), JSON.stringify({ task, result }, null, 2) + "\n");
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
}
console.log(`${passed}/${total} passed; runs written to ${runDir}`);
