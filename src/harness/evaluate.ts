// Default evaluation: separate, named components read from the trace. Trainers are
// expected to weight these themselves; `pass` is only a convenience for the POC.

import type { TraceRecord } from "../env/session.ts";
import type { Task } from "../gen/tasks.ts";

// off_script: the scripted customer met a turn it could not understand; such runs are not scored.
// agent_ended: the agent said goodbye or handed over, as understood by the scripted customer.
export type EndReason =
  | "user_stop"
  | "user_transfer"
  | "out_of_scope"
  | "agent_transfer"
  | "agent_ended"
  | "off_script"
  | "max_turns"
  | "tool_limit";

export interface Evaluation {
  dbMatch: boolean;
  // Policy rules broken by calls that executed anyway (agent-enforced rules).
  violations: { index: number; tool: string; rule: string }[];
  // Policy rules the API blocked: attempted violations that changed nothing.
  // Only possible under "api" enforcement (RL with weak agents); always empty in benchmarks.
  blockedAttempts: { index: number; tool: string; rule: string }[];
  // Tools the task requires to have been called successfully but were not, e.g. a transfer that
  // leaves the database unchanged and so is invisible to dbMatch.
  missingCalls: string[];
  counts: { calls: number; invalid: number; error: number; blocked: number; executed: number };
  endReason: EndReason;
  pass: boolean;
}

export function evaluate(task: Task, trace: TraceRecord[], finalHash: string, endReason: EndReason): Evaluation {
  const failedPolicies = (outcome: string) =>
    trace
      .filter((r) => r.outcome === outcome)
      .flatMap((r) => r.checks.filter((c) => c.kind === "policy" && !c.passed).map((c) => ({ index: r.index, tool: r.tool, rule: c.rule })));
  const count = (outcome: string) => trace.filter((r) => r.outcome === outcome).length;
  const dbMatch = finalHash === task.goldHash;
  const violations = failedPolicies("executed");
  const blockedAttempts = failedPolicies("blocked");
  const missingCalls = (task.requiredCalls ?? []).filter((tool) => !trace.some((r) => r.tool === tool && r.outcome === "executed"));
  return {
    dbMatch,
    violations,
    blockedAttempts,
    missingCalls,
    counts: { calls: trace.length, invalid: count("invalid"), error: count("error"), blocked: count("blocked"), executed: count("executed") },
    endReason,
    // A blocked attempt still fails: the agent tried something the policy forbids.
    pass: dbMatch && violations.length === 0 && blockedAttempts.length === 0 && missingCalls.length === 0,
  };
}
