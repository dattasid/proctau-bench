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
  | "fee_reversal"; // courtesy refund of a valid fee; counts toward the yearly cap

export interface Transaction {
  id: string;
  accountId: string;
  date: string;
  kind: TransactionKind;
  amountCents: number; // signed: credits positive, debits negative
  memo: string;
  feeMonth?: string; // monthly_fee: the YYYY-MM month charged for
  relatedId?: string; // refunds: the fee refunded; transfers: the other leg
}

export interface Database {
  schemaVersion: 1;
  customers: Record<string, Customer>;
  accounts: Record<string, Account>;
  transactions: Transaction[];
}
