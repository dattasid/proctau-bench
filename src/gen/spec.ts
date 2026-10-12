// Every number, weight and list the generator samples from, in one place. The samplers in
// sample.ts and sample_db.ts only read this. Ranges are [min, max, step]; a `...Chance` is
// the probability of the named case. Money is in dollars, rates in percent.

import type { AccountType, WaiverCondition } from "../bank/schema.ts";

export type Range = readonly [min: number, max: number, step: number];

// A value that depends on a tier's place in the ladder: `bottom` for the lowest tier, `top`
// for the highest, interpolated in between. Mostly chances; also weights and amounts.
export interface Odds {
  bottom: number;
  top: number;
}

// `rank` is 0 for the lowest tier and 1 for the highest.
export function at(o: Odds, rank: number): number {
  return o.bottom + (o.top - o.bottom) * rank;
}

// How one account type is built tier by tier. The bottom tier samples from the anchors;
// every higher tier adds a step to the tier below, so it dominates by construction.
// The key in SPEC.accountTypes is the type's name; customers see it with underscores as spaces.
export interface AccountTypeSpec {
  presence: number; // chance a bank offers this type; a type whose required type is missing is left out
  minOpeningDeposit: { anchor: Range; step: Range };
  fee: { anchor: Range; step: Range; free: Odds };
  waiver: {
    kinds: readonly WaiverCondition["kind"][];
    minBalance: Range; // for the bottom tier
    minBalanceGrowth: number; // the range is multiplied by this for each tier up
  };
  interest: {
    none: Odds;
    floor: number; // the bottom tier's lowest rate starts here
    spread: Range; // added on top of the start
    gapAboveBelow: Range; // a higher tier starts this far above the top rate of the tier below
    tiered: Odds; // otherwise flat
  };
  // linkTo: the account type a "linked_account" bonus asks for; null offers only the other triggers.
  bonus: { chance: Odds; linkTo: AccountType | null };
  // Opening requirements: an account of an earlier type, held for a while. Placed by the
  // tier's real position even on unordered banks, since it says nothing about rates or fees.
  requirement: { chance: Odds; accountType: AccountType; minAgeDays: readonly number[] } | null;
  // Background customers, considered type by type in order (see background.fallbackAccountType).
  background: {
    holdChance: number;
    tierWeight: Odds; // relative weight of each tier among the products the customer qualifies for
    startingBalanceMax: Odds; // dollars
    payroll: boolean; // paychecks land here
    spending: boolean; // card purchases come out of here, and transfers out
    receivesTransfers: boolean; // monthly transfers from the spending account land here
  };
}

