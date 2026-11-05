import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FlexiClient } from "../src/flexischools/client.ts";
import { FlexiError } from "../src/flexischools/errors.ts";
import { FlexiHttp } from "../src/flexischools/http.ts";
import type { Student } from "../src/flexischools/types.ts";
import { availableServicesResponse, fulfillmentDatesResponse, itemListResponse, K, orderDetailResponse, orderFeeResponse, orderHistoryResponse, placeOrderResponse, studentsResponse } from "./fixtures.ts";
import { fakeFetch, json } from "./helpers.ts";
import type { Handler } from "./helpers.ts";

const route = (method: string, test: RegExp, respond: (c: Parameters<Handler>[0]) => Response): Handler => (c) =>
  c.method === method && test.test(c.url.pathname) ? respond(c) : undefined;

function setup(...extra: Handler[]) {
  const forced: boolean[] = [];
  const tokens = { async getIdToken(force = false) { forced.push(force); return force ? "tok-2" : "tok-1"; } };
  const { fetch, calls } = fakeFetch(
    ...extra,
    route("GET", /service-categories\/1\/students$/, () => json(studentsResponse)),
    route("POST", /available-services$/, () => json(availableServicesResponse)),
    route("POST", /next-order-fulfillment-dates$/, () => json(fulfillmentDatesResponse)),
    route("GET", /\/itemlist$/, () => json(itemListResponse)),
    route("GET", /\/orderfee$/, () => json(orderFeeResponse)),
    route("POST", /orders\/order-history$/, () => json(orderHistoryResponse)),
  );
  const client = new FlexiClient(new FlexiHttp(tokens, { fetch }));
  return { client, calls, forced };
}

async function alice(client: FlexiClient): Promise<{ student: Student; lunch: ReturnType<typeof FlexiClient.findService> }> {
  const student = await client.findStudent("alice");
  return { student, lunch: FlexiClient.findService(student, "lunch") };
}

describe("discovery", () => {
  it("finds students by first name and services by substring; explains ambiguity", async () => {
    const { client } = setup();
    const { student, lunch } = await alice(client);
    assert.equal(student.key, K.stuA);
    assert.equal(lunch.key, K.lunch);
    await assert.rejects(client.findStudent("zed"), (e: unknown) => e instanceof FlexiError && e.kind === "not_found" && /Alice, Bob/.test(e.message));
    assert.throws(() => FlexiClient.findService(student, "j"), /Ambiguous/); // Junior Recess and Junior Lunch
  });

  it("lists service slots by posting the student's services with their school keys", async () => {
    const { client, calls } = setup();
    const { student } = await alice(client);
    const slots = await client.listServiceSlots(student);
    assert.equal(slots[0]!.cutoffUtc, "2026-11-05T22:30:00Z");
    const body = JSON.parse(calls.find((c) => /available-services/.test(c.url.pathname))!.body!);
    assert.equal(body.length, 2);
    assert.deepEqual(Object.keys(body[0]).sort(), ["schoolKey", "schoolSiteKey", "supplierKey", "supplierServiceKey", "supplierServiceName", "supplierSiteKey", "supplierSiteTimeRegionKey"]);
    assert.equal(body[0].schoolKey, K.school);
  });
});

describe("listOrders", () => {
  it("hides cancelled orders by default and sorts newest first", async () => {
    const { client } = setup();
    const orders = await client.listOrders();
    assert.deepEqual(orders.map((o) => o.key), ["ord-lunch", "ord-old"]);
  });

  it("includes cancelled orders on request, and filters by student", async () => {
    const { client } = setup();
    assert.equal((await client.listOrders({ includeInactive: true })).length, 3);
    assert.equal((await client.listOrders({ studentKey: K.stuB, includeInactive: true })).length, 0);
  });

  it("sends the date range and bearer token, and pages until hasMoreOrders is false", async () => {
    const pages: number[] = [];
    const paged = route("POST", /orders\/order-history$/, (c) => {
      const b = JSON.parse(c.body!);
      pages.push(b.pageIndex);
      return json({ ...orderHistoryResponse, hasMoreOrders: b.pageIndex < 2 });
    });
    const { client, calls } = setup(paged);
    await client.listOrders({ from: "2026-11-01", to: "2026-11-07" });
    assert.deepEqual(pages, [1, 2]);
    const first = calls.find((c) => /order-history/.test(c.url.pathname))!;
    assert.equal(first.headers.authorization, "Bearer tok-1");
    assert.deepEqual([JSON.parse(first.body!).fromDate, JSON.parse(first.body!).toDate], ["2026-11-01", "2026-11-07"]);
    assert.equal(first.headers["x-channel"], "USERPORTAL");
    assert.equal(first.headers["x-brandid"], "8");
  });
});

