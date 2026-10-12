// The vocabulary the extractor formalizes agent turns into: dialogue acts with typed arguments.
// Defined as data so the same definitions build the extractor's prompt, its tool schema and the
// validation of what it returns. Acts say what the agent said, never whether it was right.

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
}

const ACTIONS = ["open_account", "transfer_funds", "refund_fee", "close_account", "other"] as const;

const INFO_FIELDS = [
  "full_name", "date_of_birth", "ssn_last4", "product", "amount", "funding_account", "account", "reason", "other",
] as const;

export const POLICY_RULES = [
  "eligibility_requirement", // what a product requires the customer to hold, and whether they meet it
  "opening_minimum_deposit",
  "monthly_fee",
  "fee_waiver",
  "interest_rate",
  "courtesy_reversal_cap",
  "identity_verification",
  "other",
] as const;

export const ACTS: readonly ActSpec[] = [
  { name: "greet", description: "A greeting or an offer to help, with no other content.", args: {} },
  {
    name: "request_info",
    description: "The agent asks the customer for one piece of information. One act per field asked for.",
    args: {
      field: { type: "string", enum: INFO_FIELDS, description: "What is asked for." },
      detail: { type: "string", optional: true, description: "Only for field=other: what exactly is asked for." },
    },
  },
  {
    name: "ask_confirmation",
    description: "The agent asks the customer to confirm or consent to an action before taking it.",
    args: {
      action: { type: "string", enum: ACTIONS, description: "The action to be confirmed." },
      product: { type: "string", optional: true, description: "Product name, as the bank names it." },
      amount: { type: "number", optional: true, description: "Dollars: the deposit or transfer amount." },
      funding_account: { type: "string", optional: true, description: "The account money comes from, by name or id." },
      account: { type: "string", optional: true, description: "Another account involved, e.g. a transfer's destination or the account a fee was charged to." },
    },
  },
  {
    name: "report_verification",
    description: "The agent tells the customer whether their identity was verified.",
    args: { verified: { type: "boolean", description: "True if the agent says verification succeeded." } },
  },
  {
    name: "inform_account",
    description: "The agent states facts about an account the customer already held before this turn.",
    args: {
      account: { type: "string", description: "The account, by product name or id, as the agent refers to it." },
      balance: { type: "number", optional: true, description: "Dollars, if a balance is stated." },
      opened_on: { type: "date", optional: true, description: "If an opening date is stated." },
      other: { type: "string", optional: true, description: "Any other stated fact, briefly." },
    },
  },
  {
    name: "report_action",
    description: "The agent reports the outcome of an action: done, not done (declined or not attempted), or failed.",
    args: {
      action: { type: "string", enum: ACTIONS, description: "The action." },
      status: { type: "string", enum: ["done", "not_done", "failed"], description: "Outcome as the agent states it." },
      product: { type: "string", optional: true, description: "Product name, as the bank names it." },
      amount: { type: "number", optional: true, description: "Dollars: the deposit, transfer or refund amount." },
      funding_account: { type: "string", optional: true, description: "The account money came from, by name or id." },
      account: { type: "string", optional: true, description: "Another account involved, e.g. a transfer's destination or the account a fee was charged to." },
      balance: { type: "number", optional: true, description: "Dollars: a resulting balance, if stated." },
    },
  },
  {
    name: "policy_claim",
    description:
      "The agent states a bank rule or applies one to the customer. One act per rule mentioned. Fill only the " +
      "arguments the agent actually stated.",
    args: {
      rule: { type: "string", enum: POLICY_RULES, description: "Which rule." },
      product: { type: "string", optional: true, description: "The product the rule is about." },
      required_account: {
        type: "string",
        optional: true,
        description: "For eligibility: the account the rule requires, as the rule states it (an account type like 'checking', or a product name), not the customer's own account.",
      },
      min_age_days: { type: "number", optional: true, description: "For eligibility: how long it must have been held, in days." },
      met: { type: "boolean", optional: true, description: "Whether the agent says the customer meets the rule." },
      eligible_from: { type: "date", optional: true, description: "The date the agent says the customer becomes eligible." },
      amount: { type: "number", optional: true, description: "Dollars: a minimum deposit, fee or waiver threshold." },
      rate: { type: "number", optional: true, description: "Percent APY." },
      count: { type: "number", optional: true, description: "A count, e.g. courtesy reversals allowed or remaining." },
      detail: { type: "string", optional: true, description: "Only for rule=other, or a condition no argument covers." },
    },
  },
  {
    name: "offer_alternative",
    description: "The agent suggests a different product or action instead of the one asked for.",
    args: { product: { type: "string", optional: true, description: "Product suggested." }, detail: { type: "string", optional: true, description: "Otherwise, what is suggested." } },
  },
  { name: "offer_more_help", description: "The agent asks whether there is anything else it can help with.", args: {} },
  {
    name: "transfer_to_human",
    description: "The agent says it is transferring the customer to a human agent.",
    args: { reason: { type: "string", optional: true, description: "The reason given, briefly." } },
  },
  { name: "closing", description: "A goodbye or thanks that ends the conversation, with no other content.", args: {} },
  {
    name: "unknown",
    description: "Anything that fits no other act. Use it rather than stretching an act to fit; the quote carries the text.",
    args: {},
  },
];

export const ACT_NAMES = ACTS.map((a) => a.name);
