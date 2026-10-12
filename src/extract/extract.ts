// Formalizes one agent turn into dialogue acts from the vocabulary. The extractor never sees the
// task: only the bank's product names, the conversation so far (to resolve references) and the
// turn itself. Every act carries a verbatim quote, checked against the turn, so an act the agent
// never said is caught. Optionally runs several times and compares the samples (normalize.ts).

import { chat } from "../harness/llm.ts";
import type { ChatTool } from "../harness/llm.ts";
import { compareSamples, groundActs, normalizeActs, resolveAliases } from "./normalize.ts";
import type { Comparison, Names } from "./normalize.ts";
import { ACTS, ACT_NAMES } from "./vocab.ts";
import type { ActSpec } from "./vocab.ts";

export interface Act {
  act: string;
  args: Record<string, unknown>;
  quote: string;
}

export interface Extraction {
  acts: Act[];
  errors: string[]; // validation problems
  dropped: string[]; // number and date arguments removed because the agent never said them
}

export interface ExtractContext extends Names {
  bankName?: string;
  history: { role: "agent" | "user"; content: string }[]; // turns before this one
}

function describeAct(a: ActSpec): string {
  const args = Object.entries(a.args).map(([k, s]) => {
    const values = s.enum ? ` One of: ${s.enum.join(", ")}.` : "";
    return `    - ${k} (${s.type}${s.optional ? ", optional" : ""}): ${s.description}${values}`;
  });
  return `- ${a.name}: ${a.description}${args.length > 0 ? `\n${args.join("\n")}` : ""}`;
}

// Worked examples. Products, names and dates are made up and differ from every saved run, so
// they teach the decisions without giving away answers.
const EXAMPLES = `
Example 1
Agent turn: "Sure, I can help. Before I make any changes, I'll need your full name, date of birth and the last four digits of your Social Security number."
Acts:
- pleasantry()
- request_info(field="full_name")
- request_info(field="date_of_birth")
- request_info(field="ssn_last4")
(Asking for identity details is only request_info, even with "before I make any changes".)

Example 2
Agent turn: "Thanks, you're verified. Navy Savings requires a checking account held for at least 60 days. Your Classic Checking was opened on February 3, 2026, so you don't qualify yet; you will on April 4, 2026. I haven't opened anything or moved any money."
Acts:
- report_verification(subject="identity", passed=true)
- mentions_requirement(product="Navy Savings", required_account="checking", min_age_days=60)
- mentions_account_opened_on(account="Classic Checking", date="2026-02-03")
- mentions_eligibility(product="Navy Savings", eligible=false)
- mentions_eligible_date(product="Navy Savings", date="2026-04-04")
- action_result(action="open_account", status="not_done", product="Navy Savings")
(required_account is "checking", the rule's wording, not "Classic Checking". "Haven't moved any money" is the same not-done opening, not a separate transfer.)

Example 3
Agent turn: "Unfortunately you aren't eligible for Navy Savings yet. You can apply once your checking account has been open for 60 days."
Acts:
- mentions_eligibility(product="Navy Savings", eligible=false)
- mentions_requirement(product="Navy Savings", required_account="checking", min_age_days=60)
(No date is given, so there is no mentions_eligible_date. Never work one out.)

Example 4
Agent turn: "Your checking account meets the 60-day requirement for Navy Savings. Before I open it I need to verify you again, since we re-verify before every change. What is your date of birth?"
Acts:
- mentions_requirement(product="Navy Savings", required_account="checking", min_age_days=60)
- mentions_eligibility(product="Navy Savings", eligible=true)
- mentions_rule(rule="identity_verification", detail="verification is repeated before every change")
- request_info(field="date_of_birth")
(Asking to verify again is not a failed verification, so no report_verification.)

Example 5
Agent turn: "Done! Your Navy Savings account is open with a $3,000 balance, transferred from your Classic Checking account. Its number ends in 4417. Your Classic Checking balance is now $1,240. Anything else I can help with?"
Acts:
- action_result(action="open_account", status="done", product="Navy Savings", amount=3000, funding_account="Classic Checking", account_number="4417")
- mentions_account_balance(account="Classic Checking", amount=1240)
- offer_more_help()
(Opening funded from another account is one open_account action; the new account's balance is its amount.)

Example 6
Agent turn: "Just to confirm: I'll open Navy Savings with $3,000 from Classic Checking. The minimum opening deposit is $2,500. Shall I go ahead?"
Acts:
- ask_confirmation(action="open_account", product="Navy Savings", amount=3000, funding_account="Classic Checking")
- mentions_min_deposit(product="Navy Savings", amount=2500)

Example 7
Agent turn: "Good news: your Classic Checking has been open 41 days and has enough funds for the $3,000 deposit, which meets Navy Savings' minimum. Shall I open Navy Savings with $3,000 from Classic Checking?"
Acts:
- mentions_account_age(account="Classic Checking", days=41)
- mentions_funds_sufficient(account="Classic Checking", amount=3000, sufficient=true)
- mentions_deposit_meets_minimum(product="Navy Savings", amount=3000, meets=true)
- ask_confirmation(action="open_account", product="Navy Savings", amount=3000, funding_account="Classic Checking")

Example 8
Agent turn: "You'll qualify for Navy Savings on April 4, 2026, as long as your Classic Checking stays open. Please contact us again on or after April 4, 2026, and we'll be glad to help."
Acts:
- mentions_eligible_date(product="Navy Savings", date="2026-04-04")
- mentions_account_state(account="Classic Checking", state="open")
- restates_eligible_date(product="Navy Savings", date="2026-04-04")
- pleasantry()

Example 9
Agent turn: "I found two Classic Checking accounts in your name. Which one should I use for the deposit?"
Acts:
- request_info(field="funding_account")
("I found two accounts" only sets up the question; it is not a fact to record.)
`.trim();

