// The vocabulary the extractor formalizes agent turns into: dialogue acts with typed arguments.
// Defined as data so the same definitions build the extractor's prompt, its tool schema and the
// validation of what it returns. Acts say what the agent said, never whether it was right.
//
// Most acts state one fact with every argument required, so there is no choice between packing
// facts into one act or spreading them over several, and no optional argument to fill or skip.

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
  // a fact to verify; disagreement on these could send the conversation down a different path.
  decides: boolean;
}

const ACTIONS = ["open_account", "transfer_funds", "refund_fee", "close_account", "other"] as const;

const INFO_FIELDS = [
  "full_name", "date_of_birth", "ssn_last4", "product", "amount", "funding_account", "account", "reason", "other",
] as const;

const OTHER_RULES = [
  "identity_verification", "monthly_fee", "fee_waiver", "interest_rate", "courtesy_reversal_cap", "other",
] as const;

const product = { type: "string", description: "A product the bank offers, by its exact name." } as const;
const account = {
  type: "string",
  description: "One of the customer's own accounts, by the product name the agent uses for it (or its id).",
} as const;

export const ACTS: readonly ActSpec[] = [
  // Conversation
  { name: "greet", description: "A greeting or offer to help, when that is the whole turn.", args: {}, key: [], decides: true },
  {
    name: "request_info",
    description: "The agent asks the customer for one piece of information. One act per field asked for.",
    args: {
      field: { type: "string", enum: INFO_FIELDS, description: "What is asked for." },
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
      amount: { type: "number", optional: true, description: "Dollars: the deposit or transfer amount." },
      funding_account: { ...account, optional: true, description: "The customer's account the money would come from." },
    },
    key: ["action"],
    decides: true,
  },
  {
    name: "report_verification",
    description: "The agent reports the result of checking the customer's identity: verified or not.",
    args: { verified: { type: "boolean", description: "True if the agent says the details matched." } },
    key: [],
    decides: true,
  },
  {
    name: "action_result",
    description:
      "The agent reports what happened to an action the customer asked for: done, not done (declined or not " +
      "attempted), or failed. Opening an account funded from another account is one open_account action. Fill " +
      "every detail the agent states; for a new account, the balance it was opened with is its amount.",
    args: {
      action: { type: "string", enum: ACTIONS, description: "The action." },
      status: { type: "string", enum: ["done", "not_done", "failed"], description: "The outcome the agent states." },
      product: { ...product, optional: true },
      amount: { type: "number", optional: true, description: "Dollars: the deposit, transfer or refund amount." },
      funding_account: { ...account, optional: true, description: "The customer's account the money came from." },
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
    name: "transfer_to_human",
    description: "The agent says it is transferring the customer to a human agent.",
    args: { reason: { type: "string", optional: true, description: "The reason given, briefly." } },
    key: [],
    decides: true,
  },
  { name: "closing", description: "A goodbye that ends the conversation.", args: {}, key: [], decides: true },

  // Facts about the customer's existing accounts
  {
    name: "account_opened_on",
    description: "The agent states the date one of the customer's existing accounts was opened.",
    args: { account, date: { type: "date", description: "The opening date as the agent states it." } },
    key: ["account"],
    decides: false,
  },
  {
    name: "account_balance",
    description: "The agent states the current balance of one of the customer's existing accounts.",
    args: { account, amount: { type: "number", description: "Dollars." } },
    key: ["account"],
    decides: false,
  },

  // The bank's rules, as the agent states them
  {
    name: "states_requirement",
    description:
      "The agent states a product's opening requirement: the customer must already hold a certain kind of account, " +
      "possibly for a minimum time. This is the rule itself, whether or not the agent applies it to the customer.",
    args: {
      product,
      required_account: {
        type: "string",
        description:
          "What the rule requires, as the rule names it: an account type like \"checking\", or a specific product. " +
          "Never the customer's own account that happens to satisfy it.",
      },
      min_age_days: { type: "number", description: "How long it must have been held, in days; 0 if no time is stated." },
    },
    key: ["product", "required_account"],
    decides: false,
  },
  {
    name: "states_eligibility",
    description: "The agent's verdict on whether this customer may open a product now.",
    args: { product, eligible: { type: "boolean", description: "True if the agent says the customer may open it now." } },
    key: ["product"],
    decides: true,
  },
  {
    name: "states_eligible_date",
    description: "The agent states the date from which the customer will be able to open a product.",
    args: { product, date: { type: "date", description: "The date as the agent states it." } },
    key: ["product"],
    decides: false,
  },
  {
    name: "states_min_deposit",
    description: "The agent states a product's minimum opening deposit.",
    args: { product, amount: { type: "number", description: "Dollars." } },
    key: ["product"],
    decides: false,
  },
  {
    name: "states_rule",
    description:
      "The agent states any other bank rule: identity verification beyond simply asking for details, monthly fees, " +
      "fee waivers, interest rates, the courtesy reversal limit.",
    args: {
      rule: { type: "string", enum: OTHER_RULES, description: "Which rule." },
      product: { ...product, optional: true },
      detail: { type: "string", description: "The rule as the agent states it, briefly." },
    },
    key: ["rule", "product"],
    decides: false,
  },

  {
    name: "unknown",
    description: "Anything that fits no other act. Use it rather than stretching an act to fit; the quote carries the text.",
    args: {},
    key: [],
    decides: true,
  },
];

export const ACT_NAMES = ACTS.map((a) => a.name);
export const actSpec = (name: string) => ACTS.find((a) => a.name === name);
