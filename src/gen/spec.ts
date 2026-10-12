// Every number, weight and list the generator samples from, in one place. The samplers in
// sample.ts and sample_db.ts only read this. Ranges are [min, max, step]; a `...Chance` is
// the probability of the named case. Money is in dollars, rates in percent.

export type Range = readonly [min: number, max: number, step: number];

export const SPEC = {
  bank: {
    prefixes: ["Harbor", "Summit", "Cedar", "Lakeside", "Ironwood", "Meridian", "Northgate", "Willow"],
    suffixes: ["Bank", "Savings Bank", "Trust", "Community Bank"],
    // One scheme per bank: basic products take a name from the first list, premium from the second.
    nameSchemes: [
      { basic: ["Bronze", "Silver"], premium: ["Gold", "Platinum"] },
      { basic: ["Blue", "Green"], premium: ["Navy", "Emerald"] },
      { basic: ["Essential", "Everyday"], premium: ["Plus", "Preferred"] },
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

  checking: {
    basic: {
      minOpeningDeposit: [0, 100, 25],
      fee: [5, 15, 1],
      waiverMinBalance: [500, 2500, 250],
      interestChance: 0.3,
      apy: [0.01, 0.1, 0.01],
    },
    premium: {
      minOpeningDeposit: [500, 5000, 500],
      feeAboveBasic: [5, 20, 1],
      waiverMinBalance: [5000, 25000, 2500],
      apyAboveBasic: [0.05, 0.5, 0.05],
    },
  },

  savings: {
    basic: {
      minOpeningDeposit: [0, 100, 25],
      freeChance: 0.4,
      fee: [2, 5, 1],
      waiverMinBalance: [300, 1500, 100],
      apyFloor: 0.5,
    },
    premium: {
      minOpeningDeposit: [1000, 10000, 500],
      feeAboveBasic: [8, 20, 1],
      waiverMinBalance: [5000, 25000, 2500],
      // Premium's lowest rate starts this far above Basic's highest rate.
      apyGapAboveBasicTop: [0.25, 1.5, 0.05],
    },
    interest: {
      apyAboveFloor: [0, 1.5, 0.05],
      flatChance: 0.5,
      firstTierMinBalance: [5000, 25000, 5000],
      tierApyStep: [0.1, 0.75, 0.05],
      thirdTierChance: 0.5,
      thirdTierBalanceGap: [25000, 75000, 25000],
      appliesTo: ["whole_balance", "marginal"],
    },
    bonus: {
      chance: 0.5,
      triggers: ["direct_deposit", "linked_checking"],
      apyBoost: [0.05, 0.5, 0.05],
    },
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
