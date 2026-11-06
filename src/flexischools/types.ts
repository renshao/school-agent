// Domain types: what the rest of the system (and later the LLM) sees. Never raw API shapes.

export interface Service {
  key: string;
  name: string;
  supplierKey: string;
  supplierSiteKey: string;
  supplierSiteTimeRegionKey: string;
}

export interface Student {
  key: string;
  firstName: string;
  lastName: string;
  schoolKey: string;
  schoolSiteKey: string;
  schoolName: string;
  services: Service[];
}

/** The next orderable occasion of a service, with its exact cutoff. */
export interface ServiceSlot {
  serviceKey: string;
  name: string;
  supplierKey: string;
  distributionTimeKey: string;
  /** Local (school) time, e.g. "2026-11-06T09:00:00". */
  cutoffLocal: string;
  /** Real instant, ISO with Z. */
  cutoffUtc: string;
  nextFulfillmentLocal: string;
}

/** One orderable day for a student+service. */
export interface OrderDay {
  /** YYYY-MM-DD (local). */
  date: string;
  fulfillmentLocal: string;
  cutoffPassed: boolean;
  closureReason: string | null;
  distributionTimeKey: string;
}

export interface Order {
  key: string;
  studentKey: string;
  studentName: string;
  serviceKey: string;
  serviceName: string;
  supplierKey: string;
  /** YYYY-MM-DD (local). */
  date: string;
  dueLocal: string;
  items: { name: string; quantity: number }[];
  /** Includes the order fee. */
  total: number;
  /** Raw state string: Placed | Printed | Closed | CancelledByUser | ... */
  state: string;
  /** False for cancelled/failed orders: they must not count as "lunch is ordered". */
  active: boolean;
}

export interface OrderDetail extends Order {
  fee: number;
  gst: number;
  canCancel: boolean;
  history: { state: string; at: string }[];
}

export interface MenuOption {
  key: string;
  name: string;
  price: number;
  inStock: boolean;
  isDefault: boolean;
}

export interface MenuOptionSet {
  key: string;
  name: string;
  required: boolean;
  min: number;
  max: number;
  options: MenuOption[];
}

export interface MenuItem {
  key: string;
  name: string;
  category: string;
  /** The item's own price (0 when the price lives in required option sets). */
  basePrice: number;
  /** Cheapest possible price: base + cheapest in-stock option of each required set. */
  priceFrom: number;
  /** Server-computed availability for this date. */
  inStock: boolean;
  labels: string[];
  optionSets: MenuOptionSet[];
  hasQuestions: boolean;
}

export interface Menu {
  serviceKey: string;
  serviceName: string;
  date: string;
  dueLocal: string;
  supplierKey: string;
  distributionTimeKey: string;
  items: MenuItem[];
}

/** What a caller (CLI or, later, the LLM) asks for, by name. Resolved against the menu into an OrderLine. */
export interface ItemRequest {
  /** Item name (case-insensitive; exact match preferred, else a unique substring). */
  item: string;
  quantity?: number;
  /** Option choices by name. `set` is optional when the option name is unique across the item's option sets. */
  choices?: { set?: string; option: string }[];
}

/** A resolved line: item and chosen options by key. */
export interface OrderLine {
  itemKey: string;
  quantity: number;
  optionKeys: string[];
}

export interface PlaceOrderInput {
  student: Student;
  service: Service;
  /** YYYY-MM-DD */
  date: string;
  /** One order may hold several items (the web cart does). */
  lines: OrderLine[];
}

export interface PlaceOrderOption {
  optionKey: string;
  quantity: number;
  isExcluded: boolean;
  /** Whether this option is the item's default option (from the menu). */
  isDefault: boolean;
}

/** Exact body of POST /api/v2.0/orders as the web app sends it. */
export interface PlaceOrderBody {
  cartKey: string;
  totalCartAmount: number;
  placeOrderRequests: {
    orderRequestId: string;
    studentKey: string;
    supplierServiceKey: string;
    supplierKey: string;
    dueDate: string;
    orderAmount: number;
    items: { itemKey: string; quantity: number; options: PlaceOrderOption[]; questions: never[] }[];
    orderOrigin: "Normal";
  }[];
}

export interface PlanLine {
  item: string;
  quantity: number;
  /** Chosen option names, e.g. ["Chocolate"]. */
  options: string[];
  /** Price of one unit including chosen options. */
  unitPrice: number;
  lineTotal: number;
}

export interface OrderPlan {
  body: PlaceOrderBody;
  summary: {
    student: string;
    service: string;
    date: string;
    lines: PlanLine[];
    subtotal: number;
    fee: number;
    total: number;
  };
}

/** The household's Flexischools wallet (one per parent login). */
export interface Account {
  accountKey: string;
  state: string;
  availableBalance: number;
  currentBalance: number;
}

/**
 * - card: a purchase at the canteen with a student card (no order; how a child "buys their own lunch")
 * - order: the charge for an online order, posted when the order closes (the evening of the day it was served;
 *   so today's orders appear only in the evening, and cancelled orders never)
 * - top_up: money added to the wallet (e.g. an automatic top-up from PayPal)
 * - fee: a separate charge such as a payment surcharge
 */
export type TransactionKind = "card" | "order" | "top_up" | "fee" | "other";

export interface TransactionItem {
  name: string;
  quantity: number;
  /** Line price as shown (already multiplied by the quantity). */
  price: number;
}

/** One row of the account history. */
export interface Transaction {
  /** ISO instant (UTC). */
  at: string;
  /** School-local YYYY-MM-DD and HH:MM of `at`. */
  date: string;
  time: string;
  /** First name on the row: a child (card purchases, orders) or a parent / system (top-ups). */
  name: string;
  /** For a child's row, the student key. */
  userKey: string | null;
  /** Negative = money spent. */
  amount: number;
  /** Wallet balance after this row. */
  balance: number;
  kind: TransactionKind;
  orderId: string | null;
  /** Parsed from the description for card and order rows (fees excluded). */
  items: TransactionItem[];
  /** Order fee or student card fee, when the description states one. */
  fee: number;
  /** Where a card purchase was made, e.g. "Example School Canteen". */
  place: string | null;
  description: string;
}
