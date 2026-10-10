// Usage: npm run generate -- [--seed N] [--count K] [--out DIR]
// Writes DIR/bank_<seed>/{config.json, db.json, docs/} for seeds N .. N+K-1.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { checkDocCoverage, renderDocs } from "./docs.ts";
import { createRng } from "./rng.ts";
import { sampleBank } from "./sample.ts";
import { sampleDatabase } from "./sample_db.ts";
import { validateBank } from "./validate.ts";
import { validateDatabase } from "./validate_db.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    count: { type: "string", default: "1" },
    out: { type: "string", default: "out" },
  },
});

const firstSeed = Number(values.seed);
const count = Number(values.count);
if (!Number.isInteger(firstSeed) || !Number.isInteger(count) || count < 1) {
  console.error("--seed and --count must be integers, count >= 1");
  process.exit(2);
}

const write = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

let failures = 0;
for (let seed = firstSeed; seed < firstSeed + count; seed++) {
  const config = sampleBank(createRng(seed, 0), seed);
  const configErrors = validateBank(config);
  // The database and documents assume a coherent config, so stop at config errors.
  const db = configErrors.length === 0 ? sampleDatabase(createRng(seed, 1), config) : null;
  const docs = db ? renderDocs(createRng(seed, 2), config) : [];
  const errors = db ? [...validateDatabase(config, db), ...checkDocCoverage(config, docs)] : configErrors;
  if (errors.length > 0) {
    failures++;
    console.error(`seed ${seed}: invalid bank\n  ${errors.join("\n  ")}`);
    continue;
  }
  const dir = join(values.out, `bank_${seed}`);
  write(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  write(join(dir, "db.json"), JSON.stringify(db, null, 2) + "\n");
  for (const doc of docs) write(join(dir, "docs", doc.path), doc.content);
  console.log(`seed ${seed}: ${config.bank.name}, ${Object.keys(db!.customers).length} customers -> ${dir}`);
}

process.exit(failures > 0 ? 1 : 0);
