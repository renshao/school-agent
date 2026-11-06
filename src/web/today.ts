// The "Today" strip: each child's status for the next day that still matters, from the same pure checkOrders logic
// as `flexi check` (and, later, the reminder routine). No LLM involved.
import { addDays, checkOrders, ymdInZone } from "../flexischools/index.ts";
import type { CheckStatus, FlexiClient, OrderDay, ServiceSlot } from "../flexischools/index.ts";
import { findSkip } from "../agent/memory.ts";
import type { Skip } from "../agent/memory.ts";

export interface TodayRow {
  student: string;
  service: string;
  /** "skipped": nothing ordered, and a saved rule or day exception says none is needed. */
  status: CheckStatus | "skipped";
  /** The saved rule or exception covering this day, e.g. "excursion" (also set when an order exists anyway). */
  skip?: { ref: string; reason: string };
  /** Active orders' items, e.g. ["Pizza"]. */
  items: string[];
  total?: number;
  /** ISO instant, when known (the next slot's cutoff). */
  cutoffUtc?: string;
  closureReason?: string;
}

export interface TodayView {
  /** YYYY-MM-DD, school-local. */
  date: string;
  rows: TodayRow[];
  checkedAt: string;
}

/**
 * Today, while something can still be done about today (a missing order, or an order still cancellable before the
 * cutoff); otherwise the next day that is an order day for anyone, within `horizonDays`.
 */
export async function upcomingDay(client: FlexiClient, opts: { now: Date; serviceMatch: RegExp; horizonDays?: number; skips?: readonly Skip[] }): Promise<TodayView> {
  const { now, serviceMatch } = opts;
  const horizon = opts.horizonDays ?? 10;
  const today = ymdInZone(now);
  const students = await client.listStudents();
  const slotsByStudent = new Map<string, ServiceSlot[]>();
  const daysByService = new Map<string, OrderDay[]>();
  for (const s of students) {
    slotsByStudent.set(s.key, await client.listServiceSlots(s));
    for (const v of s.services.filter((v) => serviceMatch.test(v.name))) daysByService.set(`${s.key}:${v.key}`, await client.getOrderDays(s.key, v.key));
  }
  const orders = await client.listOrders({ from: today, to: addDays(today, horizon), includeInactive: true, maxPages: 10 });

  const skips = opts.skips ?? [];
  const rowsFor = (date: string) =>
    checkOrders({ date, students, orders, daysByService, slotsByStudent, serviceMatch, now }).map((r) => {
      const st = students.find((s) => s.firstName === r.student);
      const sv = st?.services.find((v) => v.name === r.service);
      const skip = st && sv ? findSkip(skips, st.key, sv.key, date) : undefined;
      if (!skip) return { ...r, skip: undefined };
      const status: TodayRow["status"] = r.status === "missing" || r.status === "missed_cutoff" ? "skipped" : r.status;
      return { ...r, status, skip: { ref: `S${skip.id}`, reason: skip.reason } };
    });
  let date = today;
  let rows = rowsFor(today);
  const todayActionable = rows.some((r) => r.status === "missing" || (r.status === "ordered" && (r.minutesToCutoff ?? 0) > 0));
  if (!todayActionable) {
    for (let i = 1; i <= horizon; i++) {
      const d = addDays(today, i);
      const r = rowsFor(d);
      if (r.some((x) => x.status !== "no_order_day")) {
        date = d;
        rows = r;
        break;
      }
    }
  }

  return {
    date,
    checkedAt: now.toISOString(),
    rows: rows.map((r) => ({
      student: r.student,
      service: r.service,
      status: r.status,
      items: r.orders.flatMap((o) => o.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name))),
      ...(r.orders.length ? { total: Math.round(r.orders.reduce((t, o) => t + o.total, 0) * 100) / 100 } : {}),
      ...(r.cutoffUtc ? { cutoffUtc: r.cutoffUtc } : {}),
      ...(r.closureReason ? { closureReason: r.closureReason } : {}),
      ...(r.skip ? { skip: r.skip } : {}),
    })),
  };
}
