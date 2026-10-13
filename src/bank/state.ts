// In-memory database the executor reads and changes. Plain JSON: a sorted-key
// dump hashes stably for tau2, and two snapshots diff cleanly for the trace.
// Money is integer cents here (the config uses dollars); dates are ISO YYYY-MM-DD.

import type { ProductId } from "./schema.ts";

export interface Customer {
  id: string;
  name: string;
  dateOfBirth: string;
  ssnLast4: string;
}

export interface Account {
  id: string;
  customerId: string;
  productId: ProductId;
  openedOn: string;
  status: "open" | "closed";
  balanceCents: number;
}

export type TransactionKind =
  | "balance_forward" // balance carried in from before the generated history
  | "opening_deposit"
  | "deposit"
  | "direct_deposit"
  | "card_purchase"
  | "transfer_in"
  | "transfer_out"
  | "monthly_fee"
  | "fee_correction" // refund of a fee charged although the waiver was met; never capped
  | "fee_reversal" // courtesy refund of a valid fee; counts toward the yearly cap
  | "interest"; // a month's interest, paid on the first day of the next month

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  kind: TransactionKind;
  amountCents: number; // signed: credits positive, debits negative
  memo: string;
  feeMonth?: string; // monthly_fee: the YYYY-MM month charged for
  interestMonth?: string; // interest: the YYYY-MM month paid for
  relatedId?: string; // refunds: the fee refunded; transfers: the other leg
}

// A request passed to a back-office team. Only structured fields, so a correct conversation always
// leaves the same database; the agent's free-text summary goes to the session notes.
export interface Ticket {
  id: string;
  accountId: string;
  openedOn: string;
  kind: "interest_discrepancy" | "closure_approval";
  month?: string; // interest_discrepancy: the YYYY-MM month whose interest was wrong
  expectedCents?: number; // interest_discrepancy: the interest that should have been paid
}

// Next sequential id such as txn_0042: one past the highest numeric suffix in use.
export function nextId(prefix: string, ids: Iterable<string>, width: number): string {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.slice(prefix.length + 1));
    if (id.startsWith(`${prefix}_`) && n > max) max = n;
  }
  return `${prefix}_${String(max + 1).padStart(width, "0")}`;
}

export interface Database {
  schemaVersion: 1;
  customers: Record<string, Customer>;
  accounts: Record<string, Account>;
  transactions: Transaction[];
  tickets: Ticket[];
}
