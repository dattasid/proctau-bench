// Samples a random but coherent bank from SPEC. Premium is built from Basic so that it
// dominates on rate and limits and costs more to open and keep fee-free.

import type { Rng } from "../util/rng.ts";
import type {
  BankConfig,
  Family,
  Interest,
  InterestBonus,
  MonthlyFee,
  Policies,
  Product,
  WaiverCondition,
} from "../bank/schema.ts";
import { SPEC } from "./spec.ts";
import type { Range } from "./spec.ts";

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function simulatedDate(rng: Rng): string {
  const day = rng.int(0, 364);
  return new Date(Date.UTC(SPEC.bank.simulatedYear, 0, 1 + day)).toISOString().slice(0, 10);
}

function title(family: Family): string {
  return family === "checking" ? "Checking" : "Savings";
}

function waiverConditions(rng: Rng, family: Family, minBalance: Range): WaiverCondition[] {
  const spec = SPEC.monthlyFee;
  const measure = rng.pick(spec.balanceMeasures);
  const pool: WaiverCondition[] = [
    { kind: "min_balance", amount: rng.money(...minBalance), measure },
    family === "checking"
      ? { kind: "direct_deposit", minMonthlyAmount: rng.money(...spec.directDepositMonthly) }
      : { kind: "linked_account" },
    { kind: "senior", minAge: rng.int(...spec.seniorMinAge) },
  ];
  return rng.subset(pool, ...spec.conditionCount);
}

function monthlyFee(rng: Rng, family: Family, amount: number, minBalance: Range): MonthlyFee {
  if (amount === 0 || !rng.bool(SPEC.monthlyFee.waivableChance)) return { amount, waiver: { logic: "any", conditions: [] } };
  return {
    amount,
    waiver: { logic: rng.pick(SPEC.monthlyFee.logics), conditions: waiverConditions(rng, family, minBalance) },
  };
}

// Interest whose lowest rate is at least `floorApy`, returned with its top rate.
function savingsInterest(rng: Rng, floorApy: number): { interest: Interest; topApy: number } {
  const spec = SPEC.savings.interest;
  const base = round3(floorApy + rng.rate(...spec.apyAboveFloor));
  if (rng.bool(spec.flatChance)) return { interest: { structure: "flat", apy: base }, topApy: base };

  const t1 = rng.money(...spec.firstTierMinBalance);
  const tiers = [
    { minBalance: 0, apy: base },
    { minBalance: t1, apy: round3(base + rng.rate(...spec.tierApyStep)) },
  ];
  if (rng.bool(spec.thirdTierChance)) {
    const prev = tiers[1]!.apy;
    tiers.push({
      minBalance: t1 + rng.money(...spec.thirdTierBalanceGap),
      apy: round3(prev + rng.rate(...spec.tierApyStep)),
    });
  }
  return {
    interest: { structure: "tiered", appliesTo: rng.pick(spec.appliesTo), tiers },
    topApy: tiers.at(-1)!.apy,
  };
}

function savingsBonuses(rng: Rng): InterestBonus[] {
  const spec = SPEC.savings.bonus;
  if (!rng.bool(spec.chance)) return [];
  return [{ trigger: rng.pick(spec.triggers), apyBoost: rng.rate(...spec.apyBoost) }];
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
  const scheme = rng.pick(SPEC.bank.nameSchemes);
  const basicName = rng.pick(scheme.basic);
  const premiumName = rng.pick(scheme.premium);

  // Checking: Basic may pay nothing; Premium always pays more than Basic.
  const cb = SPEC.checking.basic;
  const cp = SPEC.checking.premium;
  const basicCheckingApy = rng.bool(cb.interestChance) ? rng.rate(...cb.apy) : 0;
  const premiumCheckingApy = round3(basicCheckingApy + rng.rate(...cp.apyAboveBasic));
  const basicCheckingFee = rng.money(...cb.fee);

  const checkingBasic = product("checking", "basic", basicName, {
    minOpeningDeposit: rng.money(...cb.minOpeningDeposit),
    monthlyFee: monthlyFee(rng, "checking", basicCheckingFee, cb.waiverMinBalance),
    interest: basicCheckingApy > 0 ? { structure: "flat", apy: basicCheckingApy } : { structure: "none" },
    bonuses: [],
  });
  const checkingPremium = product("checking", "premium", premiumName, {
    minOpeningDeposit: rng.money(...cp.minOpeningDeposit),
    monthlyFee: monthlyFee(rng, "checking", basicCheckingFee + rng.money(...cp.feeAboveBasic), cp.waiverMinBalance),
    interest: { structure: "flat", apy: premiumCheckingApy },
    bonuses: [],
  });

  // Savings: Premium's lowest rate starts above Basic's highest rate.
  const sb = SPEC.savings.basic;
  const sp = SPEC.savings.premium;
  const basicSavings = savingsInterest(rng, sb.apyFloor);
  const premiumSavings = savingsInterest(rng, basicSavings.topApy + rng.rate(...sp.apyGapAboveBasicTop));
  const basicSavingsFee = rng.bool(sb.freeChance) ? 0 : rng.money(...sb.fee);

  const savingsBasic = product("savings", "basic", basicName, {
    minOpeningDeposit: rng.money(...sb.minOpeningDeposit),
    monthlyFee: monthlyFee(rng, "savings", basicSavingsFee, sb.waiverMinBalance),
    interest: basicSavings.interest,
    bonuses: savingsBonuses(rng),
  });
  const savingsPremium = product("savings", "premium", premiumName, {
    minOpeningDeposit: rng.money(...sp.minOpeningDeposit),
    monthlyFee: monthlyFee(rng, "savings", basicSavingsFee + rng.money(...sp.feeAboveBasic), sp.waiverMinBalance),
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
  const spec = SPEC.policies;
  const requiresChecking = rng.bool(spec.premiumSavingsRequiresCheckingChance);
  return {
    identityVerification: rng.pick(spec.identityVerification),
    feeReversal: { maxPerYear: rng.int(...spec.courtesyReversalsPerYear) },
    premiumSavingsEligibility: {
      requiresChecking,
      minCheckingAgeDays: requiresChecking ? rng.pick(spec.minCheckingAgeDays) : 0,
      enforcement: "agent", // "api" only for RL with weak agents, see Enforcement
    },
  };
}

export function sampleBank(rng: Rng, seed: number): BankConfig {
  return {
    schemaVersion: 1,
    seed,
    bank: {
      name: `${rng.pick(SPEC.bank.prefixes)} ${rng.pick(SPEC.bank.suffixes)}`,
      simulatedDate: simulatedDate(rng),
    },
    products: sampleProducts(rng),
    policies: samplePolicies(rng),
  };
}
