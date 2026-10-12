// Samples a random but coherent bank from SPEC. Every product comes from one tier-generic
// sampler: each tier steps up from the one below, so it dominates on rate and limits and
// costs more to open and keep fee-free.

import type { Rng } from "../util/rng.ts";
import { highestApy } from "../bank/rules.ts";
import { ACCOUNT_TYPES } from "../bank/schema.ts";
import type {
  BankConfig,
  AccountType,
  Interest,
  InterestBonus,
  MonthlyFee,
  Policies,
  Product,
  WaiverCondition,
} from "../bank/schema.ts";
import { SPEC } from "./spec.ts";
import type { AccountTypeSpec, Odds, Range } from "./spec.ts";

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function simulatedDate(rng: Rng): string {
  const day = rng.int(0, 364);
  return new Date(Date.UTC(SPEC.bank.simulatedYear, 0, 1 + day)).toISOString().slice(0, 10);
}

function title(accountType: AccountType): string {
  return accountType === "checking" ? "Checking" : "Savings";
}

function scaled(r: Range, factor: number): Range {
  return [r[0] * factor, r[1] * factor, r[2] * factor];
}

function waiverConditions(rng: Rng, kinds: AccountTypeSpec["waiver"]["kinds"], minBalance: Range): WaiverCondition[] {
  const spec = SPEC.monthlyFee;
  const measure = rng.pick(spec.balanceMeasures);
  const pool = kinds.map((kind): WaiverCondition => {
    switch (kind) {
      case "min_balance":
        return { kind, amount: rng.money(...minBalance), measure };
      case "direct_deposit":
        return { kind, minMonthlyAmount: rng.money(...spec.directDepositMonthly) };
      case "linked_account":
        return { kind };
      case "senior":
        return { kind, minAge: rng.int(...spec.seniorMinAge) };
    }
  });
  return rng.subset(pool, ...spec.conditionCount);
}

// Balance-band interest starting at `base`, each band paying more than the one below.
function tieredInterest(rng: Rng, base: number): Interest {
  const spec = SPEC.interestTiers;
  const t1 = rng.money(...spec.firstTierMinBalance);
  const tiers = [
    { minBalance: 0, apy: base },
    { minBalance: t1, apy: round3(base + rng.rate(...spec.apyStep)) },
  ];
  if (rng.bool(spec.thirdTierChance)) {
    tiers.push({
      minBalance: t1 + rng.money(...spec.thirdTierBalanceGap),
      apy: round3(tiers[1]!.apy + rng.rate(...spec.apyStep)),
    });
  }
  return { structure: "tiered", appliesTo: rng.pick(spec.appliesTo), tiers };
}

// One product of any account type at any tier. `below` is the same account type's product one tier
// down (null for the bottom tier); every value either comes from the account type's anchors or
// steps up from `below`, which is what makes higher tiers dominate. With `unordered`, every tier
// is sampled as if it were the bottom one; only its id and name say which tier it is.
function sampleProduct(
  rng: Rng,
  accountType: AccountType,
  position: number,
  below: Product | null,
  name: string,
  unordered: boolean,
): Product {
  const spec: AccountTypeSpec = SPEC.accountTypes[accountType];
  const count = SPEC.tiers.length;
  const level = unordered ? 0 : position; // the tier's place for sampling purposes
  if (unordered) below = null;
  const rank = count > 1 ? level / (count - 1) : 0;
  const chance = (o: Odds) => o.bottom + (o.top - o.bottom) * rank;
  const stepUp = (from: number | undefined, r: { anchor: Range; step: Range }) =>
    from === undefined ? rng.money(...r.anchor) : from + rng.money(...r.step);

  const minOpeningDeposit = stepUp(below?.minOpeningDeposit, spec.minOpeningDeposit);
  const feeAmount = rng.bool(chance(spec.fee.free)) ? 0 : stepUp(below?.monthlyFee.amount, spec.fee);
  const minBalance = scaled(spec.waiver.minBalance, spec.waiver.minBalanceGrowth ** level);
  const monthlyFee: MonthlyFee =
    feeAmount === 0 || !rng.bool(SPEC.monthlyFee.waivableChance)
      ? { amount: feeAmount, waiver: { logic: "any", conditions: [] } }
      : {
          amount: feeAmount,
          waiver: { logic: rng.pick(SPEC.monthlyFee.logics), conditions: waiverConditions(rng, spec.waiver.kinds, minBalance) },
        };

  let interest: Interest = { structure: "none" };
  if (!rng.bool(chance(spec.interest.none))) {
    const start = below ? highestApy(below.interest) + rng.rate(...spec.interest.gapAboveBelow) : spec.interest.floor;
    const base = round3(start + rng.rate(...spec.interest.spread));
    interest = rng.bool(chance(spec.interest.tiered)) ? tieredInterest(rng, base) : { structure: "flat", apy: base };
  }

  const bonuses: InterestBonus[] = rng.bool(chance(spec.bonus))
    ? [{ trigger: rng.pick(SPEC.bonus.triggers), apyBoost: rng.rate(...SPEC.bonus.apyBoost) }]
    : [];

  const tier = SPEC.tiers[position]!;
  return {
    id: `${accountType}_${tier}`,
    accountType,
    tier,
    displayName: `${name} ${title(accountType)}`,
    minOpeningDeposit,
    monthlyFee,
    interest,
    bonuses,
  };
}

function sampleProducts(rng: Rng, unordered: boolean): BankConfig["products"] {
  const scheme = rng.pick(SPEC.bank.nameSchemes);
  const names = SPEC.tiers.map((_, i) => rng.pick(scheme[i]!));
  const products: Partial<BankConfig["products"]> = {};
  for (const accountType of ACCOUNT_TYPES) {
    let below: Product | null = null;
    SPEC.tiers.forEach((_, position) => {
      const p = sampleProduct(rng, accountType, position, below, names[position]!, unordered);
      products[p.id] = p;
      below = p;
    });
  }
  return products as BankConfig["products"];
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
  const unorderedTiers = rng.bool(SPEC.unorderedTiersChance);
  return {
    schemaVersion: 1,
    seed,
    bank: {
      name: `${rng.pick(SPEC.bank.prefixes)} ${rng.pick(SPEC.bank.suffixes)}`,
      simulatedDate: simulatedDate(rng),
    },
    unorderedTiers,
    products: sampleProducts(rng, unorderedTiers),
    policies: samplePolicies(rng),
  };
}
