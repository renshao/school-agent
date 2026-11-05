// "Is lunch ordered?" as a pure function over data already fetched. This is the core of the reminder routine.
import type { Order, OrderDay, ServiceSlot, Student } from "./types.ts";

export type CheckStatus =
  | "ordered" // an active order exists
  | "missing" // nothing ordered and the cutoff has not passed: remind now
  | "missed_cutoff" // nothing ordered and the cutoff has passed
  | "no_order_day"; // not an order day (weekend, holiday, closure)

export interface CheckRow {
  student: string;
  service: string;
  date: string;
  status: CheckStatus;
  orders: Order[];
  /** Why it is not an order day, if the site says so. */
  closureReason?: string;
  /** Present when the slot for this date is known. */
  cutoffUtc?: string;
  minutesToCutoff?: number;
}

export interface CheckInput {
  /** YYYY-MM-DD to check. */
  date: string;
  students: Student[];
  /** Orders covering `date` (any state; cancelled ones are ignored here). */
  orders: Order[];
  /** Keyed `${studentKey}:${serviceKey}`. */
  daysByService: ReadonlyMap<string, OrderDay[]>;
  /** Keyed by studentKey. */
  slotsByStudent: ReadonlyMap<string, ServiceSlot[]>;
  /** Only services whose name matches are checked. */
  serviceMatch: RegExp;
  now: Date;
}

export function checkOrders(input: CheckInput): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const student of input.students) {
    for (const service of student.services) {
      if (!input.serviceMatch.test(service.name)) continue;

      const base = { student: student.firstName, service: service.name, date: input.date };
      const day = input.daysByService.get(`${student.key}:${service.key}`)?.find((d) => d.date === input.date);
      if (!day || day.closureReason) {
        rows.push({ ...base, status: "no_order_day", orders: [], ...(day?.closureReason ? { closureReason: day.closureReason } : {}) });
        continue;
      }

      const active = input.orders.filter((o) => o.active && o.studentKey === student.key && o.serviceKey === service.key && o.date === input.date);
      const slot = input.slotsByStudent.get(student.key)?.find((s) => s.serviceKey === service.key && s.nextFulfillmentLocal.slice(0, 10) === input.date);
      const timing = slot ? { cutoffUtc: slot.cutoffUtc, minutesToCutoff: Math.round((Date.parse(slot.cutoffUtc) - input.now.getTime()) / 60000) } : {};

      const status: CheckStatus = active.length ? "ordered" : day.cutoffPassed ? "missed_cutoff" : "missing";
      rows.push({ ...base, status, orders: active, ...timing });
    }
  }
  return rows;
}
