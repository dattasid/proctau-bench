// Usage: npm run harness -- [--seed N] [--count K] [--template ID] [--tasks-per-bank T]
//          [--agent-model M] [--user-model M] [--server URL] [--out DIR]
//          [--customer llm|scripted] [--extract-samples N] [--wrong-identity-rate R]
// --wrong-identity-rate: share of tasks whose customer gives one identity detail wrong first (default 0.25).
// --tasks-per-bank: draw more task variants until each bank has T tasks (default: one per template).
// --template: one or more template ids, comma-separated; * matches anything (e.g. fee_*,open_account_eligible).
//   npm run harness -- --list-templates prints them.
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
import { TEMPLATES, buildTasks } from "../gen/tasks.ts";
import { DEFAULT_MODEL, readApiKey } from "./llm.ts";
import { agentSystemPrompt } from "./prompts.ts";
import { runTask } from "./run.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    count: { type: "string", default: "1" },
    template: { type: "string" },
    "list-templates": { type: "boolean", default: false },
    "tasks-per-bank": { type: "string" },
    customer: { type: "string", default: "llm" },
    "extract-samples": { type: "string", default: "1" },
    "wrong-identity-rate": { type: "string" },
    "agent-model": { type: "string", default: DEFAULT_MODEL },
    "user-model": { type: "string", default: DEFAULT_MODEL },
    server: { type: "string" },
    out: { type: "string", default: "out/runs" },
  },
});

if (values["list-templates"]) {
  console.log(TEMPLATES.map((t) => t.id).join("\n"));
  process.exit(0);
}
// Each pattern matches a whole template id; * stands for any run of characters.
const pattern = (p: string) => new RegExp(`^${p.trim().split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
const templateFilter = values.template ? values.template.split(",").map(pattern) : null;
if (templateFilter && !TEMPLATES.some((t) => templateFilter.some((re) => re.test(t.id)))) {
  console.error(`no template matches ${values.template}; known: ${TEMPLATES.map((t) => t.id).join(", ")}`);
  process.exit(1);
}

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
  customer: values.customer,
  extractSamples: Number(values["extract-samples"]),
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
    const wanted = values["tasks-per-bank"] ? Number(values["tasks-per-bank"]) : 0;
    const keep = (t: { template: string }) => !templateFilter || templateFilter.some((re) => re.test(t.template));
    const options = values["wrong-identity-rate"] ? { wrongIdentityRate: Number(values["wrong-identity-rate"]) } : {};
    let tasks = buildTasks(bank, 0, options).filter(keep);
    for (let variant = 1; tasks.length > 0 && tasks.length < wanted; variant++) tasks.push(...buildTasks(bank, variant, options).filter(keep));
    if (wanted > 0) tasks = tasks.slice(0, wanted);
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
          customer: values.customer === "scripted" ? "scripted" : "llm",
          extractSamples: Number(values["extract-samples"]),
        });
        writeJson(join(runDir, `${task.id.replace(/:/g, "_")}.json`), { task, result });
        const e = result.evaluation;
        if (e.pass) passed++;
        const issues = [
          e.dbMatch ? "" : "end state differs",
          ...e.violations.map((v) => `violated ${v.rule}`),
          ...e.blockedAttempts.map((v) => `blocked ${v.rule}`),
          ...e.missingCalls.map((t) => `never called ${t}`),
          ...(e.consentMissing ?? []).map((c) => `no consent before ${c.tool} (#${c.index})`),
        ].filter(Boolean);
        const verdict = e.endReason === "off_script" ? "OFF-SCRIPT" : e.pass ? "PASS" : "FAIL";
        console.log(`${verdict} ${task.id} (${e.endReason}, ${e.counts.calls} calls)${issues.length ? ": " + issues.join("; ") : ""}`);
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
