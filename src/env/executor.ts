// Runs one tool call against a session and records a trace entry for it:
// shape check, system and policy checks, the enforcement decision, and the database change.

import type { BankConfig, Enforcement } from "../bank/schema.ts";
import { TOOLS } from "../bankapi/tools.ts";
import type { Args, Param, Tool } from "../bankapi/tools.ts";
import { diffDatabases } from "./session.ts";
import type { Coercion, Outcome, RecordedCheck, Session, TraceRecord } from "./session.ts";

// Policy blocks are deliberately vague: the API does not explain the rule.
export const DECLINED = "This request was declined.";

// Policy rules with a fixed enforcement. product.eligibility comes from the config.
// Benchmark setting: every rule is "agent", as in tau2. "api" is only meant for RL with weak agents.
export const FIXED_ENFORCEMENT = {
  "identity.verified": "agent",
  "opening.min_deposit": "agent",
  "refund.correction_valid": "agent",
  "refund.courtesy_cap": "agent",
  "transfer.monthly_limit": "agent",
  "ticket.interest_wrong": "agent",
  "ticket.interest_amount": "agent",
} as const;

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function enforcementOf(s: Session, rule: string): Enforcement {
  if (rule === "product.eligibility") return s.config.policies.eligibilityEnforcement;
  const fixed = (FIXED_ENFORCEMENT as Record<string, Enforcement>)[rule];
  if (!fixed) throw new Error(`no enforcement defined for rule ${rule}`);
  return fixed;
}

// A parameter's allowed values, for parameters whose values depend on the bank.
function enumOf(p: Param, config: BankConfig): readonly string[] | undefined {
  return typeof p.enum === "function" ? p.enum(config) : p.enum;
}

// Weaker models often send a number or a boolean as text ("7400", "true"). Such a value is converted
// when it is unambiguous, then checked like any other; each conversion is recorded as a formatting
// slip, so a trainer can penalize it without the run failing over JSON typing.
function coerce(tool: Tool, args: unknown): { args: unknown; coerced: Coercion[] } {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { args, coerced: [] };
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  const coerced: Coercion[] = [];
  for (const [key, p] of Object.entries(tool.params) as [string, Param][]) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const s = v.trim();
    let to: number | boolean | undefined;
    if (p.type === "number" && /^-?\d+(\.\d+)?$/.test(s)) to = Number(s);
    if (p.type === "boolean" && /^(true|false)$/i.test(s)) to = s.toLowerCase() === "true";
    if (to === undefined) continue;
    out[key] = to;
    coerced.push({ arg: key, from: v, to });
  }
  return { args: out, coerced };
}

function shapeErrors(tool: Tool, args: unknown, config: BankConfig): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return ["arguments must be an object"];
  const errors: string[] = [];
  const given = args as Record<string, unknown>;
  for (const key of Object.keys(given)) if (!(key in tool.params)) errors.push(`unknown argument "${key}"`);
  for (const [key, p] of Object.entries(tool.params) as [string, Param][]) {
    const v = given[key];
    if (v === undefined || v === null) {
      if (!p.optional) errors.push(`missing argument ${key}`);
      continue;
    }
    if (typeof v !== p.type) {
      errors.push(`${key} must be a ${p.type}`);
      continue;
    }
    const allowed = enumOf(p, config);
    if (allowed && !allowed.includes(v as string)) errors.push(`${key} must be one of ${allowed.join(", ")}`);
    if (p.money) {
      const n = v as number;
      if (!(n > 0) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) errors.push(`${key} must be a positive amount with at most two decimals`);
    }
  }
  return errors;
}

export function callTool(s: Session, name: string, args: unknown): TraceRecord {
  const base = { index: s.trace.length, at: s.now, tool: name, args: structuredClone(args) };
  const finish = (r: Omit<TraceRecord, keyof typeof base>): TraceRecord => {
    const record = { ...base, ...r };
    s.trace.push(record);
    return record;
  };

  const tool = byName.get(name);
  if (!tool) return finish({ shapeErrors: [`unknown tool "${name}"`], checks: [], outcome: "invalid", result: { error: `Unknown tool "${name}".` }, changes: [] });
  const converted = coerce(tool, args);
  args = converted.args;
  if (converted.coerced.length > 0) Object.assign(base, { coerced: converted.coerced });
  const shape = shapeErrors(tool, args, s.config);
  if (shape.length > 0) return finish({ shapeErrors: shape, checks: [], outcome: "invalid", result: { error: shape.join("; ") }, changes: [] });
  if (s.ended) {
    const check: RecordedCheck = { rule: "session.open", kind: "system", passed: false, detail: "The conversation was transferred to a human agent." };
    return finish({ shapeErrors: [], checks: [check], outcome: "error", result: { error: check.detail }, changes: [] });
  }

  const plan = tool.plan(s, args as Args);
  const checks: RecordedCheck[] = plan.checks.map((c) => (c.kind === "policy" ? { ...c, enforcement: enforcementOf(s, c.rule) } : c));
  const systemFailure = checks.find((c) => c.kind === "system" && !c.passed);
  const blocking = checks.some((c) => c.kind === "policy" && !c.passed && c.enforcement === "api");

  let outcome: Outcome;
  let result: unknown;
  let changes: TraceRecord["changes"] = [];
  if (systemFailure) {
    outcome = "error";
    result = { error: systemFailure.detail };
  } else if (blocking) {
    outcome = "blocked";
    result = { error: DECLINED };
  } else {
    const before = structuredClone(s.db);
    result = plan.apply();
    changes = diffDatabases(before, s.db);
    outcome = "executed";
    if (tool.write && s.verified) s.verified.usedByWrite = true;
  }
  return finish({ shapeErrors: [], checks, outcome, result, changes });
}

// Tool definitions in JSON Schema form, for the adapter to hand to the agent.
export function toolList(config: BankConfig) {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(t.params).map(([k, p]) => [k, { type: p.type, description: p.description, ...(enumOf(p, config) ? { enum: [...enumOf(p, config)!] } : {}) }]),
      ),
      required: Object.entries(t.params).filter(([, p]) => !p.optional).map(([k]) => k),
      additionalProperties: false,
    },
  }));
}
