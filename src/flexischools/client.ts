import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { CHANNEL_ORDERING_PORTAL } from "./config.ts";
import { datePart } from "./dates.ts";
import { FlexiError } from "./errors.ts";
import { buildOrderItem } from "./request.ts";
import type { FlexiHttp } from "./http.ts";
import {
  normalizeHistory,
  normalizeMenu,
  normalizeOrderDays,
  normalizeOrderDetail,
  normalizeSlots,
  normalizeStudents,
} from "./normalize.ts";
import {
  AvailableServicesResponse,
  FulfillmentDatesResponse,
  ItemListResponse,
  OrderDetailResponse,
  OrderFeeResponse,
  OrderHistoryResponse,
  StudentsResponse,
} from "./schemas.ts";
import type {
  Menu,
  Order,
  OrderDay,
  OrderDetail,
  OrderPlan,
  PlaceOrderBody,
  PlaceOrderInput,
  Service,
  ServiceSlot,
  Student,
} from "./types.ts";

const round2 = (n: number): number => Math.round(n * 100) / 100;

interface PlaceResult {
  orderKey?: string;
  orderPlaced?: boolean;
  error?: unknown;
}

/** Finds the result for our request anywhere in the response (object, array, or wrapper), matching on orderRequestId. */
function findPlaceResult(raw: unknown, orderRequestId: string): PlaceResult | undefined {
  const candidates: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (typeof o.orderKey === "string" || "orderPlaced" in o) candidates.push(o);
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(raw, 0);
  const mine = candidates.find((c) => c.orderRequestId === orderRequestId) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!mine) return undefined;
  return {
    ...(typeof mine.orderKey === "string" ? { orderKey: mine.orderKey } : {}),
    ...(typeof mine.orderPlaced === "boolean" ? { orderPlaced: mine.orderPlaced } : {}),
    ...("error" in mine ? { error: mine.error } : {}),
  };
}

/** Structure only (key names and array sizes, never values), safe to put in an error message. */
function describeShape(v: unknown): string {
  if (Array.isArray(v)) return `array[${v.length}]${v.length ? ` of ${describeShape(v[0])}` : ""}`;
  if (v && typeof v === "object") return `{${Object.keys(v).slice(0, 12).join(", ")}}`;
  return v === null ? "null" : typeof v;
}

