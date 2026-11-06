// Account history (wallet transactions) and "what did X have": ordered meals plus student-card purchases.
// Synthetic fixtures (Alice orders online, Bob buys at the counter), fake Flexischools API, fake Messages API.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../src/agent/agent.ts";
import { ApprovalDesk } from "../src/agent/approvals.ts";
import { FlexiError } from "../src/flexischools/errors.ts";
import { mealsBetween } from "../src/flexischools/meals.ts";
import { normalizeTransaction, parseItemList } from "../src/flexischools/transactions.ts";
import { transactionsResponse, USER_KEY } from "./fixtures.ts";
import { fakeFlexi, route } from "./flexi-fake.ts";
import { json } from "./helpers.ts";
import { fakeModel, text, toolUse } from "./model-fake.ts";
import type { Block } from "./model-fake.ts";

const rows = transactionsResponse.data.findTransactions;
const isGraphql = (c: { url: URL }) => c.url.pathname.endsWith("/graphql/");
const bodyOf = (c: { body: string | undefined }) => JSON.parse(c.body ?? "{}") as { operationName: string; variables: Record<string, string> };

describe("parsing account-history rows", () => {
  it("splits item lists whose names contain commas and dollar amounts", () => {
    assert.deepEqual(parseItemList("Bacon, Tomato & Cheese Roll $5.80, 2 x Juice $10.00"), [
      { name: "Bacon, Tomato & Cheese Roll", quantity: 1, price: 5.8 },
      { name: "Juice", quantity: 2, price: 10 },
    ]);
    assert.deepEqual(
      parseItemList("Canteen IOU ($2, $5) $7.00, SPRING ROLLS  $5.80").map((i) => i.name),
      ["Canteen IOU ($2, $5)", "SPRING ROLLS"],
    );
    assert.deepEqual(parseItemList(""), []);
  });

  it("a card purchase: items, card fee, place, school-local date and time; the card number is not kept", () => {
    const t = normalizeTransaction(rows[2]!); // 2026-11-05T23:42Z
    assert.equal(t.kind, "card");
    assert.equal(t.date, "2026-11-06", "school-local date, not the UTC one");
    assert.equal(t.time, "10:42");
    assert.deepEqual(t.items.map((i) => i.name), ["recess 5.00", "Juice"]);
    assert.equal(t.fee, 0.18);
    assert.equal(t.place, "Example School Canteen");
    assert.equal(t.userKey, "stu-bbbb");
    assert.doesNotMatch(JSON.stringify(t), /CARD0001/);
  });

  it("an order charge, a top-up, a surcharge and the empty card row the API sometimes returns", () => {
    const order = normalizeTransaction(rows[0]!);
    assert.deepEqual([order.kind, order.orderId, order.fee, order.items.map((i) => i.name)], ["order", "900002", 0.39, ["Cheese Sandwich (White)"]]);
    const topUp = normalizeTransaction(rows[5]!);
    assert.deepEqual([topUp.kind, topUp.amount, topUp.date], ["top_up", 150, "2026-11-04"]);
    assert.equal(normalizeTransaction(rows[4]!).kind, "fee");
    const empty = normalizeTransaction(rows[6]!);
    assert.deepEqual([empty.kind, empty.items, empty.amount], ["card", [], 0]);
  });
});

describe("FlexiClient wallet", () => {
  it("reads the account with the user key from the ID token, then asks for a padded UTC range and keeps only the local days", async () => {
    const f = fakeFlexi();
    const day = await f.client.listTransactions({ from: "2026-11-06", to: "2026-11-06" });
    assert.deepEqual(day.map((t) => `${t.time} ${t.name} ${t.kind}`), ["10:42 Bob card", "12:58 Bob card", "17:52 Alice order"], "oldest first, only 6 Nov local");

    const ops = f.calls.filter(isGraphql).map(bodyOf);
    assert.deepEqual(ops.map((o) => o.operationName), ["getUserAccount", "findTransactions"]);
    assert.equal(ops[0]!.variables.userKey, USER_KEY);
    assert.deepEqual(ops[1]!.variables, { accountKey: "acct-1", transactionDateFrom: "2026-11-05T00:00:00Z", transactionDateTo: "2026-11-07T23:59:59Z" });
    assert.equal(f.calls.filter(isGraphql)[0]!.url.host, "servicebff.flexischools.com.au");

    await f.client.listTransactions({ from: "2026-11-04", to: "2026-11-04" });
    assert.equal(f.calls.filter(isGraphql).map(bodyOf).filter((o) => o.operationName === "getUserAccount").length, 1, "the account key is cached");
  });

  it("GraphQL errors (sent with HTTP 200) and drifted shapes fail loudly", async () => {
    const errs = fakeFlexi(route("POST", /graphql\/$/, () => json({ errors: [{ message: "Access denied" }] })));
    await assert.rejects(errs.client.listTransactions({ from: "2026-11-06", to: "2026-11-06" }), (e: unknown) => e instanceof FlexiError && e.kind === "http" && /getUserAccount: Access denied/.test(e.message));
    const drift = fakeFlexi(route("POST", /graphql\/$/, (c) => json(bodyOf(c).operationName === "findTransactions" ? { data: { findTransactions: [{ amount: 1 }] } } : { data: { getUserAccount: { accountKey: "a", accountState: "Active", availableBalance: 1, currentBalance: 1 } } })));
    await assert.rejects(drift.client.listTransactions({ from: "2026-11-06", to: "2026-11-06" }), (e: unknown) => e instanceof FlexiError && e.kind === "schema");
  });
});

