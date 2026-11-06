// Pure: what each child ate (or at least got) from the canteen, from two sources:
// - orders: pre-ordered meals, on the day they are served, with their service (an order's charge reaches the account
//   history only when the order closes, the evening of that day, so order transactions are not used here);
// - card purchases: bought at the counter with the student card, on the day and time of purchase.
import type { Order, Student, Transaction } from "./types.ts";

export interface Meal {
  /** School-local YYYY-MM-DD. */
  date: string;
  student: string;
  source: "order" | "card";
  /** Orders: the service, e.g. "Junior Lunch". */
  service?: string;
  /** Card purchases: school-local HH:MM. (Orders have none: their due time is the canteen's delivery time.) */
  time?: string;
  items: string[];
  /** Including the order fee or card fee. */
  total: number;
  /** Card purchases: where. */
  place?: string;
}

const itemText = (i: { name: string; quantity: number }): string => (i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name);

/** Meals in [from, to] (inclusive), sorted by date, then time. Cancelled orders and parents' rows are left out. */
export function mealsBetween(opts: { from: string; to: string; students: readonly Student[]; orders: readonly Order[]; transactions: readonly Transaction[] }): Meal[] {
  const { from, to, students } = opts;
  const inRange = (d: string) => d >= from && d <= to;
  const studentOf = (t: Transaction): Student | undefined =>
    students.find((s) => s.key === t.userKey) ?? (t.userKey ? undefined : students.find((s) => s.firstName === t.name));

  const ordered: Meal[] = opts.orders
    .filter((o) => o.active && inRange(o.date))
    .map((o) => ({
      date: o.date,
      student: o.studentName,
      source: "order",
      service: o.serviceName,
      items: o.items.map(itemText),
      total: o.total,
    }));

  const bought: Meal[] = [];
  for (const t of opts.transactions) {
    if (t.kind !== "card" || !inRange(t.date) || (t.amount >= 0 && !t.items.length)) continue;
    const s = studentOf(t);
    if (!s) continue;
    bought.push({ date: t.date, student: s.firstName, source: "card", time: t.time, items: t.items.map(itemText), total: Math.abs(t.amount), ...(t.place ? { place: t.place } : {}) });
  }

  return [...ordered, ...bought].sort((a, b) => a.date.localeCompare(b.date) || a.student.localeCompare(b.student) || (a.time ?? "").localeCompare(b.time ?? ""));
}
