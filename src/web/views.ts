// What the browser sees: stored events turned into small display records, never raw API payloads (no thinking
// blocks, tool inputs, internal keys or prompts). Model text is sent as plain text; the page renders it as text nodes.
import type { Proposal } from "../agent/approvals.ts";
import { describeNote, describeSkip } from "../agent/memory.ts";
import type { MemoryChange } from "../agent/memory.ts";
import type { EventRow } from "./store.ts";

/** A value after a JSON round trip (Dates become strings). Proposals are stored and served in this form. */
export type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[] : T extends object ? { [K in keyof T]: Json<T[K]> } : T;
export type StoredProposal = Json<Proposal>;

export const toJson = <T>(v: T): Json<T> => JSON.parse(JSON.stringify(v)) as Json<T>;

export interface ProposalView {
  id: string;
  kind: "order" | "cancel" | "skip";
  status: Proposal["status"];
  student: string;
  service: string;
  date: string;
  lines: { label: string; amount?: number }[];
  fee?: number;
  total: number;
  warnings: string[];
  outcome?: string;
  decidedBy?: string;
  expiresAt: string;
  /** The order being cancelled, or the order placed. */
  orderKey?: string;
}

export function proposalView(p: StoredProposal): ProposalView {
  const base = { id: p.id, status: p.status, expiresAt: p.expiresAt, ...(p.outcome ? { outcome: p.outcome } : {}), ...(p.decidedBy ? { decidedBy: p.decidedBy } : {}) };
  if (p.kind === "skip") {
    const uniq = (xs: string[]) => [...new Set(xs)].join(" & ");
    return {
      ...base,
      kind: "skip",
      student: uniq(p.skips.map((s) => s.studentName)),
      service: uniq(p.skips.map((s) => s.serviceName ?? "all services")),
      date: p.skips[0]?.from ?? "",
      // The card lists each pause in words; money fields do not apply.
      lines: p.skips.map((s) => ({ label: describeSkip(s) })),
      total: 0,
      warnings: [],
    };
  }
  if (p.kind === "cancel") {
    const o = p.order;
    return {
      ...base,
      kind: "cancel",
      student: o.studentName,
      service: o.serviceName,
      date: o.date,
      lines: o.items.map((i) => ({ label: i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name })),
      total: o.total,
      warnings: [],
      orderKey: p.orderKey,
    };
  }
  const s = p.summary;
  return {
    ...base,
    kind: "order",
    student: s.student,
    service: s.service,
    date: s.date,
    lines: s.lines.map((l) => ({ label: `${l.quantity > 1 ? `${l.quantity} x ` : ""}${l.item}${l.options.length ? ` (${l.options.join(", ")})` : ""}`, amount: l.lineTotal })),
    fee: s.fee,
    total: s.total,
    warnings: p.warnings,
    ...(p.placed ? { orderKey: p.placed.key } : {}),
  };
}

export type ViewEvent = { seq: number; ts: string; thread: string } & (
  | { kind: "user"; author: string; text: string; clientId?: string }
  | { kind: "assistant"; text: string; steps: string[]; final: boolean }
  | { kind: "proposal"; proposal: ProposalView }
  | { kind: "decision"; proposal: ProposalView }
  | { kind: "error"; text: string }
  | { kind: "memory"; change: MemoryChangeView }
);

export interface MemoryChangeView {
  action: MemoryChange["action"];
  by: string;
  /** "N3" / "S2" */
  ref: string;
  /** The note or skip in words. */
  text: string;
}

export function memoryChangeView(c: Json<MemoryChange>): MemoryChangeView {
  return "note" in c
    ? { action: c.action, by: c.by, ref: `N${c.note.id}`, text: describeNote(c.note) }
    : { action: c.action, by: c.by, ref: `S${c.skip.id}`, text: describeSkip(c.skip) };
}

const STEP_LABELS: Record<string, string> = {
  list_students: "looked up the children",
  list_service_slots: "checked cutoffs",
  get_order_days: "checked order days",
  list_orders: "looked at orders",
  get_order: "opened an order",
  get_menu: "read the menu",
  check_orders: "checked what's ordered",
  plan_order: "priced an order",
  plan_cancel: "prepared a cancellation",
  list_proposals: "checked approvals",
  plan_skip: "prepared a pause",
  remove_skip: "removed a pause",
  remember: "saved a note",
  forget: "forgot a note",
  list_memory: "checked what it remembers",
};

type Block = { type: string; text?: string; name?: string };

/** One stored event as the page shows it, or null for events the page does not show (tool results, usage). */
export function toView(row: EventRow): ViewEvent | null {
  const head = { seq: row.seq, ts: row.ts, thread: row.thread };
  const p = row.payload as Record<string, any>;
  switch (row.type) {
    case "user":
      return { ...head, kind: "user", author: String(p.author ?? row.author ?? "?"), text: String(p.text ?? ""), ...(p.clientId ? { clientId: String(p.clientId) } : {}) };
    case "assistant": {
      const content = (p.message?.content ?? []) as Block[];
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("\n")
        .trim();
      const steps = content.filter((b) => b.type === "tool_use").map((b) => STEP_LABELS[b.name ?? ""] ?? String(b.name));
      if (!text && !steps.length) return null;
      return { ...head, kind: "assistant", text, steps, final: p.message?.stop_reason !== "tool_use" };
    }
    case "proposal":
    case "decision":
      return { ...head, kind: row.type, proposal: proposalView(p.proposal as StoredProposal) };
    case "error":
      return { ...head, kind: "error", text: String(p.error ?? "Something went wrong") };
    case "memory":
      return { ...head, kind: "memory", change: memoryChangeView(p.change as Json<MemoryChange>) };
    default:
      return null;
  }
}
