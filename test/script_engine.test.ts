// The script engine with hand-written agent acts: no LLM, so every reply is exact.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Act } from "../src/extract/extract.ts";
import { newState, step } from "../src/script/engine.ts";
import type { CustomerScript } from "../src/script/types.ts";

const act = (name: string, args: Record<string, unknown> = {}): Act => ({ act: name, args, quote: "" });

const goal = { action: "open_account", product: "Navy Savings", amount: 3000, funding_account: "Classic Checking" } as const;

const eligible: CustomerScript = {
  name: "Ada Quinn",
  knows: { full_name: "Ada Quinn", date_of_birth: "1980-02-03", ssn_last4: "1234", product: "Navy Savings", amount: 3000, funding_account: "Classic Checking" },
  goal,
  reactions: {},
  expectedEnding: "account_opened",
  truth: { kind: "opening", requirements: [{ required_account: "checking", min_age_days: 60 }], eligible: true, min_deposit: 2500 },
};

const tooNew: CustomerScript = {
  ...eligible,
  reactions: { refused: ["ask_when_eligible", "thank_and_end"], date_given: ["thank_and_end"], alternative: ["decline"] },
  expectedEnding: "refused_with_date",
  truth: { kind: "opening", requirements: [{ required_account: "checking", min_age_days: 60 }], eligible: false, eligible_date: "2026-04-04", min_deposit: 2500 },
};

const names = (s: ReturnType<typeof step>) => s.acts.map((a) => a.act);

describe("script engine", () => {
  it("runs the happy path of an eligible opening", () => {
    const state = newState();
    assert.deepEqual(names(step(eligible, state, [act("greet")])), ["state_goal"]);
    const ask = step(eligible, state, [
      act("request_info", { field: "full_name" }),
      act("request_info", { field: "date_of_birth" }),
      act("request_info", { field: "ssn_last4" }),
    ]);
    assert.deepEqual(ask.acts, [
      { act: "give_info", field: "full_name", value: "Ada Quinn" },
      { act: "give_info", field: "date_of_birth", value: "1980-02-03" },
      { act: "give_info", field: "ssn_last4", value: "1234" },
    ]);
    const confirm = step(eligible, state, [act("ask_confirmation", { action: "open_account", product: "navy savings", amount: 3000 })]);
    assert.deepEqual(names(confirm), ["confirm"]);
    const done = step(eligible, state, [act("action_result", { action: "open_account", status: "done", product: "Navy Savings" }), act("offer_more_help")]);
    assert.deepEqual(names(done), ["thank_and_end"]);
    assert.equal(done.end, "user_stop");
  });

  it("corrects a confirmation with the wrong amount or funding account", () => {
    const s = step(eligible, newState(), [act("ask_confirmation", { action: "open_account", product: "Navy Savings", amount: 300 })]);
    assert.deepEqual(s.acts, [{ act: "correct", field: "amount", value: 3000 }]);
    const t = step(eligible, newState(), [act("ask_confirmation", { action: "open_account", funding_account: "Gold Checking" })]);
    assert.deepEqual(t.acts, [{ act: "correct", field: "funding_account", value: "Classic Checking" }]);
  });

  it("asks why once when an eligible customer is refused, then ends", () => {
    const state = newState();
    assert.deepEqual(names(step(eligible, state, [act("mentions_eligibility", { product: "Navy Savings", eligible: false })])), ["ask_why"]);
    const second = step(eligible, state, [act("mentions_requirement", { product: "Navy Savings", required_account: "checking", min_age_days: 60 })]);
    assert.deepEqual(names(second), ["acknowledge"]);
    const third = step(eligible, state, [act("action_result", { action: "open_account", status: "not_done" })]);
    assert.deepEqual(names(third), ["thank_and_end"]);
  });

  it("held too briefly: asks when, ends once given a date, declines alternatives", () => {
    const state = newState();
    const refused = step(tooNew, state, [act("report_verification", { subject: "identity", passed: true }), act("mentions_eligibility", { product: "Navy Savings", eligible: false })]);
    assert.deepEqual(names(refused), ["ask_when_eligible"]);
    assert.deepEqual(names(step(tooNew, newState(), [act("offer_alternative", { product: "Teal Savings" })])), ["decline"]);
    const dated = step(tooNew, state, [act("mentions_eligible_date", { product: "Navy Savings", date: "2026-04-04" })]);
    assert.deepEqual(names(dated), ["thank_and_end"]);
    assert.equal(dated.end, "user_stop");
  });

  it("a refusal that already gives the date ends at once", () => {
    const s = step(tooNew, newState(), [
      act("mentions_eligibility", { product: "Navy Savings", eligible: false }),
      act("mentions_eligible_date", { product: "Navy Savings", date: "2026-04-04" }),
    ]);
    assert.equal(s.trigger, "date_given");
    assert.deepEqual(names(s), ["thank_and_end"]);
  });

  it("answers what it doesn't know with dont_have, and needs no acknowledgement besides", () => {
    const s = step(eligible, newState(), [act("request_info", { field: "account" }), act("mentions_eligibility", { product: "Navy Savings", eligible: true })]);
    assert.deepEqual(s.acts, [{ act: "dont_have", field: "account" }]);
  });

  it("stops off script on a turn of only unknown acts, and flags an unknown among others", () => {
    const off = step(eligible, newState(), [act("unknown")]);
    assert.equal(off.end, "off_script");
    assert.deepEqual(off.acts, []);
    const mixed = step(eligible, newState(), [act("unknown"), act("greet")]);
    assert.deepEqual(names(mixed), ["state_goal"]);
    assert.deepEqual(mixed.flags, ["unknown act ignored"]);
  });

  it("refund goal: states the fee, insists once when told it was valid, confirms the right refund", () => {
    const refund: CustomerScript = {
      ...eligible,
      knows: { full_name: "Ada Quinn", account: "Classic Checking", amount: 12, date: "2026-03-01" },
      goal: { action: "refund_fee", account: "Classic Checking", amount: 12, date: "2026-03-01" },
      reactions: { refused: ["insist", "thank_and_end"] },
      expectedEnding: "fee_refunded",
    };
    const state = newState();
    assert.deepEqual(names(step(refund, state, [act("greet")])), ["state_goal"]);
    assert.deepEqual(step(refund, state, [act("request_info", { field: "date" })]).acts, [{ act: "give_info", field: "date", value: "2026-03-01" }]);
    assert.deepEqual(names(step(refund, state, [act("mentions_fee_valid", { account: "Classic Checking", valid: true })])), ["insist"]);
    assert.deepEqual(names(step(refund, state, [act("ask_confirmation", { action: "refund_fee", account: "Classic Checking", amount: 12 })])), ["confirm"]);
    assert.deepEqual(step(refund, state, [act("ask_confirmation", { action: "refund_fee", amount: 15 })]).acts, [{ act: "correct", field: "amount", value: 12 }]);
    const done = step(refund, state, [act("action_result", { action: "refund_fee", status: "done", account: "Classic Checking" })]);
    assert.equal(done.end, "user_stop");
  });

  it("waits while the agent says it is transferring, accepts an offered transfer, ends on goodbye", () => {
    const t = step(eligible, newState(), [act("transfer_to_human")]);
    assert.deepEqual(names(t), ["acknowledge"]);
    assert.equal(t.end, null);
    assert.deepEqual(names(step(eligible, newState(), [act("offer_transfer")])), ["confirm"]);
    const bye = step(eligible, newState(), [act("closing")]);
    assert.equal(bye.end, "agent_ended");
    assert.deepEqual(bye.acts, []);
  });
});
