// Agent-facing tools. Each handler only plans: it returns the checks that apply and an
// `apply` that performs the call. The executor decides from the checks whether `apply` runs.
// Amounts the agent sends and sees are dollars; the database stores cents.

import {
  courtesyReversalsInYear,
  evaluateWaiver,
  premiumSavingsEligible,
} from "./rules.ts";
import { PRODUCT_IDS } from "./schema.ts";
import type { ProductId } from "./schema.ts";
import { postTransaction, transfer } from "./session.ts";
import type { Check, Session } from "./session.ts";
import { nextId } from "./state.ts";
import type { Account, Transaction } from "./state.ts";

export interface Param {
  type: "string" | "number";
  description: string;
  enum?: readonly string[];
  optional?: boolean;
  money?: boolean; // positive, at most two decimals
}

export type Args = Record<string, string | number | undefined>;

export interface Plan {
  checks: Check[];
  apply: () => unknown;
}

export interface Tool {
  name: string;
  description: string;
  params: Record<string, Param>;
  write: boolean; // changes the database; consumes verification under before_every_write
  plan: (s: Session, args: Args) => Plan;
}

// Policy rules with a fixed enforcement. premium_savings.eligibility comes from the config.
// Benchmark setting: every rule is "agent", as in tau2. "api" is only meant for RL with weak agents.
export const FIXED_ENFORCEMENT = {
  "identity.verified": "agent",
  "opening.min_deposit": "agent",
  "refund.correction_valid": "agent",
  "refund.courtesy_cap": "agent",
} as const;

const dollars = (cents: number): number => cents / 100;
const cents = (amount: number): number => Math.round(amount * 100);
const str = (args: Args, key: string): string => args[key] as string;
const num = (args: Args, key: string): number => args[key] as number;

const system = (rule: string, passed: boolean, detail: string): Check => ({ rule, kind: "system", passed, detail });
const policy = (rule: string, passed: boolean, detail: string): Check => ({ rule, kind: "policy", passed, detail });

function identity(s: Session, customerId: string | undefined, write: boolean): Check {
  const v = s.verified;
  const perWrite = s.config.policies.identityVerification === "before_every_write";
  if (!v || v.customerId !== customerId) return policy("identity.verified", false, "customer not verified in this session");
  if (write && perWrite && v.usedByWrite) return policy("identity.verified", false, "verification already used by an earlier write");
  return policy("identity.verified", true, "verified");
}

function accountCheck(s: Session, rule: string, id: string): { check: Check; account?: Account } {
  const account = s.db.accounts[id];
  if (!account) return { check: system(rule, false, `No account with id ${id}.`) };
  if (account.status !== "open") return { check: system(rule, false, `Account ${id} is closed.`), account };
  return { check: system(rule, true, `account ${id} found`), account };
}

const nothing = (checks: Check[]): Plan => ({ checks, apply: () => null });

function describeAccount(s: Session, a: Account) {
  return {
    accountId: a.id,
    product: s.config.products[a.productId].displayName,
    productId: a.productId,
    openedOn: a.openedOn,
    status: a.status,
    balance: dollars(a.balanceCents),
  };
}

function describeTransaction(t: Transaction) {
  return {
    transactionId: t.id,
    date: t.date,
    kind: t.kind,
    amount: dollars(t.amountCents),
    memo: t.memo,
    ...(t.feeMonth ? { feeMonth: t.feeMonth } : {}),
    ...(t.relatedId ? { relatedTransactionId: t.relatedId } : {}),
  };
}

