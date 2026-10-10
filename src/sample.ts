// Samples a random but coherent bank. Premium is built from Basic so that it
// dominates on rate and limits and costs more to open and keep fee-free.

import type { Rng } from "./rng.ts";
import type {
  BankConfig,
  Family,
  Interest,
  InterestBonus,
  MonthlyFee,
  Policies,
  Product,
  WaiverCondition,
} from "./schema.ts";

const BANK_PREFIXES = ["Harbor", "Summit", "Cedar", "Lakeside", "Ironwood", "Meridian", "Northgate", "Willow"];
const BANK_SUFFIXES = ["Bank", "Savings Bank", "Trust", "Community Bank"];

const NAME_SCHEMES: readonly { basic: readonly string[]; premium: readonly string[] }[] = [
  { basic: ["Bronze", "Silver"], premium: ["Gold", "Platinum"] },
  { basic: ["Blue", "Green"], premium: ["Navy", "Emerald"] },
  { basic: ["Essential", "Everyday"], premium: ["Plus", "Preferred"] },
];

const SIM_YEAR = 2026;

function simulatedDate(rng: Rng): string {
  const day = rng.int(0, 364);
  return new Date(Date.UTC(SIM_YEAR, 0, 1 + day)).toISOString().slice(0, 10);
}

function title(family: Family): string {
  return family === "checking" ? "Checking" : "Savings";
}

// With "all" logic any subset is allowed, so a waiver can demand a high balance, direct
// deposits and a senior age at once. Unrealistic but intentional: rare, valid rules test
// whether the agent reads the policy instead of applying common-bank priors.
function waiverConditions(
  rng: Rng,
  family: Family,
  minBalanceRange: [number, number, number],
): WaiverCondition[] {
  const measure = rng.pick(["daily_minimum", "monthly_average"] as const);
  const pool: WaiverCondition[] = [
    { kind: "min_balance", amount: rng.money(...minBalanceRange), measure },
    family === "checking"
      ? { kind: "direct_deposit", minMonthlyAmount: rng.money(250, 1500, 250) }
      : { kind: "linked_account" },
    { kind: "senior", minAge: rng.int(62, 67) },
  ];
  return rng.subset(pool, 1, 3);
}

function monthlyFee(
  rng: Rng,
  family: Family,
  amount: number,
  minBalanceRange: [number, number, number],
): MonthlyFee {
  // Zero fee, or 15% of paid fees: no way to waive.
  if (amount === 0 || !rng.bool(0.85)) return { amount, waiver: { logic: "any", conditions: [] } };
  return {
    amount,
    waiver: { logic: rng.pick(["any", "all"] as const), conditions: waiverConditions(rng, family, minBalanceRange) },
  };
}

// Interest whose lowest rate is at least `floorApy`, returned with its top rate.
function savingsInterest(rng: Rng, floorApy: number): { interest: Interest; topApy: number } {
  const base = Math.round((floorApy + rng.rate(0, 1.5, 0.05)) * 1000) / 1000;
  if (rng.bool(0.5)) return { interest: { structure: "flat", apy: base }, topApy: base };

  const t1 = rng.money(5000, 25000, 5000);
  const tiers = [
    { minBalance: 0, apy: base },
    { minBalance: t1, apy: Math.round((base + rng.rate(0.1, 0.75, 0.05)) * 1000) / 1000 },
  ];
  if (rng.bool(0.5)) {
    const prev = tiers[1]!.apy;
    tiers.push({
      minBalance: t1 + rng.money(25000, 75000, 25000),
      apy: Math.round((prev + rng.rate(0.1, 0.75, 0.05)) * 1000) / 1000,
    });
  }
  return {
    interest: { structure: "tiered", appliesTo: rng.pick(["whole_balance", "marginal"] as const), tiers },
    topApy: tiers.at(-1)!.apy,
  };
}

