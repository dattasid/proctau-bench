// Formalizes one agent turn into dialogue acts from the vocabulary. The extractor never sees the
// task: only the bank's product names, the conversation so far (to resolve references) and the
// turn itself. Every act carries a verbatim quote, checked against the turn, so an act the agent
// never said is caught. Optionally runs several times and reports whether the samples agree.

import { chat } from "../harness/llm.ts";
import type { ChatTool } from "../harness/llm.ts";
import { ACTS, ACT_NAMES } from "./vocab.ts";
import type { ActSpec } from "./vocab.ts";

export interface Act {
  act: string;
  args: Record<string, unknown>;
  quote: string;
}

export interface Extraction {
  acts: Act[];
  errors: string[]; // validation problems; any error makes the extraction unusable
}

export interface ExtractContext {
  bankName?: string;
  products: string[]; // display names
  history: { role: "agent" | "user"; content: string }[]; // turns before this one
}

function describeAct(a: ActSpec): string {
  const args = Object.entries(a.args).map(([k, s]) => {
    const values = s.enum ? ` one of ${s.enum.join(", ")}.` : "";
    return `    - ${k} (${s.type}${s.optional ? ", optional" : ""}): ${s.description}${values}`;
  });
  return `- ${a.name}: ${a.description}${args.length > 0 ? `\n${args.join("\n")}` : ""}`;
}

export function extractorSystemPrompt(): string {
  return [
    "You formalize what a bank's customer service agent says into dialogue acts. You are given the conversation so far",
    "and one agent turn. Record every act in that turn by calling record_acts once.",
    "",
    "Rules:",
    "- Formalize only the agent turn given. Earlier turns are only for resolving references like \"that account\".",
    "- One act per distinct thing the agent says. One sentence can give several acts; several sentences can form one act.",
    "- Every act has a quote: the shortest exact span of the agent turn that supports it, copied character for character.",
    "  If the support is in several places, join the exact pieces with \" ... \".",
    "- Record what the agent said, not what is true or what it meant to say. Fill every argument the agent stated,",
    "  and only those; never add facts the agent did not state. Arguments come only from the agent turn itself, never",
    "  from earlier turns: an amount only the customer mentioned is not an argument.",
    "- Opening an account funded from another account is one open_account action, with the funding account and the",
    "  deposit as its arguments. transfer_funds is only for a transfer between existing accounts on its own.",
    "- Facts about an account the agent has just opened belong in that report_action, not in inform_account.",
    "- At most one inform_account per account per turn, combining every fact stated about it.",
    "- report_verification is only for the result of a verification attempt. Asking for identity details, even with a",
    "  lead-in like \"before I access your accounts\", is only request_info. policy_claim(rule=identity_verification) is",
    "  for stating a verification rule beyond the request itself, e.g. that verification must be repeated before a change.",
    "- Skip filler such as \"Sure\" or \"I can help with that\", unless it is the whole turn.",
    "- If something fits no act, use unknown. Never stretch an act to make something fit.",
    "- Dates as YYYY-MM-DD. Amounts in dollars, as numbers. When the agent clearly means one of the bank's products,",
    "  use the product's exact name.",
    "",
    "Acts:",
    ...ACTS.map(describeAct),
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
  if (!Array.isArray(list)) return { acts: [], errors: ["no acts array"] };
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
  return { acts, errors };
}

// An act as a function call, e.g. report_action(action="open_account", status="done").
export function renderAct(a: Act): string {
  const args = Object.entries(a.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return `${a.act}(${args.join(", ")})`;
}

// Free-text arguments vary in wording between samples, so only their presence is compared.
const FREE_TEXT = new Set(["detail", "other", "reason"]);

// A canonical form of an act for comparing samples: quote dropped, arguments sorted, strings lowercased.
export function canonicalAct(a: Act): string {
  const args = Object.keys(a.args)
    .sort()
    .map((k) => {
      const v = a.args[k];
      if (FREE_TEXT.has(k)) return `${k}=*`;
      return `${k}=${typeof v === "string" ? v.toLowerCase().trim() : JSON.stringify(v)}`;
    });
  return `${a.act}(${args.join(",")})`;
}

export function canonical(acts: Act[]): string {
  return acts.map(canonicalAct).sort().join(" ");
}

function userMessage(ctx: ExtractContext, text: string): string {
  const products = ctx.products.length > 0 ? ctx.products.join(", ") : "(not given)";
  const history = ctx.history.length > 0 ? ctx.history.map((t) => `${t.role.toUpperCase()}: ${t.content}`).join("\n\n") : "(none)";
  return (
    `Bank: ${ctx.bankName ?? "(not given)"}\nProducts: ${products}\n\nConversation so far:\n${history}\n\n` +
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
    return { acts: [], errors: [`could not parse the extractor's output: ${(call?.function.arguments ?? reply.content ?? "").slice(0, 200)}`] };
  }
  return validateActs(raw, text);
}

export interface TurnResult {
  samples: Extraction[];
  agreed: boolean; // every sample valid and canonically identical
  consensus: Act[]; // acts found by more than half the samples, in first-seen order
  disputed: Act[]; // acts found by some samples but not by more than half
}

// Per-act majority vote: an act counts if more than half the samples contain it.
function vote(samples: Extraction[]): { consensus: Act[]; disputed: Act[] } {
  const seen = new Map<string, { act: Act; votes: number }>();
  for (const s of samples) {
    for (const key of new Set(s.acts.map(canonicalAct))) {
      const entry = seen.get(key) ?? { act: s.acts.find((a) => canonicalAct(a) === key)!, votes: 0 };
      entry.votes++;
      seen.set(key, entry);
    }
  }
  const all = [...seen.values()];
  return {
    consensus: all.filter((e) => e.votes * 2 > samples.length).map((e) => e.act),
    disputed: all.filter((e) => e.votes * 2 <= samples.length).map((e) => e.act),
  };
}

// Runs the extractor `times` times on the same turn, in parallel.
export async function extractRepeated(apiKey: string, model: string, ctx: ExtractContext, text: string, times: number): Promise<TurnResult> {
  const samples = await Promise.all(Array.from({ length: times }, () => extractTurn(apiKey, model, ctx, text)));
  const forms = samples.map((s) => canonical(s.acts));
  const agreed = samples.every((s) => s.errors.length === 0) && forms.every((f) => f === forms[0]);
  return { samples, agreed, ...vote(samples) };
}
