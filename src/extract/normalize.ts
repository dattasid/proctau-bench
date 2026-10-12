// Code-side cleanup of extracted acts and comparison of repeated samples. Names are matched to the
// bank's products and account types, numbers and dates must appear in the agent's own words,
// duplicates collapse, and samples are compared argument by argument: a conflict is two samples
// giving different values for the same thing; a sample leaving something out is only an omission.

import { actSpec } from "./vocab.ts";
import type { Act } from "./extract.ts";

export interface Names {
  products: string[]; // display names
  accountTypes: string[]; // as customers say them, e.g. "checking", "business savings"
}

const NAME_ARGS = new Set(["product", "account", "funding_account", "required_account"]);
// Free-text arguments vary in wording between samples; only their presence is compared.
const FREE_TEXT = new Set(["detail", "reason"]);

function cleanName(raw: string, names: Names): string {
  const bare = raw.trim().replace(/^(your|the|an?)\s+/i, "").replace(/\s+account$/i, "");
  const lower = bare.toLowerCase();
  return names.products.find((p) => p.toLowerCase() === lower) ?? names.accountTypes.find((t) => t === lower) ?? bare;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Whether a number or date argument appears in the agent's words, in any usual spelling.
function grounded(value: unknown, type: string, text: string): boolean {
  const has = (s: string) => new RegExp(`(^|[^\\d])${s.replace(/[.$]/g, "\\$&")}(?![\\d])`).test(text);
  if (type === "number" && typeof value === "number") {
    const forms = [String(value), value.toLocaleString("en-US"), value.toLocaleString("en-US", { minimumFractionDigits: 2 })];
    return forms.some(has);
  }
  if (type === "date" && typeof value === "string") {
    const [y, m, d] = value.split("-").map(Number);
    const month = MONTHS[m! - 1]!;
    return text.includes(value) || new RegExp(`${month}\\s+${d}(?!\\d)`).test(text) || new RegExp(`(^|\\D)${d}\\s+${month}`).test(text) || text.includes(`${m}/${d}/${y}`);
  }
  return true;
}

// Drops number and date arguments the agent never said (worked out, or copied from the customer);
// an act whose required argument is dropped goes with it.
export function groundActs(acts: Act[], text: string): { acts: Act[]; dropped: string[] } {
  const plain = text.replace(/\*\*/g, "");
  const dropped: string[] = [];
  const kept: Act[] = [];
  for (const a of acts) {
    const spec = actSpec(a.act);
    const args: Record<string, unknown> = {};
    let lost = false;
    for (const [k, v] of Object.entries(a.args)) {
      const s = spec?.args[k];
      const exempt = k === "min_age_days" && v === 0; // "0 if no time is stated"
      if (s && !exempt && !grounded(v, s.type, plain)) {
        dropped.push(`${a.act}.${k}=${JSON.stringify(v)} is not in the turn`);
        if (!s.optional) lost = true;
        continue;
      }
      args[k] = v;
    }
    if (!lost) kept.push({ ...a, args });
  }
  return { acts: kept, dropped };
}

// Product and account names matched to the bank's own; identical acts collapse into one.
export function normalizeActs(acts: Act[], names: Names): Act[] {
  const seen = new Set<string>();
  const out: Act[] = [];
  for (const a of acts) {
    const args = Object.fromEntries(
      Object.entries(a.args).map(([k, v]) => [k, NAME_ARGS.has(k) && typeof v === "string" ? cleanName(v, names) : v]),
    );
    const act = { ...a, args };
    const id = `${factKey(act)}:${JSON.stringify(Object.keys(args).sort().map((k) => [k, show(k, args[k])]))}`;
    if (!seen.has(id)) out.push(act);
    seen.add(id);
  }
  return out;
}

const show = (k: string, v: unknown) => (FREE_TEXT.has(k) ? "*" : typeof v === "string" ? v.toLowerCase() : JSON.stringify(v));

// Which fact an act states: its name plus its key arguments.
export function factKey(a: Act): string {
  const key = actSpec(a.act)?.key ?? [];
  return `${a.act}(${key.map((k) => `${k}=${show(k, a.args[k])}`).join(",")})`;
}

const decides = (name: string) => actSpec(name)?.decides ?? true;

export interface Comparison {
  decisionsAgree: boolean; // same decision acts in every sample, with no conflicting argument
  conflicts: string[]; // an argument given different values by different samples
  omissions: string[]; // a fact or argument some samples have and others do not
  consensus: Act[]; // facts most samples have, each with the arguments most samples agree on
}

export function compareSamples(samples: Act[][]): Comparison {
  const n = samples.length;
  const majority = (count: number) => count * 2 > n;
  // For each fact, the act each sample gives for it (the first, if a sample gives several).
  const facts = new Map<string, (Act | undefined)[]>();
  samples.forEach((acts, i) => {
    for (const a of acts) {
      const key = factKey(a);
      if (!facts.has(key)) facts.set(key, new Array(n).fill(undefined));
      facts.get(key)![i] ??= a;
    }
  });

  const conflicts: string[] = [];
  const omissions: string[] = [];
  const consensus: Act[] = [];
  let decisionsAgree = true;
  for (const [key, perSample] of facts) {
    const given = perSample.filter((a): a is Act => a !== undefined);
    const name = given[0]!.act;
    if (given.length < n) {
      omissions.push(`${key} in ${given.length} of ${n}`);
      if (decides(name)) decisionsAgree = false;
    }
    const args: Record<string, unknown> = {};
    for (const k of new Set(given.flatMap((a) => Object.keys(a.args)))) {
      const values = new Map<string, { value: unknown; votes: number }>();
      for (const a of given) {
        if (!(k in a.args)) continue;
        const id = show(k, a.args[k]);
        const entry = values.get(id) ?? { value: a.args[k], votes: 0 };
        entry.votes++;
        values.set(id, entry);
      }
      const counted = [...values.values()];
      const present = counted.reduce((s, e) => s + e.votes, 0);
      if (counted.length > 1) {
        conflicts.push(`${key}.${k}: ${[...values.keys()].join(" | ")}`);
        if (decides(name)) decisionsAgree = false;
      }
      if (present < given.length) omissions.push(`${key}.${k} in ${present} of ${given.length}`);
      const best = counted.reduce((a, b) => (b.votes > a.votes ? b : a));
      if (majority(best.votes)) args[k] = best.value;
    }
    if (majority(given.length)) consensus.push({ act: name, args, quote: given[0]!.quote });
  }
  return { decisionsAgree, conflicts, omissions, consensus };
}
