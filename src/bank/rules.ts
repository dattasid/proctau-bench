// Rule evaluation shared by the database generator, its validator, the documents'
// worked examples and (next) the executor, so every layer agrees on what a rule means.

import { addDays, ageOn, daysBetween, monthEnd, monthStart } from "../util/dates.ts";
import type { BankConfig, Interest, InterestBonus, InterestMethod, Product, Requirement, WaiverCondition } from "./schema.ts";
import type { Account, Database, Transaction } from "./state.ts";

const byDate = (a: Transaction, b: Transaction): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

export function endOfDayBalances(db: Database, accountId: string, from: string, to: string): number[] {
  const txns = db.transactions.filter((t) => t.accountId === accountId && t.date <= to).sort(byDate);
  const balances: number[] = [];
  let balance = 0;
  let i = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    while (i < txns.length && txns[i]!.date <= day) balance += txns[i++]!.amountCents;
    balances.push(balance);
  }
  return balances;
}

// A month is charged only if the account was open on its first day.
export function isFullMonth(account: Account, month: string): boolean {
  return account.openedOn <= monthStart(month);
}

export interface ConditionResult {
  condition: WaiverCondition;
  met: boolean;
  observed: number; // cents for balances and deposits, years for age, 1/0 for a linked account
}

// Whether one waiver condition held for `month` (YYYY-MM), with the value it was judged on, so a
// trace or a refund check can show why a fee was or wasn't waived.
function evaluateCondition(db: Database, account: Account, month: string, c: WaiverCondition): ConditionResult {
  const start = monthStart(month);
  const end = monthEnd(month);
  switch (c.kind) {
    case "min_balance": {
      // End-of-day balances for every day of the month: daily_minimum takes the lowest day,
      // monthly_average the mean of all days. Only full months are charged, so every day counts.
      const balances = endOfDayBalances(db, account.id, start, end);
      const observed =
        c.measure === "daily_minimum" ? Math.min(...balances) : balances.reduce((s, b) => s + b, 0) / balances.length;
      return { condition: c, met: observed >= c.amount * 100, observed: Math.floor(observed) };
    }
    case "direct_deposit": {
      // Direct deposits into this account during the month; deposits to the customer's other
      // accounts do not count.
      const observed = db.transactions
        .filter((t) => t.accountId === account.id && t.kind === "direct_deposit" && t.date >= start && t.date <= end)
        .reduce((s, t) => s + t.amountCents, 0);
      return { condition: c, met: observed >= c.minMonthlyAmount * 100, observed };
    }
    case "linked_account": {
      // Any other open account of the same customer, of any type, opened by the month's last day,
      // so one opened mid-month counts for the whole month. Status is today's, not the month's:
      // an account closed since then no longer counts.
      const linked = Object.values(db.accounts).some(
        (a) => a.id !== account.id && a.customerId === account.customerId && a.status === "open" && a.openedOn <= end,
      );
      return { condition: c, met: linked, observed: linked ? 1 : 0 };
    }
    case "senior": {
      // Age on the month's last day, so a birthday during the month counts.
      const age = ageOn(db.customers[account.customerId]!.dateOfBirth, end);
      return { condition: c, met: age >= c.minAge, observed: age };
    }
  }
}

// Whether `month`'s fee is waived. Every condition is evaluated, not just until the answer is known,
// so the results show each one. "any": one met condition waives; "all": every one must be met.
// No conditions: never waived.
export function evaluateWaiver(
  config: BankConfig,
  db: Database,
  account: Account,
  month: string,
): { waived: boolean; results: ConditionResult[] } {
  const { logic, conditions } = config.products[account.productId].monthlyFee.waiver;
  const results = conditions.map((c) => evaluateCondition(db, account, month, c));
  const waived = results.length > 0 && (logic === "any" ? results.some((r) => r.met) : results.every((r) => r.met));
  return { waived, results };
}

// Fee in cents owed for `month`. It is charged on the first day of the next month.
export function monthlyFeeDue(config: BankConfig, db: Database, account: Account, month: string): number {
  const fee = config.products[account.productId].monthlyFee.amount;
  if (fee === 0 || !isFullMonth(account, month)) return 0;
  return evaluateWaiver(config, db, account, month).waived ? 0 : fee * 100;
}

// Transfers out of one account in a calendar month (YYYY-MM), for the monthly transfer limit.
export function transfersOutInMonth(db: Database, accountId: string, month: string): number {
  return db.transactions.filter((t) => t.accountId === accountId && t.kind === "transfer_out" && t.date.startsWith(month)).length;
}

// Whether transfers out of this account count against the bank's monthly limit.
export function transferLimited(config: BankConfig, account: Account): boolean {
  const limit = config.policies.transferLimit;
  return !!limit && limit.accountTypes.includes(config.products[account.productId]!.accountType);
}

// Courtesy reversals count per customer, across all their accounts, per calendar year.
export function courtesyReversalsInYear(db: Database, customerId: string, year: string): number {
  const owned = new Set(Object.values(db.accounts).filter((a) => a.customerId === customerId).map((a) => a.id));
  return db.transactions.filter((t) => t.kind === "fee_reversal" && owned.has(t.accountId) && t.date.startsWith(year))
    .length;
}