describe("meals: orders plus card purchases", () => {
  it("lists ordered meals by the day served and card purchases by the day bought; no double counting, no parents, no cancelled orders", async () => {
    const f = fakeFlexi();
    const [students, orders, transactions] = await Promise.all([
      f.client.listStudents(),
      f.client.listOrders({ from: "2026-11-01", to: "2026-11-06", includeInactive: true }),
      f.client.listTransactions({ from: "2026-11-01", to: "2026-11-06" }),
    ]);
    const meals = mealsBetween({ from: "2026-11-04", to: "2026-11-06", students, orders, transactions });
    assert.deepEqual(
      meals.map((m) => `${m.date} ${m.student} ${m.source} ${m.service ?? m.time} ${m.items.join("+")} ${m.total}`),
      [
        "2026-11-04 Alice order Junior Lunch Pizza 8.24",
        "2026-11-04 Bob card 12:33 Bacon, Egg & Cheese Roll+2 x Cookie 12.98",
        "2026-11-06 Alice order Junior Lunch Cheese Sandwich (White) 4.69",
        "2026-11-06 Bob card 10:42 recess 5.00+Juice 10.18",
        "2026-11-06 Bob card 12:58 CHICKEN CURRY / HONEY SOY 11.68",
      ],
    );
    assert.equal(mealsBetween({ from: "2026-11-02", to: "2026-11-02", students, orders, transactions }).length, 0, "an empty zero-amount card row is not a meal");
  });
});

// ---------------------------------------------------------------- through the agent

const NOW = new Date("2026-11-06T08:00:00Z"); // Fri 6 Nov 19:00 Sydney

function agentWith(script: Parameters<typeof fakeModel>[0], ...extra: Parameters<typeof fakeFlexi>) {
  const flexi = fakeFlexi(...extra);
  const model = fakeModel(script);
  const agent = new Agent({ anthropic: model.anthropic, client: flexi.client, desk: new ApprovalDesk(flexi.client, { now: () => NOW }), now: () => NOW });
  const toolResult = (i: number) => (model.requests[i]!.body.messages.at(-1).content as Block[])[0]!;
  return { ...flexi, ...model, agent, toolResult };
}

describe("the meals and list_transactions tools", () => {
  it('"what did Bob have for lunch" finds his card purchases although he has no orders', async () => {
    const { agent, toolResult, writes } = agentWith([
      { content: [toolUse("t1", "meals", { student: "Bob" })], stop_reason: "tool_use" },
      { content: [text("Chicken curry at 12:58.")], stop_reason: "end_turn" },
    ]);
    await agent.send("Ren", "what did Bob have for lunch today?");
    const r = toolResult(1);
    assert.equal(r.is_error, undefined);
    const payload = JSON.parse(r.content as string);
    assert.deepEqual(payload.meals.map((m: { time: string; source: string; items: string[] }) => `${m.source} ${m.time} ${m.items.join("+")}`), ["card 10:42 recess 5.00+Juice", "card 12:58 CHICKEN CURRY / HONEY SOY"]);
    assert.equal(payload.warning, undefined);
    assert.equal(writes().length, 0);
  });

  it("if the account history cannot be read, ordered meals still come back, with a warning", async () => {
    const { agent, toolResult } = agentWith(
      [
        { content: [toolUse("t1", "meals", {})], stop_reason: "tool_use" },
        { content: [text("ok")], stop_reason: "end_turn" },
      ],
      route("POST", /graphql\/$/, () => json({ errors: [{ message: "Access denied" }] })),
    );
    await agent.send("Ren", "what did the kids have today?");
    const payload = JSON.parse(toolResult(1).content as string);
    assert.deepEqual(payload.meals.map((m: { student: string; source: string }) => `${m.student} ${m.source}`), ["Alice order"]);
    assert.match(payload.warning, /Card purchases could not be read.*Access denied/);
  });

  it("list_transactions gives the balance and spending, without card numbers or the PayPal account", async () => {
    const { agent, toolResult } = agentWith([
      { content: [toolUse("t1", "list_transactions", { from: "2026-11-01" })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await agent.send("Ren", "how much did we spend this week?");
    const raw = toolResult(1).content as string;
    const payload = JSON.parse(raw);
    assert.equal(payload.balance, 62.4);
    assert.deepEqual(payload.spent_by, { Ren: 1.8, Bob: 34.84, Alice: 4.69 });
    assert.doesNotMatch(raw, /CARD0001|parent@example\.com/);
  });

  it("refuses backwards and over-long ranges", async () => {
    const { agent, requests } = agentWith([
      { content: [toolUse("t1", "meals", { from: "2026-11-06", to: "2026-11-01" }), toolUse("t2", "meals", { from: "2026-01-01", to: "2026-11-06" })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await agent.send("Ren", "meals?");
    const results = (requests[1]!.body.messages.at(-1).content as Block[]).filter((b) => b.type === "tool_result");
    assert.equal(results.length, 2);
    assert.deepEqual(results.map((r) => r.is_error), [true, true]);
    assert.match(String(results[0]!.content), /before/);
    assert.match(String(results[1]!.content), /At most 62 days/);
  });
});
