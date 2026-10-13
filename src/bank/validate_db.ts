// Database checks, in two kinds.
//
// Errors are broken bookkeeping no real bank database could have: a balance that is not the sum of
// its transactions, a transaction outside its account's life, a dangling id. Nothing may ever
// produce them, so they always fail.
//
// Findings are places where the history departs from the bank's own rules: a fee the waiver says
// should not have been charged, an account opened by a customer who was not eligible, courtesy
// reversals over the yearly cap. Tasks plant some of these on purpose, so the audit only reports
// them; whoever builds a database decides which ones it meant (see gen/tasks.ts).

import { addMonths, ageOn, monthOf, monthStart } from "../util/dates.ts";
import {
  courtesyReversalsInYear,
  endOfDayBalances,
  interestDue,
  meetsRequirements,
  monthlyFeeDue,
  transferLimited,
  transfersOutInMonth,
} from "./rules.ts";
import type { BankConfig } from "./schema.ts";
import type { Database } from "./state.ts";

export type Finding =
  | { kind: "wrong_fee"; account: string; month: string; dueCents: number; chargedCents: number }
  | { kind: "wrong_interest"; account: string; month: string; dueCents: number; paidCents: number }
  | { kind: "opened_while_ineligible"; account: string; productId: string }
  | { kind: "over_courtesy_cap"; customer: string; year: string; count: number; cap: number }
  | { kind: "negative_balance"; account: string }
  | { kind: "over_transfer_limit"; account: string; month: string; count: number; limit: number }
  | { kind: "underage_customer"; customer: string };

export function describeFinding(f: Finding): string {
  switch (f.kind) {
    case "wrong_fee":
      return `${f.account}: ${f.month} fee should be ${f.dueCents} cents, charged ${f.chargedCents}`;
    case "wrong_interest":
      return `${f.account}: ${f.month} interest should be ${f.dueCents} cents, paid ${f.paidCents}`;
    case "opened_while_ineligible":
      return `${f.account}: ${f.productId} opened by a customer who did not meet its requirements`;
    case "over_courtesy_cap":
      return `${f.customer}: ${f.count} courtesy reversals in ${f.year}, cap ${f.cap}`;
    case "negative_balance":
      return `${f.account}: balance goes negative`;
    case "over_transfer_limit":
      return `${f.account}: ${f.count} transfers out in ${f.month}, limit ${f.limit}`;
    case "underage_customer":
      return `${f.customer}: under 18`;
  }
}

export interface Audit {
  errors: string[];
  findings: Finding[];
}

export function auditDatabase(config: BankConfig, db: Database): Audit {
  const errors: string[] = [];
  const findings: Finding[] = [];
  const err = (msg: string) => errors.push(msg);
  const today = config.bank.simulatedDate;

  for (const [id, c] of Object.entries(db.customers)) {
    if (c.id !== id) err(`${id}: id field is ${c.id}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.dateOfBirth)) err(`${id}: date of birth is not an ISO date`);
    else if (ageOn(c.dateOfBirth, today) < 18) findings.push({ kind: "underage_customer", customer: id });
    if (!/^\d{4}$/.test(c.ssnLast4)) err(`${id}: bad SSN last four`);
  }

  const txnIds = new Set(db.transactions.map((t) => t.id));
  if (txnIds.size !== db.transactions.length) err("duplicate transaction ids");
  for (const t of db.transactions) {
    const account = db.accounts[t.accountId];
    if (!account) {
      err(`${t.id}: unknown account ${t.accountId}`);
      continue;
    }
    if (t.date < account.openedOn || t.date > today) err(`${t.id}: date ${t.date} outside account life`);
    if (t.relatedId !== undefined && !txnIds.has(t.relatedId)) err(`${t.id}: unknown related transaction`);
  }

  for (const [id, a] of Object.entries(db.accounts)) {
    if (a.id !== id) err(`${id}: id field is ${a.id}`);
    if (!db.customers[a.customerId]) err(`${id}: unknown customer ${a.customerId}`);
    const product = config.products[a.productId];
    if (!product) {
      err(`${id}: unknown product ${a.productId}`);
      continue;
    }
    if (a.openedOn > today) err(`${id}: opened after the simulated date`);

    const txns = db.transactions.filter((t) => t.accountId === id);
    const sum = txns.reduce((s, t) => s + t.amountCents, 0);
    if (sum !== a.balanceCents) err(`${id}: balance ${a.balanceCents} but transactions sum to ${sum}`);
    if (txns.length === 0) continue;

    const first = txns.reduce((m, t) => (t.date < m ? t.date : m), txns[0]!.date);
    if (Math.min(...endOfDayBalances(db, id, first, today)) < 0) findings.push({ kind: "negative_balance", account: id });

    // Every month covered by the history, from the account's opening or the first full month, should
    // be charged and paid exactly what the rules say.
    for (let month = monthOf(first); monthStart(addMonths(month, 1)) < today; month = addMonths(month, 1)) {
      if (monthStart(month) < first && first !== a.openedOn) continue;
      const due = monthlyFeeDue(config, db, a, month);
      const charged = -txns.filter((t) => t.kind === "monthly_fee" && t.feeMonth === month).reduce((s, t) => s + t.amountCents, 0);
      if (due !== charged) findings.push({ kind: "wrong_fee", account: id, month, dueCents: due, chargedCents: charged });
      const owed = interestDue(config, db, a, month);
      const paid = txns.filter((t) => t.kind === "interest" && t.interestMonth === month).reduce((s, t) => s + t.amountCents, 0);
      if (owed !== paid) findings.push({ kind: "wrong_interest", account: id, month, dueCents: owed, paidCents: paid });
    }

    if (transferLimited(config, a)) {
      const limit = config.policies.transferLimit!.perMonth;
      for (const month of new Set(txns.filter((t) => t.kind === "transfer_out").map((t) => t.date.slice(0, 7)))) {
        const count = transfersOutInMonth(db, id, month);
        if (count > limit) findings.push({ kind: "over_transfer_limit", account: id, month, count, limit });
      }
    }

    if (!meetsRequirements(config, db, a.customerId, product, a.openedOn)) {
      findings.push({ kind: "opened_while_ineligible", account: id, productId: a.productId });
    }
  }

  const ticketIds = new Set(db.tickets.map((t) => t.id));
  if (ticketIds.size !== db.tickets.length) err("duplicate ticket ids");
  for (const t of db.tickets) {
    if (!db.accounts[t.accountId]) err(`${t.id}: unknown account ${t.accountId}`);
    if (t.openedOn > today) err(`${t.id}: opened after the simulated date`);
  }

  const cap = config.policies.feeReversal.maxPerYear;
  const years = [...new Set(db.transactions.filter((t) => t.kind === "fee_reversal").map((t) => t.date.slice(0, 4)))].sort();
  for (const id of Object.keys(db.customers)) {
    for (const year of years) {
      const count = courtesyReversalsInYear(db, id, year);
      if (count > cap) findings.push({ kind: "over_courtesy_cap", customer: id, year, count, cap });
    }
  }
  return { errors, findings };
}

// Broken bookkeeping only. What the env server checks before accepting a database, since a task's
// database may hold planted findings.
export function validateDatabase(config: BankConfig, db: Database): string[] {
  return auditDatabase(config, db).errors;
}

// No errors and no findings: a database whose whole history followed the rules.
export function strictProblems(config: BankConfig, db: Database): string[] {
  const { errors, findings } = auditDatabase(config, db);
  return [...errors, ...findings.map(describeFinding)];
}