export function extractorSystemPrompt(): string {
  return [
    "You formalize what a bank's customer service agent says into dialogue acts. You are given the conversation so far",
    "and one agent turn. Record every act in that turn by calling record_acts once.",
    "",
    "Rules:",
    "- Formalize only the agent turn given. Earlier turns are only for resolving references like \"that account\" or",
    "  which product \"it\" is.",
    "- Each act states one thing. One sentence can give several acts; never put the same fact in two acts.",
    "- Record what the agent said, not what is true. Fill every argument the agent stated and only those. Arguments",
    "  come only from the agent turn itself, never from earlier turns: an amount only the customer mentioned is not",
    "  an argument.",
    "- Never calculate. Copy dates and numbers as the agent gives them, changing only their format: \"April 4, 2026\"",
    "  becomes 2026-04-04 and \"60-day\" becomes 60. If the agent gives no date, there is no date argument, even if you",
    "  could work one out. If a date has no year, leave it out.",
    "- Every act has a quote: the shortest exact span of the agent turn that supports it, copied character for",
    "  character. If the support is in several places, join the exact pieces with \" ... \".",
    "- Politeness with no content is pleasantry. A sentence that only sets up the next one adds no act.",
    "- unknown is only for what no act can express (off-topic remarks, claims outside banking, nonsense). Check",
    "  every act, including the aliases, before using it, and never stretch an act to make something fit.",
    "- Amounts in dollars, as numbers. Products by their exact names from the bank's list.",
    "",
    "Acts:",
    ...ACTS.map(describeAct),
    "",
    "Examples (made up; arguments shown inline, quotes left out):",
    "",
    EXAMPLES,
  ].join("\n");
}

