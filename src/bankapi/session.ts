// What the fake bank tracks for one call: its config, its own copy of the database, the
// simulated clock, who is verified, the interaction notes and whether the call was handed off.

import type { BankConfig } from "../bank/schema.ts";
import type { Database } from "../bank/state.ts";

export interface BankSession {
  config: BankConfig;
  db: Database;
  now: string;
  // usedByWrite matters only under the before_every_write policy.
  verified: { customerId: string; usedByWrite: boolean } | null;
  notes: string[]; // interaction log entries; outside the database so they never affect scoring
  ended: boolean; // set by transfer_to_human
}

export function createBankSession(config: BankConfig, db: Database): BankSession {
  return {
    config,
    db: structuredClone(db),
    now: config.bank.simulatedDate,
    verified: null,
    notes: [],
    ended: false,
  };
}
