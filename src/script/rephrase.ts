// Puts the engine's customer acts into words. A plain draft is built in code; an LLM only rewrites
// it to sound natural and fit the agent's last message. Code then checks every value survived
// exactly (names, dates, amounts, products) and falls back to the draft if a rewrite loses one.

import { chat } from "../harness/llm.ts";
import { longDate, money } from "../util/format.ts";
import type { CustomerAct, CustomerScript } from "./types.ts";

const FIELD_NAMES: Record<string, string> = {
  full_name: "full name",
  date_of_birth: "date of birth",
  ssn_last4: "last four digits of my Social Security number",
  product: "product",
  amount: "amount",
  funding_account: "account",
  account: "account number",
  reason: "reason",
  other: "that",
};

// How a value must appear in the customer's message.
function spoken(field: string, value: string | number): string {
  if (field === "date_of_birth") return longDate(String(value));
  if (field === "amount") return money(Number(value));
  return String(value);
}

function sentence(a: CustomerAct): string {
  switch (a.act) {
    case "state_goal":
      return `I'd like to open a ${a.goal.product} account and fund it with ${money(a.goal.amount)} from my ${a.goal.funding_account} account.`;
    case "give_info":
      if (a.field === "funding_account") return `Please use my ${a.value} account.`;
      if (a.field === "product") return `I'd like to open ${a.value}.`;
      return `My ${FIELD_NAMES[a.field]} is ${spoken(a.field, a.value)}.`;
    case "dont_have":
      return `I'm sorry, I don't have my ${FIELD_NAMES[a.field]} with me.`;
    case "confirm":
      return "Yes, that's right. Please go ahead.";
    case "correct":
      return a.field === "funding_account"
        ? `Actually, I'd like to fund it from my ${a.value} account.`
        : `Actually, it should be ${spoken(a.field, a.value)}.`;
    case "decline":
      return `No, thank you. I'd like ${a.goal.product}.`;
    case "ask_why":
      return "Why can't I open it?";
    case "ask_when_eligible":
      return "When will I be able to open it?";
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
        return [a.goal.product, money(a.goal.amount), a.goal.funding_account];
      case "give_info":
        return [spoken(a.field, a.value)];
      case "correct":
        return [spoken(a.field, a.value)];
      case "decline":
        return [a.goal.product];
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
