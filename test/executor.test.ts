import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIds } from "../src/bank/products.ts";
import { DECLINED, callTool, toolList } from "../src/env/executor.ts";
import { addAccount, addCustomer, addTransaction, emptyDatabase } from "../src/gen/fixtures.ts";
import { addDays } from "../src/util/dates.ts";
import { createRng } from "../src/util/rng.ts";
import { sampleBank } from "../src/gen/sample.ts";
import { sampleDatabase } from "../src/gen/sample_db.ts";
import type { BankConfig } from "../src/bank/schema.ts";
import { createSession } from "../src/env/session.ts";
import type { Session } from "../src/env/session.ts";
import { strictProblems } from "../src/bank/validate_db.ts";

const DOB = "1988-03-14";
const SSN = "4821";

// A sampled bank with the policies the test needs pinned down, Premium savings requiring a
// checking account held 30 days, and one customer holding a checking account of the given
// age and balance.
function setup(policies: Partial<BankConfig["policies"]> = {}, checkingAgeDays = 400, checkingCents = 1_000_000) {
  const config = sampleBank(createRng(1), 1);
  config.policies = {
    ...config.policies,
    identityVerification: "once_per_session",
    eligibilityEnforcement: "agent",
    feeReversal: { maxPerYear: 1 },
    ...policies,
  };
  config.products.savings_premium!.requirements = [{ kind: "holds_account", accountType: "checking", minAgeDays: 30 }];
  const today = config.bank.simulatedDate;
  const db = emptyDatabase();
  const customer = addCustomer(db, { name: "Maria Chen", dateOfBirth: DOB, ssnLast4: SSN });
  const checking = addAccount(db, customer, "checking_basic", addDays(today, -checkingAgeDays), checkingCents);
  return { config, db, customer, checking, session: createSession(config, db) };
}

const verify = (s: Session, customerId: string) => callTool(s, "verify_identity", { customerId, dateOfBirth: DOB, ssnLast4: SSN });
const failed = (r: { checks: { rule: string; passed: boolean }[] }) => r.checks.filter((c) => !c.passed).map((c) => c.rule);

function openPremiumSavings(s: Session, customerId: string, fundingAccountId: string) {
  const deposit = Math.max(s.config.products.savings_premium!.minOpeningDeposit, 100);
  return callTool(s, "open_account", { customerId, productId: "savings_premium", initialDeposit: deposit, fundingAccountId });
}

describe("text values", () => {
  it("converts an unambiguous number or boolean, records it, and still checks the converted value", () => {
    const { customer, checking, session } = setup();
    verify(session, customer.id);
    const savings = openPremiumSavings(session, customer.id, checking.id);
    const moved = callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: (savings.result as { account: { accountId: string } }).account.accountId, amount: " 250 " });
    assert.equal(moved.outcome, "executed");
    assert.deepEqual(moved.coerced, [{ arg: "amount", from: " 250 ", to: 250 }]);
    assert.deepEqual(moved.args, { fromAccountId: checking.id, toAccountId: (moved.args as { toAccountId: string }).toAccountId, amount: " 250 " });
    // Converted, then refused by the money check like any other number.
    const cents = callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: checking.id, amount: "10.555" });
    assert.equal(cents.outcome, "invalid");
    assert.match(cents.shapeErrors.join(), /at most two decimals/);
    // Not unambiguous: left as text, and invalid.
    assert.equal(callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: checking.id, amount: "$250" }).outcome, "invalid");
    const month = addDays(session.now, -40).slice(0, 7);
    const interest = callTool(session, "calculate_interest", { accountId: checking.id, month, method: "average_daily_balance", includeBonus: "TRUE" });
    assert.deepEqual(interest.coerced, [{ arg: "includeBonus", from: "TRUE", to: true }]);
    assert.equal(interest.outcome, "executed");
  });
});

describe("tool list", () => {
  it("exposes every tool with a JSON schema", () => {
    const config = sampleBank(createRng(1), 1);
    const tools = toolList(config);
    const productEnum = (tools.find((t) => t.name === "open_account")!.parameters.properties.productId as { enum?: string[] }).enum;
    assert.deepEqual(productEnum, productIds(config));
    assert.ok(productEnum!.includes("checking_basic") && productEnum!.includes("savings_premium"));
    assert.equal(tools.length, 11);
    const open = tools.find((t) => t.name === "open_account")!;
    assert.deepEqual(open.parameters.required, ["customerId", "productId", "initialDeposit", "fundingAccountId"]);
  });
});

