// Consent before changes: only an explicit yes to that action counts, and it is used up by one change.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Act } from "../src/extract/extract.ts";
import { ConsentTracker } from "../src/harness/consent.ts";

const ask = (action: string): Act => ({ act: "ask_confirmation", args: { action }, quote: "" });

describe("consent tracker", () => {
  it("flags a change made after only the request and identity checks", () => {
    const c = new ConsentTracker();
    c.customerTurn([{ act: "greet", args: {}, quote: "" }], [{ act: "state_goal", goal: { action: "transfer_funds", from: "A", to: "B", amount: 5 } }]);
    c.customerTurn([{ act: "request_info", args: { field: "full_name" }, quote: "" }], [{ act: "give_info", field: "full_name", value: "Ada" }]);
    c.executed("find_customer", 0);
    c.executed("transfer_funds", 2);
    assert.deepEqual(c.missing, [{ index: 2, tool: "transfer_funds" }]);
  });

  it("accepts a change after the customer confirmed that action, once", () => {
    const c = new ConsentTracker();
    c.customerTurn([ask("transfer_funds")], [{ act: "confirm" }]);
    c.executed("transfer_funds", 3);
    assert.deepEqual(c.missing, []);
    c.executed("transfer_funds", 4); // a second transfer needs a second yes
    assert.deepEqual(c.missing, [{ index: 4, tool: "transfer_funds" }]);
  });

  it("does not count a correction, or a yes to a different action", () => {
    const c = new ConsentTracker();
    c.customerTurn([ask("transfer_funds")], [{ act: "correct", field: "amount", value: 500 }]);
    c.customerTurn([ask("refund_fee")], [{ act: "confirm" }]);
    c.executed("transfer_funds", 5);
    c.executed("refund_fee", 6);
    assert.deepEqual(c.missing, [{ index: 5, tool: "transfer_funds" }]);
  });
});