function parse<T extends z.ZodType>(schema: T, raw: unknown, what: string): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) {
    // Names the endpoint and the first offending path; never dumps the payload.
    const issue = r.error.issues[0];
    throw new FlexiError("schema", `Unexpected ${what} response (API changed?): ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  return r.data;
}

export interface ListOrdersOptions {
  /** YYYY-MM-DD inclusive. */
  from?: string;
  to?: string;
  studentKey?: string;
  /** Include cancelled/failed orders (default false: they are not "ordered"). */
  includeInactive?: boolean;
  maxPages?: number;
}

export class FlexiClient {
  private http: FlexiHttp;

  constructor(http: FlexiHttp) {
    this.http = http;
  }

  // ---- discovery -------------------------------------------------------------------------------------------

  async listStudents(): Promise<Student[]> {
    const raw = await this.http.request("GET", "/api/v2.0/service-categories/1/students");
    return normalizeStudents(parse(StudentsResponse, raw, "students"));
  }

  async findStudent(name: string): Promise<Student> {
    const students = await this.listStudents();
    const q = name.trim().toLowerCase();
    const hits = students.filter((s) => s.firstName.toLowerCase() === q || `${s.firstName} ${s.lastName}`.toLowerCase() === q);
    const found = hits.length ? hits : students.filter((s) => s.firstName.toLowerCase().startsWith(q));
    if (found.length !== 1) {
      throw new FlexiError("not_found", `${found.length ? "Ambiguous" : "No"} student "${name}". Known: ${students.map((s) => s.firstName).join(", ")}`);
    }
    return found[0]!;
  }

  static findService(student: Student, name: string): Service {
    const q = name.trim().toLowerCase();
    const exact = student.services.filter((s) => s.name.toLowerCase() === q);
    const found = exact.length ? exact : student.services.filter((s) => s.name.toLowerCase().includes(q));
    if (found.length !== 1) {
      throw new FlexiError("not_found", `${found.length ? "Ambiguous" : "No"} service "${name}" for ${student.firstName}. Known: ${student.services.map((s) => s.name).join(", ")}`);
    }
    return found[0]!;
  }

  /** Next orderable occasion of each of the student's services, with exact cutoff times. */
  async listServiceSlots(student: Student): Promise<ServiceSlot[]> {
    const body = student.services.map((s) => ({
      supplierServiceKey: s.key,
      supplierServiceName: s.name,
      supplierKey: s.supplierKey,
      supplierSiteKey: s.supplierSiteKey,
      supplierSiteTimeRegionKey: s.supplierSiteTimeRegionKey,
      schoolKey: student.schoolKey,
      schoolSiteKey: student.schoolSiteKey,
    }));
    const raw = await this.http.request("POST", "/api/v1.0/available-services", { body });
    return normalizeSlots(parse(AvailableServicesResponse, raw, "available-services"));
  }

  /** Orderable days for a student+service, including closures and whether each cutoff has passed. */
  async getOrderDays(studentKey: string, serviceKey: string): Promise<OrderDay[]> {
    const raw = await this.http.request("POST", `/api/v1.0/students/${studentKey}/supplierservices/${serviceKey}/next-order-fulfillment-dates`, {
      query: { startDate: "", includeUnavailableDates: "true" },
    });
    return normalizeOrderDays(parse(FulfillmentDatesResponse, raw, "order days"));
  }

  // ---- orders ----------------------------------------------------------------------------------------------

  /** Orders (newest first). Future orders are included; cancelled ones only with includeInactive. */
  async listOrders(opts: ListOrdersOptions = {}): Promise<Order[]> {
    const all: Order[] = [];
    const pageSize = 50;
    for (let page = 1; page <= (opts.maxPages ?? 20); page++) {
      const raw = await this.http.request("POST", "/api/v1.0/orders/order-history", {
        body: { pageIndex: page, pageSize, fromDate: opts.from ?? null, toDate: opts.to ?? null },
      });
      const parsed = parse(OrderHistoryResponse, raw, "order history");
      all.push(...normalizeHistory(parsed));
      if (!parsed.hasMoreOrders) break;
    }
    return all
      .filter((o) => (opts.includeInactive ? true : o.active))
      .filter((o) => (opts.studentKey ? o.studentKey === opts.studentKey : true))
      .sort((a, b) => b.dueLocal.localeCompare(a.dueLocal));
  }

  async getOrder(orderKey: string): Promise<OrderDetail> {
    const raw = await this.http.request("GET", `/api/v1.0/orders/${orderKey}`);
    return normalizeOrderDetail(parse(OrderDetailResponse, raw, "order"));
  }

  // ---- menu ------------------------------------------------------------------------------------------------

  /** Menu for one service on one date. Errors if that date is not an order day. */
  async getMenu(student: Student, service: Service, date: string): Promise<Menu> {
    const days = await this.getOrderDays(student.key, service.key);
    const day = days.find((d) => d.date === date);
    if (!day) {
      throw new FlexiError("not_found", `${service.name} is not orderable on ${date} for ${student.firstName}. Orderable: ${days.filter((d) => !d.closureReason).map((d) => d.date).join(", ")}`);
    }
    if (day.closureReason) {
      throw new FlexiError("precondition", `${service.name} is closed on ${date}: ${day.closureReason}`);
    }
    const raw = await this.http.request("GET", `/api/v2.0/suppliers/${service.supplierKey}/supplierservices/${service.key}/itemlist`, {
      auth: false, // the menu endpoint needs no token
      query: { studentKey: student.key, dueDate: day.fulfillmentLocal, schoolKey: student.schoolKey },
    });
    return normalizeMenu(parse(ItemListResponse, raw, "menu"), date, service.supplierKey);
  }

  // ---- placing and cancelling ------------------------------------------------------------------------------

  /**
   * Validates an order and builds the exact request, WITHOUT sending it. Each line is checked against the menu's own
   * metadata (stock, required/min/max option sets), so any item with options is handled the same way. Items that ask
   * questions at checkout are still refused (that request shape has not been captured).
   */
  async planOrder(input: PlaceOrderInput): Promise<OrderPlan> {
    if (!input.lines.length) throw new FlexiError("precondition", "An order needs at least one item");
    const menu = await this.getMenu(input.student, input.service, input.date);

    const days = await this.getOrderDays(input.student.key, input.service.key);
    if (days.find((d) => d.date === input.date)?.cutoffPassed) {
      throw new FlexiError("precondition", `The cutoff for ${input.service.name} on ${input.date} has passed`);
    }

    const built = input.lines.map((l) => buildOrderItem(menu, l));

    const feeRaw = await this.http.request("GET", `/api/v2.0/orders/${input.student.key}/supplierservices/${input.service.key}/orderfee`);
    const fee = parse(OrderFeeResponse, feeRaw, "order fee").fee;

    const subtotal = round2(built.reduce((sum, b) => sum + b.line.lineTotal, 0));
    const total = round2(subtotal + fee);
    const body: PlaceOrderBody = {
      cartKey: randomUUID(),
      totalCartAmount: total,
      placeOrderRequests: [
        {
          orderRequestId: randomUUID(),
          studentKey: input.student.key,
          supplierServiceKey: input.service.key,
          supplierKey: input.service.supplierKey,
          dueDate: menu.dueLocal,
          orderAmount: subtotal,
          items: built.map((b) => b.body),
          orderOrigin: "Normal",
        },
      ],
    };
    return { body, summary: { student: input.student.firstName, service: input.service.name, date: input.date, lines: built.map((b) => b.line), subtotal, fee, total } };
  }

  /**
   * Sends a plan built by planOrder. This spends money. Callers must have obtained explicit approval first.
   *
   * The server's response shape is not relied on: we look for the order in whatever came back, and otherwise
   * reconcile against the order list (an order that did not exist before the request, for this student, service and
   * date). If the outcome still cannot be confirmed, the error says the order MAY have been placed, so nobody retries
   * blindly and orders twice.
   */
  async placeOrder(plan: OrderPlan): Promise<OrderDetail> {
    const req = plan.body.placeOrderRequests[0];
    if (!req) throw new FlexiError("precondition", "Plan has no order");
    const date = datePart(req.dueDate);
    const listFor = (includeInactive: boolean) => this.listOrders({ from: date, to: date, studentKey: req.studentKey, includeInactive });
    const before = new Set((await listFor(true)).map((o) => o.key));

    let raw: unknown;
    try {
      raw = await this.http.request("POST", "/api/v2.0/orders", { body: plan.body, headers: { "x-channel": CHANNEL_ORDERING_PORTAL } });
    } catch (e) {
      if (e instanceof FlexiError) throw e; // an HTTP error status: the request was refused
      // Network-level failure after sending: the outcome is unknown.
      throw new FlexiError("http", `Connection failed while placing the order; it MAY have been placed. Run "flexi orders --from ${date} --to ${date}" before retrying.`);
    }

    const found = findPlaceResult(raw, req.orderRequestId);
    if (found?.orderPlaced === false) {
      throw new FlexiError("http", `Order was not placed: ${JSON.stringify(found.error ?? null).slice(0, 200)}`);
    }
    let orderKey = found?.orderKey;
    if (!orderKey) {
      const fresh = (await listFor(false)).filter((o) => !before.has(o.key) && o.serviceKey === req.supplierServiceKey);
      if (fresh.length === 1) orderKey = fresh[0]!.key;
      else {
        throw new FlexiError(
          "http",
          `The order request was accepted but its result could not be confirmed (response: ${describeShape(raw)}). It MAY have been placed: run "flexi orders --from ${date} --to ${date}" before retrying.`,
        );
      }
    }
    const detail = await this.getOrder(orderKey);
    if (!detail.active) throw new FlexiError("http", `Order ${orderKey} came back in state ${detail.state}`);
    return detail;
  }

  /** Cancels an order if the server says it is still cancellable; returns the order as read back afterwards. */
  async cancelOrder(orderKey: string): Promise<OrderDetail> {
    const before = await this.getOrder(orderKey);
    if (!before.canCancel) throw new FlexiError("precondition", `Order ${orderKey} cannot be cancelled (state ${before.state})`);
    // The web app sends the bare order key as the body.
    await this.http.request("DELETE", `/api/v1.0/orders/${orderKey}`, { rawBody: orderKey });
    const after = await this.getOrder(orderKey);
    if (after.active) throw new FlexiError("http", `Cancel request returned OK but the order is still ${after.state}`);
    return after;
  }
}
