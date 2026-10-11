// Minimal OpenAI-format chat client for OpenRouter, with tool calls and retries.

import { existsSync, readFileSync } from "node:fs";

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
  usage?: { prompt_tokens: number; completion_tokens: number };
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
  options: { tools?: ChatTool[]; temperature?: number } = {},
): Promise<ChatReply> {
  const body = JSON.stringify({
    model,
    messages,
    ...(options.tools && options.tools.length > 0 ? { tools: options.tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
  });
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** attempt);
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
      continue;
    }
    if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${text.slice(0, 500)}`);
    const data = JSON.parse(text) as {
      choices?: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
      usage?: ChatReply["usage"];
      error?: { message: string };
    };
    const message = data.choices?.[0]?.message;
    if (!message) {
      lastError = data.error?.message ?? `no choices in response: ${text.slice(0, 300)}`;
      continue;
    }
    return { content: message.content, toolCalls: message.tool_calls ?? [], usage: data.usage };
  }
  throw new Error(`OpenRouter request failed after retries: ${lastError}`);
}
