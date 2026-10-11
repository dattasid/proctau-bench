// REST wrapper around the executor. Clients create an environment from a config and a
// starting database; the server never sees tasks.
//
//   GET    /tools               tool definitions (JSON Schema)
//   POST   /envs                {config, db} -> {envId}
//   POST   /envs/:id/calls      {tool, args} -> {result, outcome, record}
//   GET    /envs/:id/state      {db, hash}
//   GET    /envs/:id/trace      {trace, notes, ended}
//   POST   /envs/:id/reset      back to the starting database, empty trace
//   DELETE /envs/:id

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { callTool, toolList } from "./executor.ts";
import { hashDatabase } from "./hash.ts";
import type { BankConfig } from "./schema.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";
import type { Database } from "./state.ts";
import { validateBank } from "./validate.ts";
import { validateDatabase } from "./validate_db.ts";

const MAX_BODY_BYTES = 50 * 1024 * 1024;

interface Env {
  config: BankConfig;
  startDb: Database;
  session: Session;
}

class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, { error: "body too large" });
    chunks.push(chunk as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, { error: "body must be a JSON object" });
  }
}

export function createEnvServer(): Server {
  const envs = new Map<string, Env>();

  const envFor = (id: string): Env => {
    const env = envs.get(id);
    if (!env) throw new HttpError(404, { error: `no environment ${id}` });
    return env;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts = new URL(req.url ?? "/", "http://localhost").pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && parts.length === 1 && parts[0] === "tools") return send(res, 200, toolList());

    if (parts[0] !== "envs") throw new HttpError(404, { error: "not found" });

    if (parts.length === 1 && method === "POST") {
      const body = await readJson(req);
      const config = body.config as BankConfig;
      const db = body.db as Database;
      if (!config || !db) throw new HttpError(400, { error: "body needs config and db" });
      const errors = validateBank(config);
      if (errors.length === 0) errors.push(...validateDatabase(config, db));
      if (errors.length > 0) throw new HttpError(400, { error: "invalid environment", errors });
      const envId = randomUUID();
      envs.set(envId, { config, startDb: structuredClone(db), session: createSession(config, db) });
      return send(res, 201, { envId });
    }

    const id = parts[1] ?? "";
    const action = parts[2];
    if (parts.length === 2 && method === "DELETE") {
      envFor(id);
      envs.delete(id);
      return send(res, 204);
    }
    const env = envFor(id);
    if (action === "calls" && method === "POST") {
      const body = await readJson(req);
      if (typeof body.tool !== "string") throw new HttpError(400, { error: "body needs tool" });
      const record = callTool(env.session, body.tool, body.args ?? {});
      return send(res, 200, { result: record.result, outcome: record.outcome, record });
    }
    if (action === "state" && method === "GET") return send(res, 200, { db: env.session.db, hash: hashDatabase(env.session.db) });
    if (action === "trace" && method === "GET") {
      const s = env.session;
      return send(res, 200, { trace: s.trace, notes: s.notes, ended: s.ended });
    }
    if (action === "reset" && method === "POST") {
      env.session = createSession(env.config, env.startDb);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, { error: "not found" });
  }

  return createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) send(res, e.status, e.body);
      else send(res, 500, { error: String(e) });
    });
  });
}
