// Pure functions: raw (validated) API responses -> domain types. No I/O, fully unit-tested.
import type { z } from "zod";
import { datePart } from "./dates.ts";
import type {
  AvailableServicesResponse,
  FulfillmentDatesResponse,
  ItemListResponse,
  OrderDetailResponse,
  OrderHistoryResponse,
  StudentsResponse,
} from "./schemas.ts";
import type { Menu, MenuItem, MenuOptionSet, Order, OrderDay, OrderDetail, ServiceSlot, Student } from "./types.ts";

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Cancelled (or otherwise dead) orders must never count as "ordered". */
export function isActiveState(state: string): boolean {
  return !/^(cancel|fail|reject|declin)/i.test(state);
}

export function normalizeStudents(raw: z.infer<typeof StudentsResponse>): Student[] {
  return raw.map((s) => ({
    key: s.studentKey,
    firstName: s.studentFirstName,
    lastName: s.studentLastName,
    schoolKey: s.schoolKey,
    schoolSiteKey: s.schoolSiteKey,
    schoolName: s.schoolName,
    services: s.services.map((v) => ({
      key: v.supplierServiceKey,
      name: v.supplierServiceName.trim(),
      supplierKey: v.supplierKey,
      supplierSiteKey: v.supplierSiteKey,
      supplierSiteTimeRegionKey: v.supplierSiteTimeRegionKey,
    })),
  }));
}

/** Cognito/BFF UTC timestamps come without a "Z"; make them real instants. */
function asUtcIso(s: string): string {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
}

export function normalizeSlots(raw: z.infer<typeof AvailableServicesResponse>): ServiceSlot[] {
  return raw.map((r) => ({
    serviceKey: r.supplierServiceKey,
    name: r.serviceName.trim(),
    supplierKey: r.supplierKey,
    distributionTimeKey: r.supplierDistributionTimeKey,
    cutoffLocal: r.cutOffTime,
    cutoffUtc: asUtcIso(r.cutOffTimeUtc),
    nextFulfillmentLocal: r.nextOrderFulfillmentDate,
  }));
}

export function normalizeOrderDays(raw: z.infer<typeof FulfillmentDatesResponse>): OrderDay[] {
  return raw.map((r) => ({
    date: datePart(r.fulfillmentDate),
    fulfillmentLocal: r.fulfillmentDate,
    cutoffPassed: r.hasCutOffTimePassed,
    closureReason: r.closureReason ?? null,
    distributionTimeKey: r.supplierDistributionTimeKey.value,
  }));
}

export function normalizeHistory(raw: z.infer<typeof OrderHistoryResponse>): Order[] {
  const out: Order[] = [];
  for (const day of [...raw.presentOrders, ...raw.pastOrders]) {
    for (const o of day.orders) {
      out.push({
        key: o.orderKey.value,
        studentKey: o.studentKey.value,
        studentName: o.studentName,
        serviceKey: o.supplierServiceKey,
        serviceName: o.supplierServiceName,
        supplierKey: o.supplierKey,
        date: datePart(o.dueDate),
        dueLocal: o.dueDate,
        items: o.orderItems.map((i) => ({ name: i.itemDisplayName, quantity: i.quantityOrdered })),
        total: o.orderTotal,
        state: o.orderState,
        active: isActiveState(o.orderState),
      });
    }
  }
  return out;
}

export function normalizeOrderDetail(raw: z.infer<typeof OrderDetailResponse>): OrderDetail {
  return {
    key: raw.orderKey.value,
    studentKey: raw.studentKey.value,
    studentName: raw.studentName,
    serviceKey: raw.supplierServiceKey.value,
    serviceName: raw.serviceName,
    supplierKey: "",
    date: datePart(raw.fulfillmentDate),
    dueLocal: raw.fulfillmentDate,
    items: raw.items.map((i) => ({ name: i.itemDisplayName, quantity: 1 })),
    total: raw.totalPrice,
    state: raw.orderState,
    active: isActiveState(raw.orderState),
    fee: raw.orderFee,
    gst: raw.totalGst,
    canCancel: raw.canCancelOrder,
    history: raw.stateHistory.map((h) => ({ state: h.state, at: h.stateChangedOn })),
  };
}

export function normalizeMenu(raw: z.infer<typeof ItemListResponse>, date: string, supplierKey: string): Menu {
  const items: MenuItem[] = [];
  for (const cat of raw.itemCategories) {
    for (const it of cat.items) {
      const optionSets: MenuOptionSet[] = it.optionSets.map((os) => ({
        key: os.optionSetKey,
        name: os.name,
        required: os.minQuantity >= 1,
        min: os.minQuantity,
        max: os.maxQuantity,
        options: os.options
          .filter((o) => o.isActive !== false)
          .map((o) => ({ key: o.optionKey, name: o.name, price: o.optionPrice, inStock: o.inStock, isDefault: o.isDefault ?? false })),
      }));
      // Cheapest way to satisfy every required set.
      let priceFrom = it.itemPrice;
      for (const os of optionSets) {
        if (!os.required) continue;
        const prices = os.options.filter((o) => o.inStock).map((o) => o.price);
        if (prices.length) priceFrom += Math.min(...prices) * os.min;
      }
      items.push({
        key: it.itemKey,
        name: it.name,
        category: cat.name,
        basePrice: it.itemPrice,
        priceFrom: round2(priceFrom),
        inStock: it.inStock,
        labels: it.labels,
        optionSets,
        hasQuestions: it.questionSets.length > 0,
      });
    }
  }
  return {
    serviceKey: raw.supplierServiceKey,
    serviceName: raw.supplierServiceName,
    date,
    dueLocal: raw.dueDate,
    supplierKey,
    distributionTimeKey: raw.supplierDistributionTimeKey,
    items,
  };
}
