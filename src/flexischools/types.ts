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

export interface PlaceOrderInput {
  student: Student;
  service: Service;
  /** YYYY-MM-DD */
  date: string;
  itemKey: string;
  quantity: number;
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
    items: { itemKey: string; quantity: number; options: never[]; questions: never[] }[];
    orderOrigin: "Normal";
  }[];
}

export interface OrderPlan {
  body: PlaceOrderBody;
  summary: {
    student: string;
    service: string;
    date: string;
    item: string;
    quantity: number;
    subtotal: number;
    fee: number;
    total: number;
  };
}
