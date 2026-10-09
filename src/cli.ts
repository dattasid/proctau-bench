// Usage: npm run generate -- [--seed N] [--count K] [--out DIR]
// Writes DIR/bank_<seed>/config.json for seeds N .. N+K-1.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createRng } from "./rng.ts";
import { sampleBank } from "./sample.ts";
import { validateBank } from "./validate.ts";

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

let failures = 0;
for (let seed = firstSeed; seed < firstSeed + count; seed++) {
  const config = sampleBank(createRng(seed), seed);
  const errors = validateBank(config);
  if (errors.length > 0) {
    failures++;
    console.error(`seed ${seed}: invalid config\n  ${errors.join("\n  ")}`);
    continue;
  }
  const dir = join(values.out, `bank_${seed}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  console.log(`seed ${seed}: ${config.bank.name} -> ${join(dir, "config.json")}`);
}

process.exit(failures > 0 ? 1 : 0);
