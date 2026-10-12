// HTTP client for the executor's REST API.

import type { BankConfig } from "../bank/schema.ts";
import type { Outcome, TraceRecord } from "../env/session.ts";
import type { Database } from "../bank/state.ts";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export class EnvClient {
  private readonly baseUrl: string;
  readonly envId: string;

  private constructor(baseUrl: string, envId: string) {
    this.baseUrl = baseUrl;
    this.envId = envId;
  }

  static async create(baseUrl: string, config: BankConfig, db: Database): Promise<EnvClient> {
    const { envId } = await request<{ envId: string }>("POST", `${baseUrl}/envs`, { config, db });
    return new EnvClient(baseUrl, envId);
  }

  private get url(): string {
    return `${this.baseUrl}/envs/${this.envId}`;
  }

  tools(): Promise<ToolDefinition[]> {
    return request("GET", `${this.url}/tools`);
  }

  call(tool: string, args: unknown): Promise<{ result: unknown; outcome: Outcome; record: TraceRecord }> {
    return request("POST", `${this.url}/calls`, { tool, args });
  }

  state(): Promise<{ db: Database; hash: string }> {
    return request("GET", `${this.url}/state`);
  }

  trace(): Promise<{ trace: TraceRecord[]; notes: string[]; ended: boolean }> {
    return request("GET", `${this.url}/trace`);
  }

  close(): Promise<void> {
    return request("DELETE", this.url);
  }
}
