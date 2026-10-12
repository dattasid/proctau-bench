// Fee waiver witnesses: histories that make the waiver met or not met in chosen months, checked by
// the rules, with planted wrong fees that the audit finds and nothing else.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditDatabase, describeFinding } from "../src/bank/validate_db.ts";
import { evaluateWaiver } from "../src/bank/rules.ts";
import { generateBank } from "../src/gen/generate.ts";
import { addCustomer } from "../src/gen/fixtures.ts";
import { feeHistory } from "../src/gen/witness.ts";
import type { MonthPlan } from "../src/gen/witness.ts";
import { addMonths, monthOf } from "../src/util/dates.ts";
import { createRng } from "../src/util/rng.ts";

describe("fee waiver witnesses", () => {
  it("make the waiver come out as planned, with exactly the planted findings", () => {
    let built = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const bank = generateBank(seed).bank!;
      const { config } = bank;
      const today = config.bank.simulatedDate;
      const month = addMonths(monthOf(today), Number(today.slice(8)) >= 6 ? -1 : -2);
      const waivable = Object.values(config.products).filter(
        (p) => p.requirements.length === 0 && p.monthlyFee.amount > 0 && p.monthlyFee.waiver.conditions.length > 0,
      );
      for (const product of waivable) {
        const cases: [MonthPlan[], "none" | "add" | "remove"][] = [
          [[{ month, met: true }], "none"],
          [[{ month, met: true, chargeAnyway: true }], "remove"],
          [[{ month, met: false }], "add"],
        ];
        if (config.policies.feeReversal.maxPerYear > 0) cases.push([[{ month: addMonths(month, -1), met: false, courtesy: true }, { month, met: false }], "none"]);
        for (const [plans, after] of cases) {
          const db = structuredClone(bank.db);
          const customer = addCustomer(db, { name: "Test Person", dateOfBirth: "1980-05-05", ssnLast4: "1111" });
          let h;
          try {
            h = feeHistory(createRng(seed, 50 + built), config, db, customer, product, plans, after);
          } catch (e) {
            // Only a minimum balance too low to stay safely under, or no room for a reversal, may refuse.
            assert.match((e as Error).message, /line too low|no room for the courtesy/, `seed ${seed} ${product.id}`);
            continue;
          }
          built++;
          for (const plan of plans) assert.equal(evaluateWaiver(config, db, h.account, plan.month).waived, plan.met);
          const { errors, findings } = auditDatabase(config, db);
          assert.deepEqual(errors, []);
          assert.deepEqual(findings.map(describeFinding).sort(), h.planted.map(describeFinding).sort(), `seed ${seed} ${product.id}`);
          if (plans.some((p) => p.chargeAnyway)) assert.equal(h.planted.length, 1);
        }
      }
    }
    assert.ok(built > 500, `${built} histories`);
  });
});
