// Canonical JSON (sorted keys, undefined dropped) and its hash, so two databases with
// the same content always compare equal regardless of key insertion order.

import { createHash } from "node:crypto";
import type { Database } from "./state.ts";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const hashDatabase = (db: Database): string => createHash("sha256").update(canonicalJson(db)).digest("hex");
