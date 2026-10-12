// Usage: npm run generate -- [--seed N] [--count K] [--out DIR]
// Writes DIR/bank_<seed>/{config.json, db.json, docs/} for seeds N .. N+K-1.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { generateBank } from "./generate.ts";

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
  const { bank, errors } = generateBank(seed);
  if (!bank) {
    failures++;
    console.error(`seed ${seed}: invalid bank\n  ${errors.join("\n  ")}`);
    continue;
  }
  const dir = join(values.out, `bank_${seed}`);
  write(join(dir, "config.json"), JSON.stringify(bank.config, null, 2) + "\n");
  write(join(dir, "db.json"), JSON.stringify(bank.db, null, 2) + "\n");
  for (const doc of bank.docs) write(join(dir, "docs", doc.path), doc.content);
  console.log(`seed ${seed}: ${bank.config.bank.name}, ${Object.keys(bank.db.customers).length} customers -> ${dir}`);
}

process.exit(failures > 0 ? 1 : 0);