describe("shape", () => {
  it("rejects unknown tools, missing and bad arguments without touching the database", () => {
    const { session, customer } = setup();
    assert.equal(callTool(session, "close_account", {}).outcome, "invalid");
    assert.equal(callTool(session, "verify_identity", { customerId: customer.id }).outcome, "invalid");
    const bad = callTool(session, "open_account", { customerId: customer.id, productId: "gold", initialDeposit: 10.001, fundingAccountId: "x" });
    assert.equal(bad.outcome, "invalid");
    assert.equal(bad.shapeErrors.length, 2);
    assert.ok(session.trace.every((r) => r.changes.length === 0));
  });
});

describe("identity", () => {
  it("lets reads through before verification but records the violation", () => {
    const { session, customer } = setup();
    const before = callTool(session, "list_accounts", { customerId: customer.id });
    assert.equal(before.outcome, "executed");
    assert.deepEqual(failed(before), ["identity.verified"]);
    assert.deepEqual(verify(session, customer.id).result, { verified: true });
    assert.deepEqual(failed(callTool(session, "list_accounts", { customerId: customer.id })), []);
  });

  it("does not verify with a wrong date of birth", () => {
    const { session, customer, checking } = setup();
    const r = callTool(session, "verify_identity", { customerId: customer.id, dateOfBirth: "1988-03-15", ssnLast4: SSN });
    assert.deepEqual(r.result, { verified: false });
    assert.deepEqual(failed(openPremiumSavings(session, customer.id, checking.id)), ["identity.verified"]);
  });

  it("needs a fresh verification before every write under that policy", () => {
    const { session, customer, checking } = setup({ identityVerification: "before_every_write" });
    const savings = addAccount(session.db, customer, "savings_basic", checking.openedOn, 0);
    verify(session, customer.id);
    const move = () => callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: savings.id, amount: 100 });
    assert.deepEqual(failed(move()), []);
    assert.deepEqual(failed(move()), ["identity.verified"]);
    assert.deepEqual(failed(callTool(session, "list_accounts", { customerId: customer.id })), []);
    verify(session, customer.id);
    assert.deepEqual(failed(move()), []);
  });
});

describe("product eligibility", () => {
  it("opens when the checking account is old enough", () => {
    const { session, customer, checking } = setup({}, 40);
    verify(session, customer.id);
    const r = openPremiumSavings(session, customer.id, checking.id);
    assert.equal(r.outcome, "executed");
    assert.ok(r.checks.every((c) => c.passed));
  });

  // "api" enforcement is only for RL with weak agents; the benchmark never samples it.
  it("blocks a too-young checking account when the API enforces the rule", () => {
    const { session, customer, checking } = setup({ eligibilityEnforcement: "api" }, 20);
    verify(session, customer.id);
    const r = openPremiumSavings(session, customer.id, checking.id);
    assert.equal(r.outcome, "blocked");
    assert.deepEqual(r.result, { error: DECLINED });
    assert.equal(r.changes.length, 0);
    assert.equal(Object.keys(session.db.accounts).length, 1);
  });

  it("lets the call through but records the violation when the agent must enforce it", () => {
    const { session, customer, checking } = setup({}, 20);
    verify(session, customer.id);
    const r = openPremiumSavings(session, customer.id, checking.id);
    assert.equal(r.outcome, "executed");
    const rule = r.checks.find((c) => c.rule === "product.eligibility")!;
    assert.equal(rule.passed, false);
    assert.equal(rule.enforcement, "agent");
  });
});

describe("opening and transfers", () => {
  it("records a deposit below the product minimum as a violation", () => {
    const { session, customer, checking, config } = setup();
    verify(session, customer.id);
    const min = config.products.checking_premium.minOpeningDeposit;
    const r = callTool(session, "open_account", { customerId: customer.id, productId: "checking_premium", initialDeposit: min - 1, fundingAccountId: checking.id });
    assert.equal(r.outcome, "executed");
    assert.deepEqual(failed(r), ["opening.min_deposit"]);
  });

  it("fails a transfer without enough funds as a system error", () => {
    const { session, customer, checking } = setup({}, 400, 5_000);
    const savings = addAccount(session.db, customer, "savings_basic", checking.openedOn, 0);
    verify(session, customer.id);
    const r = callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: savings.id, amount: 60 });
    assert.equal(r.outcome, "error");
    assert.match(JSON.stringify(r.result), /Insufficient funds/);
  });

  it("records the database change of a transfer", () => {
    const { session, customer, checking } = setup();
    const savings = addAccount(session.db, customer, "savings_basic", checking.openedOn, 0);
    verify(session, customer.id);
    const r = callTool(session, "transfer_funds", { fromAccountId: checking.id, toAccountId: savings.id, amount: 250.5 });
    assert.equal(r.outcome, "executed");
    const ops = r.changes.map((c) => `${c.op} ${c.table}`).sort();
    assert.deepEqual(ops, ["add transactions", "add transactions", "update accounts", "update accounts"]);
    assert.equal(session.db.accounts[savings.id]!.balanceCents, 25_050);
  });
});

