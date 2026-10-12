// Coherence checks. The sampler should never violate these; the validator
// guards against sampler bugs and against hand-edited configs.

import { highestApy, lowestApy } from "./rules.ts";
import { PRODUCT_IDS } from "./schema.ts";
import type { BankConfig, Family, Product } from "./schema.ts";

function minBalanceWaiver(p: Product): number | null {
  const c = p.monthlyFee.waiver.conditions.find((x) => x.kind === "min_balance");
  return c && c.kind === "min_balance" ? c.amount : null;
}

export function validateBank(config: BankConfig): string[] {
  const errors: string[] = [];
  const err = (msg: string) => errors.push(msg);

  for (const id of PRODUCT_IDS) {
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
    if (p.family === "checking" && p.bonuses.length > 0) err(`${id}: checking accounts have no interest bonus in this schema`);
    if (p.interest.structure === "tiered") {
      const tiers = p.interest.tiers;
      if (tiers[0]?.minBalance !== 0) err(`${id}: first tier must start at 0`);
      for (let i = 1; i < tiers.length; i++) {
        if (tiers[i]!.minBalance <= tiers[i - 1]!.minBalance) err(`${id}: tier thresholds not increasing`);
        if (tiers[i]!.apy <= tiers[i - 1]!.apy) err(`${id}: tier rates not increasing`);
      }
    }
  }
  if (errors.length > 0) return errors;

  const families: Family[] = ["checking", "savings"];
  for (const family of families) {
    const basic = config.products[`${family}_basic`];
    const premium = config.products[`${family}_premium`];
    if (lowestApy(premium.interest) <= highestApy(basic.interest) && highestApy(premium.interest) > 0) {
      err(`${family}: premium lowest rate must beat basic highest rate`);
    }
    if (premium.minOpeningDeposit <= basic.minOpeningDeposit) err(`${family}: premium opening deposit must exceed basic`);
    if (premium.monthlyFee.amount < basic.monthlyFee.amount) err(`${family}: premium fee below basic`);
    const bw = minBalanceWaiver(basic);
    const pw = minBalanceWaiver(premium);
    if (bw !== null && pw !== null && pw <= bw) err(`${family}: premium waiver balance must exceed basic`);
  }

  const elig = config.policies.premiumSavingsEligibility;
  if (!elig.requiresChecking && elig.minCheckingAgeDays !== 0) {
    // Harmless but misleading in generated documents; normalize in the sampler instead.
    err("premiumSavingsEligibility: checking age set but checking not required");
  }
  if (config.policies.feeReversal.maxPerYear < 0) err("feeReversal: negative cap");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.bank.simulatedDate)) err("bank.simulatedDate is not an ISO date");

  return errors;
}