// In order: a product may only require account types listed before its own.
const ACCOUNT_TYPES: Record<AccountType, AccountTypeSpec> = {
  checking: {
    presence: 1,
    minOpeningDeposit: { anchor: [0, 100, 25], step: [500, 5000, 500] },
    fee: { anchor: [5, 15, 1], step: [5, 20, 1], free: { bottom: 0, top: 0 } },
    waiver: { kinds: ["min_balance", "direct_deposit", "senior"], minBalance: [500, 2500, 250], minBalanceGrowth: 10 },
    interest: {
      none: { bottom: 0.7, top: 0 },
      floor: 0,
      spread: [0.01, 0.1, 0.01],
      gapAboveBelow: [0.05, 0.5, 0.05],
      tiered: { bottom: 0, top: 0 },
    },
    bonus: { chance: { bottom: 0, top: 0 }, linkTo: null },
    requirement: null,
    background: {
      holdChance: 0.85,
      tierWeight: { bottom: 0.7, top: 0.3 },
      startingBalanceMax: { bottom: 4000, top: 30000 },
      payroll: true,
      spending: true,
      receivesTransfers: false,
    },
  },
  savings: {
    presence: 1,
    minOpeningDeposit: { anchor: [0, 100, 25], step: [1000, 10000, 500] },
    fee: { anchor: [2, 5, 1], step: [8, 20, 1], free: { bottom: 0.4, top: 0 } },
    waiver: { kinds: ["min_balance", "linked_account", "senior"], minBalance: [300, 1500, 100], minBalanceGrowth: 15 },
    interest: {
      none: { bottom: 0, top: 0 },
      floor: 0.5,
      spread: [0, 1.5, 0.05],
      gapAboveBelow: [0.25, 1.5, 0.05],
      tiered: { bottom: 0.5, top: 0.5 },
    },
    bonus: { chance: { bottom: 0.5, top: 0.5 }, linkTo: "checking" },
    requirement: { chance: { bottom: 0, top: 0.6 }, accountType: "checking", minAgeDays: [0, 14, 30, 60, 90] },
    background: {
      holdChance: 0.6, // for customers who already hold another account
      tierWeight: { bottom: 0.65, top: 0.35 },
      startingBalanceMax: { bottom: 15000, top: 60000 },
      payroll: false,
      spending: false,
      receivesTransfers: true,
    },
  },
  business_checking: {
    presence: 0.5,
    minOpeningDeposit: { anchor: [100, 500, 50], step: [1000, 5000, 500] },
    fee: { anchor: [10, 25, 1], step: [10, 30, 1], free: { bottom: 0, top: 0 } },
    waiver: { kinds: ["min_balance", "linked_account"], minBalance: [2000, 10000, 500], minBalanceGrowth: 6 },
    interest: {
      none: { bottom: 0.8, top: 0.2 },
      floor: 0,
      spread: [0.01, 0.1, 0.01],
      gapAboveBelow: [0.05, 0.5, 0.05],
      tiered: { bottom: 0, top: 0 },
    },
    bonus: { chance: { bottom: 0, top: 0 }, linkTo: null },
    requirement: { chance: { bottom: 1, top: 1 }, accountType: "checking", minAgeDays: [0, 30, 90] },
    background: {
      holdChance: 0.5,
      tierWeight: { bottom: 0.6, top: 0.4 },
      startingBalanceMax: { bottom: 20000, top: 80000 },
      payroll: false,
      spending: false,
      receivesTransfers: false,
    },
  },
  business_savings: {
    presence: 0.7, // of banks with business checking
    minOpeningDeposit: { anchor: [500, 2000, 100], step: [2000, 10000, 500] },
    fee: { anchor: [5, 10, 1], step: [10, 20, 1], free: { bottom: 0.2, top: 0 } },
    waiver: { kinds: ["min_balance", "linked_account"], minBalance: [2500, 10000, 500], minBalanceGrowth: 8 },
    interest: {
      none: { bottom: 0, top: 0 },
      floor: 0.75,
      spread: [0, 1.5, 0.05],
      gapAboveBelow: [0.25, 1.5, 0.05],
      tiered: { bottom: 0.5, top: 0.7 },
    },
    bonus: { chance: { bottom: 0.3, top: 0.3 }, linkTo: "business_checking" },
    requirement: { chance: { bottom: 1, top: 1 }, accountType: "business_checking", minAgeDays: [30, 60, 90] },
    background: {
      holdChance: 0.8,
      tierWeight: { bottom: 0.6, top: 0.4 },
      startingBalanceMax: { bottom: 30000, top: 120000 },
      payroll: false,
      spending: false,
      receivesTransfers: false,
    },
  },
};

