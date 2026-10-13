// OpenRouter spend for this key: today, this week, this month and in total, plus what is left of any
// limit. Reads the key from ./OPENROUTER_API_KEY (or the env var) and never prints it.
// Usage: node scripts/or_usage.mjs
import { existsSync, readFileSync } from "node:fs";

const key = existsSync("OPENROUTER_API_KEY") ? readFileSync("OPENROUTER_API_KEY", "utf8").trim() : process.env.OPENROUTER_API_KEY?.trim();
if (!key) {
  console.error("no OpenRouter key: put it in ./OPENROUTER_API_KEY or the OPENROUTER_API_KEY env var");
  process.exit(1);
}
const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` } });
if (!res.ok) {
  console.error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  process.exit(1);
}
const d = (await res.json()).data;
const usd = (x) => (typeof x === "number" ? `$${x.toFixed(2)}` : "n/a");
console.log(`today:      ${usd(d.usage_daily)}`);
console.log(`this week:  ${usd(d.usage_weekly)}`);
console.log(`this month: ${usd(d.usage_monthly)}`);
console.log(`all time:   ${usd(d.usage)}`);
if (d.limit != null) console.log(`limit:      ${usd(d.limit)}, ${usd(d.limit_remaining)} left${d.limit_reset ? ` (resets ${d.limit_reset})` : ""}`);
