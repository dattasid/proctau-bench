// Bank config schema: the single source of truth for documents, executor and tasks.
// Amounts are in dollars, rates are APY percentages (2.5 means 2.5%).

// An account type from BankConfig.accountTypes, e.g. "checking" or "business_checking".
// Customers see it with underscores as spaces (see accountTypeName).
export type AccountType = string;

// A tier name from BankConfig.tiers, e.g. "basic". A product id is `${accountType}_${tier}`.
export type Tier = string;
export type ProductId = string;

// What a customer must already have to open a product: an open account of an earlier account
// type (any tier), or of one specific earlier product, opened at least minAgeDays before the new
// account. Empty list: anyone may open it.
export type Requirement =
  | { kind: "holds_account"; accountType: AccountType; minAgeDays: number }
  | { kind: "holds_product"; productId: ProductId; minAgeDays: number };

export type WaiverCondition =
  | { kind: "min_balance"; amount: number; measure: "daily_minimum" | "monthly_average" }
  | { kind: "direct_deposit"; minMonthlyAmount: number }
  | { kind: "linked_account" }
  | { kind: "senior"; minAge: number };

export interface MonthlyFee {
  amount: number;
  // Empty conditions: the fee can never be waived. An empty list always uses
  // "any" (any of nothing is false); "all" of nothing would waive every fee.
  waiver: { logic: "any" | "all"; conditions: WaiverCondition[] };
}

export type Interest =
  | { structure: "none" }
  | { structure: "flat"; apy: number }
  | {
      structure: "tiered";
      // whole_balance: the tier reached sets the rate for the entire balance.
      // marginal: each tier's rate applies only to the slice of balance inside it.
      appliesTo: "whole_balance" | "marginal";
      tiers: { minBalance: number; apy: number }[];
    };

// How a month's interest is worked out from the account's end-of-day balances. Banks name one in
// their documents; calculate_interest accepts them all, so the agent must pick the bank's.
//   average_daily_balance: the month's average balance, at a twelfth of the yearly rate
//   daily_accrual: each day's balance at 1/365 of the yearly rate, added up
//   minimum_daily_balance: the month's lowest balance, at a twelfth of the yearly rate
//   month_end_balance: the balance on the month's last day, at a twelfth of the yearly rate
//   month_start_balance: the balance at the end of the previous month, at a twelfth of the yearly rate
export const INTEREST_METHODS = [
  "average_daily_balance",
  "daily_accrual",
  "minimum_daily_balance",
  "month_end_balance",
  "month_start_balance",
] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

// A bonus is earned month by month. direct_deposit: a direct deposit into any of the customer's
// accounts during the month. linked_account: an open account of that type at the end of the month.
export type InterestBonus =
  | { trigger: "direct_deposit"; apyBoost: number }
  | { trigger: "linked_account"; accountType: AccountType; apyBoost: number }; // holds an open account of this type

export interface Product {
  id: ProductId;
  accountType: AccountType;
  tier: Tier;
  displayName: string;
  minOpeningDeposit: number;
  requirements: Requirement[]; // all must hold
  monthlyFee: MonthlyFee;
  interest: Interest;
  // Empty: no bonus is offered.
  bonuses: InterestBonus[];
}

// Where a rule is enforced: "api" blocks the call with a vague error,
// "agent" lets the call through and only the trace records the violation.
// Benchmarks use "agent" only. "api" is kept for RL with weak agents, where blocking keeps
// episodes from going off the rails; it is never sampled for the benchmark.
export type Enforcement = "api" | "agent";

export interface Policies {
  identityVerification: "once_per_session" | "before_every_write";
  feeReversal: {
    // 0 means the agent may never reverse a fee and must escalate.
    maxPerYear: number;
  };
  // How product requirements are enforced when opening an account.
  eligibilityEnforcement: Enforcement;
  // Transfers out of accounts of these types are limited per calendar month (transfers in are not).
  // null: no limit on any account.
  transferLimit: { perMonth: number; accountTypes: AccountType[] } | null;
  // How monthly interest is worked out. Every bank uses average_daily_balance for now.
  interestMethod: InterestMethod;
}

export interface BankConfig {
  schemaVersion: 1;
  seed: number;
  bank: {
    name: string;
    simulatedDate: string; // ISO date, the executor's clock starts here
  };
  // false: each tier dominates the one below (higher rates, deposits, fees and waiver balances).
  // true: tiers are sampled independently, so a higher tier can be worse on any of these. It
  // tests that the agent reads the numbers instead of assuming the usual order.
  unorderedTiers: boolean;
  tiers: Tier[]; // lowest to highest; every account type has one product per tier
  // In order: a product may only require account types listed before its own, so opening
  // requirements can never form a cycle.
  accountTypes: AccountType[];
  // true: a product may also require one specific earlier product, even a lower tier of its own
  // type (Gold Checking requires Silver Checking). Earlier means earlier in product order, so
  // requirements still cannot form a cycle.
  productRequirements: boolean;
  products: Record<ProductId, Product>;
  policies: Policies;
}
