// Database coherence checks, re-deriving every fee and limit from the shared rules.

import { addMonths, ageOn, monthOf, monthStart } from "../util/dates.ts";
import { courtesyReversalsInYear, endOfDayBalances, monthlyFeeDue, premiumSavingsEligible } from "./rules.ts";
import { PRODUCT_IDS } from "./schema.ts";
import type { BankConfig } from "./schema.ts";
import type { Database } from "./state.ts";

export function validateDatabase(config: BankConfig, db: Database): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);
  const today = config.bank.simulatedDate;

  for (const [id, c] of Object.entries(db.customers)) {
    if (c.id !== id) err(`${id}: id field is ${c.id}`);
    if (ageOn(c.dateOfBirth, today) < 18) err(`${id}: under 18`);
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
    if (!PRODUCT_IDS.includes(a.productId)) err(`${id}: unknown product ${a.productId}`);
    if (a.openedOn > today) err(`${id}: opened after the simulated date`);

    const txns = db.transactions.filter((t) => t.accountId === id);
    const sum = txns.reduce((s, t) => s + t.amountCents, 0);
    if (sum !== a.balanceCents) err(`${id}: balance ${a.balanceCents} but transactions sum to ${sum}`);
    if (txns.length === 0) continue;

    const first = txns.reduce((m, t) => (t.date < m ? t.date : m), txns[0]!.date);
    if (Math.min(...endOfDayBalances(db, id, first, today)) < 0) err(`${id}: balance goes negative`);

    // Every month fully covered by the history must be charged exactly what the rules say.
    for (let month = monthOf(first); monthStart(addMonths(month, 1)) < today; month = addMonths(month, 1)) {
      if (monthStart(month) < first) continue;
      const due = monthlyFeeDue(config, db, a, month);
      const charged = -txns.filter((t) => t.kind === "monthly_fee" && t.feeMonth === month).reduce((s, t) => s + t.amountCents, 0);
      if (due !== charged) err(`${id}: ${month} fee should be ${due} cents, charged ${charged}`);
    }

    if (a.productId === "savings_premium" && !premiumSavingsEligible(config, db, a.customerId, a.openedOn)) {
      err(`${id}: premium savings opened by an ineligible customer`);
    }
  }

  const years = new Set(db.transactions.filter((t) => t.kind === "fee_reversal").map((t) => t.date.slice(0, 4)));
  for (const id of Object.keys(db.customers)) {
    for (const year of years) {
      if (courtesyReversalsInYear(db, id, year) > config.policies.feeReversal.maxPerYear) {
        err(`${id}: over the courtesy reversal cap in ${year}`);
      }
    }
  }
  return errors;
}
