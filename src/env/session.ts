// One conversation's environment: the fake bank's session plus the trace the evaluator reads.
// The executor never sees the task.

import { createBankSession } from "../bankapi/session.ts";
import type { BankSession } from "../bankapi/session.ts";
import type { Check } from "../bankapi/tools.ts";
import type { BankConfig, Enforcement } from "../bank/schema.ts";
import type { Database } from "../bank/state.ts";

// A check as recorded in the trace: policy checks carry the enforcement the executor applied.
export interface RecordedCheck extends Check {
  enforcement?: Enforcement;
}

export interface Change {
  table: "customers" | "accounts" | "transactions";
  id: string;
  op: "add" | "update" | "remove";
  before?: unknown;
  after?: unknown;
}

export type Outcome = "invalid" | "error" | "blocked" | "executed";

export interface TraceRecord {
  index: number;
  at: string; // simulated date
  tool: string;
  args: unknown;
  shapeErrors: string[];
  checks: RecordedCheck[];
  outcome: Outcome;
  result: unknown; // exactly what the agent saw
  changes: Change[];
}

export interface Session extends BankSession {
  trace: TraceRecord[];
}

export function createSession(config: BankConfig, db: Database): Session {
  return { ...createBankSession(config, db), trace: [] };
}

function diffTable(table: Change["table"], before: Map<string, unknown>, after: Map<string, unknown>): Change[] {
  const changes: Change[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (b === undefined) changes.push({ table, id, op: "add", after: a });
    else if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ table, id, op: "update", before: b, after: a });
  }
  for (const [id, b] of before) if (!after.has(id)) changes.push({ table, id, op: "remove", before: b });
  return changes;
}

export function diffDatabases(before: Database, after: Database): Change[] {
  const records = <T>(r: Record<string, T>) => new Map<string, unknown>(Object.entries(r));
  const txns = (db: Database) => new Map<string, unknown>(db.transactions.map((t) => [t.id, t]));
  return [
    ...diffTable("customers", records(before.customers), records(after.customers)),
    ...diffTable("accounts", records(before.accounts), records(after.accounts)),
    ...diffTable("transactions", txns(before), txns(after)),
  ];
}
