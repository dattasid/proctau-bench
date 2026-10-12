// Runs the extractor over saved harness runs and writes a report. Offline: it reads the agent
// turns from run files, so it can be tried without running new conversations.
//
//   npm run extract -- [--dir scratch/runs] [--times 3] [--limit N] [--model M] [--out scratch/extract]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { BankConfig } from "../bank/schema.ts";
import type { RunResult } from "../harness/run.ts";
import { DEFAULT_MODEL, readApiKey } from "../harness/llm.ts";
import { extractRepeated, renderAct } from "./extract.ts";
import type { ExtractContext, TurnResult } from "./extract.ts";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

function runFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "banks" ? [] : runFiles(path);
    return name.endsWith(".json") && name !== "meta.json" ? [path] : [];
  });
}

// The bank saved next to a run, when the harness saved one.
function savedBank(runPath: string, seed: number): BankConfig | null {
  const path = join(dirname(runPath), "banks", `${seed}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { config: BankConfig }).config : null;
}

interface Job {
  run: string;
  turn: number;
  text: string;
  ctx: ExtractContext;
}

async function pool<T, R>(items: T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await work(items[i]!);
      }
    }),
  );
  return out;
}

async function main() {
  const dir = arg("dir", "scratch/runs");
  const times = Number(arg("times", "3"));
  const limit = Number(arg("limit", "0"));
  const model = arg("model", DEFAULT_MODEL);
  const apiKey = readApiKey();

  const jobs: Job[] = [];
  for (const path of runFiles(dir)) {
    const { task, result } = JSON.parse(readFileSync(path, "utf8")) as { task: { bankSeed: number }; result: RunResult };
    const config = savedBank(path, task.bankSeed);
    const ctx = (history: Job["ctx"]["history"]): ExtractContext => ({
      bankName: config?.bank.name,
      products: config ? Object.values(config.products).map((p) => p.displayName) : [],
      history,
    });
    const said = result.turns.filter((t): t is { role: "agent" | "user"; content: string } => t.role !== "tool");
    said.forEach((t, i) => {
      if (t.role === "agent") jobs.push({ run: relative(dir, path), turn: i, text: t.content, ctx: ctx(said.slice(Math.max(0, i - 6), i)) });
    });
  }
  const todo = limit > 0 ? jobs.slice(0, limit) : jobs;
  console.log(`${todo.length} agent turns from ${dir}, ${times} samples each, model ${model}`);

  const results: TurnResult[] = await pool(todo, 6, (j) => extractRepeated(apiKey, model, j.ctx, j.text, times));

  const report = todo.map((j, i) => ({
    run: j.run,
    turn: j.turn,
    text: j.text,
    agreed: results[i]!.agreed,
    consensus: results[i]!.consensus.map(renderAct),
    disputed: results[i]!.disputed.map(renderAct),
    samples: results[i]!.samples.map((s) => ({ acts: s.acts, rendered: s.acts.map(renderAct), errors: s.errors })),
  }));
  const outDir = join(arg("out", "scratch/extract"), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));

  for (const r of report) {
    console.log(`\n${r.agreed ? "agree   " : "DISAGREE"} ${r.run} turn ${r.turn}`);
    console.log(`  agent: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
    console.log(`  consensus:\n    ${r.consensus.join("\n    ")}`);
    if (r.disputed.length > 0) console.log(`  disputed (dropped):\n    ${r.disputed.join("\n    ")}`);
    for (const e of new Set(r.samples.flatMap((s) => s.errors))) console.log(`  error in a sample: ${e}`);
  }
  const agreed = report.filter((r) => r.agreed).length;
  const unknown = report.filter((r) => r.samples.some((s) => s.acts.some((a) => a.act === "unknown"))).length;
  const invalid = report.filter((r) => r.samples.some((s) => s.errors.length > 0)).length;
  const disputed = report.filter((r) => r.disputed.length > 0).length;
  console.log(
    `\n${agreed} of ${report.length} turns agree across ${times} samples; ${unknown} with an unknown act; ` +
      `${invalid} with validation errors; ${disputed} with an act dropped by the vote`,
  );
  console.log(`report: ${join(outDir, "report.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
