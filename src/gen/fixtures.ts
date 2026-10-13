// Building blocks for placing specific customers into a database: the start of the
// task fixture builder. Each helper writes records consistent with the shared rules.

import { addMonths, monthOf, monthStart } from "../util/dates.ts";
import { postTransaction } from "../bank/ledger.ts";
import { interestDue, monthlyFeeDue } from "../bank/rules.ts";
import type { BankConfig, ProductId } from "../bank/schema.ts";
import { nextId } from "../bank/state.ts";
import type { Account, Customer, Database, Transaction, TransactionKind } from "../bank/state.ts";

export function emptyDatabase(): Database {
  return { schemaVersion: 1, customers: {}, accounts: {}, transactions: [], tickets: [] };
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

// A month's interest payment, on the first day of the next month. Nothing is posted for zero.
export function payInterest(db: Database, account: Account, month: string, cents: number): Transaction | null {
  if (cents === 0) return null;
  return postTransaction(db, account, monthStart(addMonths(month, 1)), "interest", cents, `Interest for ${month}`, { interestMonth: month });
}

// Posts every month's interest and then its fee, as the rules require, between the account's opening
// and `today`, oldest first, so a fixture account's history is as consistent as a generated one.
// Call it after the account's other history is in place. `interest` replaces the interest paid for
// a month, to plant a wrong payment.
export function postMonthly(
  config: BankConfig,
  db: Database,
  account: Account,
  today: string,
  interest: (month: string, dueCents: number) => number = (_, due) => due,
): void {
  for (let month = monthOf(account.openedOn); monthStart(addMonths(month, 1)) < today; month = addMonths(month, 1)) {
    payInterest(db, account, month, interest(month, interestDue(config, db, account, month)));
    const fee = monthlyFeeDue(config, db, account, month);
    if (fee > 0) postTransaction(db, account, monthStart(addMonths(month, 1)), "monthly_fee", -fee, `Monthly fee for ${month}`, { feeMonth: month });
  }
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