// Whether an account of `productId` is the kind of account `r` asks for, regardless of its age.
export function requirementMatches(config: BankConfig, productId: string, r: Requirement): boolean {
  switch (r.kind) {
    case "holds_account":
      return config.products[productId]?.accountType === r.accountType;
    case "holds_product":
      return productId === r.productId;
  }
}

// Whether the customer holds an open account that `r` asks for, opened at least minAgeDays before
// `onDate`. A closed account never qualifies, however long it was held.
export function requirementMet(config: BankConfig, db: Database, customerId: string, r: Requirement, onDate: string): boolean {
  return Object.values(db.accounts).some(
    (a) =>
      a.customerId === customerId &&
      a.status === "open" &&
      requirementMatches(config, a.productId, r) &&
      daysBetween(a.openedOn, onDate) >= r.minAgeDays,
  );
}

// Whether the customer may open `product` on `onDate`.
export function meetsRequirements(config: BankConfig, db: Database, customerId: string, product: Product, onDate: string): boolean {
  return product.requirements.every((r) => requirementMet(config, db, customerId, r, onDate));
}

export function lowestApy(interest: Interest): number {
  if (interest.structure === "none") return 0;
  if (interest.structure === "flat") return interest.apy;
  return interest.tiers[0]!.apy;
}

export function highestApy(interest: Interest): number {
  if (interest.structure === "none") return 0;
  if (interest.structure === "flat") return interest.apy;
  return interest.tiers.at(-1)!.apy;
}

// A year's interest in cents at a constant balance, unrounded. A negative balance earns nothing.
function yearlyInterest(interest: Interest, balanceCents: number, apyBoost: number): number {
  const balance = Math.max(0, balanceCents);
  if (interest.structure === "none") return 0;
  if (interest.structure === "flat") return (balance * (interest.apy + apyBoost)) / 100;
  const tiers = interest.tiers;
  if (interest.appliesTo === "whole_balance") {
    const tier = tiers.filter((t) => t.minBalance * 100 <= balance).at(-1)!;
    return (balance * (tier.apy + apyBoost)) / 100;
  }
  let total = 0;
  tiers.forEach((tier, i) => {
    const lo = tier.minBalance * 100;
    const hi = i + 1 < tiers.length ? tiers[i + 1]!.minBalance * 100 : Infinity;
    total += (Math.max(0, Math.min(balance, hi) - lo) * (tier.apy + apyBoost)) / 100;
  });
  return total;
}

// A year's interest at a constant balance. This is the quote the agent is expected to give.
export function annualInterestCents(interest: Interest, balanceCents: number, apyBoost = 0): number {
  return Math.round(yearlyInterest(interest, balanceCents, apyBoost));
}

// Whether the customer earned bonus `b` on `account` in `month` (YYYY-MM). Status is today's, as for
// the linked-account waiver.
export function bonusEarned(config: BankConfig, db: Database, account: Account, month: string, b: InterestBonus): boolean {
  const start = monthStart(month);
  const end = monthEnd(month);
  const mine = Object.values(db.accounts).filter((a) => a.customerId === account.customerId);
  if (b.trigger === "direct_deposit") {
    const ids = new Set(mine.map((a) => a.id));
    return db.transactions.some((t) => t.kind === "direct_deposit" && ids.has(t.accountId) && t.date >= start && t.date <= end);
  }
  return mine.some(
    (a) => a.id !== account.id && a.status === "open" && a.openedOn <= end && config.products[a.productId]?.accountType === b.accountType,
  );
}

// The extra APY earned on `account` in `month`: the sum of the bonuses earned.
export function bonusBoost(config: BankConfig, db: Database, account: Account, month: string): number {
  return config.products[account.productId]!.bonuses.filter((b) => bonusEarned(config, db, account, month, b)).reduce((s, b) => s + b.apyBoost, 0);
}

export interface InterestResult {
  cents: number;
  balanceCents: number | null; // the balance the method used; null for daily_accrual, which uses every day's
}

// A month's interest on `account` by `method`, with `apyBoost` added to every rate, rounded to the
// cent once at the end. Days before the account was opened count as a zero balance.
export function interestForMonth(config: BankConfig, db: Database, account: Account, month: string, method: InterestMethod, apyBoost: number): InterestResult {
  const interest = config.products[account.productId]!.interest;
  const balances = endOfDayBalances(db, account.id, monthStart(month), monthEnd(month));
  const monthly = (balance: number): InterestResult => ({
    cents: Math.round(yearlyInterest(interest, balance, apyBoost) / 12),
    balanceCents: Math.round(balance),
  });
  switch (method) {
    case "average_daily_balance":
      return monthly(balances.reduce((s, b) => s + b, 0) / balances.length);
    case "daily_accrual":
      return { cents: Math.round(balances.reduce((s, b) => s + yearlyInterest(interest, b, apyBoost) / 365, 0)), balanceCents: null };
    case "minimum_daily_balance":
      return monthly(Math.min(...balances));
    case "month_end_balance":
      return monthly(balances.at(-1)!);
    case "month_start_balance": {
      const before = addDays(monthStart(month), -1);
      return monthly(endOfDayBalances(db, account.id, before, before)[0]!);
    }
  }
}

// Interest in cents owed for `month` by the bank's own method and bonus rules. It is paid on the
// first day of the next month.
export function interestDue(config: BankConfig, db: Database, account: Account, month: string): number {
  return interestForMonth(config, db, account, month, config.policies.interestMethod, bonusBoost(config, db, account, month)).cents;
}