export const SPEC = {
  bank: {
    prefixes: ["Harbor", "Summit", "Cedar", "Lakeside", "Ironwood", "Meridian", "Northgate", "Willow"],
    suffixes: ["Bank", "Savings Bank", "Trust", "Community Bank"],
    // Product name ladders, lowest to highest. Each account type picks its own ladder and takes
    // one name per tier, in order: a run of consecutive names starting anywhere, or at the first
    // name with `fromStart`. Five names each, so a bank can have up to five tiers.
    nameLadders: [
      { names: ["Bronze", "Silver", "Gold", "Platinum", "Diamond"], fromStart: false },
      { names: ["Essential", "Plus", "Preferred", "Premier", "Private"], fromStart: false },
      { names: ["Blue", "Green", "Navy", "Emerald", "Onyx"], fromStart: false },
      { names: ["Starter", "Classic", "Select", "Elite", "Signature"], fromStart: false },
      { names: ["Level 1", "Level 2", "Level 3", "Level 4", "Level 5"], fromStart: true },
    ] as readonly { names: readonly string[]; fromStart: boolean }[],
    simulatedYear: 2026,
  },

  monthlyFee: {
    waivableChance: 0.85, // of paid fees; the rest can never be waived
    logics: ["any", "all"],
    // With "all" logic any subset is allowed, so a waiver can demand a high balance, direct
    // deposits and a senior age at once. Unrealistic but intentional: rare, valid rules test
    // whether the agent reads the policy instead of applying common-bank priors.
    conditionCount: [1, 3],
    balanceMeasures: ["daily_minimum", "monthly_average"],
    directDepositMonthly: [250, 1500, 250],
    seniorMinAge: [62, 67, 1],
  },

  // Banks whose tiers are sampled independently instead of stepping up (see
  // BankConfig.unorderedTiers). Belongs in a profile once profiles exist.
  unorderedTiersChance: 0.2,

  // Banks whose products may also require one specific earlier product (see
  // BankConfig.productRequirements); `chance` is per product, by tier.
  productRequirements: {
    bankChance: 0.25,
    chance: { bottom: 0.2, top: 0.6 } as Odds,
    minAgeDays: [0, 30, 60, 90] as readonly number[],
  },

  // Product tiers from lowest to highest. Each account type has one product per tier.
  tiers: ["basic", "premium"] as readonly string[],

  accountTypes: ACCOUNT_TYPES,

  // Shape of tiered (balance-band) interest, for any account type whose interest is tiered.
  interestTiers: {
    firstTierMinBalance: [5000, 25000, 5000],
    apyStep: [0.1, 0.75, 0.05],
    thirdTierChance: 0.5,
    thirdTierBalanceGap: [25000, 75000, 25000],
    appliesTo: ["whole_balance", "marginal"],
  },

  bonus: {
    triggers: ["direct_deposit", "linked_account"],
    apyBoost: [0.05, 0.5, 0.05],
  },

  policies: {
    identityVerification: ["once_per_session", "before_every_write"],
    courtesyReversalsPerYear: [0, 3, 1],
  },

  background: {
    customers: 6,
    firstNames: [
      "Maria", "James", "Aisha", "Daniel", "Priya", "Thomas", "Elena", "Kwame", "Sofia", "Hiroshi",
      "Grace", "Mateo", "Nadia", "Owen", "Leila", "Samuel", "Ingrid", "Ravi", "Chloe", "Marcus",
    ],
    lastNames: [
      "Chen", "Okafor", "Garcia", "Novak", "Patel", "Brennan", "Haddad", "Kim", "Lindqvist", "Mensah",
      "Rossi", "Tanaka", "Dubois", "Alvarez", "Kowalski", "Nguyen", "Abara", "Fischer", "Reyes", "Walsh",
    ],
    ageYears: [21, 85, 1],
    historyMonths: 3,
    // A customer who holds none of the earlier types always gets this one, so everyone has an
    // account; if it has no product they qualify for, they get the bank's first product.
    fallbackAccountType: "savings" as AccountType,
    accountAgeDays: [10, 1500, 1],
    startingBalance: {
      min: 50, // or the product's minimum opening deposit, if higher
      step: 50, // the maximum is per account type
    },
    paycheckChance: 0.7, // of customers with a payroll account
    paycheck: [600, 3000, 50], // per direct deposit
    payDays: [1, 15],
    courtesyReversalChance: 0.15, // of charged fees, subject to the yearly cap
    courtesyReversalDelayDays: [1, 10, 1],
    cashDepositChance: 0.05, // per day, customers without a paycheck
    cashDeposit: [100, 1500, 50],
    cardPurchaseChance: 0.3, // per day
    cardPurchaseMinCents: 500,
    cardPurchaseMaxCents: 5000, // or a fifth of the paycheck, if higher
    cardPurchasePaycheckShare: 5,
    spendingFloorCents: 10_000, // spending never takes the spending account below this, so later fees cannot overdraw it
    transferDay: 20,
    transferChance: 0.5,
    transfer: [50, 500, 50],
  },
} as const;

export type Spec = typeof SPEC;
