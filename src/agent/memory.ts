// What the household asked the assistant to remember.
//
// - Skips pause the order checks (Today strip, reminders, check_orders) for a child and service. A standing rule has
//   no end date ("Bob buys his own lunch"), optionally only on some weekdays; a day exception has one ("Alice:
//   excursion on 13 Nov"). Adding one needs a parent's confirmation (it switches reminders off); removing one is
//   immediate (it only makes checks stricter).
// - Notes are free text the model reads at the start of each day ("Alice doesn't like tomato").
//
// Stored in SQLite (web/store.ts); this module is the shapes and the pure rules.

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
export const WEEKDAYS: readonly Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A skip as proposed (keys resolved, not yet saved). */
export interface SkipDraft {
  studentKey: string;
  studentName: string;
  /** null = every service. */
  serviceKey: string | null;
  serviceName: string | null;
  /** YYYY-MM-DD, school-local, inclusive. */
  from: string;
  /** Inclusive; null = ongoing (a standing rule). */
  to: string | null;
  /** null = every day. */
  weekdays: Weekday[] | null;
  reason: string;
}

export interface Skip extends SkipDraft {
  id: number;
  createdBy: string;
  createdAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export interface Note {
  id: number;
  /** null = about the whole household. */
  studentName: string | null;
  text: string;
  createdBy: string;
  createdAt: string;
  removedAt: string | null;
  removedBy: string | null;
}

export interface MemoryStore {
  addSkip(draft: SkipDraft, by: string, now: Date): Skip;
  removeSkip(id: number, by: string, now: Date): Skip | undefined;
  /** Not removed, and not ended before `today` (YYYY-MM-DD). */
  activeSkips(today: string): Skip[];
  addNote(note: { studentName: string | null; text: string }, by: string, now: Date): Note;
  removeNote(id: number, by: string, now: Date): Note | undefined;
  activeNotes(): Note[];
}

/** A change to memory, logged and shown in the chat. */
export type MemoryChange =
  | { action: "note_added" | "note_removed"; note: Note; by: string }
  | { action: "skip_added" | "skip_removed"; skip: Skip; by: string };

export function weekdayOf(ymd: string): Weekday {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

export function skipApplies(s: Skip | SkipDraft, studentKey: string, serviceKey: string, date: string): boolean {
  if ("removedAt" in s && s.removedAt) return false;
  if (s.studentKey !== studentKey) return false;
  if (s.serviceKey !== null && s.serviceKey !== serviceKey) return false;
  if (date < s.from || (s.to !== null && date > s.to)) return false;
  return s.weekdays === null || s.weekdays.includes(weekdayOf(date));
}

/** The first skip that applies, if any. */
export const findSkip = (skips: readonly Skip[], studentKey: string, serviceKey: string, date: string): Skip | undefined =>
  skips.find((s) => skipApplies(s, studentKey, serviceKey, date));

const shortDay = (ymd: string): string => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y, m - 1, d))).replace(",", "");
};

const PLURAL: Record<Weekday, string> = { Mon: "Mondays", Tue: "Tuesdays", Wed: "Wednesdays", Thu: "Thursdays", Fri: "Fridays", Sat: "Saturdays", Sun: "Sundays" };

/** "Alice · Junior Lunch · Fri 13 Nov · excursion", "Bob · Lunch · Fridays, ongoing from Thu 5 Nov · buys his own lunch" */
export function describeSkip(s: SkipDraft): string {
  const days = s.weekdays ? (s.weekdays.length === 1 ? PLURAL[s.weekdays[0]!] : s.weekdays.join("/")) : null;
  const when =
    s.to === null ? `${days ? `${days}, ` : ""}ongoing from ${shortDay(s.from)}` : s.from === s.to ? shortDay(s.from) : `${shortDay(s.from)} to ${shortDay(s.to)}${days ? `, ${days} only` : ""}`;
  return `${s.studentName} · ${s.serviceName ?? "all services"} · ${when} · ${s.reason}`;
}

/** "Alice: no tomato" (not "Alice: Alice doesn't like tomato" when the text already names the child). */
export const describeNote = (n: Pick<Note, "studentName" | "text">): string =>
  n.studentName && !n.text.toLowerCase().startsWith(n.studentName.toLowerCase()) ? `${n.studentName}: ${n.text}` : n.text;

/** The memory block the model gets at the start of each day's conversation (empty when there is nothing). */
export function memoryBlock(skips: readonly Skip[], notes: readonly Note[]): string {
  if (!skips.length && !notes.length) return "";
  const lines = ["[household memory: saved by the parents; today's conversation starts with it]"];
  if (skips.length) lines.push("Order checks paused (ids are for remove_skip):", ...skips.map((s) => `- S${s.id}: ${describeSkip(s)}`));
  if (notes.length) lines.push("Notes (ids are for forget):", ...notes.map((n) => `- N${n.id}: ${describeNote(n)}`));
  return lines.join("\n");
}
