import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, resolveDate, ymdInZone } from "../src/flexischools/dates.ts";
import { isActiveState, normalizeHistory, normalizeMenu, normalizeOrderDays, normalizeOrderDetail, normalizeSlots, normalizeStudents } from "../src/flexischools/normalize.ts";
import { AvailableServicesResponse, FulfillmentDatesResponse, ItemListResponse, OrderDetailResponse, OrderHistoryResponse, StudentsResponse } from "../src/flexischools/schemas.ts";
import { availableServicesResponse, fulfillmentDatesResponse, itemListResponse, K, orderDetailResponse, orderHistoryResponse, studentsResponse } from "./fixtures.ts";

describe("normalizers", () => {
  it("students: trims service names and keeps keys", () => {
    const s = normalizeStudents(StudentsResponse.parse(studentsResponse));
    assert.equal(s.length, 2);
    assert.equal(s[0]!.services[1]!.name, "Junior Lunch"); // trailing space removed
    assert.equal(s[0]!.schoolKey, K.school);
  });

  it("slots: UTC cutoff becomes a real instant", () => {
    const [slot] = normalizeSlots(AvailableServicesResponse.parse(availableServicesResponse));
    assert.equal(slot!.cutoffUtc, "2026-11-05T22:30:00Z");
    assert.equal(Date.parse(slot!.cutoffUtc), Date.UTC(2026, 10, 5, 22, 30));
    assert.equal(slot!.cutoffLocal, "2026-11-06T09:30:00");
  });

  it("order days: date, cutoff and closure", () => {
    const days = normalizeOrderDays(FulfillmentDatesResponse.parse(fulfillmentDatesResponse));
    assert.deepEqual(days.map((d) => [d.date, d.cutoffPassed, d.closureReason]), [
      ["2026-11-05", true, null],
      ["2026-11-06", false, null],
      ["2026-11-09", false, "Staff development day"],
    ]);
  });

  it("history: today and future orders are present; cancelled orders are marked inactive", () => {
    const orders = normalizeHistory(OrderHistoryResponse.parse(orderHistoryResponse));
    assert.equal(orders.length, 3);
    const cancelled = orders.find((o) => o.key === "ord-cancelled")!;
    assert.equal(cancelled.state, "CancelledByUser");
    assert.equal(cancelled.active, false);
    assert.equal(orders.find((o) => o.key === "ord-lunch")!.active, true);
    assert.equal(orders.find((o) => o.key === "ord-old")!.date, "2026-11-04");
  });

  it("isActiveState: only dead states are inactive", () => {
    for (const s of ["Placed", "Printed", "Closed", "New Order"]) assert.equal(isActiveState(s), true, s);
    for (const s of ["CancelledByUser", "Cancelled By User", "Failed", "Rejected"]) assert.equal(isActiveState(s), false, s);
  });

  it("order detail: fee, cancellability and history", () => {
    const d = normalizeOrderDetail(OrderDetailResponse.parse(orderDetailResponse("Placed", true)));
    assert.equal(d.fee, 0.39);
    assert.equal(d.canCancel, true);
    assert.equal(d.total, 6.19);
    assert.equal(d.history[0]!.state, "Placed");
  });

  describe("menu", () => {
    const menu = normalizeMenu(ItemListResponse.parse(itemListResponse), "2026-11-06", K.supplier);
    const item = (key: string) => menu.items.find((i) => i.key === key)!;

    it("tolerates null option bounds/prices from the API", () => {
      const allergy = item("i-allergy");
      assert.equal(allergy.optionSets[0]!.required, false);
      assert.equal(allergy.optionSets[0]!.options[0]!.price, 0);
    });

    it("keeps server-side inStock (not label text) as availability", () => {
      assert.equal(item("i-pasta").inStock, true);
      assert.equal(item("i-offweek").inStock, false); // label says 'Available fortnightly Friday', inStock is the truth
      assert.equal(item("i-sold").inStock, false);
    });

    it("price: base for simple items, cheapest in-stock option for required sets", () => {
      assert.equal(item("i-cheese").basePrice, 4.3);
      assert.equal(item("i-cheese").priceFrom, 4.3);
      assert.equal(item("i-pasta").basePrice, 0);
      assert.equal(item("i-pasta").priceFrom, 6.6); // XL ($5.00) is out of stock and must be ignored
      assert.equal(item("i-pasta").optionSets[0]!.required, true);
    });

    it("flags items that ask checkout questions", () => {
      assert.equal(item("i-asks").hasQuestions, true);
      assert.equal(item("i-cheese").hasQuestions, false);
    });
  });
});

describe("schemas reject drift", () => {
  it("a response missing a required field fails to parse", () => {
    const bad = structuredClone(orderHistoryResponse) as any;
    delete bad.presentOrders[0].orders[0].orderState;
    assert.equal(OrderHistoryResponse.safeParse(bad).success, false);
  });
});

describe("dates", () => {
  it("resolves relative dates in the school's timezone, not the machine's", () => {
    // 14:00Z on 5 Nov is 01:00 on 6 Nov in Sydney (UTC+11).
    const now = new Date("2026-11-05T14:00:00Z");
    assert.equal(ymdInZone(now), "2026-11-06");
    assert.equal(resolveDate("today", now), "2026-11-06");
    assert.equal(resolveDate("tomorrow", now), "2026-11-07");
    assert.equal(resolveDate("yesterday", now), "2026-11-05");
    assert.equal(resolveDate("+7", now), "2026-11-13");
    assert.equal(resolveDate("2026-12-25", now), "2026-12-25");
    assert.throws(() => resolveDate("next week", now));
  });

  it("addDays crosses month and year boundaries", () => {
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });
});
