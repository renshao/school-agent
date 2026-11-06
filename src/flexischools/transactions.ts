// Pure: account-history rows (GraphQL findTransactions) -> Transaction. The interesting part is the description,
// the only place the items of a card purchase appear:
//   Card transaction for: 'SPRING ROLLS  $5.80, Cookie  $4.80' using Card Number: '…' at <canteen> by <operator> ,Student Card Fee $0.18
//   Order (900001): Meat Pie with Sauce $6.40, Order Fee $0.39
//   Automatic Credit purchase. Charged to PayPal '…'. (Txn ID: …)
//   PayPal Surcharge ($0.30 + 1% of $150)
// The card number is deliberately not kept.
import type { z } from "zod";
import { DEFAULT_TIMEZONE } from "./config.ts";
import { ymdInZone } from "./dates.ts";
import type { TransactionsData } from "./schemas.ts";
import type { Transaction, TransactionItem, TransactionKind } from "./types.ts";

type RawTransaction = z.infer<typeof TransactionsData>["findTransactions"][number];

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * "Bacon, Tomato & Cheese Roll $5.80, 2 x Juice $10.00" -> items. Names may contain commas and even "$" amounts
 * ("Canteen IOU ($2, $5) $7.00"), so an item ends only at a price followed by a comma or the end.
 */
export function parseItemList(s: string): TransactionItem[] {
  const items: TransactionItem[] = [];
  for (const m of s.matchAll(/(?:^|,)\s*(.+?)\s+\$(\d+(?:\.\d+)?)(?=\s*,|\s*$)/g)) {
    const raw = m[1]!.replace(/\s+/g, " ").trim();
    const q = /^(\d+)\s*x\s+(.+)$/i.exec(raw);
    items.push({ name: q ? q[2]! : raw, quantity: q ? Number(q[1]) : 1, price: Number(m[2]) });
  }
  return items;
}

const CARD = /^Card transaction for: '(.*)' using Card Number: '[^']*'(.*)$/s;
const ORDER = /^Order \(\d+\):\s*(.*)$/s;

function classify(description: string, orderId: string | null): { kind: TransactionKind; items: TransactionItem[]; fee: number; place: string | null } {
  const card = CARD.exec(description);
  if (card) {
    const rest = card[2]!;
    const fee = /Student Card Fee \$(\d+(?:\.\d+)?)/i.exec(rest);
    // " at Example School Canteen by Some Caterer by Impos User ,Student Card Fee $0.18" -> "Example School Canteen"
    const at = /\bat (.+?)(?:\s+by\s|\s*,|$)/.exec(rest);
    return { kind: "card", items: parseItemList(card[1]!), fee: fee ? Number(fee[1]) : 0, place: at ? at[1]!.trim() : null };
  }
  const order = ORDER.exec(description);
  if (order || orderId) {
    const all = parseItemList(order ? order[1]! : "");
    const fees = all.filter((i) => /^order fee$/i.test(i.name));
    return { kind: "order", items: all.filter((i) => !fees.includes(i)), fee: round2(fees.reduce((t, i) => t + i.price, 0)), place: null };
  }
  if (/credit purchase|top.?up/i.test(description)) return { kind: "top_up", items: [], fee: 0, place: null };
  if (/surcharge|fee\b/i.test(description)) return { kind: "fee", items: [], fee: 0, place: null };
  return { kind: "other", items: [], fee: 0, place: null };
}

/** HH:MM (24h) of an instant in the school's timezone. */
export function timeInZone(d: Date, tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

export function normalizeTransaction(r: RawTransaction, tz: string = DEFAULT_TIMEZONE): Transaction {
  const at = new Date(r.transactionDate);
  const description = (r.description ?? "").replace(/(Card Number: )'[^']*'/i, "$1'…'");
  const orderId = r.orderId === null ? null : String(r.orderId);
  return {
    at: at.toISOString(),
    date: ymdInZone(at, tz),
    time: timeInZone(at, tz),
    name: r.firstName?.trim() || "?",
    userKey: r.userKey,
    amount: r.debitCredit,
    balance: r.balance,
    orderId,
    description,
    ...classify(description, orderId),
  };
}
