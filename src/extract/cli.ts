// Runs the extractor over saved harness runs and writes a report. Offline: it reads the agent
// turns from run files, so it can be tried without running new conversations.
//
//   npm run extract -- [--dir scratch/runs] [--times 3] [--limit N] [--model M] [--out scratch/extract]

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { accountTypeName } from "../bank/products.ts";
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
      accountTypes: (config?.accountTypes ?? ["checking", "savings"]).map(accountTypeName),
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

  const report = todo.map((j, i) => {
    const r = results[i]!;
    const errors = [...new Set(r.samples.flatMap((s) => s.errors))];
    const dropped = [...new Set(r.samples.flatMap((s) => s.dropped))];
    return {
      run: j.run,
      turn: j.turn,
      text: j.text,
      identical: r.conflicts.length === 0 && r.omissions.length === 0 && errors.length === 0,
      decisionsAgree: r.decisionsAgree,
      conflicts: r.conflicts,
      omissions: r.omissions,
      errors,
      dropped,
      consensus: r.consensus.map(renderAct),
      samples: r.samples.map((s) => ({ acts: s.acts, rendered: s.acts.map(renderAct), errors: s.errors })),
    };
  });
  const outDir = join(arg("out", "scratch/extract"), new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));

  for (const r of report) {
    const mark = r.identical ? "same     " : r.decisionsAgree ? "facts    " : "DECISIONS";
    console.log(`\n${mark} ${r.run} turn ${r.turn}`);
    console.log(`  agent: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`);
    console.log(`  consensus:\n    ${r.consensus.join("\n    ")}`);
    for (const c of r.conflicts) console.log(`  conflict: ${c}`);
    for (const o of r.omissions) console.log(`  omitted by some: ${o}`);
    for (const e of r.errors) console.log(`  error in a sample: ${e}`);
    for (const d of r.dropped) console.log(`  dropped in a sample: ${d}`);
  }
  const count = (f: (r: (typeof report)[number]) => boolean) => report.filter(f).length;
  console.log(
    `\n${report.length} turns, ${times} samples each:` +
      `\n  identical samples: ${count((r) => r.identical)}` +
      `\n  same decisions (what the customer's reply depends on): ${count((r) => r.decisionsAgree)}` +
      `\n  a fact with conflicting values: ${count((r) => r.conflicts.length > 0)}` +
      `\n  a fact some samples missed: ${count((r) => r.omissions.length > 0)}` +
      `\n  validation errors: ${count((r) => r.errors.length > 0)}` +
      `\n  a number or date the agent never said, dropped: ${count((r) => r.dropped.length > 0)}` +
      `\n  an unknown act: ${count((r) => r.samples.some((s) => s.acts.some((a) => a.act === "unknown")))}`,
  );
  console.log(`report: ${join(outDir, "report.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
