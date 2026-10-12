// Posting money movements to the database. Every write that changes a balance goes through here.

import { nextId } from "./state.ts";
import type { Account, Database, Transaction, TransactionKind } from "./state.ts";

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
