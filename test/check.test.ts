import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkOrders } from "../src/flexischools/check.ts";
import type { CheckInput } from "../src/flexischools/check.ts";
import { normalizeHistory, normalizeOrderDays, normalizeSlots, normalizeStudents } from "../src/flexischools/normalize.ts";
import { AvailableServicesResponse, FulfillmentDatesResponse, OrderHistoryResponse, StudentsResponse } from "../src/flexischools/schemas.ts";
import { availableServicesResponse, fulfillmentDatesResponse, K, orderHistoryResponse, studentsResponse } from "./fixtures.ts";

const students = normalizeStudents(StudentsResponse.parse(studentsResponse));
const orders = normalizeHistory(OrderHistoryResponse.parse(orderHistoryResponse));
const days = normalizeOrderDays(FulfillmentDatesResponse.parse(fulfillmentDatesResponse));
const slots = normalizeSlots(AvailableServicesResponse.parse(availableServicesResponse));

function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    date: "2026-11-06",
    students,
    orders,
    daysByService: new Map([
      [`${K.stuA}:${K.lunch}`, days],
      [`${K.stuA}:${K.recess}`, days],
      [`${K.stuB}:${K.lunchB}`, days],
    ]),
    slotsByStudent: new Map([[K.stuA, slots]]),
    serviceMatch: /lunch/i,
    now: new Date("2026-11-05T21:30:00Z"),
    ...over,
  };
}

describe("checkOrders (the reminder logic)", () => {
  it("ordered: an active order exists; reports minutes to cutoff when known", () => {
    const rows = checkOrders(input({ students: [students[0]!] }));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "ordered");
    assert.equal(rows[0]!.orders[0]!.key, "ord-lunch");
    assert.equal(rows[0]!.minutesToCutoff, 60); // cutoff 22:30Z, now 21:30Z
  });

  it("missing: an order day with nothing ordered and the cutoff not passed", () => {
    const rows = checkOrders(input({ students: [students[1]!] }));
    assert.equal(rows[0]!.status, "missing");
    assert.equal(rows[0]!.student, "Bob");
  });

  it("a cancelled order does NOT count as ordered", () => {
    // Alice's only Junior Recess order for the day was cancelled.
    const rows = checkOrders(input({ students: [students[0]!], serviceMatch: /recess/i }));
    assert.equal(rows[0]!.status, "missing");
    assert.deepEqual(rows[0]!.orders, []);
  });

  it("missed_cutoff: nothing ordered and the cutoff has passed", () => {
    const passed = days.map((d) => (d.date === "2026-11-06" ? { ...d, cutoffPassed: true } : d));
    const rows = checkOrders(input({ students: [students[0]!], serviceMatch: /recess/i, daysByService: new Map([[`${K.stuA}:${K.recess}`, passed]]) }));
    assert.equal(rows[0]!.status, "missed_cutoff");
  });

  it("no_order_day: unknown day, or a closure (with the reason)", () => {
    const closed = checkOrders(input({ date: "2026-11-09", students: [students[0]!] }));
    assert.equal(closed[0]!.status, "no_order_day");
    assert.equal(closed[0]!.closureReason, "Staff development day");

    const weekend = checkOrders(input({ date: "2026-11-07", students: [students[0]!] }));
    assert.equal(weekend[0]!.status, "no_order_day");
  });

  it("only checks services that match the filter", () => {
    const rows = checkOrders(input({ serviceMatch: /recess/i }));
    assert.deepEqual(rows.map((r) => r.service), ["Junior Recess"]);
  });

  it("an order for a different service or date does not satisfy the check", () => {
    const wrongDay = orders.filter((o) => o.key === "ord-old"); // lunch, but 4 Nov
    const rows = checkOrders(input({ students: [students[0]!], orders: wrongDay }));
    assert.equal(rows[0]!.status, "missing");
  });
});
