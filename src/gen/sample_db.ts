// Background customers with a few months of history, simulated day by day so that
// every monthly fee in the history is exactly what the rules say. Task fixtures
// will add their own customers on top. Interest is not posted yet.

import { addDays, addMonths, daysBetween, monthOf, monthStart } from "../util/dates.ts";
import type { Rng } from "../util/rng.ts";
import { courtesyReversalsInYear, monthlyFeeDue } from "../bank/rules.ts";
import type { BankConfig, ProductId } from "../bank/schema.ts";
import type { Account, Customer, Database, Transaction, TransactionKind } from "../bank/state.ts";

const FIRST_NAMES = [
  "Maria", "James", "Aisha", "Daniel", "Priya", "Thomas", "Elena", "Kwame", "Sofia", "Hiroshi",
  "Grace", "Mateo", "Nadia", "Owen", "Leila", "Samuel", "Ingrid", "Ravi", "Chloe", "Marcus",
];
const LAST_NAMES = [
  "Chen", "Okafor", "Garcia", "Novak", "Patel", "Brennan", "Haddad", "Kim", "Lindqvist", "Mensah",
  "Rossi", "Tanaka", "Dubois", "Alvarez", "Kowalski", "Nguyen", "Abara", "Fischer", "Reyes", "Walsh",
];

const HISTORY_MONTHS = 3;
// Card spending never takes an account below this, so later fees cannot overdraw it.
const SPENDING_FLOOR_CENTS = 10_000;

interface Holder {
  customer: Customer;
  accounts: { account: Account; startCents: number }[];
  paycheckCents: number; // per direct deposit, on the 1st and 15th; 0 for none
}

function sampleCustomer(rng: Rng, id: string, name: string, today: string): Customer {
  return {
    id,
    name,
    dateOfBirth: addDays(today, -(rng.int(21, 85) * 365 + rng.int(0, 364))),
    ssnLast4: String(rng.int(0, 9999)).padStart(4, "0"),
  };
}

function startingBalanceCents(rng: Rng, config: BankConfig, productId: ProductId): number {
  const min = Math.max(config.products[productId].minOpeningDeposit, 50);
  const max = { checking_basic: 4000, checking_premium: 30000, savings_basic: 15000, savings_premium: 60000 }[productId];
  return rng.money(min, Math.max(min, max), 50) * 100;
}

function planAccounts(rng: Rng, config: BankConfig, customerId: string, today: string): Omit<Account, "id">[] {
  const openedOn = () => addDays(today, -rng.int(10, 1500));
  const planned: Omit<Account, "id">[] = [];
  const hasChecking = rng.bool(0.85);
  let checkingOpened: string | null = null;
  if (hasChecking) {
    checkingOpened = openedOn();
    const productId: ProductId = rng.bool(0.3) ? "checking_premium" : "checking_basic";
    planned.push({ customerId, productId, openedOn: checkingOpened, status: "open", balanceCents: 0 });
  }
  if (!hasChecking || rng.bool(0.6)) {
    const savingsOpened = openedOn();
    const rule = config.policies.premiumSavingsEligibility;
    const eligible =
      !rule.requiresChecking ||
      (checkingOpened !== null && daysBetween(checkingOpened, savingsOpened) >= rule.minCheckingAgeDays);
    const productId: ProductId = eligible && rng.bool(0.35) ? "savings_premium" : "savings_basic";
    planned.push({ customerId, productId, openedOn: savingsOpened, status: "open", balanceCents: 0 });
  }
  return planned;
}

export function sampleDatabase(rng: Rng, config: BankConfig, customerCount = 6): Database {
  const today = config.bank.simulatedDate;
  const yesterday = addDays(today, -1);
  const historyStart = monthStart(addMonths(monthOf(today), -HISTORY_MONTHS));
  const reversalCap = config.policies.feeReversal.maxPerYear;
  const db: Database = { schemaVersion: 1, customers: {}, accounts: {}, transactions: [] };

  const holders: Holder[] = [];
  const names = new Set<string>();
  let accountCount = 0;
  for (let i = 1; i <= customerCount; i++) {
    let name: string;
    do name = `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`;
    while (names.has(name));
    names.add(name);
    const customer = sampleCustomer(rng, `cust_${String(i).padStart(2, "0")}`, name, today);
    db.customers[customer.id] = customer;
    const accounts = planAccounts(rng, config, customer.id, today).map((plan) => {
      const account: Account = { id: `acct_${String(++accountCount).padStart(3, "0")}`, ...plan };
      db.accounts[account.id] = account;
      return { account, startCents: startingBalanceCents(rng, config, account.productId) };
    });
    const hasChecking = accounts.some((a) => a.account.productId.startsWith("checking"));
    holders.push({ customer, accounts, paycheckCents: hasChecking && rng.bool(0.7) ? rng.money(600, 3000, 50) * 100 : 0 });
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
        if (rng.bool(0.15)) {
          const when = addDays(day, rng.int(1, 10));
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
      const checking = open.find((a) => a.productId.startsWith("checking"));
      const savings = open.find((a) => a.productId.startsWith("savings"));

      if (checking && holder.paycheckCents > 0 && (dayOfMonth === 1 || dayOfMonth === 15)) {
        post(checking, day, "direct_deposit", holder.paycheckCents, "Payroll direct deposit");
      }
      if (holder.paycheckCents === 0 && open.length > 0 && rng.bool(0.05)) {
        post(rng.pick(open), day, "deposit", rng.money(100, 1500, 50) * 100, "Cash deposit");
      }
      if (checking && rng.bool(0.3)) {
        const amount = rng.int(500, Math.max(5000, holder.paycheckCents / 5));
        if ((balance.get(checking.id) ?? 0) - amount >= SPENDING_FLOOR_CENTS) {
          post(checking, day, "card_purchase", -amount, "Card purchase");
        }
      }
      if (checking && savings && dayOfMonth === 20 && rng.bool(0.5)) {
        const amount = rng.money(50, 500, 50) * 100;
        if ((balance.get(checking.id) ?? 0) - amount >= SPENDING_FLOOR_CENTS) {
          const out = post(checking, day, "transfer_out", -amount, `Transfer to ${savings.id}`);
          const into = post(savings, day, "transfer_in", amount, `Transfer from ${checking.id}`, { relatedId: out.id });
          out.relatedId = into.id;
        }
      }
    }
  }

  for (const account of Object.values(db.accounts)) account.balanceCents = balance.get(account.id) ?? 0;
  return db;
}
