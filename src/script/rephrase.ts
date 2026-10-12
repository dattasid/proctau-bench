// Puts the engine's customer acts into words. A plain draft is built in code; an LLM only rewrites
// it to sound natural and fit the agent's last message. Code then checks every value survived
// exactly (names, dates, amounts, products) and falls back to the draft if a rewrite loses one.

import { chat } from "../harness/llm.ts";
import { longDate, money } from "../util/format.ts";
import type { CustomerAct, CustomerScript, Goal } from "./types.ts";

const FIELD_NAMES: Record<string, string> = {
  full_name: "full name",
  date_of_birth: "date of birth",
  ssn_last4: "last four digits of my Social Security number",
  product: "product",
  amount: "amount",
  funding_account: "account",
  account: "account",
  date: "date",
  reason: "reason",
  other: "that",
};

// How a value must appear in the customer's message.
function spoken(field: string, value: string | number): string {
  if (field === "date_of_birth" || field === "date") return longDate(String(value));
  if (field === "amount") return money(Number(value));
  return String(value);
}

function goalSentence(goal: Goal): string {
  switch (goal.action) {
    case "open_account":
      return `I'd like to open a ${goal.product} account and fund it with ${money(goal.amount)} from my ${goal.funding_account} account.`;
    case "refund_fee":
      return (
        `I was charged a ${money(goal.amount)} monthly fee on ${longDate(goal.date)} on my ${goal.account} account. ` +
        "I don't think I should have been charged, and I'd like it refunded."
      );
    case "report_transaction":
      return (
        `There's a ${money(goal.amount)} card purchase from ${goal.merchant} on ${longDate(goal.date)} on my ` +
        `${goal.account} account that I didn't make.`
      );
    case "request_service":
      return `I'd like to ${goal.request}.`;
    case "transfer_funds":
      return `I'd like to move ${money(goal.amount)} from my ${goal.from} account to my ${goal.to} account.`;
  }
}

function goalValues(goal: Goal): string[] {
  switch (goal.action) {
    case "open_account":
      return [goal.product, money(goal.amount), goal.funding_account];
    case "refund_fee":
      return [goal.account, money(goal.amount), longDate(goal.date)];
    case "report_transaction":
      return [goal.account, money(goal.amount), goal.merchant];
    case "request_service":
      return [];
    case "transfer_funds":
      return [goal.from, goal.to, money(goal.amount)];
  }
}

function sentence(a: CustomerAct): string {
  switch (a.act) {
    case "state_goal":
      return goalSentence(a.goal);
    case "give_info":
      if (a.field === "funding_account" || a.field === "account") return `It's my ${a.value} account.`;
      if (a.field === "product") return `I'd like to open ${a.value}.`;
      if (a.field === "date") return `It was charged on ${spoken(a.field, a.value)}.`;
      return `My ${FIELD_NAMES[a.field]} is ${spoken(a.field, a.value)}.`;
    case "dont_have":
      return `I'm sorry, I don't have my ${FIELD_NAMES[a.field]} with me.`;
    case "confirm":
      return "Yes, that's right. Please go ahead.";
    case "correct":
      return a.field === "funding_account"
        ? `Actually, I'd like to fund it from my ${a.value} account.`
        : a.field === "account"
          ? `Actually, it's my ${a.value} account.`
          : `Actually, it should be ${spoken(a.field, a.value)}.`;
    case "decline":
      return a.goal.action === "open_account" ? `No, thank you. I'd like ${a.goal.product}.` : "No, thank you.";
    case "ask_why":
      return "Why not?";
    case "ask_when_eligible":
      return "When will I be able to open it?";
    case "insist":
      return "I'd really like this refunded. Is there anything you can do?";
    case "ask_for_human":
      return "Could I speak to someone who can help me with this, please?";
    case "correct_info":
      return `I'm sorry, I gave you the wrong ${FIELD_NAMES[a.field]}. It's ${spoken(a.field, a.value)}.`;
    case "repeat_info":
      return "I'm quite sure the details I gave are right.";
    case "acknowledge":
      return "Okay.";
    case "thank_and_end":
      return "Thank you, that's everything. Goodbye.";
  }
}

export function draft(acts: CustomerAct[]): string {
  return acts.map(sentence).join(" ");
}

// Every value the message must contain, as it must appear.
export function requiredValues(acts: CustomerAct[]): string[] {
  return acts.flatMap((a) => {
    switch (a.act) {
      case "state_goal":
        return goalValues(a.goal);
      case "give_info":
        return [spoken(a.field, a.value)];
      case "correct":
      case "correct_info":
        return [spoken(a.field, a.value)];
      case "decline":
        return a.goal.action === "open_account" ? [a.goal.product] : [];
      default:
        return [];
    }
  });
}

const missing = (text: string, values: string[]) => values.filter((v) => !text.toLowerCase().includes(v.toLowerCase()));

const SYSTEM =
  "You write the next chat message of a bank customer talking to a customer service agent. You are given the " +
  "agent's last message and a draft of the customer's reply. Rewrite the draft so it sounds natural and answers the " +
  "agent, in one or two short sentences. Keep every name, date, amount, product and account name exactly as written " +
  "in the draft. Do not add anything the draft does not say: no new questions, requests, facts or details. Reply with " +
  "the message only.";

export interface Rephrased {
  text: string;
  draft: string;
  fellBack: boolean; // the LLM's rewrites lost a value, so the draft was sent as is
}

export async function rephrase(
  apiKey: string,
  model: string,
  script: CustomerScript,
  agentText: string,
  acts: CustomerAct[],
  tries = 2,
): Promise<Rephrased> {
  const plain = draft(acts);
  const values = requiredValues(acts);
  for (let i = 0; i < tries; i++) {
    const reply = await chat(apiKey, model, [
      { role: "system", content: SYSTEM },
      { role: "user", content: `You are ${script.name}.\n\nAgent's last message:\n${agentText}\n\nDraft reply:\n${plain}` },
    ]);
    const text = (reply.content ?? "").trim();
    if (text && missing(text, values).length === 0) return { text, draft: plain, fellBack: false };
  }
  return { text: plain, draft: plain, fellBack: true };
}