describe("getMenu", () => {
  it("calls itemlist without a token, using the fulfilment time for that date", async () => {
    const { client, calls } = setup();
    const { student, lunch } = await alice(client);
    const menu = await client.getMenu(student, lunch, "2026-11-06");
    assert.equal(menu.items.length, 8);
    const c = calls.find((x) => /itemlist/.test(x.url.pathname))!;
    assert.equal(c.headers.authorization, undefined);
    assert.equal(c.url.searchParams.get("dueDate"), "2026-11-06T12:30:00");
    assert.equal(c.url.searchParams.get("studentKey"), K.stuA);
    assert.equal(c.url.searchParams.get("schoolKey"), K.school);
  });

  it("refuses dates that are not order days, and closed days", async () => {
    const { client } = setup();
    const { student, lunch } = await alice(client);
    await assert.rejects(client.getMenu(student, lunch, "2026-11-08"), (e: unknown) => e instanceof FlexiError && e.kind === "not_found");
    await assert.rejects(client.getMenu(student, lunch, "2026-11-09"), (e: unknown) => e instanceof FlexiError && /closed.*Staff development day/.test(e.message));
  });
});

describe("planOrder (builds the request, sends nothing)", () => {
  it("builds the exact body the web app sends, with total = items + fee", async () => {
    const { client, calls } = setup();
    const { student, lunch } = await alice(client);
    const plan = await client.planOrder({ student, service: lunch, date: "2026-11-06", lines: [{ itemKey: "i-cheese", quantity: 2, optionKeys: [] }] });

    assert.deepEqual(plan.summary, {
      student: "Alice",
      service: "Junior Lunch",
      date: "2026-11-06",
      lines: [{ item: "Cheese Sandwich", quantity: 2, options: [], unitPrice: 4.3, lineTotal: 8.6 }],
      subtotal: 8.6,
      fee: 0.39,
      total: 8.99,
    });
    const { cartKey, placeOrderRequests, totalCartAmount } = plan.body;
    assert.equal(totalCartAmount, 8.99);
    assert.match(cartKey, /^[0-9a-f-]{36}$/);
    assert.equal(placeOrderRequests.length, 1);
    const r = placeOrderRequests[0]!;
    assert.match(r.orderRequestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...r, orderRequestId: "-" }, {
      orderRequestId: "-",
      studentKey: K.stuA,
      supplierServiceKey: K.lunch,
      supplierKey: K.supplier,
      dueDate: "2026-11-06T12:30:00",
      orderAmount: 8.6,
      items: [{ itemKey: "i-cheese", quantity: 2, options: [], questions: [] }],
      orderOrigin: "Normal",
    });
    assert.equal(calls.filter((c) => c.method === "POST" && /\/api\/v2\.0\/orders$/.test(c.url.pathname)).length, 0, "planning must not place anything");
  });

  it("builds the same body shape the web app sent for a two-item order with options (captured in Chrome)", async () => {
    const { client } = setup();
    const { student, lunch } = await alice(client);
    // Up & Go (Chocolate) $3.80 + Ham & Cheese (GLUTEN FREE +$1) $6.40, fee $0.39 -> $10.59 in the real capture.
    const plan = await client.planOrder({
      student,
      service: lunch,
      date: "2026-11-06",
      lines: [
        { itemKey: "i-upgo", quantity: 1, optionKeys: ["o-choc"] },
        { itemKey: "i-ham", quantity: 1, optionKeys: ["o-gf"] },
      ],
    });
    assert.equal(plan.body.totalCartAmount, 10.59);
    const r = plan.body.placeOrderRequests[0]!;
    assert.equal(r.orderAmount, 10.2);
    assert.deepEqual(r.items, [
      { itemKey: "i-upgo", quantity: 1, options: [{ optionKey: "o-choc", quantity: 1, isExcluded: false, isDefault: false }], questions: [] },
      { itemKey: "i-ham", quantity: 1, options: [{ optionKey: "o-gf", quantity: 1, isExcluded: false, isDefault: false }], questions: [] },
    ]);
    assert.deepEqual(plan.summary.lines.map((l) => [l.item, l.options, l.lineTotal]), [["Up & Go", ["Chocolate"], 3.8], ["Ham & Cheese Sandwich", ["GLUTEN FREE"], 6.4]]);
  });

  it("refuses what it cannot do faithfully", async () => {
    const { client } = setup();
    const { student, lunch } = await alice(client);
    const plan = (itemKey: string, optionKeys: string[] = [], date = "2026-11-06", quantity = 1) =>
      client.planOrder({ student, service: lunch, date, lines: [{ itemKey, quantity, optionKeys }] });
    await assert.rejects(plan("i-sold"), /not available/);
    await assert.rejects(plan("i-offweek"), /not available/);
    await assert.rejects(plan("i-pasta"), /needs a choice for "Size"/);
    await assert.rejects(plan("i-upgo", ["o-van"]), /Vanilla" is sold out \(available: Chocolate, Strawberry\)/);
    await assert.rejects(plan("i-asks"), /asks questions/);
    await assert.rejects(plan("i-nope"), (e: unknown) => e instanceof FlexiError && e.kind === "not_found");
    await assert.rejects(plan("i-cheese", [], "2026-11-05"), /cutoff.*has passed/);
    await assert.rejects(plan("i-cheese", [], "2026-11-06", 0), /Quantity/);
    await assert.rejects(plan("i-cheese", [], "2026-11-06", 1.5), /Quantity/);
    await assert.rejects(client.planOrder({ student, service: lunch, date: "2026-11-06", lines: [] }), /at least one item/);
  });
});

