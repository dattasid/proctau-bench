// Samples a random but coherent bank from a Spec (SPEC by default). Every product comes from one
// tier-generic sampler: each tier steps up from the one below, so it dominates on rate and limits
// and costs more to open and keep fee-free. Works for any number of tiers.

import type { Rng } from "../util/rng.ts";
import { accountTypeTitle, productId } from "../bank/products.ts";
import { highestApy } from "../bank/rules.ts";
import type {
  BankConfig,
  AccountType,
  Interest,
  InterestBonus,
  MonthlyFee,
  Policies,
  Product,
  Requirement,
  WaiverCondition,
} from "../bank/schema.ts";
import { at, SPEC } from "./spec.ts";
import type { AccountTypeSpec, Range, Spec } from "./spec.ts";

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function simulatedDate(rng: Rng, spec: Spec): string {
  const day = rng.int(0, 364);
  return new Date(Date.UTC(spec.bank.simulatedYear, 0, 1 + day)).toISOString().slice(0, 10);
}

function scaled(r: Range, factor: number): Range {
  return [r[0] * factor, r[1] * factor, r[2] * factor];
}

function waiverConditions(rng: Rng, spec: Spec, kinds: AccountTypeSpec["waiver"]["kinds"], minBalance: Range): WaiverCondition[] {
  const fee = spec.monthlyFee;
  const measure = rng.pick(fee.balanceMeasures);
  const pool = kinds.map((kind): WaiverCondition => {
    switch (kind) {
      case "min_balance":
        return { kind, amount: rng.money(...minBalance), measure };
      case "direct_deposit":
        return { kind, minMonthlyAmount: rng.money(...fee.directDepositMonthly) };
      case "linked_account":
        return { kind };
      case "senior":
        return { kind, minAge: rng.int(...fee.seniorMinAge) };
    }
  });
  return rng.subset(pool, ...fee.conditionCount);
}

// Balance-band interest starting at `base`, each band paying more than the one below.
function tieredInterest(rng: Rng, spec: Spec, base: number): Interest {
  const bands = spec.interestTiers;
  const t1 = rng.money(...bands.firstTierMinBalance);
  const tiers = [
    { minBalance: 0, apy: base },
    { minBalance: t1, apy: round3(base + rng.rate(...bands.apyStep)) },
  ];
  if (rng.bool(bands.thirdTierChance)) {
    tiers.push({
      minBalance: t1 + rng.money(...bands.thirdTierBalanceGap),
      apy: round3(tiers[1]!.apy + rng.rate(...bands.apyStep)),
    });
  }
  return { structure: "tiered", appliesTo: rng.pick(bands.appliesTo), tiers };
}