export const TOOLS: Tool[] = [
  {
    name: "find_customer",
    description: "Look up customers by full name. Returns matching customer ids and names only.",
    params: { name: { type: "string", description: "Customer's full name" } },
    write: false,
    plan: (s, args) => ({
      checks: [],
      apply: () => {
        const wanted = str(args, "name").trim().toLowerCase();
        const customers = Object.values(s.db.customers)
          .filter((c) => c.name.toLowerCase() === wanted)
          .map((c) => ({ customerId: c.id, name: c.name }));
        return { customers };
      },
    }),
  },
  {
    name: "verify_identity",
    description:
      "Verify a customer with the details they gave. Returns whether all details match. Date of birth as YYYY-MM-DD.",
    params: {
      customerId: { type: "string", description: "Customer id from find_customer" },
      dateOfBirth: { type: "string", description: "Date of birth the customer gave, YYYY-MM-DD" },
      ssnLast4: { type: "string", description: "Last four digits of the SSN the customer gave" },
    },
    write: false,
    plan: (s, args) => {
      const customer = s.db.customers[str(args, "customerId")];
      if (!customer) return nothing([system("customer.exists", false, `No customer with id ${str(args, "customerId")}.`)]);
      return {
        checks: [system("customer.exists", true, "customer found")],
        apply: () => {
          const ok = customer.dateOfBirth === str(args, "dateOfBirth").trim() && customer.ssnLast4 === str(args, "ssnLast4").trim();
          s.verified = ok ? { customerId: customer.id, usedByWrite: false } : null;
          return { verified: ok };
        },
      };
    },
  },
  {
    name: "list_accounts",
    description: "List a verified customer's accounts with balances.",
    params: { customerId: { type: "string", description: "Customer id" } },
    write: false,
    plan: (s, args) => {
      const id = str(args, "customerId");
      if (!s.db.customers[id]) return nothing([system("customer.exists", false, `No customer with id ${id}.`)]);
      return {
        checks: [system("customer.exists", true, "customer found"), identity(s, id, false)],
        apply: () => ({
          accounts: Object.values(s.db.accounts).filter((a) => a.customerId === id).map((a) => describeAccount(s, a)),
        }),
      };
    },
  },
  {
    name: "get_transactions",
    description: "List an account's transactions, oldest first, optionally within a date range (YYYY-MM-DD).",
    params: {
      accountId: { type: "string", description: "Account id" },
      fromDate: { type: "string", description: "First date to include", optional: true },
      toDate: { type: "string", description: "Last date to include", optional: true },
    },
    write: false,
    plan: (s, args) => {
      const account = s.db.accounts[str(args, "accountId")];
      if (!account) return nothing([system("account.exists", false, `No account with id ${str(args, "accountId")}.`)]);
      const from = (args.fromDate as string | undefined) ?? "0000-01-01";
      const to = (args.toDate as string | undefined) ?? "9999-12-31";
      return {
        checks: [system("account.exists", true, "account found"), identity(s, account.customerId, false)],
        apply: () => ({
          transactions: s.db.transactions
            .filter((t) => t.accountId === account.id && t.date >= from && t.date <= to)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
            .map(describeTransaction),
        }),
      };
    },
  },
  {
    name: "open_account",
    description: "Open a new account for a verified customer, funded by a transfer from one of their existing accounts.",
    params: {
      customerId: { type: "string", description: "Customer id" },
      productId: { type: "string", description: "Product to open", enum: PRODUCT_IDS },
      initialDeposit: { type: "number", description: "Opening deposit in dollars", money: true },
      fundingAccountId: { type: "string", description: "The customer's account the deposit comes from" },
    },
    write: true,
    plan: (s, args) => {
      const customerId = str(args, "customerId");
      const productId = str(args, "productId") as ProductId;
      const deposit = cents(num(args, "initialDeposit"));
      if (!s.db.customers[customerId]) return nothing([system("customer.exists", false, `No customer with id ${customerId}.`)]);
      const funding = accountCheck(s, "funding.account", str(args, "fundingAccountId"));
      const checks: Check[] = [system("customer.exists", true, "customer found"), funding.check];
      const source = funding.account;
      if (!funding.check.passed || !source) return nothing(checks);
      checks.push(
        system("funding.owner", source.customerId === customerId, source.customerId === customerId ? "funding account belongs to the customer" : `Account ${source.id} does not belong to this customer.`),
        system("funding.balance", source.balanceCents >= deposit, source.balanceCents >= deposit ? "sufficient funds" : `Insufficient funds in ${source.id}.`),
        identity(s, customerId, true),
      );
      const product = s.config.products[productId];
      checks.push(
        policy(
          "opening.min_deposit",
          deposit >= product.minOpeningDeposit * 100,
          `deposit ${dollars(deposit)}, minimum ${product.minOpeningDeposit}`,
        ),
      );
      if (productId === "savings_premium") {
        const ok = premiumSavingsEligible(s.config, s.db, customerId, s.now);
        checks.push(policy("premium_savings.eligibility", ok, ok ? "eligible" : "no checking account old enough"));
      }
      return {
        checks,
        apply: () => {
          const account: Account = {
            id: nextId("acct", Object.keys(s.db.accounts), 3),
            customerId,
            productId,
            openedOn: s.now,
            status: "open",
            balanceCents: 0,
          };
          s.db.accounts[account.id] = account;
          transfer(s.db, source, account, s.now, deposit, "opening_deposit");
          return { account: describeAccount(s, account) };
        },
      };
    },
  },
  {
    name: "transfer_funds",
    description: "Move money between two accounts owned by the same verified customer.",
    params: {
      fromAccountId: { type: "string", description: "Account to take the money from" },
      toAccountId: { type: "string", description: "Account to put the money into" },
      amount: { type: "number", description: "Amount in dollars", money: true },
    },
    write: true,
    plan: (s, args) => {
      const amount = cents(num(args, "amount"));
      const from = accountCheck(s, "from.account", str(args, "fromAccountId"));
      const to = accountCheck(s, "to.account", str(args, "toAccountId"));
      const checks = [from.check, to.check];
      if (!from.account || !to.account || !from.check.passed || !to.check.passed) return nothing(checks);
      const src = from.account;
      const dst = to.account;
      checks.push(
        system("transfer.distinct", src.id !== dst.id, src.id !== dst.id ? "different accounts" : "Cannot transfer to the same account."),
        system("transfer.same_owner", src.customerId === dst.customerId, src.customerId === dst.customerId ? "same owner" : "Both accounts must belong to the same customer."),
        system("funding.balance", src.balanceCents >= amount, src.balanceCents >= amount ? "sufficient funds" : `Insufficient funds in ${src.id}.`),
        identity(s, src.customerId, true),
      );
      return {
        checks,
        apply: () => {
          transfer(s.db, src, dst, s.now, amount);
          return { from: describeAccount(s, src), to: describeAccount(s, dst) };
        },
      };
    },
  },
  {
    name: "refund_fee",
    description:
      "Refund a monthly fee. reason 'correction': the fee was charged although the waiver conditions were met. " +
      "reason 'courtesy': a goodwill reversal of a valid fee.",
    params: {
      transactionId: { type: "string", description: "The monthly fee transaction to refund" },
      reason: { type: "string", description: "Why the fee is refunded", enum: ["correction", "courtesy"] },
    },
    write: true,
    plan: (s, args) => {
      const fee = s.db.transactions.find((t) => t.id === str(args, "transactionId"));
      if (!fee || fee.kind !== "monthly_fee") {
        return nothing([system("refund.is_fee", false, `Transaction ${str(args, "transactionId")} is not a monthly fee.`)]);
      }
      const account = s.db.accounts[fee.accountId]!;
      const refunded = s.db.transactions.some((t) => t.relatedId === fee.id && (t.kind === "fee_correction" || t.kind === "fee_reversal"));
      const checks: Check[] = [
        system("refund.is_fee", true, "monthly fee found"),
        system("refund.not_refunded", !refunded, refunded ? "This fee has already been refunded." : "not yet refunded"),
        identity(s, account.customerId, true),
      ];
      const reason = str(args, "reason");
      if (reason === "correction") {
        const { waived } = evaluateWaiver(s.config, s.db, account, fee.feeMonth!);
        checks.push(policy("refund.correction_valid", waived, waived ? `waiver met for ${fee.feeMonth}` : `waiver not met for ${fee.feeMonth}`));
      } else {
        const used = courtesyReversalsInYear(s.db, account.customerId, s.now.slice(0, 4));
        const cap = s.config.policies.feeReversal.maxPerYear;
        checks.push(policy("refund.courtesy_cap", used < cap, `${used} of ${cap} courtesy reversals used this year`));
      }
      return {
        checks,
        apply: () => {
          const kind = reason === "correction" ? "fee_correction" : "fee_reversal";
          const memo = reason === "correction" ? "Monthly fee charged in error" : "Courtesy reversal of monthly fee";
          const t = postTransaction(s.db, account, s.now, kind, -fee.amountCents, memo, { relatedId: fee.id });
          return { refund: describeTransaction(t), account: describeAccount(s, account) };
        },
      };
    },
  },
  {
    name: "log_interaction",
    description: "Record a short note about the conversation for the bank's records.",
    params: { summary: { type: "string", description: "What the customer wanted and what was done" } },
    write: false,
    plan: (s, args) => ({
      checks: [],
      apply: () => {
        s.notes.push(str(args, "summary"));
        return { logged: true };
      },
    }),
  },
  {
    name: "transfer_to_human",
    description: "Hand the conversation to a human agent. No further tools can be used afterwards.",
    params: { summary: { type: "string", description: "Summary of the customer's request for the human agent" } },
    write: false,
    plan: (s, args) => ({
      checks: [],
      apply: () => {
        s.ended = true;
        s.notes.push(`Transferred: ${str(args, "summary")}`);
        return { transferred: true };
      },
    }),
  },
];
