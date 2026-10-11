// One conversation: the user simulator and the agent take turns, the agent's tool
// calls go to the executor over REST, and the result is evaluated against the task.
// Half-duplex, like tau2's orchestrator: the agent greets first.

import type { Bank } from "../bank.ts";
import type { TraceRecord } from "../session.ts";
import type { Task } from "../tasks.ts";
import { EnvClient } from "./env_client.ts";
import type { ToolDefinition } from "./env_client.ts";
import { evaluate } from "./evaluate.ts";
import type { EndReason, Evaluation } from "./evaluate.ts";
import { chat } from "./llm.ts";
import type { ChatMessage, ChatTool } from "./llm.ts";
import { GREETING, OUT_OF_SCOPE, STOP, TRANSFER, agentSystemPrompt, userSystemPrompt } from "./prompts.ts";

export type Turn =
  | { role: "agent" | "user"; content: string }
  | { role: "tool"; tool: string; args: unknown; result: unknown; outcome: string };

export interface RunResult {
  taskId: string;
  agentModel: string;
  userModel: string;
  turns: Turn[];
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
  tools: ToolDefinition[];
  maxTurns?: number;
  maxToolCallsPerTurn?: number;
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
  const tools: ChatTool[] = opts.tools.map((t) => ({ type: "function", function: t }));
  const env = await EnvClient.create(opts.baseUrl, bank.config, task.db);

  const agentMsgs: ChatMessage[] = [{ role: "system", content: agentSystemPrompt(bank.config, bank.docs) }];
  // The simulator plays the customer, so roles are mirrored in its history.
  const userMsgs: ChatMessage[] = [{ role: "system", content: userSystemPrompt(task.user.instructions) }];
  const turns: Turn[] = [];
  const agentSays = (text: string) => {
    agentMsgs.push({ role: "assistant", content: text });
    userMsgs.push({ role: "user", content: text });
    turns.push({ role: "agent", content: text });
  };

  let endReason: EndReason = "max_turns";
  try {
    agentSays(GREETING);
    conversation: for (let turn = 0; turn < maxTurns; turn++) {
      const reply = await chat(opts.apiKey, opts.userModel, userMsgs, { temperature: 0 });
      const text = (reply.content ?? "").trim();
      userMsgs.push({ role: "assistant", content: text });
      const marker = MARKERS.find(([m]) => text.includes(m));
      const said = MARKERS.reduce((s, [m]) => s.split(m).join(""), text).trim();
      if (said) turns.push({ role: "user", content: said });
      if (marker) {
        endReason = marker[1];
        break;
      }
      agentMsgs.push({ role: "user", content: said });

      for (let calls = 0; ; ) {
        const a = await chat(opts.apiKey, opts.agentModel, agentMsgs, { tools, temperature: 0 });
        if (a.toolCalls.length === 0) {
          agentSays((a.content ?? "").trim());
          break;
        }
        agentMsgs.push({ role: "assistant", content: a.content, tool_calls: a.toolCalls });
        let transferred = false;
        for (const call of a.toolCalls) {
          const args = parseArgs(call.function.arguments);
          const r = await env.call(call.function.name, args);
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
      userModel: opts.userModel,
      turns,
      trace,
      notes,
      finalHash: hash,
      evaluation: evaluate(task, trace, hash, endReason),
    };
  } finally {
    await env.close();
  }
}