// One product of any account type at any tier. `below` is the same account type's product one tier
// down (null for the bottom tier); every value either comes from the account type's anchors or
// steps up from `below`, which is what makes higher tiers dominate. With `unordered`, every tier
// is sampled as if it were the bottom one; only its id and name say which tier it is.
function sampleProduct(
  rng: Rng,
  spec: Spec,
  accountType: AccountType,
  position: number,
  below: Product | null,
  name: string,
  unordered: boolean,
): Product {
  const typeSpec: AccountTypeSpec = spec.accountTypes[accountType]!;
  const count = spec.tiers.length;
  const rankOf = (p: number) => (count > 1 ? p / (count - 1) : 0);
  const level = unordered ? 0 : position; // the tier's place for sampling rates, fees and limits
  if (unordered) below = null;
  const rank = rankOf(level);
  const stepUp = (from: number | undefined, r: { anchor: Range; step: Range }) =>
    from === undefined ? rng.money(...r.anchor) : from + rng.money(...r.step);

  const minOpeningDeposit = stepUp(below?.minOpeningDeposit, typeSpec.minOpeningDeposit);
  // A tier can only be free, or pay no interest, if the tier below is too; otherwise it would
  // be worse than the tier below. With two tiers the top's chances are 0, so this never bites.
  const free = (!below || below.monthlyFee.amount === 0) && rng.bool(at(typeSpec.fee.free, rank));
  const feeAmount = free ? 0 : stepUp(below?.monthlyFee.amount, typeSpec.fee);
  const minBalance = scaled(typeSpec.waiver.minBalance, typeSpec.waiver.minBalanceGrowth ** level);
  const monthlyFee: MonthlyFee =
    feeAmount === 0 || !rng.bool(spec.monthlyFee.waivableChance)
      ? { amount: feeAmount, waiver: { logic: "any", conditions: [] } }
      : {
          amount: feeAmount,
          waiver: { logic: rng.pick(spec.monthlyFee.logics), conditions: waiverConditions(rng, spec, typeSpec.waiver.kinds, minBalance) },
        };

  let interest: Interest = { structure: "none" };
  const noInterest = (!below || below.interest.structure === "none") && rng.bool(at(typeSpec.interest.none, rank));
  if (!noInterest) {
    const start = below ? highestApy(below.interest) + rng.rate(...typeSpec.interest.gapAboveBelow) : typeSpec.interest.floor;
    const base = round3(start + rng.rate(...typeSpec.interest.spread));
    interest = rng.bool(at(typeSpec.interest.tiered, rank)) ? tieredInterest(rng, spec, base) : { structure: "flat", apy: base };
  }

  const bonuses: InterestBonus[] = [];
  if (rng.bool(at(typeSpec.bonus.chance, rank))) {
    const linkTo = typeSpec.bonus.linkTo;
    const trigger = rng.pick(spec.bonus.triggers.filter((t) => t !== "linked_account" || linkTo));
    const apyBoost = rng.rate(...spec.bonus.apyBoost);
    bonuses.push(trigger === "linked_account" ? { trigger, accountType: linkTo!, apyBoost } : { trigger, apyBoost });
  }

  // Requirements follow the tier's real position: they say nothing about rates or fees.
  const req = typeSpec.requirement;
  const requirements: Requirement[] =
    req && rng.bool(at(req.chance, rankOf(position)))
      ? [{ kind: "holds_account", accountType: req.accountType, minAgeDays: rng.pick(req.minAgeDays) }]
      : [];

  const tier = spec.tiers[position]!;
  return {
    id: productId(accountType, tier),
    accountType,
    tier,
    displayName: `${name} ${accountTypeTitle(accountType)}`,
    minOpeningDeposit,
    requirements,
    monthlyFee,
    interest,
    bonuses,
  };
}

function sampleProducts(rng: Rng, spec: Spec, unordered: boolean): BankConfig["products"] {
  const scheme = rng.pick(spec.bank.nameSchemes);
  if (scheme.length < spec.tiers.length) throw new Error(`a name scheme has ${scheme.length} lists for ${spec.tiers.length} tiers`);
  const names = spec.tiers.map((_, i) => rng.pick(scheme[i]!));
  const products: BankConfig["products"] = {};
  for (const accountType of Object.keys(spec.accountTypes)) {
    let below: Product | null = null;
    spec.tiers.forEach((_, position) => {
      const p = sampleProduct(rng, spec, accountType, position, below, names[position]!, unordered);
      products[p.id] = p;
      below = p;
    });
  }
  return products;
}

function samplePolicies(rng: Rng, spec: Spec): Policies {
  return {
    identityVerification: rng.pick(spec.policies.identityVerification),
    feeReversal: { maxPerYear: rng.int(...spec.policies.courtesyReversalsPerYear) },
    eligibilityEnforcement: "agent", // "api" only for RL with weak agents, see Enforcement
  };
}

export function sampleBank(rng: Rng, seed: number, spec: Spec = SPEC): BankConfig {
  const unorderedTiers = rng.bool(spec.unorderedTiersChance);
  return {
    schemaVersion: 1,
    seed,
    bank: {
      name: `${rng.pick(spec.bank.prefixes)} ${rng.pick(spec.bank.suffixes)}`,
      simulatedDate: simulatedDate(rng, spec),
    },
    unorderedTiers,
    tiers: [...spec.tiers],
    accountTypes: Object.keys(spec.accountTypes),
    products: sampleProducts(rng, spec, unorderedTiers),
    policies: samplePolicies(rng, spec),
  };
}
