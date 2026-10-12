// Background customers with a few months of history, simulated day by day so that
// every monthly fee in the history is exactly what the rules say. Task fixtures
// will add their own customers on top. Interest is not posted yet.

import { addDays, addMonths, daysBetween, monthOf, monthStart } from "../util/dates.ts";
import type { Rng } from "../util/rng.ts";
import { productsOf, tierRank } from "../bank/products.ts";
import { courtesyReversalsInYear, monthlyFeeDue } from "../bank/rules.ts";
import type { AccountType, BankConfig, Product } from "../bank/schema.ts";
import type { Account, Customer, Database, Transaction, TransactionKind } from "../bank/state.ts";
import { at, SPEC } from "./spec.ts";
import type { Spec } from "./spec.ts";

type Background = Spec["background"];
type Types = Spec["accountTypes"];
type Planned = Omit<Account, "id">;

interface Holder {
  customer: Customer;
  accounts: { account: Account; startCents: number }[];
  paycheckCents: number; // per direct deposit, on the pay days; 0 for none
}

function sampleCustomer(rng: Rng, BG: Background, id: string, name: string, today: string): Customer {
  return {
    id,
    name,
    dateOfBirth: addDays(today, -(rng.int(...BG.ageYears) * 365 + rng.int(0, 364))),
    ssnLast4: String(rng.int(0, 9999)).padStart(4, "0"),
  };
}

function startingBalanceCents(rng: Rng, BG: Background, types: Types, config: BankConfig, product: Product): number {
  const { min: floor, step } = BG.startingBalance;
  const min = Math.max(product.minOpeningDeposit, floor);
  const top = at(types[product.accountType]!.background.startingBalanceMax, tierRank(config, product.tier));
  return rng.money(min, Math.max(min, top), step) * 100;
}

// A product of `accountType` opened on `openedOn`, weighted by tier, among those whose
// requirements the customer's already planned accounts meet. Null if none qualifies.
function pickProduct(rng: Rng, types: Types, config: BankConfig, accountType: AccountType, openedOn: string, planned: Planned[]): Product | null {
  const qualifies = (p: Product) =>
    p.requirements.every((r) =>
      planned.some((a) => config.products[a.productId]!.accountType === r.accountType && daysBetween(a.openedOn, openedOn) >= r.minAgeDays),
    );
  const candidates = productsOf(config, accountType).filter(qualifies);
  if (candidates.length === 0) return null;
  const weights = candidates.map((p) => at(types[accountType]!.background.tierWeight, tierRank(config, p.tier)));
  let x = rng.next() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < candidates.length; i++) {
    x -= weights[i]!;
    if (x < 0) return candidates[i]!;
  }
  return candidates.at(-1)!;
}

function planAccounts(rng: Rng, BG: Background, types: Types, config: BankConfig, customerId: string, today: string): Planned[] {
  const planned: Planned[] = [];
  const plan = (accountType: AccountType) => {
    const openedOn = addDays(today, -rng.int(...BG.accountAgeDays));
    const product = pickProduct(rng, types, config, accountType, openedOn, planned);
    if (product) planned.push({ customerId, productId: product.id, openedOn, status: "open", balanceCents: 0 });
  };
  for (const t of config.accountTypes) {
    if ((t === BG.fallbackAccountType && planned.length === 0) || rng.bool(types[t]!.background.holdChance)) plan(t);
  }
  return planned;
}

