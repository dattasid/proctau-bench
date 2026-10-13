// One conversation: the user simulator and the agent take turns, the agent's tool
// calls go to the executor over REST, and the result is evaluated against the task.
// Half-duplex, like tau2's orchestrator: the agent greets first.
//
// The customer is either an LLM following the task's prose instructions, or scripted: each agent
// turn is extracted into acts, the script engine picks the customer's reply from the task's
// script, and the rephraser puts it into words.

import type { Bank } from "../gen/generate.ts";
import type { TraceRecord } from "../env/session.ts";
import type { Task } from "../gen/tasks.ts";
import { EnvClient } from "./env_client.ts";
import { evaluate } from "./evaluate.ts";
import type { EndReason, Evaluation } from "./evaluate.ts";
import { accountTypeName } from "../bank/products.ts";
import { extractRepeated } from "../extract/extract.ts";
import type { Act, ExtractContext } from "../extract/extract.ts";
import { newState, step } from "../script/engine.ts";
import { rephrase } from "../script/rephrase.ts";
import type { CustomerAct, Trigger } from "../script/types.ts";
import { ConsentTracker } from "./consent.ts";
import { chat } from "./llm.ts";
import type { ChatMessage, ChatRouting, ChatTool } from "./llm.ts";
import { GREETING, OUT_OF_SCOPE, STOP, TRANSFER, agentSystemPrompt, userSystemPrompt } from "./prompts.ts";

export type Turn =
  | { role: "agent" | "user"; content: string }
  | { role: "tool"; tool: string; args: unknown; result: unknown; outcome: string };

// One scripted customer turn: what was extracted from the agent and what the script decided.
export interface ScriptTurn {
  agent: string;
  acts: Act[]; // the agent's acts (the vote across samples when there are several)
  conflicts: string[];
  samples?: Act[][]; // each sample's acts, when the extractor ran more than once
  trigger: Trigger | null;
  customer: CustomerAct[];
  flags: string[];
  draft?: string;
  fellBack?: boolean; // the rephraser lost a value, so the draft was sent
}

export interface RunResult {
  taskId: string;
  agentModel: string;
  agentRouting?: ChatRouting;
  agentProviders?: Record<string, number>; // agent replies per provider that answered
  userModel: string;
  prompts: { agent: string; user: string }; // system prompts exactly as sent
  turns: Turn[];
  script?: ScriptTurn[]; // scripted customer only
  trace: TraceRecord[];
  notes: string[];
  finalHash: string;
  evaluation: Evaluation;
}

export interface RunOptions {
  baseUrl: string;
  apiKey: string;
  agentModel: string;
  userModel: string;
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
  customer?: "llm" | "scripted";
  extractSamples?: number; // scripted: extractor samples per agent turn, voted per act
  agentRouting?: ChatRouting; // provider and reasoning budget for the agent only
}

const MARKERS: [string, EndReason][] = [
  [STOP, "user_stop"],
  [TRANSFER, "user_transfer"],
  [OUT_OF_SCOPE, "out_of_scope"],
];

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw; // the executor records it as an invalid call
  }
}

