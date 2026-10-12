// One seed -> one validated bank: config, background database and documents.

import { checkDocCoverage, renderDocs } from "./docs.ts";
import type { Doc } from "./docs.ts";
import { createRng } from "../util/rng.ts";
import { sampleBank } from "./sample.ts";
import { sampleDatabase } from "./sample_db.ts";
import { SPEC } from "./spec.ts";
import type { Spec } from "./spec.ts";
import type { BankConfig } from "../bank/schema.ts";
import type { Database } from "../bank/state.ts";
import { validateBank } from "../bank/validate.ts";
import { validateDatabase } from "../bank/validate_db.ts";

export interface Bank {
  seed: number;
  config: BankConfig;
  db: Database;
  docs: Doc[];
}

// `spec` defaults to SPEC; tests pass others, e.g. to generate banks with more tiers.
export function generateBank(seed: number, spec: Spec = SPEC): { bank: Bank | null; errors: string[] } {
  const config = sampleBank(createRng(seed, 0), seed, spec);
  const configErrors = validateBank(config);
  // The database and documents assume a coherent config, so stop at config errors.
  if (configErrors.length > 0) return { bank: null, errors: configErrors };
  const db = sampleDatabase(createRng(seed, 1), config, spec);
  const docs = renderDocs(createRng(seed, 2), config);
  const errors = [...validateDatabase(config, db), ...checkDocCoverage(config, docs)];
  return { bank: errors.length === 0 ? { seed, config, db, docs } : null, errors };
}
