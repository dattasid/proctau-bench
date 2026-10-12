// Coherence checks. The sampler should never violate these; the validator
// guards against sampler bugs and against hand-edited configs.

import { productIds, productsOf } from "./products.ts";
import { highestApy, lowestApy } from "./rules.ts";
import { ACCOUNT_TYPES } from "./schema.ts";
import type { BankConfig, Product } from "./schema.ts";

function minBalanceWaiver(p: Product): number | null {
  const c = p.monthlyFee.waiver.conditions.find((x) => x.kind === "min_balance");
  return c && c.kind === "min_balance" ? c.amount : null;
}

export function validateBank(config: BankConfig): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  if (config.tiers.length === 0) return ["no tiers"];
  if (new Set(config.tiers).size !== config.tiers.length) return ["duplicate tier names"];
  const expected = new Set(productIds(config));
  for (const id of Object.keys(config.products)) if (!expected.has(id)) err(`${id}: product for an unknown tier or account type`);

  for (const id of expected) {
    const p = config.products[id];
    if (!p) {
      err(`missing product ${id}`);
      continue;
    }
    if (p.id !== id) err(`${id}: id field is ${p.id}`);
    if (p.minOpeningDeposit < 0) err(`${id}: negative opening deposit`);
    if (p.monthlyFee.amount < 0) err(`${id}: negative monthly fee`);
    const waiver = p.monthlyFee.waiver;
    if (p.monthlyFee.amount === 0 && waiver.conditions.length > 0) err(`${id}: waiver on a zero fee`);
    if (waiver.conditions.length === 0 && waiver.logic !== "any") err(`${id}: empty "all" waiver would waive every fee`);
    if (p.accountType === "checking" && p.bonuses.length > 0) err(`${id}: checking accounts have no interest bonus in this schema`);
    if (p.interest.structure === "tiered") {
      const tiers = p.interest.tiers;
      if (tiers[0]?.minBalance !== 0) err(`${id}: first tier must start at 0`);
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i]!.minBalance <= tiers[i - 1]!.minBalance) err(`${id}: tier thresholds not increasing`);
        if (tiers[i]!.apy <= tiers[i - 1]!.apy) err(`${id}: tier rates not increasing`);
      }
    }
    for (const r of p.requirements) {
      // Requirements only point to earlier account types, so they can never form a cycle.
      if (ACCOUNT_TYPES.indexOf(r.accountType) >= ACCOUNT_TYPES.indexOf(p.accountType)) {
        err(`${id}: may only require an account type listed before ${p.accountType}`);
      }
      if (r.minAgeDays < 0) err(`${id}: negative requirement age`);
    }
  }
  if (errors.length > 0) return errors;

  // Tier order: each tier against the one below it, only for banks whose tiers step up.
  for (const accountType of config.unorderedTiers ? [] : ACCOUNT_TYPES) {
    const ladder = productsOf(config, accountType);
    for (let i = 1; i < ladder.length; i++) {
      const lower = ladder[i - 1]!;
      const higher = ladder[i]!;
      const pair = `${lower.id} -> ${higher.id}`;
      if (lowestApy(higher.interest) <= highestApy(lower.interest) && highestApy(higher.interest) > 0) {
        err(`${pair}: higher tier's lowest rate must beat the lower tier's highest rate`);
      }
      if (higher.minOpeningDeposit <= lower.minOpeningDeposit) err(`${pair}: opening deposit must increase`);
      if (higher.monthlyFee.amount < lower.monthlyFee.amount) err(`${pair}: fee must not decrease`);
      const lw = minBalanceWaiver(lower);
      const hw = minBalanceWaiver(higher);
      if (lw !== null && hw !== null && hw <= lw) err(`${pair}: waiver balance must increase`);
    }
  }

  if (config.policies.feeReversal.maxPerYear < 0) err("feeReversal: negative cap");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.bank.simulatedDate)) err("bank.simulatedDate is not an ISO date");

  return errors;
}
