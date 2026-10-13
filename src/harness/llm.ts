// Minimal OpenAI-format chat client for OpenRouter, with tool calls and retries.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";

// What calls cost, as OpenRouter reports it, split between the agent under test and the simulator
// (customer, extractor, rephraser). A task's calls add to the Spend it runs under (see withSpend),
// so tasks running in parallel each keep their own.
export interface Tally {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cost: number; // dollars
}
export interface Spend {
  agent: Tally;
  simulator: Tally;
}
const tally = (): Tally => ({ calls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cost: 0 });
export const newSpend = (): Spend => ({ agent: tally(), simulator: tally() });
export function addSpend(into: Spend, from: Spend): void {
  for (const side of ["agent", "simulator"] as const) {
    for (const k of Object.keys(into[side]) as (keyof Tally)[]) into[side][k] += from[side][k];
  }
}
const meters = new AsyncLocalStorage<Spend>();
export const withSpend = <T>(spend: Spend, fn: () => Promise<T>): Promise<T> => meters.run(spend, fn);

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatReply {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  provider?: string; // the OpenRouter provider that answered
}

// Where OpenRouter sends a request and how much the model may reason. provider: endpoint slugs as
// OpenRouter lists them (e.g. "coreweave/fp16"), tried in order with no fallback to others.
// reasoning: an effort level, or a token budget; ignored by models that do not reason.
export interface ChatRouting {
  provider?: string[];
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" } | { max_tokens: number };
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const KEY_FILE = "OPENROUTER_API_KEY";
export const DEFAULT_MODEL = "openai/gpt-6-luna";

export function readApiKey(): string {
  const key = existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error(`no OpenRouter key: put it in ./${KEY_FILE} or the OPENROUTER_API_KEY env var`);
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function chat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  // side: whose spend the call counts toward; everything but the agent is the simulator.
  options: { tools?: ChatTool[]; temperature?: number; routing?: ChatRouting; side?: keyof Spend } = {},
): Promise<ChatReply> {
  const routing = options.routing ?? {};
  const body = JSON.stringify({
    model,
    messages,
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(routing.provider?.length ? { provider: { order: routing.provider, allow_fallbacks: false } } : {}),
    ...(routing.reasoning ? { reasoning: routing.reasoning } : {}),
  });
  // Rate limits and server errors are retried: after the server's Retry-After when it sends one,
  // otherwise with exponential backoff up to a minute. Jitter keeps parallel tasks that hit the
  // limit together from retrying in lockstep.
  let lastError = "";
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep((retryAfterMs || Math.min(60_000, 1000 * 2 ** attempt)) * (0.5 + Math.random()));
    retryAfterMs = 0;
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
      });
    } catch (e) {
      lastError = String(e);
      continue;
    }
    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      const after = Number(res.headers.get("retry-after"));
      if (after > 0) retryAfterMs = Math.min(120_000, after * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text) as {
      choices?: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
      usage?: ChatReply["usage"];
      provider?: string;
      error?: { message: string };
    };
    const message = data.choices?.[0]?.message;
    if (!message) {
      lastError = data.error?.message ?? `no choices in response: ${text.slice(0, 300)}`;
      continue;
    }
    const spend = meters.getStore();
    if (spend) {
      const t = spend[options.side ?? "simulator"];
      t.calls++;
      t.promptTokens += data.usage?.prompt_tokens ?? 0;
      t.completionTokens += data.usage?.completion_tokens ?? 0;
      t.reasoningTokens += data.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
      t.cost += data.usage?.cost ?? 0;
    }
    return { content: message.content, toolCalls: message.tool_calls ?? [], usage: data.usage, provider: data.provider };
  }
  throw new Error(`OpenRouter request failed after retries: ${lastError}`);
}
