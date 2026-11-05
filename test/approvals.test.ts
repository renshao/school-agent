// The approval gate guards the money path: these tests pin down that proposing sends nothing, and that approving
// executes exactly once, only while valid, and only what the human saw.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalDesk, describeProposal } from "../src/agent/approvals.ts";
import { FlexiError } from "../src/flexischools/errors.ts";
import { itemListResponse } from "./fixtures.ts";
import { fakeFlexi, isPlaceOrder, menuWithPrice, route } from "./flexi-fake.ts";
import { json } from "./helpers.ts";

const lunch = { student: "Alice", service: "lunch", date: "2026-11-06", items: [{ item: "Cheese Sandwich" }] };
const T0 = new Date("2026-11-05T20:00:00Z"); // 07:00 Sydney on the 6th

function desk(...extra: Parameters<typeof fakeFlexi>) {
  const f = fakeFlexi(...extra);
  let now = T0;
  const d = new ApprovalDesk(f.client, { now: () => now, ttlMs: 30 * 60_000 });
  return { ...f, desk: d, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("ApprovalDesk: proposing", () => {
  it("validates and prices the order, sends nothing, and names everything a human must see", async () => {
    const { desk: d, writes } = desk();
    const p = await d.proposeOrder({ ...lunch, items: [{ item: "up & go", choices: [{ option: "chocolate" }] }, { item: "Cheese Sandwich", quantity: 2 }] });
    assert.equal(p.status, "pending");
    assert.equal(p.id, "P1");
    assert.equal(p.summary.total, 12.79); // 3.80 + 2 x 4.30 + 0.39
    assert.equal(describeProposal(p), "ORDER Alice · Junior Lunch · 2026-11-06 · 1 x Up & Go (Chocolate) $3.80 + 2 x Cheese Sandwich $8.60 + fee $0.39 = $12.79");
    assert.equal(writes().length, 0, "proposing must not place anything");
  });

  it("warns when the child already has an active order for that service and day", async () => {
    const { desk: d } = desk();
    const p = await d.proposeOrder(lunch);
    assert.equal(p.warnings.length, 1);
    assert.match(p.warnings[0]!, /Already ordered.*Alice.*Junior Lunch.*Cheese Sandwich \(White\)/);
  });

  it("surfaces validation errors (sold-out option, cutoff passed) and stores nothing", async () => {
    const { desk: d } = desk();
    await assert.rejects(d.proposeOrder({ ...lunch, items: [{ item: "Up & Go", choices: [{ option: "Vanilla" }] }] }), /sold out/);
    await assert.rejects(d.proposeOrder({ ...lunch, date: "2026-11-05" }), /cutoff.*has passed/);
    assert.equal(d.pending().length, 0);
  });

  it("a cancellation is proposed only for an order that can still be cancelled", async () => {
    const { desk: d, writes } = desk(route("GET", /orders\/ord-printed$/, () => json({ orderKey: { id: 1, value: "ord-printed" }, ...printed })));
    const p = await d.proposeCancel("ord-1");
    assert.match(describeProposal(p), /^CANCEL Alice Example · Junior Recess · 2026-11-06 · Bacon Roll · \$6\.19/);
    await assert.rejects(d.proposeCancel("ord-printed"), /can no longer be cancelled/);
    assert.equal(writes().length, 0);
  });
});

const printed = (() => {
  // An order already sent to the canteen.
  return { studentName: "Alice Example", studentKey: { id: 2, value: "stu-aaaa" }, serviceName: "Junior Lunch", supplierServiceKey: { id: 3, value: "svc-lunch" }, items: [{ itemDisplayName: "Pizza", itemTotalPrice: 7.85 }], stateHistory: [], totalPrice: 8.24, totalGst: 0, orderFee: 0.39, fulfillmentDate: "2026-11-06T12:30:00", canCancelOrder: false, orderState: "Printed" };
})();

describe("ApprovalDesk: approving", () => {
  it("places the order exactly once, even if approved twice concurrently", async () => {
    const { desk: d, calls } = desk();
    const p = await d.proposeOrder(lunch);
    const [a, b] = await Promise.allSettled([d.approve(p.id, "Ren"), d.approve(p.id, "Wife")]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "rejected");
    assert.equal(p.status, "done");
    assert.equal(p.decidedBy, "Ren");
    assert.match(p.outcome!, /Placed order ord-new/);
    assert.equal(calls.filter(isPlaceOrder).length, 1);
    await assert.rejects(d.approve(p.id, "Ren"), /is done/);
    assert.equal(calls.filter(isPlaceOrder).length, 1);
  });

  it("the posted body is the order the human saw (same items and total)", async () => {
    const { desk: d, calls } = desk();
    const p = await d.proposeOrder(lunch);
    await d.approve(p.id, "Ren");
    const body = JSON.parse(calls.find(isPlaceOrder)!.body!);
    assert.equal(body.totalCartAmount, p.summary.total);
    assert.deepEqual(body.placeOrderRequests[0].items.map((i: { itemKey: string }) => i.itemKey), ["i-cheese"]);
  });

  it("a rejected proposal can never be approved", async () => {
    const { desk: d, writes } = desk();
    const p = await d.proposeOrder(lunch);
    d.reject(p.id, "Ren");
    await assert.rejects(d.approve(p.id, "Ren"), (e: unknown) => e instanceof FlexiError && /rejected/.test(e.message));
    assert.equal(writes().length, 0);
  });

  it("an expired proposal cannot be approved", async () => {
    const { desk: d, writes, advance } = desk();
    const p = await d.proposeOrder(lunch);
    advance(31 * 60_000);
    await assert.rejects(d.approve(p.id, "Ren"), /expired/);
    assert.equal(d.pending().length, 0);
    assert.equal(writes().length, 0);
  });

  it("if the price changed since the human looked, nothing is placed (stale)", async () => {
    let priceChanged = false;
    const { desk: d, writes } = desk(route("GET", /\/itemlist$/, () => json(priceChanged ? menuWithPrice("i-cheese", 4.8) : itemListResponse)));
    const p = await d.proposeOrder(lunch);
    priceChanged = true;
    await d.approve(p.id, "Ren");
    assert.equal(p.status, "stale");
    assert.match(p.outcome!, /changed since it was proposed.*\$5\.19/);
    assert.equal(writes().length, 0);
  });

  it("if the order became invalid (e.g. sold out) since proposing, nothing is placed (stale)", async () => {
    let soldOut = false;
    const sold = () => {
      const m = structuredClone(itemListResponse) as any;
      for (const c of m.itemCategories) for (const i of c.items) if (i.itemKey === "i-cheese") i.inStock = false;
      return m;
    };
    const { desk: d, writes } = desk(route("GET", /\/itemlist$/, () => json(soldOut ? sold() : itemListResponse)));
    const p = await d.proposeOrder(lunch);
    soldOut = true;
    await d.approve(p.id, "Ren");
    assert.equal(p.status, "stale");
    assert.match(p.outcome!, /no longer valid.*not available/);
    assert.equal(writes().length, 0);
  });

  it("an unconfirmed outcome is recorded as unknown and is never retried", async () => {
    const { desk: d, calls } = desk(route("POST", /\/api\/v2\.0\/orders$/, () => json({ ok: true })));
    const p = await d.proposeOrder(lunch);
    const r = await d.approve(p.id, "Ren");
    assert.equal(r.status, "unknown");
    assert.match(r.outcome!, /MAY have been placed/);
    await assert.rejects(d.approve(p.id, "Ren"), /is unknown/);
    assert.equal(calls.filter(isPlaceOrder).length, 1);
  });

  it("a refused request is recorded as failed (nothing ordered)", async () => {
    const { desk: d } = desk(route("POST", /\/api\/v2\.0\/orders$/, () => json({ message: "nope" }, 400)));
    const p = await d.proposeOrder(lunch);
    await d.approve(p.id, "Ren");
    assert.equal(p.status, "failed");
    assert.match(p.outcome!, /^Failed, nothing ordered/);
  });

  it("an approved cancellation sends exactly one DELETE and confirms the new state", async () => {
    const { desk: d, calls } = desk();
    const p = await d.proposeCancel("ord-1");
    await d.approve(p.id, "Ren");
    assert.equal(p.status, "done");
    assert.match(p.outcome!, /CancelledByUser/);
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);
  });
});
