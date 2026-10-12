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
  earlier: Product[] | null, // every product sampled before this one; null: no product requirements
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
  const requirements: Requirement[] = [];
  if (req && rng.bool(at(req.chance, rankOf(position)))) {
    requirements.push({ kind: "holds_account", accountType: req.accountType, minAgeDays: rng.pick(req.minAgeDays) });
  }
  const pr = spec.productRequirements;
  if (earlier && earlier.length > 0 && rng.bool(at(pr.chance, rankOf(position)))) {
    requirements.push({ kind: "holds_product", productId: rng.pick(earlier).id, minAgeDays: rng.pick(pr.minAgeDays) });
  }

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

// One name per tier, lowest first, from a random ladder.
function tierNames(rng: Rng, spec: Spec): string[] {
  const n = spec.tiers.length;
  const ladder = rng.pick(spec.bank.nameLadders);
  if (ladder.names.length < n) throw new Error(`a name ladder has ${ladder.names.length} names for ${n} tiers`);
  const offset = ladder.fromStart ? 0 : rng.int(0, ladder.names.length - n);
  return ladder.names.slice(offset, offset + n);
}

function sampleProducts(rng: Rng, spec: Spec, accountTypes: string[], unordered: boolean, productRequirements: boolean): BankConfig["products"] {
  const products: BankConfig["products"] = {};
  for (const accountType of accountTypes) {
    const names = tierNames(rng, spec);
    let below: Product | null = null;
    spec.tiers.forEach((_, position) => {
      const earlier = productRequirements ? Object.values(products) : null;
      const p = sampleProduct(rng, spec, accountType, position, below, names[position]!, unordered, earlier);
      products[p.id] = p;
      below = p;
    });
  }
  return products;
}

function samplePolicies(rng: Rng, spec: Spec, accountTypes: string[]): Policies {
  const limited = accountTypes.filter((t) => spec.accountTypes[t]!.transferOutLimited);
  return {
    identityVerification: rng.pick(spec.policies.identityVerification),
    feeReversal: { maxPerYear: rng.int(...spec.policies.courtesyReversalsPerYear) },
    eligibilityEnforcement: "agent", // "api" only for RL with weak agents, see Enforcement
    transferLimit:
      limited.length > 0 && rng.bool(spec.policies.transferLimitChance)
        ? { perMonth: rng.int(...spec.policies.transfersOutPerMonth), accountTypes: limited }
        : null,
  };
}

// The account types this bank offers, in spec order. A type whose required type is missing is left out.
function sampleAccountTypes(rng: Rng, spec: Spec): string[] {
  const offered: string[] = [];
  for (const [t, typeSpec] of Object.entries(spec.accountTypes)) {
    const needs = typeSpec.requirement?.accountType;
    if ((needs === undefined || offered.includes(needs)) && rng.bool(typeSpec.presence)) offered.push(t);
  }
  return offered;
}

export function sampleBank(rng: Rng, seed: number, spec: Spec = SPEC): BankConfig {
  const unorderedTiers = rng.bool(spec.unorderedTiersChance);
  const accountTypes = sampleAccountTypes(rng, spec);
  const productRequirements = rng.bool(spec.productRequirements.bankChance);
  return {
    schemaVersion: 1,
    seed,
    bank: {
      name: `${rng.pick(spec.bank.prefixes)} ${rng.pick(spec.bank.suffixes)}`,
      simulatedDate: simulatedDate(rng, spec),
    },
    unorderedTiers,
    tiers: [...spec.tiers],
    accountTypes,
    productRequirements,
    products: sampleProducts(rng, spec, accountTypes, unorderedTiers, productRequirements),
    policies: samplePolicies(rng, spec, accountTypes),
  };
}
