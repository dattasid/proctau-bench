// Histories for interest tasks: an interest-bearing account whose payment for one month comes out
// right or planted wrong, with the facts that decide its bonus that month, then checked against the
// rules. Bonus not earned that month is made to look earned from today's view: direct deposits in
// the months around it, or the linked account opened just after it.

import { addDays, addMonths, daysBetween, monthEnd, monthOf, monthStart } from "../util/dates.ts";
import type { Rng } from "../util/rng.ts";
import { postTransaction, transfer } from "../bank/ledger.ts";
import { productsOf } from "../bank/products.ts";
import { bonusBoost, bonusEarned, interestDue, interestForMonth } from "../bank/rules.ts";
import type { BankConfig, InterestBonus, Product } from "../bank/schema.ts";
import type { Account, Customer, Database, Transaction } from "../bank/state.ts";
import type { Finding } from "../bank/validate_db.ts";
import { addAccount, postMonthly } from "./fixtures.ts";

// none: paid what was due. no_bonus: paid without the bonus that was earned. month_end: paid on the
// month-end balance after money left late in the month, instead of by the bank's method.
export type InterestPlant = "none" | "no_bonus" | "month_end";

export interface InterestHistory {
  account: Account;
  payment: Transaction; // the interest paid for the month
  dueCents: number;
  withBonusCents: number; // what the month would pay with the bonus, earned or not
  bonus: InterestBonus | null;
  bonusEarned: boolean;
  planted: Finding[];
}

// A requirement-free product of `accountType` other than `not`.
const plainOf = (config: BankConfig, accountType: string, not: Product) =>
  productsOf(config, accountType).find((p) => p.requirements.length === 0 && p.id !== not.id) ?? null;

// Whether the history can be built for `product`: it pays interest, can be opened directly, and its
// bonus (if any) can be earned with an account the customer can open directly.
export function interestHistoryFits(config: BankConfig, product: Product): boolean {
  if (product.interest.structure === "none" || product.requirements.length > 0) return false;
  if (!plainOf(config, config.accountTypes[0]!, product)) return false;
  const b = product.bonuses[0];
  return !b || b.trigger === "direct_deposit" || !!plainOf(config, b.accountType, product);
}

// Writes the history onto a new account of `product` opened in the month before `month`. With a bonus
// on the product, `earn` says whether it is earned in `month`.
export function interestHistory(
  rng: Rng,
  config: BankConfig,
  db: Database,
  customer: Customer,
  product: Product,
  month: string,
  earn: boolean,
  plant: InterestPlant,
): InterestHistory {
  const today = config.bank.simulatedDate;
  if (!interestHistoryFits(config, product)) throw new Error("interest history: product does not fit");
  if (monthStart(addMonths(month, 1)) >= today) throw new Error("interest history: the month has not been paid yet");
  const bonus = product.bonuses[0] ?? null;
  if (plant === "no_bonus" && (!bonus || !earn)) throw new Error("interest history: no earned bonus to leave out");
  const start = monthStart(month);
  const end = monthEnd(month);

  // The linked account, when the bonus needs one: held well before the month ends when earned,
  // opened just after it when not.
  const linkedType = bonus?.trigger === "linked_account" ? bonus.accountType : null;
  const openLinked = (): string => {
    if (earn) return addDays(start, -rng.int(30, 300));
    const room = daysBetween(end, today) - 1;
    if (room < 1) throw new Error("interest history: no day for the linked account");
    return addDays(end, rng.int(1, Math.min(10, room)));
  };
  // An everyday account: paychecks land here and money moves here. It is the linked account too when
  // the bonus asks for its type.
  const everydayProduct = plainOf(config, config.accountTypes[0]!, product)!;
  const everydayIsLinked = linkedType === everydayProduct.accountType;
  const everyday = addAccount(db, customer, everydayProduct.id, everydayIsLinked ? openLinked() : addDays(start, -rng.int(120, 600)), rng.money(2000, 6000, 100) * 100);
  const accounts = [everyday];
  if (linkedType && !everydayIsLinked) {
    accounts.push(addAccount(db, customer, plainOf(config, linkedType, product)!.id, openLinked(), rng.money(1000, 4000, 100) * 100));
  }
  if (plant === "month_end" && everyday.openedOn > end) throw new Error("interest history: nowhere to move money in the month");

  // Large enough that the bonus is worth at least a dollar or two a month.
  const boost = bonus?.apyBoost ?? 0;
  const floor = boost > 0 ? Math.ceil(2400 / boost / 500) * 500 : 0;
  const balance = Math.max(rng.money(8000, 40000, 500), floor);
  const account = addAccount(db, customer, product.id, addDays(monthStart(addMonths(month, -1)), rng.int(0, 20)), balance * 100);

  // Paychecks on the 1st and 15th of every month from the account's opening to today, except the
  // month itself when the direct deposit bonus is not earned.
  const paycheck = rng.money(1200, 3000, 50) * 100;
  for (let m = monthOf(account.openedOn); monthStart(m) < today; m = addMonths(m, 1)) {
    if (m === month && bonus?.trigger === "direct_deposit" && !earn) continue;
    for (const day of [1, 15]) {
      const date = addDays(monthStart(m), day - 1);
      if (date >= today || date < everyday.openedOn) continue;
      postTransaction(db, everyday, date, "direct_deposit", paycheck, "Payroll direct deposit");
    }
  }

  // Money leaves late in the month, so the month-end balance is far below the average.
  if (plant === "month_end") {
    const day = addDays(end, -rng.int(1, 4));
    transfer(db, account, everyday, day, Math.floor((balance * rng.int(50, 80)) / 100 / 50) * 50 * 100);
  }

  for (const a of accounts) postMonthly(config, db, a, today);
  const paid = (m: string, due: number): number => {
    if (m !== month || plant === "none") return due;
    if (plant === "no_bonus") return interestForMonth(config, db, account, m, config.policies.interestMethod, 0).cents;
    return interestForMonth(config, db, account, m, "month_end_balance", bonusBoost(config, db, account, m)).cents;
  };
  postMonthly(config, db, account, today, paid);

  // The rules have the last word.
  const dueCents = interestDue(config, db, account, month);
  const payment = db.transactions.find((t) => t.accountId === account.id && t.kind === "interest" && t.interestMonth === month);
  if (!payment) throw new Error("interest history: no interest paid for the month");
  const earned = bonus ? bonusEarned(config, db, account, month, bonus) : false;
  if (bonus && earned !== earn) throw new Error(`interest history: bonus came out ${earned ? "earned" : "not earned"}`);
  const withBonusCents = interestForMonth(config, db, account, month, config.policies.interestMethod, boost).cents;
  const planted: Finding[] = [];
  if (plant === "none") {
    if (payment.amountCents !== dueCents) throw new Error("interest history: payment differs from what was due");
  } else if (payment.amountCents !== dueCents) {
    // How short is the caller's call; an equal payment plants nothing.
    planted.push({ kind: "wrong_interest", account: account.id, month, dueCents, paidCents: payment.amountCents });
  }
  return { account, payment, dueCents, withBonusCents, bonus, bonusEarned: earned, planted };
}