export async function runTask(bank: Bank, task: Task, opts: RunOptions): Promise<RunResult> {
  const maxTurns = opts.maxTurns ?? 25;
  const maxToolCalls = opts.maxToolCallsPerTurn ?? 12;
  const env = await EnvClient.create(opts.baseUrl, bank.config, task.db);
  const tools: ChatTool[] = (await env.tools()).map((t) => ({ type: "function", function: t }));

  const scripted = opts.customer === "scripted";
  const prompts = {
    agent: agentSystemPrompt(bank.config, bank.docs),
    user: scripted ? `(scripted customer)\n${JSON.stringify(task.script, null, 2)}` : userSystemPrompt(task.user.instructions),
  };
  const agentMsgs: ChatMessage[] = [{ role: "system", content: prompts.agent }];
  // The simulator plays the customer, so roles are mirrored in its history.
  const userMsgs: ChatMessage[] = [{ role: "system", content: prompts.user }];
  const turns: Turn[] = [];
  const agentSays = (text: string) => {
    agentMsgs.push({ role: "assistant", content: text });
    userMsgs.push({ role: "user", content: text });
    turns.push({ role: "agent", content: text });
  };

  // The LLM customer: replies from its instructions, ending with a marker.
  const llmCustomer = async (): Promise<{ said: string; end: EndReason | null }> => {
    const reply = await chat(opts.apiKey, opts.userModel, userMsgs, { temperature: 0 });
    const text = (reply.content ?? "").trim();
    userMsgs.push({ role: "assistant", content: text });
    const marker = MARKERS.find(([m]) => text.includes(m));
    return { said: MARKERS.reduce((s, [m]) => s.split(m).join(""), text).trim(), end: marker ? marker[1] : null };
  };

  // The scripted customer: extract the agent's last turn, let the engine decide, rephrase.
  const scriptLog: ScriptTurn[] = [];
  const engineState = newState();
  const consent = new ConsentTracker();
  const names: Pick<ExtractContext, "bankName" | "products" | "accountTypes"> = {
    bankName: bank.config.bank.name,
    products: Object.values(bank.config.products).map((p) => p.displayName),
    accountTypes: bank.config.accountTypes.map(accountTypeName),
  };
  const scriptedCustomer = async (): Promise<{ said: string; end: EndReason | null }> => {
    const said = turns.filter((t): t is { role: "agent" | "user"; content: string } => t.role !== "tool");
    const agentText = said.at(-1)!.content;
    let acts: Act[] = [{ act: "greet", args: {}, quote: GREETING }];
    let conflicts: string[] = [];
    let samples: Act[][] | undefined;
    if (agentText !== GREETING) {
      const r = await extractRepeated(opts.apiKey, opts.userModel, { ...names, history: said.slice(-7, -1) }, agentText, opts.extractSamples ?? 1);
      acts = r.consensus;
      conflicts = r.conflicts;
      if (r.samples.length > 1) samples = r.samples.map((x) => x.acts);
    }
    const s = step(task.script, engineState, acts);
    consent.customerTurn(acts, s.acts);
    const entry: ScriptTurn = { agent: agentText, acts, conflicts, ...(samples ? { samples } : {}), trigger: s.trigger, customer: s.acts, flags: s.flags };
    scriptLog.push(entry);
    if (s.acts.length === 0) return { said: "", end: s.end === "off_script" ? "off_script" : "agent_ended" };
    const r = await rephrase(opts.apiKey, opts.userModel, task.script, agentText, s.acts);
    entry.draft = r.draft;
    entry.fellBack = r.fellBack;
    return { said: r.text, end: s.end === "user_stop" ? "user_stop" : null };
  };

  let endReason: EndReason = "max_turns";
  const agentProviders: Record<string, number> = {};
  try {
    agentSays(GREETING);
    conversation: for (let turn = 0; turn < maxTurns; turn++) {
      const { said, end } = scripted ? await scriptedCustomer() : await llmCustomer();
      if (said) turns.push({ role: "user", content: said });
      if (end) {
        endReason = end;
        break;
      }
      agentMsgs.push({ role: "user", content: said });

      for (let calls = 0; ; ) {
        const a = await chat(opts.apiKey, opts.agentModel, agentMsgs, { tools, temperature: 0, routing: opts.agentRouting });
        if (a.provider) agentProviders[a.provider] = (agentProviders[a.provider] ?? 0) + 1;
        if (a.toolCalls.length === 0) {
          agentSays((a.content ?? "").trim());
          break;
        }
        agentMsgs.push({ role: "assistant", content: a.content, tool_calls: a.toolCalls });
        let transferred = false;
        for (const call of a.toolCalls) {
          const args = parseArgs(call.function.arguments);
          const r = await env.call(call.function.name, args);
          if (scripted && r.outcome === "executed") consent.executed(call.function.name, r.record.index);
          agentMsgs.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(r.result) });
          turns.push({ role: "tool", tool: call.function.name, args, result: r.result, outcome: r.outcome });
          if (call.function.name === "transfer_to_human" && r.outcome === "executed") transferred = true;
        }
        if (transferred) {
          endReason = "agent_transfer";
          break conversation;
        }
        calls += a.toolCalls.length;
        if (calls >= maxToolCalls) {
          endReason = "tool_limit";
          break conversation;
        }
      }
    }
    const [{ trace, notes }, { hash }] = await Promise.all([env.trace(), env.state()]);
    return {
      taskId: task.id,
      agentModel: opts.agentModel,
      ...(opts.agentRouting ? { agentRouting: opts.agentRouting } : {}),
      agentProviders,
      userModel: opts.userModel,
      prompts,
      turns,
      ...(scripted ? { script: scriptLog } : {}),
      trace,
      notes,
      finalHash: hash,
      evaluation: evaluate(task, trace, hash, endReason, scripted ? consent.missing : null),
    };
  } finally {
    await env.close();
  }
}
