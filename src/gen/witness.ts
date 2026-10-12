// Witnesses for the monthly fee waiver: a history that makes a product's waiver come out met or not
// met in chosen months, built from its conditions and then checked against the rules. Optionally
// a fee is charged in a month whose waiver was met (a planted mistake), a valid fee is reversed as a
// courtesy, and money moves after the last month so today's balance points the wrong way.

import { addDays, addMonths, monthEnd, monthOf, monthStart } from "../util/dates.ts";
import type { Rng } from "../util/rng.ts";
import { postTransaction } from "../bank/ledger.ts";
import { productsOf } from "../bank/products.ts";
import { evaluateWaiver, monthlyFeeDue } from "../bank/rules.ts";
import type { BankConfig, Product, WaiverCondition } from "../bank/schema.ts";
import type { Account, Customer, Database, Transaction } from "../bank/state.ts";
import type { Finding } from "../bank/validate_db.ts";
import { addAccount, chargeMonthlyFees } from "./fixtures.ts";

export interface MonthPlan {
  month: string; // YYYY-MM, oldest first, consecutive
  met: boolean; // whether the waiver is met in this month
  chargeAnyway?: boolean; // met, but charge the fee anyway: a planted wrong fee
  courtesy?: boolean; // not met: the valid fee is reversed as a courtesy soon after
}

export interface FeeHistory {
  account: Account;
  fees: Record<string, Transaction>; // the fee charged for each planned month that has one
  planted: Finding[];
  why: Record<string, string[]>; // per month: the conditions that were met
}

const isLocal = (c: WaiverCondition) => c.kind === "min_balance" || c.kind === "direct_deposit";

// Which conditions hold in each month: the customer-wide ones (senior, linked_account) are the same
// in every month, the account's own ones (balance, direct deposits) are chosen per month.
function assign(rng: Rng, product: Product, plans: MonthPlan[]): Map<WaiverCondition, boolean>[] {
  const { logic, conditions } = product.monthlyFee.waiver;
  const global = conditions.filter((c) => !isLocal(c));
  const local = conditions.filter(isLocal);
  if (conditions.length === 0 && plans.some((p) => p.met)) throw new Error("witness: this fee can never be waived");
  // "any" with a month not met needs every customer-wide condition false; "all" with a month met
  // needs them all true. Otherwise they are free.
  // When free, they take the only value that works if the account's own conditions can't help.
  const globalValue =
    logic === "any"
      ? plans.some((p) => !p.met) ? false : local.length === 0 || rng.bool()
      : plans.some((p) => p.met) ? true : local.length > 0 && rng.bool();
  const globalsHold = global.length > 0 && globalValue; // whether the customer-wide conditions alone count
  return plans.map((p) => {
    const truth = new Map<WaiverCondition, boolean>(global.map((c) => [c, globalValue]));
    const want = (v: boolean) => local.forEach((c) => truth.set(c, v));
    if (logic === "any") {
      want(false);
      if (p.met && !globalsHold) {
        if (local.length === 0) throw new Error("witness: no condition can be made true for this month");
        truth.set(rng.pick(local), true);
      }
    } else {
      want(true);
      // "all" fails if any condition fails: a false customer-wide one already does it.
      if (!p.met && (global.length === 0 || globalValue)) {
        if (local.length === 0) throw new Error("witness: no condition can be made false for this month");
        truth.set(rng.pick(local), false);
      }
    }
    return truth;
  });
}

