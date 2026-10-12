// The vocabulary the extractor formalizes agent turns into: dialogue acts with typed arguments.
// Defined as data so the same definitions build the extractor's prompt, its tool schema and the
// validation of what it returns. Acts record what the agent said, never whether it was right.
//
// Conversation acts move the conversation (questions, outcomes); `mentions_*` acts record one fact
// the agent claimed, with every argument required where possible, so there is no choice between
// packing facts into one act or spreading them over several. Aliases are extra acts that match how
// the extractor naturally reads a sentence; code maps each to the act it means, or drops it.

export type ArgType = "string" | "number" | "boolean" | "date";

export interface ArgSpec {
  type: ArgType;
  description: string;
  enum?: readonly string[];
  optional?: boolean;
}

export interface ActSpec {
  name: string;
  description: string;
  args: Record<string, ArgSpec>;
  // Arguments that identify which fact this is (the rest are its value). Two acts with the same
  // name and key are the same fact; if their values differ, they conflict.
  key: readonly string[];
  // Whether the customer's next reply depends on this act. Disagreement on other acts only loses
  // a fact to check; disagreement on these could send the conversation down a different path.
  decides: boolean;
  // An alias: code replaces it with this act (same argument names), or drops it with "ignore".
  aliasOf?: string;
}

export const ACTIONS = ["open_account", "transfer_funds", "refund_fee", "close_account", "dispute_transaction", "other"] as const;

export const INFO_FIELDS = [
  "full_name", "date_of_birth", "ssn_last4", "product", "amount", "funding_account", "account", "date", "reason", "other",
] as const;
export type InfoField = (typeof INFO_FIELDS)[number];

const OTHER_RULES = [
  "identity_verification", "monthly_fee", "fee_waiver", "interest_rate", "courtesy_reversal_cap", "other",
] as const;

const product = { type: "string", description: "A product the bank offers, by its exact name." } as const;
const account = {
  type: "string",
  description: "One of the customer's own accounts, by the product name the agent uses for it (or its number).",
} as const;
const dollars = { type: "number", description: "Dollars." } as const;

