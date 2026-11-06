// A FlexiClient wired to a fake Flexischools API (synthetic fixtures), shared by the agent and approval tests.
import { FlexiClient } from "../src/flexischools/client.ts";
import { FlexiHttp } from "../src/flexischools/http.ts";
import { accountResponse, availableServicesResponse, fulfillmentDatesResponse, itemListResponse, orderDetailResponse, orderFeeResponse, orderHistoryResponse, placeOrderResponse, studentsResponse, transactionsResponse, USER_KEY } from "./fixtures.ts";
import { fakeFetch, json } from "./helpers.ts";
import type { Call, Handler } from "./helpers.ts";

export const route = (method: string, test: RegExp, respond: (c: Call) => Response): Handler => (c) =>
  c.method === method && test.test(c.url.pathname) ? respond(c) : undefined;

export const isPlaceOrder = (c: Call): boolean => c.method === "POST" && /\/api\/v2\.0\/orders$/.test(c.url.pathname);
export const isWrite = (c: Call): boolean => isPlaceOrder(c) || c.method === "DELETE";

/** Placing succeeds (POST returns ord-new, read-back is Placed); cancelling ord-1 succeeds. Extra handlers win. */
export function fakeFlexi(...extra: Handler[]) {
  let cancelled = false;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = `${b64({ alg: "none" })}.${b64({ exp: 4102444800, "custom:toca_user_key": USER_KEY })}.sig`;
  const tokens = { async getIdToken() { return idToken; } };
  const { fetch, calls } = fakeFetch(
    ...extra,
    route("GET", /service-categories\/1\/students$/, () => json(studentsResponse)),
    route("POST", /available-services$/, () => json(availableServicesResponse)),
    route("POST", /next-order-fulfillment-dates$/, () => json(fulfillmentDatesResponse)),
    route("GET", /\/itemlist$/, () => json(itemListResponse)),
    route("GET", /\/orderfee$/, () => json(orderFeeResponse)),
    route("POST", /orders\/order-history$/, () => json(orderHistoryResponse)),
    route("POST", /\/api\/v1\.0\/graphql\/$/, (c) => {
      const op = (JSON.parse(c.body ?? "{}") as { operationName?: string }).operationName;
      return json(op === "getUserAccount" ? accountResponse : op === "findTransactions" ? transactionsResponse : { errors: [{ message: `unknown operation ${op}` }] });
    }),
    route("POST", /\/api\/v2\.0\/orders$/, () => json(placeOrderResponse)),
    route("GET", /\/api\/v1\.0\/orders\/ord-new$/, () => json({ ...orderDetailResponse("Placed", true), orderKey: { id: 1, value: "ord-new" } })),
    route("DELETE", /\/api\/v1\.0\/orders\/ord-1$/, () => ((cancelled = true), json(null))),
    route("GET", /\/api\/v1\.0\/orders\/ord-1$/, () => json(cancelled ? orderDetailResponse("CancelledByUser", false) : orderDetailResponse("Placed", true))),
  );
  const client = new FlexiClient(new FlexiHttp(tokens, { fetch }));
  return { client, calls, writes: () => calls.filter(isWrite) };
}

/** The menu fixture with one item's price changed (to simulate a change between proposal and approval). */
export function menuWithPrice(itemKey: string, price: number): unknown {
  const m = structuredClone(itemListResponse) as { itemCategories: { items: { itemKey: string; itemPrice: number }[] }[] };
  for (const c of m.itemCategories) for (const i of c.items) if (i.itemKey === itemKey) i.itemPrice = price;
  return m;
}