// Writes `plans` onto a new account of `product` (which must have no opening requirements), opened in
// the month before the first plan so no earlier fee muddies the first planned month.
export function feeHistory(
  rng: Rng,
  config: BankConfig,
  db: Database,
  customer: Customer,
  product: Product,
  plans: MonthPlan[],
  after: "none" | "add" | "remove",
): FeeHistory {
  const today = config.bank.simulatedDate;
  if (product.requirements.length > 0) throw new Error("witness: products with requirements are not supported");
  if (product.monthlyFee.amount === 0) throw new Error("witness: product has no fee");
  const truths = assign(rng, product, plans);
  const first = plans[0]!.month;
  const last = plans.at(-1)!.month;
  if (monthStart(addMonths(last, 1)) >= today) throw new Error("witness: the last planned month has not been charged yet");

  // Customer-wide conditions.
  for (const c of product.monthlyFee.waiver.conditions) {
    const value = truths[0]!.get(c)!;
    if (c.kind === "senior") {
      const years = value ? c.minAge + rng.int(1, 15) : rng.int(25, c.minAge - 2);
      customer.dateOfBirth = addDays(monthEnd(last), -(years * 365 + Math.floor(years / 4) + rng.int(10, 300)));
    }
  }
  const openedOn = addDays(monthStart(addMonths(first, -1)), rng.int(1, 20));
  const linked = product.monthlyFee.waiver.conditions.some((c) => c.kind === "linked_account" && truths[0]!.get(c));
  let second: Account | null = null;
  if (linked) {
    const other = config.accountTypes.flatMap((t) => productsOf(config, t)).find((p) => p.id !== product.id && p.requirements.length === 0);
    if (!other) throw new Error("witness: no product to link");
    second = addAccount(db, customer, other.id, addDays(openedOn, -rng.int(10, 200)), rng.money(3000, 8000, 100) * 100);
  }

  // The account's own conditions: a start balance per month, set on the 1st, and direct deposits.
  const minBalance = product.monthlyFee.waiver.conditions.find((c) => c.kind === "min_balance");
  const directDeposit = product.monthlyFee.waiver.conditions.find((c) => c.kind === "direct_deposit");
  const account = addAccount(db, customer, product.id, openedOn, rng.money(500, 1500, 50) * 100);
  let balance = account.balanceCents; // ignoring fees and reversals, which come later
  const post = (date: string, cents: number, memo: string, kind: Transaction["kind"]) => {
    postTransaction(db, account, date, kind, cents, memo);
    balance += cents;
  };
  const move = (date: string, cents: number) => {
    if (cents > 0) post(date, cents, "Deposit", "deposit");
    if (cents < 0) post(date, cents, "Withdrawal", "card_purchase");
  };
  const why: Record<string, string[]> = {};
  plans.forEach((plan, i) => {
    const truth = truths[i]!;
    why[plan.month] = [...truth.entries()].filter(([, v]) => v).map(([c]) => c.kind);
    const start = monthStart(plan.month);
    let target = rng.money(800, 3000, 50) * 100;
    let dip: { day: number; cents: number } | null = null;
    if (minBalance && minBalance.kind === "min_balance") {
      const line = minBalance.amount * 100;
      if (truth.get(minBalance)) target = line + rng.money(500, 3000, 50) * 100;
      else if (minBalance.measure === "daily_minimum" && rng.bool()) {
        target = line + rng.money(500, 3000, 50) * 100; // usually above the line, but one dip below it
        dip = { day: rng.int(3, 24), cents: target - line + rng.money(100, 400, 50) * 100 };
      } else target = Math.max(40_000, Math.floor((line * rng.int(30, 60)) / 100 / 5000) * 5000);
      if (!truth.get(minBalance) && !dip && target >= line) throw new Error("witness: minimum balance line too low to stay under");
    }
    move(start, target - balance);
    if (dip) {
      move(addDays(start, dip.day - 1), -dip.cents);
      move(addDays(start, dip.day - 1 + rng.int(1, 3)), dip.cents);
    }
    if (directDeposit && directDeposit.kind === "direct_deposit" && truth.get(directDeposit)) {
      // Two paychecks, each paid straight out again the same day, so the balance plan is untouched.
      const each = Math.ceil(directDeposit.minMonthlyAmount / 2 / 50) * 50 + rng.money(0, 500, 50);
      for (const day of [1, 15]) {
        post(addDays(start, day - 1), each * 100, "Payroll direct deposit", "direct_deposit");
        post(addDays(start, day - 1), -each * 100, "Bill payment", "card_purchase");
      }
    }
  });

  // After the last planned month: money that makes today's balance tell the wrong story.
  const feeDay = monthStart(addMonths(last, 1));
  const latest = addDays(today, -1);
  if (after !== "none") {
    if (latest <= feeDay) throw new Error("witness: no day left after the fee for the later move");
    const day = addDays(feeDay, rng.int(1, Math.min(20, Math.round((Date.parse(latest) - Date.parse(feeDay)) / 864e5))));
    if (after === "add") move(day, rng.money(3000, 12000, 500) * 100);
    else move(day, -(balance - rng.money(800, 1500, 50) * 100)); // what is left still covers the fees
  }

  // Fees month by month, by the rules, with planted mistakes and courtesy reversals in date order.
  const fees: Record<string, Transaction> = {};
  const planted: Finding[] = [];
  for (let month = monthOf(account.openedOn); monthStart(addMonths(month, 1)) < today; month = addMonths(month, 1)) {
    const plan = plans.find((p) => p.month === month);
    const due = monthlyFeeDue(config, db, account, month);
    const charge = plan?.chargeAnyway ? product.monthlyFee.amount * 100 : due;
    if (charge === 0) continue;
    const date = monthStart(addMonths(month, 1));
    const fee = postTransaction(db, account, date, "monthly_fee", -charge, `Monthly fee for ${month}`, { feeMonth: month });
    if (plan) fees[month] = fee;
    if (plan?.chargeAnyway) planted.push({ kind: "wrong_fee", account: account.id, month, dueCents: due, chargedCents: charge });
    if (plan?.courtesy) {
      const when = addDays(date, rng.int(1, 5));
      if (when >= today || when.slice(0, 4) !== date.slice(0, 4)) throw new Error("witness: no room for the courtesy reversal");
      postTransaction(db, account, when, "fee_reversal", charge, "Courtesy reversal of monthly fee", { relatedId: fee.id });
    }
  }

  // The linked account's own fees last: its waiver may count the account above.
  if (second) chargeMonthlyFees(config, db, second, today);

  // The rules have the last word.
  for (const plan of plans) {
    const { waived } = evaluateWaiver(config, db, account, plan.month);
    if (waived !== plan.met) throw new Error(`witness: ${plan.month} waiver came out ${waived ? "met" : "not met"}`);
    if (!plan.met && !fees[plan.month]) throw new Error(`witness: no fee charged for ${plan.month}`);
  }
  return { account, fees, planted, why };
}