describe("fee refunds", () => {
  // Basic checking's fee is waived only by holding another account. The customer has
  // just the one checking account unless `linked`, and was charged last month's fee.
  function withFee(linked = false) {
    const ctx = setup({}, 400, 50_000);
    const { config, session, checking, customer } = ctx;
    config.products.checking_basic.monthlyFee = { amount: 12, waiver: { logic: "any", conditions: [{ kind: "linked_account" }] } };
    if (linked) addAccount(session.db, customer, "savings_basic", checking.openedOn, 0);
    const today = config.bank.simulatedDate;
    const fee = addTransaction(session.db, checking, addDays(today, -1), "monthly_fee", -1_200, "Monthly fee", {
      feeMonth: addDays(today, -40).slice(0, 7),
    });
    verify(session, customer.id);
    return { ...ctx, fee };
  }

  it("passes a correction when the waiver was met", () => {
    const { session, fee } = withFee(true);
    const r = callTool(session, "refund_fee", { transactionId: fee.id, reason: "correction" });
    assert.equal(r.outcome, "executed");
    assert.ok(r.checks.every((c) => c.passed));
  });

  it("flags a correction when the waiver was not met, without blocking it", () => {
    const { session, fee } = withFee();
    const r = callTool(session, "refund_fee", { transactionId: fee.id, reason: "correction" });
    const rule = r.checks.find((c) => c.rule === "refund.correction_valid")!;
    assert.equal(r.outcome, "executed");
    assert.equal(rule.passed, false);
    assert.equal(rule.enforcement, "agent");
  });

  it("refuses to refund the same fee twice", () => {
    const { session, fee } = withFee();
    assert.equal(callTool(session, "refund_fee", { transactionId: fee.id, reason: "courtesy" }).outcome, "executed");
    assert.equal(callTool(session, "refund_fee", { transactionId: fee.id, reason: "courtesy" }).outcome, "error");
  });

  it("records a courtesy reversal over the yearly cap as a violation", () => {
    const { session, fee, checking, config } = withFee();
    const earlier = addTransaction(session.db, checking, addDays(config.bank.simulatedDate, -2), "monthly_fee", -1_200, "Monthly fee", { feeMonth: "2000-01" });
    addTransaction(session.db, checking, config.bank.simulatedDate, "fee_reversal", 1_200, "Courtesy reversal", { relatedId: earlier.id });
    const r = callTool(session, "refund_fee", { transactionId: fee.id, reason: "courtesy" });
    const rule = r.checks.find((c) => c.rule === "refund.courtesy_cap")!;
    assert.equal(rule.passed, false);
    assert.equal(r.outcome, "executed");
  });
});

describe("session end", () => {
  it("rejects every call after a transfer to a human", () => {
    const { session, customer } = setup();
    assert.equal(callTool(session, "transfer_to_human", { summary: "wants a mortgage" }).outcome, "executed");
    assert.equal(verify(session, customer.id).outcome, "error");
  });
});

describe("generated banks", () => {
  it("serves background customers and keeps the database valid after writes", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const config = sampleBank(createRng(seed, 0), seed);
      const db = sampleDatabase(createRng(seed, 1), config);
      const session = createSession(config, db);
      for (const c of Object.values(db.customers)) {
        callTool(session, "verify_identity", { customerId: c.id, dateOfBirth: c.dateOfBirth, ssnLast4: c.ssnLast4 });
        const accounts = Object.values(session.db.accounts).filter((a) => a.customerId === c.id);
        const [first, second] = accounts;
        if (first && second && first.balanceCents >= 100) {
          const r = callTool(session, "transfer_funds", { fromAccountId: first.id, toAccountId: second.id, amount: 1 });
          assert.equal(r.outcome, "executed", `seed ${seed}: ${JSON.stringify(r.result)}`);
        }
      }
      assert.deepEqual(strictProblems(config, session.db), [], `seed ${seed}`);
      assert.deepEqual(strictProblems(config, db), [], `seed ${seed}: original database was modified`);
    }
  });
});
