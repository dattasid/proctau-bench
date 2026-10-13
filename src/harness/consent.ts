// Consent before changes, for scripted runs: an action counts as agreed once the agent asked to
// confirm it and the customer's reply confirmed; each change uses the agreement up. A change made
// without one is recorded.

import type { Act } from "../extract/extract.ts";
import type { CustomerAct } from "../script/types.ts";

// Tools that change the customer's accounts; named like the extractor's actions.
export const WRITES = new Set(["open_account", "transfer_funds", "refund_fee"]);

export class ConsentTracker {
  #agreed = new Set<string>();
  readonly missing: { index: number; tool: string }[] = [];

  // After each customer turn: the agent's acts it answered, and what the customer did.
  customerTurn(agentActs: Act[], customer: CustomerAct[]): void {
    if (!customer.some((c) => c.act === "confirm")) return;
    for (const a of agentActs) if (a.act === "ask_confirmation") this.#agreed.add(String(a.args.action));
  }

  // After each executed tool call.
  executed(tool: string, index: number): void {
    if (!WRITES.has(tool)) return;
    if (!this.#agreed.has(tool)) this.missing.push({ index, tool });
    this.#agreed.delete(tool);
  }
}
