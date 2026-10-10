// Building blocks for placing specific customers into a database: the start of the
// task fixture builder. Each helper writes records consistent with the shared rules.

import { postTransaction } from "./session.ts";
import type { ProductId } from "./schema.ts";
import { nextId } from "./state.ts";
import type { Account, Customer, Database, Transaction, TransactionKind } from "./state.ts";

export function emptyDatabase(): Database {
  return { schemaVersion: 1, customers: {}, accounts: {}, transactions: [] };
}

export function addCustomer(db: Database, fields: Omit<Customer, "id">): Customer {
  const customer = { id: nextId("cust", Object.keys(db.customers), 2), ...fields };
  db.customers[customer.id] = customer;
  return customer;
}

// Opens an account on `openedOn` with an opening deposit of `balanceCents`.
export function addAccount(db: Database, customer: Customer, productId: ProductId, openedOn: string, balanceCents: number): Account {
  const account: Account = {
    id: nextId("acct", Object.keys(db.accounts), 3),
    customerId: customer.id,
    productId,
    openedOn,
    status: "open",
    balanceCents: 0,
  };
  db.accounts[account.id] = account;
  postTransaction(db, account, openedOn, "opening_deposit", balanceCents, "Opening deposit");
  return account;
}

export function addTransaction(
  db: Database,
  account: Account,
  date: string,
  kind: TransactionKind,
  amountCents: number,
  memo: string,
  extra: Partial<Transaction> = {},
): Transaction {
  return postTransaction(db, account, date, kind, amountCents, memo, extra);
}
