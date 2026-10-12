import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { highestApy, lowestApy } from "../src/bank/rules.ts";
import { ACCOUNT_TYPES } from "../src/bank/schema.ts";
import type { BankConfig } from "../src/bank/schema.ts";
import { validateBank } from "../src/bank/validate.ts";
import { generateBank } from "../src/gen/generate.ts";

// Ways a premium product can be worse than the basic one of the same account type.
function inversions(config: BankConfig): string[] {
  return ACCOUNT_TYPES.flatMap((t) => {
    const basic = config.products[`${t}_basic`];
    const premium = config.products[`${t}_premium`];
    return [
      premium.minOpeningDeposit <= basic.minOpeningDeposit ? `${t} deposit` : "",
      premium.monthlyFee.amount < basic.monthlyFee.amount ? `${t} fee` : "",
      highestApy(premium.interest) > 0 && lowestApy(premium.interest) <= highestApy(basic.interest) ? `${t} rate` : "",
    ].filter(Boolean);
  });
}

describe("unordered tiers", () => {
  const banks = Array.from({ length: 500 }, (_, i) => generateBank(i + 1));

  it("every bank validates, ordered or not", () => {
    for (const { bank, errors } of banks) assert.ok(bank, errors.join("; "));
  });

  it("about a fifth of banks are unordered", () => {
    const unordered = banks.filter((b) => b.bank!.config.unorderedTiers).length;
    assert.ok(unordered > 70 && unordered < 130, `${unordered} of 500`);
  });

  it("ordered banks never invert a tier; unordered banks often do", () => {
    let inverted = 0;
    for (const { bank } of banks) {
      const found = inversions(bank!.config);
      if (bank!.config.unorderedTiers) inverted += found.length > 0 ? 1 : 0;
      else assert.deepEqual(found, [], `seed ${bank!.seed}`);
    }
    const unordered = banks.filter((b) => b.bank!.config.unorderedTiers).length;
    assert.ok(inverted > unordered / 2, `${inverted} of ${unordered} unordered banks invert something`);
  });

  it("the validator still rejects an inverted ordered bank", () => {
    const config = structuredClone(banks.find((b) => !b.bank!.config.unorderedTiers)!.bank!.config);
    config.products.savings_premium.minOpeningDeposit = 0;
    assert.ok(validateBank(config).some((e) => e.includes("opening deposit")));
    config.unorderedTiers = true;
    assert.deepEqual(validateBank(config), []);
  });
});
