// Decides the customer's next move from the agent's extracted acts and the customer's script. Plain
// code: the same acts and script always give the same reply, and the customer cannot drift.

import type { Act } from "../extract/extract.ts";
import type { InfoField } from "../extract/vocab.ts";
import { TRIGGERS } from "./types.ts";
import type { CustomerAct, CustomerScript, Goal, Reply, Trigger } from "./types.ts";

// How every customer reacts unless their script says otherwise.
export const SHARED_REACTIONS: Record<Trigger, Reply[]> = {
  transferred: ["end"],
  closing: ["end"],
  done: ["thank_and_end"],
  date_given: ["thank_and_end"],
  refused: ["ask_why", "thank_and_end"],
  confirm_mismatch: ["correct"],
  confirm_matches: ["confirm"],
  alternative: ["decline"],
  more_help: ["thank_and_end"],
  greeted: ["state_goal"],
  statement: ["acknowledge"],
};

export interface EngineState {
  fired: Partial<Record<Trigger, number>>; // how many times each trigger has been answered
}

export const newState = (): EngineState => ({ fired: {} });

export type EndReason = "user_stop" | "agent_ended" | "off_script";

export interface Step {
  acts: CustomerAct[]; // empty when the conversation ends without a customer message
  end: EndReason | null;
  trigger: Trigger | null; // the trigger answered, if any
  flags: string[]; // things a human may want to look at, e.g. an ignored unknown
}

const same = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;

// The goal's details an agent may restate in a confirmation, keyed by the act argument naming them.
function details(goal: Goal): [string, string | number][] {
  return goal.action === "open_account"
    ? [["product", goal.product], ["amount", goal.amount], ["funding_account", goal.funding_account]]
    : [["account", goal.account], ["amount", goal.amount]];
}

// The first detail of the goal the agent got wrong in a confirmation, if any.
function mismatch(goal: Goal, a: Act): { field: string; value: string | number } | null {
  for (const [field, value] of details(goal)) {
    if (a.args[field] !== undefined && !same(a.args[field], value)) return { field, value };
  }
  return null;
}

// Whether an act is about the goal's product or account, when it names one.
function about(goal: Goal, a: Act): boolean {
  const named = a.args.product ?? a.args.account;
  if (named === undefined) return true;
  return goal.action === "open_account" ? same(named, goal.product) : same(named, goal.account);
}

function triggersOf(script: CustomerScript, acts: Act[]): Set<Trigger> {
  const { goal } = script;
  const found = new Set<Trigger>();
  for (const a of acts) {
    switch (a.act) {
      case "transfer_to_human":
        found.add("transferred");
        break;
      case "closing":
        found.add("closing");
        break;
      case "action_result":
        if (a.args.action === goal.action && about(goal, a)) found.add(a.args.status === "done" ? "done" : "refused");
        break;
      case "mentions_eligible_date":
        if (goal.action === "open_account" && about(goal, a)) found.add("date_given");
        break;
      case "mentions_eligibility":
        if (goal.action === "open_account" && about(goal, a) && a.args.eligible === false) found.add("refused");
        break;
      case "mentions_fee_valid":
        if (goal.action === "refund_fee" && about(goal, a) && a.args.valid === true) found.add("refused");
        break;
      case "ask_confirmation":
        if (a.args.action === goal.action) found.add(mismatch(goal, a) ? "confirm_mismatch" : "confirm_matches");
        break;
      case "offer_alternative":
        found.add("alternative");
        break;
      case "offer_more_help":
        found.add("more_help");
        break;
      case "greet":
        found.add("greeted");
        break;
    }
  }
  return found;
}

function replyAct(reply: Reply, script: CustomerScript, acts: Act[]): CustomerAct | null {
  switch (reply) {
    case "state_goal":
      return { act: "state_goal", goal: script.goal };
    case "correct": {
      const wrong = acts.filter((a) => a.act === "ask_confirmation").map((a) => mismatch(script.goal, a)).find(Boolean);
      return wrong ? { act: "correct", ...wrong } : { act: "confirm" };
    }
    case "decline":
      return { act: "decline", goal: script.goal };
    case "end":
      return null;
    default:
      return { act: reply };
  }
}

// One customer turn. `state` is updated in place.
export function step(script: CustomerScript, state: EngineState, acts: Act[]): Step {
  const flags: string[] = [];
  const known = acts.filter((a) => a.act !== "unknown");
  if (acts.length > 0 && known.length === 0) return { acts: [], end: "off_script", trigger: null, flags: ["only unknown acts"] };
  if (known.length < acts.length) flags.push("unknown act ignored");

  // Answer every question for information, whatever else happens.
  const info: CustomerAct[] = [];
  for (const a of known.filter((x) => x.act === "request_info")) {
    const field = a.args.field as InfoField;
    const value = script.knows[field];
    if (info.some((i) => "field" in i && i.field === field)) continue;
    info.push(value === undefined ? { act: "dont_have", field } : { act: "give_info", field, value });
  }

  // Then react to the most important situation in the turn.
  const found = triggersOf(script, known);
  if (found.size === 0 && info.length === 0) found.add("statement");
  const trigger = TRIGGERS.find((t) => found.has(t)) ?? null;
  if (!trigger) return { acts: info, end: null, trigger: null, flags };

  const replies = script.reactions[trigger] ?? SHARED_REACTIONS[trigger];
  const n = state.fired[trigger] ?? 0;
  state.fired[trigger] = n + 1;
  const reply = replies[Math.min(n, replies.length - 1)]!;
  if (reply === "end") return { acts: [], end: "agent_ended", trigger, flags };
  const main = replyAct(reply, script, known);
  // Information answers already reply to a turn that only states things.
  const out = trigger === "statement" && info.length > 0 ? info : [...info, ...(main ? [main] : [])];
  return { acts: out, end: reply === "thank_and_end" ? "user_stop" : null, trigger, flags };
}