function savingsBonuses(rng: Rng): InterestBonus[] {
  if (!rng.bool(0.5)) return [];
  return [{
    trigger: rng.pick(["direct_deposit", "linked_checking"] as const),
    apyBoost: rng.rate(0.05, 0.5, 0.05),
  }];
}

function product(
  family: Family,
  tier: "basic" | "premium",
  name: string,
  fields: Omit<Product, "id" | "family" | "tier" | "displayName">,
): Product {
  return { id: `${family}_${tier}`, family, tier, displayName: `${name} ${title(family)}`, ...fields };
}

function sampleProducts(rng: Rng): BankConfig["products"] {
  const scheme = rng.pick(NAME_SCHEMES);
  const basicName = rng.pick(scheme.basic);
  const premiumName = rng.pick(scheme.premium);

  // Checking: Basic may pay nothing; Premium always pays more than Basic.
  const basicCheckingApy = rng.bool(0.3) ? rng.rate(0.01, 0.1, 0.01) : 0;
  const premiumCheckingApy = Math.round((basicCheckingApy + rng.rate(0.05, 0.5, 0.05)) * 1000) / 1000;
  const basicCheckingFee = rng.money(5, 15, 1);

  const checkingBasic = product("checking", "basic", basicName, {
    minOpeningDeposit: rng.money(0, 100, 25),
    monthlyFee: monthlyFee(rng, "checking", basicCheckingFee, [500, 2500, 250]),
    interest: basicCheckingApy > 0 ? { structure: "flat", apy: basicCheckingApy } : { structure: "none" },
    bonuses: [],
  });
  const checkingPremium = product("checking", "premium", premiumName, {
    minOpeningDeposit: rng.money(500, 5000, 500),
    monthlyFee: monthlyFee(rng, "checking", basicCheckingFee + rng.money(5, 20, 1), [5000, 25000, 2500]),
    interest: { structure: "flat", apy: premiumCheckingApy },
    bonuses: [],
  });

  // Savings: Premium's lowest rate starts above Basic's highest rate.
  const basicSavings = savingsInterest(rng, 0.5);
  const premiumSavings = savingsInterest(rng, basicSavings.topApy + rng.rate(0.25, 1.5, 0.05));
  const basicSavingsFee = rng.bool(0.4) ? 0 : rng.money(2, 5, 1);

  const savingsBasic = product("savings", "basic", basicName, {
    minOpeningDeposit: rng.money(0, 100, 25),
    monthlyFee: monthlyFee(rng, "savings", basicSavingsFee, [300, 1500, 100]),
    interest: basicSavings.interest,
    bonuses: savingsBonuses(rng),
  });
  const savingsPremium = product("savings", "premium", premiumName, {
    minOpeningDeposit: rng.money(1000, 10000, 500),
    monthlyFee: monthlyFee(rng, "savings", basicSavingsFee + rng.money(8, 20, 1), [5000, 25000, 2500]),
    interest: premiumSavings.interest,
    bonuses: savingsBonuses(rng),
  });

  return {
    checking_basic: checkingBasic,
    checking_premium: checkingPremium,
    savings_basic: savingsBasic,
    savings_premium: savingsPremium,
  };
}

function samplePolicies(rng: Rng): Policies {
  const requiresChecking = rng.bool(0.6);
  return {
    identityVerification: rng.pick(["once_per_session", "before_every_write"] as const),
    feeReversal: { maxPerYear: rng.int(0, 3) },
    premiumSavingsEligibility: {
      requiresChecking,
      minCheckingAgeDays: requiresChecking ? rng.pick([0, 14, 30, 60, 90]) : 0,
      enforcement: rng.pick(["api", "agent"] as const),
    },
  };
}

export function sampleBank(rng: Rng, seed: number): BankConfig {
  return {
    schemaVersion: 1,
    seed,
    bank: {
      name: `${rng.pick(BANK_PREFIXES)} ${rng.pick(BANK_SUFFIXES)}`,
      simulatedDate: simulatedDate(rng),
    },
    products: sampleProducts(rng),
    policies: samplePolicies(rng),
  };
}
