// One conversation's environment: the bank config, its own copy of the database,
// the simulated clock, who is verified, and the trace. The executor never sees the task.

import type { BankConfig, Enforcement } from "./schema.ts";
import { nextId } from "./state.ts";
import type { Account, Database, Transaction, TransactionKind } from "./state.ts";

export interface Check {
  rule: string;
  // system: the operation is impossible (unknown id, insufficient funds) and always fails the call.
  // policy: a bank rule, blocked or let through according to its enforcement.
  kind: "system" | "policy";
  passed: boolean;
  detail: string;
  enforcement?: Enforcement; // policy checks only, filled in by the executor
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
  checks: Check[];
  outcome: Outcome;
  result: unknown; // exactly what the agent saw
  changes: Change[];
}

export interface Session {
  config: BankConfig;
  db: Database;
  now: string;
  // usedByWrite matters only under the before_every_write policy.
  verified: { customerId: string; usedByWrite: boolean } | null;
  notes: string[]; // interaction log entries; outside the database so they never affect scoring
  ended: boolean; // set by transfer_to_human
  trace: TraceRecord[];
}

export function createSession(config: BankConfig, db: Database): Session {
  return {
    config,
    db: structuredClone(db),
    now: config.bank.simulatedDate,
    verified: null,
    notes: [],
    ended: false,
    trace: [],
  };
}

export function postTransaction(
  db: Database,
  account: Account,
  date: string,
  kind: TransactionKind,
  amountCents: number,
  memo: string,
  extra: Partial<Transaction> = {},
): Transaction {
  const id = nextId("txn", db.transactions.map((t) => t.id), 4);
  const t: Transaction = { id, accountId: account.id, date, kind, amountCents, memo, ...extra };
  db.transactions.push(t);
  account.balanceCents += amountCents;
  return t;
}

export function transfer(db: Database, from: Account, to: Account, date: string, amountCents: number, kindIn: TransactionKind = "transfer_in"): Transaction {
  const out = postTransaction(db, from, date, "transfer_out", -amountCents, `Transfer to ${to.id}`);
  const into = postTransaction(db, to, date, kindIn, amountCents, `Transfer from ${from.id}`, { relatedId: out.id });
  out.relatedId = into.id;
  return into;
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
