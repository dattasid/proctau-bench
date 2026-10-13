// A scripted customer: what they know, what they want, and how they react to what the agent does.
// Templates write one per task; the engine (engine.ts) reads it after every agent turn and decides
// the customer's next move; the rephraser (rephrase.ts) only puts that move into words.

import type { InfoField } from "../extract/vocab.ts";

export interface OpenGoal {
  action: "open_account";
  product: string; // display name
  amount: number; // dollars
  funding_account: string; // display name of the customer's account
  // The customer asks the agent to pick the product by this criterion and doesn't know which one
  // it is: any product the agent proposes is accepted, and `product` is only the right answer.
  pickedByAgent?: { accountType: string; criterion: "most_interest" };
}

export interface RefundGoal {
  action: "refund_fee";
  account: string; // display name of the account the fee was charged to
  amount: number; // the fee, dollars
  date: string; // the day the fee was charged
}

export interface ReportGoal {
  action: "report_transaction"; // a card purchase the customer did not make
  account: string;
  amount: number;
  date: string;
  merchant: string;
}

export interface ServiceGoal {
  action: "request_service"; // something the bank's policies do not cover
  request: string; // what the customer says they want, e.g. "order a book of paper checks"
}

export interface TransferGoal {
  action: "transfer_funds";
  from: string; // display name of the account the money leaves
  to: string; // display name of the account it goes to
  amount: number;
}

export interface InterestGoal {
  action: "correct_interest"; // a month's interest payment the customer thinks was too low
  account: string;
  amount: number; // the interest paid, dollars
  date: string; // the day it was paid
}

export type Goal = OpenGoal | RefundGoal | ReportGoal | ServiceGoal | TransferGoal | InterestGoal;

// Situations the engine recognizes in an agent turn, from the extracted acts.
export const TRIGGERS = [
  "transferred", // the agent hands over to a human
  "closing", // the agent says goodbye
  "done", // the agent reports the goal action done
  "date_given", // the agent gives the date from which the customer can open the product
  "verification_failed", // the agent says the identity details did not match
  "refused", // the agent says no: not eligible, the fee was valid, or the goal action was not done
  "transfer_offered", // the agent offers to hand over to a human
  "confirm_mismatch", // the agent asks to confirm an action that differs from the goal
  "confirm_matches", // the agent asks to confirm the goal action
  "alternative", // the agent suggests something else
  "more_help", // the agent asks if there is anything else
  "greeted", // the agent greets
  "statement", // anything else the engine understood, with nothing to answer
] as const;
export type Trigger = (typeof TRIGGERS)[number];

// What the customer can do in reply. `end` ends the conversation without a message.
export type Reply =
  | "state_goal"
  | "confirm"
  | "correct"
  | "decline"
  | "ask_why"
  | "ask_when_eligible"
  | "insist"
  | "ask_for_human"
  | "correct_identity"
  | "give_identity"
  | "acknowledge"
  | "thank_and_end"
  | "end";

export type CustomerAct =
  | { act: "state_goal"; goal: Goal }
  | { act: "give_info"; field: InfoField; value: string | number }
  | { act: "dont_have"; field: InfoField }
  | { act: "confirm" }
  | { act: "correct"; field: string; value: string | number }
  | { act: "decline"; goal: Goal }
  | { act: "ask_why" }
  | { act: "ask_when_eligible" }
  | { act: "insist" }
  | { act: "ask_for_human" }
  | { act: "correct_info"; field: InfoField; value: string | number }
  | { act: "repeat_info" }
  | { act: "ask_recheck" }
  | { act: "acknowledge" }
  | { act: "thank_and_end" };

export interface CustomerScript {
  name: string;
  // Details the customer can give when asked. Anything else, they don't have.
  knows: Partial<Record<InfoField, string | number>>;
  // Details the customer gets wrong the first time they give them, then corrects.
  wrongFirst?: Partial<Record<InfoField, string | number>>;
  goal: Goal;
  // This task's own reactions; the shared table (engine.ts) covers every other trigger. The nth time
  // a trigger fires, the nth reply is used; the last one repeats.
  reactions: Partial<Record<Trigger, Reply[]>>;
  expectedEnding: "account_opened" | "refused_with_date" | "fee_refunded" | "transferred" | "funds_moved" | "refused" | "ticket_opened";
  // What is actually true, for checking what the agent mentions. Written by the template, which built
  // the situation and so knows it.
  truth: OpeningTruth | FeeTruth | HandoverTruth | TransferTruth | BestTruth | InterestTruth;
}

export interface InterestTruth {
  kind: "interest";
  month: string; // the month the interest was paid for
  method: string; // the bank's method
  paid: number; // dollars
  due: number; // dollars, by the bank's method and bonus rules
  bonus: { trigger: string; earned: boolean; with_bonus: number } | null; // with_bonus: the month's interest if the bonus applied
  planted: "none" | "no_bonus" | "month_end"; // why the payment is wrong, if it is
}

export interface OpeningTruth {
  kind: "opening";
  requirements: { required_account: string; min_age_days: number }[];
  eligible: boolean;
  unmet?: { required_account: string; min_age_days: number };
  eligible_date?: string;
  min_deposit: number;
}

export interface BestTruth {
  kind: "best_product";
  amount: number;
  best: string; // display name
  // Every product of the type, with its year's interest on the amount (no bonuses) and whether the
  // customer could open it now.
  candidates: { product: string; interestCents: number; eligible: boolean; why?: string }[];
}

export interface TransferTruth {
  kind: "transfer";
  limit: number | null; // transfers out of the source account allowed per month, if limited
  used: number; // transfers out of it already this month
  allowed: boolean;
}

export interface HandoverTruth {
  kind: "handover";
  reason: "unrecognized_transaction" | "out_of_scope"; // why the policy says to transfer
}

export interface FeeTruth {
  kind: "fee";
  month: string; // the month the fee was for
  waiver_met: boolean; // so the fee was charged in error
  conditions_met: string[]; // which waiver conditions held that month
  refund: "correction" | "courtesy" | "none"; // what the agent should do
  courtesy_used: number; // courtesy reversals already used this calendar year
  courtesy_cap: number;
  balance_moved_after: "none" | "add" | "remove"; // money moved after the fee, making today's balance misleading
}