export function sampleDatabase(rng: Rng, config: BankConfig, spec: Spec = SPEC): Database {
  const BG = spec.background;
  const types = spec.accountTypes;
  const today = config.bank.simulatedDate;
  const yesterday = addDays(today, -1);
  const historyStart = monthStart(addMonths(monthOf(today), -BG.historyMonths));
  const reversalCap = config.policies.feeReversal.maxPerYear;
  const db: Database = { schemaVersion: 1, customers: {}, accounts: {}, transactions: [] };
  const role = (a: Account) => types[config.products[a.productId]!.accountType]!.background;

  const holders: Holder[] = [];
  const names = new Set<string>();
  let accountCount = 0;
  for (let i = 1; i <= BG.customers; i++) {
    let name: string;
    do name = `${rng.pick(BG.firstNames)} ${rng.pick(BG.lastNames)}`;
    while (names.has(name));
    names.add(name);
    const customer = sampleCustomer(rng, BG, `cust_${String(i).padStart(2, "0")}`, name, today);
    db.customers[customer.id] = customer;
    const accounts = planAccounts(rng, BG, types, config, customer.id, today).map((plan) => {
      const account: Account = { id: `acct_${String(++accountCount).padStart(3, "0")}`, ...plan };
      db.accounts[account.id] = account;
      return { account, startCents: startingBalanceCents(rng, BG, types, config, config.products[account.productId]!) };
    });
    const hasPayroll = accounts.some((a) => role(a.account).payroll);
    holders.push({ customer, accounts, paycheckCents: hasPayroll && rng.bool(BG.paycheckChance) ? rng.money(...BG.paycheck) * 100 : 0 });
  }

  const balance = new Map<string, number>();
  let txnCount = 0;
  const post = (
    account: Account,
    date: string,
    kind: TransactionKind,
    amountCents: number,
    memo: string,
    extra: Partial<Transaction> = {},
  ): Transaction => {
    const t: Transaction = { id: `txn_${String(++txnCount).padStart(4, "0")}`, accountId: account.id, date, kind, amountCents, memo, ...extra };
    db.transactions.push(t);
    balance.set(account.id, (balance.get(account.id) ?? 0) + amountCents);
    return t;
  };
  const scheduled: { date: string; run: () => void }[] = [];

  for (let day = historyStart; day <= yesterday; day = addDays(day, 1)) {
    const dayOfMonth = Number(day.slice(8));

    // Charge last month's fees first, using the same rule the validator and executor use.
    if (dayOfMonth === 1 && day > historyStart) {
      const month = addMonths(monthOf(day), -1);
      for (const { account } of holders.flatMap((h) => h.accounts)) {
        const fee = monthlyFeeDue(config, db, account, month);
        if (fee === 0) continue;
        const charge = post(account, day, "monthly_fee", -fee, `Monthly fee for ${month}`, { feeMonth: month });
        if (rng.bool(BG.courtesyReversalChance)) {
          const when = addDays(day, rng.int(...BG.courtesyReversalDelayDays));
          scheduled.push({
            date: when,
            run: () => {
              if (courtesyReversalsInYear(db, account.customerId, when.slice(0, 4)) < reversalCap) {
                post(account, when, "fee_reversal", fee, "Courtesy reversal of monthly fee", { relatedId: charge.id });
              }
            },
          });
        }
      }
    }
    for (const job of scheduled.filter((j) => j.date === day)) job.run();

    for (const holder of holders) {
      for (const { account, startCents } of holder.accounts) {
        if (day === historyStart && account.openedOn < historyStart) {
          post(account, day, "balance_forward", startCents, "Balance brought forward");
        } else if (day === account.openedOn) {
          post(account, day, "opening_deposit", startCents, "Opening deposit");
        }
      }
      const open = holder.accounts.map((a) => a.account).filter((a) => a.openedOn <= day);
      const payroll = open.find((a) => role(a).payroll);
      const spending = open.find((a) => role(a).spending);
      const target = open.find((a) => role(a).receivesTransfers);

      if (payroll && holder.paycheckCents > 0 && (BG.payDays as readonly number[]).includes(dayOfMonth)) {
        post(payroll, day, "direct_deposit", holder.paycheckCents, "Payroll direct deposit");
      }
      if (holder.paycheckCents === 0 && open.length > 0 && rng.bool(BG.cashDepositChance)) {
        post(rng.pick(open), day, "deposit", rng.money(...BG.cashDeposit) * 100, "Cash deposit");
      }
      if (spending && rng.bool(BG.cardPurchaseChance)) {
        const max = Math.max(BG.cardPurchaseMaxCents, holder.paycheckCents / BG.cardPurchasePaycheckShare);
        const amount = rng.int(BG.cardPurchaseMinCents, max);
        if ((balance.get(spending.id) ?? 0) - amount >= BG.spendingFloorCents) {
          post(spending, day, "card_purchase", -amount, "Card purchase");
        }
      }
      if (spending && target && target !== spending && dayOfMonth === BG.transferDay && rng.bool(BG.transferChance)) {
        const amount = rng.money(...BG.transfer) * 100;
        if ((balance.get(spending.id) ?? 0) - amount >= BG.spendingFloorCents) {
          const out = post(spending, day, "transfer_out", -amount, `Transfer to ${target.id}`);
          const into = post(target, day, "transfer_in", amount, `Transfer from ${spending.id}`, { relatedId: out.id });
          out.relatedId = into.id;
        }
      }
    }
  }

  for (const account of Object.values(db.accounts)) account.balanceCents = balance.get(account.id) ?? 0;
  return db;
}
