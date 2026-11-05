import { DEFAULT_TIMEZONE } from "./config.ts";

/** YYYY-MM-DD of `d` in the given IANA timezone. */
export function ymdInZone(d: Date, tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Add `n` days to a YYYY-MM-DD string (calendar arithmetic, no timezone involved). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Accepts `today`, `tomorrow`, `yesterday`, `+N` / `-N` days, or `YYYY-MM-DD`. */
export function resolveDate(input: string, now: Date = new Date(), tz: string = DEFAULT_TIMEZONE): string {
  const today = ymdInZone(now, tz);
  const s = input.trim().toLowerCase();
  if (s === "today") return today;
  if (s === "tomorrow") return addDays(today, 1);
  if (s === "yesterday") return addDays(today, -1);
  if (/^[+-]\d+$/.test(s)) return addDays(today, Number(s));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error(`Unrecognised date "${input}" (use today, tomorrow, yesterday, +N, or YYYY-MM-DD)`);
}

/** The YYYY-MM-DD part of a Flexischools local timestamp like "2026-11-06T10:30:00". */
export function datePart(local: string): string {
  return local.slice(0, 10);
}
