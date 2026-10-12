// Every number, weight and list the generator samples from, in one place. The samplers in
// sample.ts and sample_db.ts only read this. Ranges are [min, max, step]; a `...Chance` is
// the probability of the named case. Money is in dollars, rates in percent.

import type { WaiverCondition } from "../bank/schema.ts";

export type Range = readonly [min: number, max: number, step: number];

// A chance that depends on a tier's place in the ladder: `bottom` for the lowest tier, `top`
// for the highest, interpolated in between.
export interface Odds {
  bottom: number;
  top: number;
}

// How one product family is built tier by tier. The bottom tier samples from the anchors;
// every higher tier adds a step to the tier below, so it dominates by construction.
export interface FamilySpec {
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
  bonus: Odds;
}

export const SPEC = {
  bank: {
    prefixes: ["Harbor", "Summit", "Cedar", "Lakeside", "Ironwood", "Meridian", "Northgate", "Willow"],
    suffixes: ["Bank", "Savings Bank", "Trust", "Community Bank"],
    // One scheme per bank, one list per tier from lowest to highest; each tier's products
    // take a name from its list. Every scheme needs at least as many lists as there are tiers.
    nameSchemes: [
      [["Bronze", "Silver"], ["Gold", "Platinum"]],
      [["Blue", "Green"], ["Navy", "Emerald"]],
      [["Essential", "Everyday"], ["Plus", "Preferred"]],
    ],
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

  // Product tiers from lowest to highest. Each family has one product per tier.
  tiers: ["basic", "premium"],

  families: {
    checking: {
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
      bonus: { bottom: 0, top: 0 },
    },
    savings: {
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
      bonus: { bottom: 0.5, top: 0.5 },
    },
  } satisfies Record<"checking" | "savings", FamilySpec>,

  // Shape of tiered (balance-band) interest, for any family whose interest is tiered.
  interestTiers: {
    firstTierMinBalance: [5000, 25000, 5000],
    apyStep: [0.1, 0.75, 0.05],
    thirdTierChance: 0.5,
    thirdTierBalanceGap: [25000, 75000, 25000],
    appliesTo: ["whole_balance", "marginal"],
  },

  bonus: {
    triggers: ["direct_deposit", "linked_checking"],
    apyBoost: [0.05, 0.5, 0.05],
  },

  policies: {
    identityVerification: ["once_per_session", "before_every_write"],
    courtesyReversalsPerYear: [0, 3, 1],
    premiumSavingsRequiresCheckingChance: 0.6,
    minCheckingAgeDays: [0, 14, 30, 60, 90],
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
    accountAgeDays: [10, 1500, 1],
    checkingChance: 0.85,
    premiumCheckingChance: 0.3,
    savingsAlongsideCheckingChance: 0.6, // customers without checking always have savings
    premiumSavingsChance: 0.35, // only when eligible
    startingBalance: {
      min: 50, // or the product's minimum opening deposit, if higher
      step: 50,
      max: { checking_basic: 4000, checking_premium: 30000, savings_basic: 15000, savings_premium: 60000 },
    },
    paycheckChance: 0.7, // of customers with checking
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
    spendingFloorCents: 10_000, // spending never takes checking below this, so later fees cannot overdraw it
    savingsTransferDay: 20,
    savingsTransferChance: 0.5,
    savingsTransfer: [50, 500, 50],
  },
} as const;