export const ACTS: readonly ActSpec[] = [
  // ---- Conversation
  { name: "greet", description: "A greeting or offer to help, when that is the whole turn.", args: {}, key: [], decides: true },
  {
    name: "request_info",
    description: "The agent asks the customer for one piece of information. One act per field asked for.",
    args: {
      field: {
        type: "string",
        enum: INFO_FIELDS,
        description:
          "What is asked for. Which of the customer's accounts to fund from is funding_account; which account " +
          "something happened on (e.g. a fee) is account; when something happened is date.",
      },
      detail: { type: "string", optional: true, description: "Only for field=other: what exactly is asked for." },
    },
    key: ["field"],
    decides: true,
  },
  {
    name: "ask_confirmation",
    description:
      "The agent asks the customer to confirm or agree to an action before taking it. Fill every detail of the " +
      "action the agent states.",
    args: {
      action: { type: "string", enum: ACTIONS, description: "The action to be confirmed." },
      product: { ...product, optional: true },
      amount: { type: "number", optional: true, description: "Dollars: the deposit, transfer or refund amount." },
      funding_account: { ...account, optional: true, description: "The customer's account the money would come from." },
      account: { ...account, optional: true, description: "The customer's account the action is on, e.g. the account a fee was charged to." },
      refund_type: { type: "string", optional: true, enum: ["correction", "courtesy"], description: "For a fee refund: as a correction or as a courtesy." },
    },
    key: ["action"],
    decides: true,
  },
  {
    name: "report_verification",
    description: "The agent reports the result of a verification it carried out: whether the details matched.",
    args: {
      subject: { type: "string", enum: ["identity"], description: "What was verified." },
      passed: { type: "boolean", description: "True if the agent says the details matched." },
    },
    key: ["subject"],
    decides: true,
  },
  {
    name: "action_result",
    description:
      "The agent reports what happened to an action the customer asked for: done, not done (declined or not " +
      "attempted), or failed. Opening an account funded from another account is one open_account action, and " +
      "\"I haven't opened anything or moved any money\" is that same open_account, not done. Fill every detail the " +
      "agent states; for a new account, the balance it was opened with is its amount.",
    args: {
      action: { type: "string", enum: ACTIONS, description: "The action." },
      status: { type: "string", enum: ["done", "not_done", "failed"], description: "The outcome the agent states." },
      product: { ...product, optional: true },
      amount: { type: "number", optional: true, description: "Dollars: the deposit, transfer or refund amount." },
      funding_account: { ...account, optional: true, description: "The customer's account the money came from." },
      account: { ...account, optional: true, description: "The customer's account the action was on, e.g. the account a fee was charged to." },
      refund_type: { type: "string", optional: true, enum: ["correction", "courtesy"], description: "For a fee refund: as a correction or as a courtesy." },
      account_number: { type: "string", optional: true, description: "The new account's number or its last digits, if stated." },
      date: { type: "date", optional: true, description: "The date it was done, if stated." },
    },
    key: ["action"],
    decides: true,
  },
  {
    name: "offer_alternative",
    description: "The agent suggests a different product or action instead of the one the customer asked for.",
    args: {
      product: { ...product, optional: true },
      detail: { type: "string", optional: true, description: "Otherwise, what is suggested." },
    },
    key: [],
    decides: true,
  },
  { name: "offer_more_help", description: "The agent asks whether it can help with anything else.", args: {}, key: [], decides: true },
  {
    name: "offer_transfer",
    description: "The agent offers to transfer the customer to a human agent, without doing it yet (\"I can transfer you if you like\").",
    args: { reason: { type: "string", optional: true, description: "The reason given, briefly." } },
    key: [],
    decides: true,
  },
  {
    name: "transfer_to_human",
    description: "The agent says it is transferring the customer to a human agent now.",
    args: { reason: { type: "string", optional: true, description: "The reason given, briefly." } },
    key: [],
    decides: true,
  },
  { name: "closing", description: "A goodbye that ends the conversation.", args: {}, key: [], decides: true },

  // ---- Facts about the customer's accounts
  {
    name: "mentions_account_opened_on",
    description: "The agent mentions the date one of the customer's existing accounts was opened.",
    args: { account, date: { type: "date", description: "The opening date." } },
    key: ["account"],
    decides: false,
  },
  {
    name: "mentions_account_age",
    description: "The agent mentions how long one of the customer's accounts has been open, as a number of days.",
    args: { account, days: { type: "number", description: "Days, as stated." } },
    key: ["account"],
    decides: false,
  },
  {
    name: "mentions_account_balance",
    description: "The agent mentions the current balance of one of the customer's existing accounts.",
    args: { account, amount: dollars },
    key: ["account"],
    decides: false,
  },
  {
    name: "mentions_account_state",
    description:
      "The agent mentions whether one of the customer's accounts is open or closed, including as a condition " +
      "(\"as long as your checking account stays open\").",
    args: { account, state: { type: "string", enum: ["open", "closed"], description: "The state mentioned." } },
    key: ["account"],
    decides: false,
  },
  {
    name: "mentions_funds_sufficient",
    description: "The agent mentions whether an account has enough money for an amount.",
    args: {
      account,
      amount: dollars,
      sufficient: { type: "boolean", description: "True if the agent says there is enough." },
    },
    key: ["account"],
    decides: false,
  },

  {
    name: "mentions_transaction",
    description: "The agent mentions a specific transaction on one of the customer's accounts.",
    args: {
      account,
      amount: dollars,
      date: { type: "date", optional: true, description: "Its date, if stated." },
      description: { type: "string", optional: true, description: "The merchant or memo, if stated." },
    },
    key: ["account", "amount"],
    decides: false,
  },
  {
    name: "mentions_fee_valid",
    description:
      "The agent says whether a monthly fee was charged correctly (valid: the waiver was not met) or charged in " +
      "error (the waiver was met).",
    args: {
      account,
      valid: { type: "boolean", description: "True if the agent says the fee was charged correctly." },
    },
    key: ["account"],
    decides: true,
  },
  {
    name: "mentions_courtesy_remaining",
    description: "The agent mentions how many courtesy fee reversals the customer has left this year.",
    args: { count: { type: "number", description: "How many are left, as stated." } },
    key: [],
    decides: false,
  },

  // ---- The bank's rules, as the agent mentions them
  {
    name: "mentions_requirement",
    description:
      "The agent mentions a product's opening requirement: the customer must already hold a certain kind of " +
      "account, possibly for a minimum time. The rule itself, whether or not it is applied to this customer.",
    args: {
      product,
      required_account: {
        type: "string",
        description:
          "What the rule requires, as the rule names it: an account type like \"checking\", or a specific product. " +
          "Never the customer's own account that happens to satisfy it.",
      },
      min_age_days: { type: "number", description: "How long it must have been held, in days; 0 if no time is mentioned." },
    },
    key: ["product", "required_account"],
    decides: false,
  },
  {
    name: "mentions_eligibility",
    description: "The agent's verdict on whether this customer may open a product now.",
    args: { product, eligible: { type: "boolean", description: "True if the agent says the customer may open it now." } },
    key: ["product"],
    decides: true,
  },
  {
    name: "mentions_eligible_date",
    description: "The agent mentions the date from which the customer will be able to open a product.",
    args: { product, date: { type: "date", description: "The date as the agent gives it." } },
    key: ["product"],
    decides: true,
  },
  {
    name: "mentions_min_deposit",
    description: "The agent mentions a product's minimum opening deposit.",
    args: { product, amount: dollars },
    key: ["product"],
    decides: false,
  },
  {
    name: "mentions_deposit_meets_minimum",
    description: "The agent says whether a proposed deposit meets a product's minimum.",
    args: { product, amount: dollars, meets: { type: "boolean", description: "True if the agent says it meets the minimum." } },
    key: ["product"],
    decides: false,
  },
  {
    name: "mentions_rule",
    description:
      "The agent mentions any other bank rule: identity verification beyond simply asking for details, monthly " +
      "fees, fee waivers, interest rates, the courtesy reversal limit.",
    args: {
      rule: { type: "string", enum: OTHER_RULES, description: "Which rule." },
      product: { ...product, optional: true },
      detail: { type: "string", description: "The rule as the agent states it, briefly." },
    },
    key: ["rule", "product"],
    decides: false,
  },

  // ---- Aliases
  {
    name: "restates_eligible_date",
    description:
      "The agent repeats or rephrases a date from which the customer can open a product, e.g. \"please contact us " +
      "again on or after April 4, 2026\".",
    args: { product, date: { type: "date", description: "The date." } },
    key: ["product"],
    decides: true,
    aliasOf: "mentions_eligible_date",
  },
  {
    name: "pleasantry",
    description: "Politeness with no content: \"Sure, I can help with that\", \"Thanks for your patience\", a greeting inside a longer turn.",
    args: {},
    key: [],
    decides: false,
    aliasOf: "ignore",
  },

  {
    name: "unknown",
    description:
      "Only for something no other act can express: an off-topic remark, a promise or claim outside banking, " +
      "nonsense. Never for an ordinary sentence the acts above cover.",
    args: {},
    key: [],
    decides: true,
  },
];

export const ACT_NAMES = ACTS.map((a) => a.name);
export const actSpec = (name: string) => ACTS.find((a) => a.name === name);
