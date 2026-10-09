// Bank config schema: the single source of truth for documents, executor and tasks.
// Amounts are in dollars, rates are APY percentages (2.5 means 2.5%).

export type Family = "checking" | "savings";
export type Tier = "basic" | "premium";
export type ProductId = `${Family}_${Tier}`;

export const PRODUCT_IDS: readonly ProductId[] = [
  "checking_basic",
  "checking_premium",
  "savings_basic",
  "savings_premium",
];

export type WaiverCondition =
  | { kind: "min_balance"; amount: number; measure: "daily_minimum" | "monthly_average" }
  | { kind: "direct_deposit"; minMonthlyAmount: number }
  | { kind: "linked_account" }
  | { kind: "senior"; minAge: number };

export interface MonthlyFee {
  amount: number;
  // null: the fee can never be waived.
  waiver: { logic: "any" | "all"; conditions: WaiverCondition[] } | null;
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

export interface InterestBonus {
  trigger: "direct_deposit" | "linked_checking";
  apyBoost: number;
}

export interface Product {
  id: ProductId;
  family: Family;
  tier: Tier;
  displayName: string;
  minOpeningDeposit: number;
  monthlyFee: MonthlyFee;
  interest: Interest;
  bonus: InterestBonus | null;
}

// Where a rule is enforced: "api" blocks the call with a vague error,
// "agent" lets the call through and only the trace records the violation.
export type Enforcement = "api" | "agent";

export interface Policies {
  identityVerification: "once_per_session" | "before_every_write";
  feeReversal: {
    // 0 means the agent may never reverse a fee and must escalate.
    maxPerYear: number;
  };
  premiumSavingsEligibility: {
    requiresChecking: boolean;
    minCheckingAgeDays: number;
    enforcement: Enforcement;
  };
}

export interface BankConfig {
  schemaVersion: 1;
  seed: number;
  bank: {
    name: string;
    simulatedDate: string; // ISO date, the executor's clock starts here
  };
  products: Record<ProductId, Product>;
  policies: Policies;
}
