// Read-only HTTP server for browsing harness output. A batch is any directory under the
// root that holds run files; nested directories are kept as they are on disk.
//
//   GET /                          the viewer page
//   GET /api/index                 every batch with its meta.json and a summary per run
//   GET /api/run?batch=B&file=F    one run file plus its bank snapshot (null if not saved)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import type { RunResult } from "../harness/run.ts";
import type { Task } from "../gen/tasks.ts";

const PAGE = new URL("./page.html", import.meta.url);
const RUN_FILE = /^[\w.-]+\.json$/;

export interface RunSummary {
  file: string;
  taskId: string;
  template: string;
  bankSeed: number;
  pass: boolean;
  dbMatch: boolean;
  violations: number;
  blocked: number;
  endReason: string;
  calls: number;
  turns: number;
}

export interface Batch {
  path: string; // relative to the root, "/" separated
  meta: Record<string, unknown> | null;
  runs: RunSummary[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarize(file: string, run: { task: Task; result: RunResult }): RunSummary {
  const { task, result } = run;
  const e = result.evaluation;
  return {
    file,
    taskId: task.id,
    template: task.template,
    bankSeed: task.bankSeed,
    pass: e.pass,
    dbMatch: e.dbMatch,
    violations: e.violations.length,
    blocked: e.blockedAttempts.length,
    endReason: e.endReason,
    calls: e.counts.calls,
    turns: result.turns.filter((t) => t.role !== "tool").length,
  };
}

export function createViewerServer(rootDir: string): Server {
  const root = resolve(rootDir);
  // Run files never change once written, so summaries are cached by path and mtime.
  const cache = new Map<string, { mtimeMs: number; summary: RunSummary | null }>();

  function summaryOf(path: string, file: string): RunSummary | null {
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.summary;
    let summary: RunSummary | null = null;
    try {
      summary = summarize(file, readJson(path) as { task: Task; result: RunResult });
    } catch {
      // Not a run file, or one still being written.
    }
    cache.set(path, { mtimeMs, summary });
    return summary;
  }

  function batches(): Batch[] {
    const out: Batch[] = [];
    const walk = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const runs: RunSummary[] = [];
      for (const e of entries) {
        if (e.isDirectory() && e.name !== "banks") walk(join(dir, e.name));
        else if (e.isFile() && e.name !== "meta.json" && RUN_FILE.test(e.name)) {
          const s = summaryOf(join(dir, e.name), e.name);
          if (s) runs.push(s);
        }
      }
      if (runs.length === 0) return;
      const metaPath = join(dir, "meta.json");
      out.push({
        path: relative(root, dir).split(sep).join("/") || ".",
        meta: existsSync(metaPath) ? (readJson(metaPath) as Record<string, unknown>) : null,
        runs: runs.sort((a, b) => a.bankSeed - b.bankSeed || a.taskId.localeCompare(b.taskId)),
      });
    };
    if (existsSync(root)) walk(root);
    return out.sort((a, b) => b.path.localeCompare(a.path)); // timestamped names: newest first
  }

  // Resolves a batch path from the client, refusing anything outside the root.
  function batchDir(batch: string): string {
    const dir = resolve(root, batch);
    if (dir !== root && !dir.startsWith(root + sep)) throw new Error("bad batch");
    return dir;
  }

  function run(batch: string, file: string): unknown {
    if (!RUN_FILE.test(file)) throw new Error("bad file");
    const dir = batchDir(batch);
    const data = readJson(join(dir, file)) as { task: Task; result: RunResult };
    const bankPath = join(dir, "banks", `${data.task.bankSeed}.json`);
    return { ...data, bank: existsSync(bankPath) ? readJson(bankPath) : null };
  }

  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET") return send(res, 405, "text/plain", "method not allowed");
      if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", readFileSync(PAGE, "utf8"));
      if (url.pathname === "/api/index") return send(res, 200, "application/json", JSON.stringify({ root, batches: batches() }));
      if (url.pathname === "/api/run") {
        const body = run(url.searchParams.get("batch") ?? "", url.searchParams.get("file") ?? "");
        return send(res, 200, "application/json", JSON.stringify(body));
      }
      send(res, 404, "text/plain", "not found");
    } catch (e) {
      send(res, 400, "application/json", JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
}