describe("placeOrder", () => {
  it("posts the plan with the ordering-portal channel, then reads the order back", async () => {
    const place = route("POST", /\/api\/v2\.0\/orders$/, () => json(placeOrderResponse));
    const detail = route("GET", /\/api\/v1\.0\/orders\/ord-new$/, () => json(orderDetailResponse("Placed", true)));
    const { client, calls } = setup(place, detail);
    const { student, lunch } = await alice(client);
    const plan = await client.planOrder({ student, service: lunch, date: "2026-11-06", lines: [{ itemKey: "i-cheese", quantity: 1, optionKeys: [] }] });

    const placed = await client.placeOrder(plan);
    assert.equal(placed.state, "Placed");
    const post = calls.find((c) => c.method === "POST" && /\/api\/v2\.0\/orders$/.test(c.url.pathname))!;
    assert.equal(post.headers["x-channel"], "ORDERINGPORTAL");
    assert.deepEqual(JSON.parse(post.body!), plan.body);
    assert.ok(calls.at(-1)!.url.pathname.endsWith("/orders/ord-new"), "read back after placing");
  });

  it("fails loudly when the server says it was not placed, or the read-back shows a dead order", async () => {
    const { student, lunch } = await alice(setup().client);
    for (const [label, handlers, expected] of [
      ["not placed", [route("POST", /\/api\/v2\.0\/orders$/, () => json({ ...placeOrderResponse, orderPlaced: false, error: { code: 1 } }))], /not placed/],
      ["dead", [route("POST", /\/api\/v2\.0\/orders$/, () => json(placeOrderResponse)), route("GET", /orders\/ord-new$/, () => json(orderDetailResponse("CancelledByUser", false)))], /CancelledByUser/],
    ] as const) {
      const { client } = setup(...handlers);
      const plan = await client.planOrder({ student, service: lunch, date: "2026-11-06", lines: [{ itemKey: "i-cheese", quantity: 1, optionKeys: [] }] });
      await assert.rejects(client.placeOrder(plan), expected, label);
    }
  });
});

describe("cancelOrder", () => {
  it("sends DELETE with the bare order key as the body, then confirms the new state", async () => {
    let cancelled = false;
    const del = route("DELETE", /\/api\/v1\.0\/orders\/ord-1$/, () => ((cancelled = true), json(null)));
    const get = route("GET", /\/api\/v1\.0\/orders\/ord-1$/, () => json(cancelled ? orderDetailResponse("CancelledByUser", false) : orderDetailResponse("Placed", true)));
    const { client, calls } = setup(del, get);

    const after = await client.cancelOrder("ord-1");
    assert.equal(after.state, "CancelledByUser");
    const d = calls.find((c) => c.method === "DELETE")!;
    assert.equal(d.body, "ord-1");
    assert.equal(d.headers["content-type"], "application/json");
  });

  it("does not send anything when the server says the order is no longer cancellable", async () => {
    const get = route("GET", /orders\/ord-1$/, () => json(orderDetailResponse("Printed", false)));
    const { client, calls } = setup(get);
    await assert.rejects(client.cancelOrder("ord-1"), (e: unknown) => e instanceof FlexiError && e.kind === "precondition");
    assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  });

  it("does not claim success if the order is still active afterwards", async () => {
    const del = route("DELETE", /orders\/ord-1$/, () => json(null));
    const get = route("GET", /orders\/ord-1$/, () => json(orderDetailResponse("Placed", true)));
    await assert.rejects(setup(del, get).client.cancelOrder("ord-1"), /still Placed/);
  });
});

describe("http behaviour", () => {
  it("on 401 refreshes the token once and retries", async () => {
    let n = 0;
    const flaky = route("POST", /orders\/order-history$/, (c) => (++n === 1 ? json({}, 401) : (assert.equal(c.headers.authorization, "Bearer tok-2"), json(orderHistoryResponse))));
    const { client, forced } = setup(flaky);
    assert.equal((await client.listOrders()).length, 2);
    assert.deepEqual(forced, [false, true]);
  });

  it("error messages carry the path but not the query string", async () => {
    const boom = route("GET", /\/itemlist$/, () => json({ message: "nope" }, 500));
    const { client } = setup(boom);
    const { student, lunch } = await alice(client);
    await assert.rejects(client.getMenu(student, lunch, "2026-11-06"), (e: unknown) => {
      const m = (e as Error).message;
      return /HTTP 500/.test(m) && /\/itemlist/.test(m) && !m.includes("studentKey") && !m.includes(K.stuA);
    });
  });

  it("a response of the wrong shape is a schema error naming the offending field", async () => {
    const bad = route("GET", /service-categories\/1\/students$/, () => json([{ studentKey: "x" }]));
    await assert.rejects(setup(bad).client.listStudents(), (e: unknown) => e instanceof FlexiError && e.kind === "schema" && /studentFirstName/.test(e.message));
  });
});