const RECORD_TOOL: ChatTool = {
  type: "function",
  function: {
    name: "record_acts",
    description: "Record the dialogue acts in the agent turn, in the order they occur.",
    parameters: {
      type: "object",
      properties: {
        acts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              act: { type: "string", enum: ACT_NAMES },
              args: { type: "object", description: "The act's arguments, as listed for it." },
              quote: { type: "string", description: "Exact span of the agent turn." },
            },
            required: ["act", "args", "quote"],
          },
        },
      },
      required: ["acts"],
    },
  },
};

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// Checks raw tool output against the vocabulary and the turn's text.
export function validateActs(raw: unknown, text: string): Extraction {
  const errors: string[] = [];
  const list = (raw as { acts?: unknown })?.acts;
  if (!Array.isArray(list)) return { acts: [], errors: ["no acts array"], dropped: [] };
  const acts: Act[] = [];
  const turn = squash(text);
  for (const [i, item] of list.entries()) {
    const { act, args = {}, quote = "" } = (item ?? {}) as { act?: unknown; args?: unknown; quote?: unknown };
    const spec = ACTS.find((a) => a.name === act);
    if (!spec) {
      errors.push(`act ${i}: unknown act ${String(act)}`);
      continue;
    }
    const given = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(given)) {
      const s = spec.args[k];
      if (!s) errors.push(`${spec.name}: unknown argument ${k}`);
      else if (v === null || v === undefined) continue;
      else if (s.type === "number" ? typeof v !== "number" : s.type === "boolean" ? typeof v !== "boolean" : typeof v !== "string") {
        errors.push(`${spec.name}.${k}: expected ${s.type}`);
      } else if (s.type === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(v as string)) errors.push(`${spec.name}.${k}: not YYYY-MM-DD`);
      else if (s.enum && !s.enum.includes(v as string)) errors.push(`${spec.name}.${k}: ${String(v)} not allowed`);
    }
    for (const [k, s] of Object.entries(spec.args)) if (!s.optional && given[k] === undefined) errors.push(`${spec.name}: missing ${k}`);
    const pieces = typeof quote === "string" ? quote.split(/\s*(?:\.\.\.|…)\s*/).map(squash).filter(Boolean) : [];
    if (pieces.length === 0 || !pieces.every((q) => turn.includes(q))) errors.push(`${spec.name}: quote not in the turn: ${JSON.stringify(quote)}`);
    const clean = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== null && v !== undefined));
    acts.push({ act: spec.name, args: clean, quote: String(quote) });
  }
  return { acts, errors, dropped: [] };
}

// An act as a function call, e.g. action_result(action="open_account", status="done").
export function renderAct(a: Act): string {
  const args = Object.entries(a.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${a.act}(${args.join(", ")})`;
}

function userMessage(ctx: ExtractContext, text: string): string {
  const products = ctx.products.length > 0 ? ctx.products.join(", ") : "(not given)";
  const history = ctx.history.length > 0 ? ctx.history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n\n") : "(none)";
  return (
    `Bank: ${ctx.bankName ?? "(not given)"}\nProducts: ${products}\nAccount types: ${ctx.accountTypes.join(", ")}\n\n` +
    `Conversation so far:\n${history}\n\n` +
    `Agent turn to formalize:\n${text}`
  );
}

export async function extractTurn(apiKey: string, model: string, ctx: ExtractContext, text: string): Promise<Extraction> {
  const reply = await chat(
    apiKey,
    model,
    [
      { role: "system", content: extractorSystemPrompt() },
      { role: "user", content: userMessage(ctx, text) },
    ],
    { tools: [RECORD_TOOL] },
  );
  const call = reply.toolCalls.find((c) => c.function.name === "record_acts");
  let raw: unknown = null;
  try {
    raw = JSON.parse(call ? call.function.arguments : (reply.content ?? ""));
  } catch {
    return { acts: [], errors: [`could not parse the extractor's output: ${(call?.function.arguments ?? reply.content ?? "").slice(0, 200)}`], dropped: [] };
  }
  const { acts, errors } = validateActs(raw, text);
  const grounded = groundActs(resolveAliases(acts), text);
  return { acts: normalizeActs(grounded.acts, ctx), errors, dropped: grounded.dropped };
}

export interface TurnResult extends Comparison {
  samples: Extraction[];
}

// Runs the extractor `times` times on the same turn, in parallel, and compares the samples.
export async function extractRepeated(apiKey: string, model: string, ctx: ExtractContext, text: string, times: number): Promise<TurnResult> {
  const samples = await Promise.all(Array.from({ length: times }, () => extractTurn(apiKey, model, ctx, text)));
  return { samples, ...compareSamples(samples.map((s) => s.acts)) };
}
