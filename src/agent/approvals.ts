// The approval gate. The model can only PROPOSE spending (plan_order / plan_cancel); a proposal is stored here, on the
// host, and only a human calling approve() executes it. There is deliberately no model-callable tool that places or
// cancels anything, so no prompt (or prompt injection) can spend money.
//
// Safety properties (tested in test/approvals.test.ts):
//   - executes at most once: the status leaves "pending" synchronously, before any await
//   - expires: an old proposal cannot be approved
//   - re-validated at approval time: the order is planned again and must match what the human saw (same lines, same
//     total) or nothing is sent and the proposal becomes "stale"
//   - an unconfirmed outcome ("it MAY have been placed") is final: never retried
import { FlexiClient, FlexiError, resolveLine } from "../flexischools/index.ts";
import type { ItemRequest, Order, OrderDetail, OrderPlan } from "../flexischools/index.ts";

export type ProposalStatus = "pending" | "executing" | "done" | "rejected" | "expired" | "stale" | "failed" | "unknown";

interface ProposalBase {
  /** Short id a human can type, e.g. "P1". */
  id: string;
  createdAt: Date;
  expiresAt: Date;
  status: ProposalStatus;
  /** Who approved or rejected it, once decided. */
  decidedBy?: string;
  /** Human-readable outcome once decided. */
  outcome?: string;
}

export interface OrderProposal extends ProposalBase {
  kind: "order";
  request: { student: string; service: string; date: string; items: ItemRequest[] };
  summary: OrderPlan["summary"];
  /** Things the approver should know, e.g. an order already exists for that day. */
  warnings: string[];
  placed?: OrderDetail;
}

export interface CancelProposal extends ProposalBase {
  kind: "cancel";
  orderKey: string;
  order: OrderDetail;
  cancelled?: OrderDetail;
}

export type Proposal = OrderProposal | CancelProposal;

export interface ApprovalDeskOptions {
  now?: () => Date;
  /** How long a proposal stays approvable. Default 30 minutes. */
  ttlMs?: number;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** One line a human can approve from: kid, service, date, every item, and the total. */
export function describeProposal(p: Proposal): string {
  if (p.kind === "cancel") {
    const o = p.order;
    return `CANCEL ${o.studentName} · ${o.serviceName} · ${o.date} · ${o.items.map((i) => i.name).join(" + ")} · ${money(o.total)} (order ${o.key})`;
  }
  const s = p.summary;
  const lines = s.lines.map((l) => `${l.quantity} x ${l.item}${l.options.length ? ` (${l.options.join(", ")})` : ""} ${money(l.lineTotal)}`).join(" + ");
  return `ORDER ${s.student} · ${s.service} · ${s.date} · ${lines} + fee ${money(s.fee)} = ${money(s.total)}`;
}

const sameSummary = (a: OrderPlan["summary"], b: OrderPlan["summary"]): boolean => JSON.stringify(a) === JSON.stringify(b);

export class ApprovalDesk {
  private client: FlexiClient;
  private now: () => Date;
  private ttlMs: number;
  private proposals = new Map<string, Proposal>();
  private seq = 0;

  constructor(client: FlexiClient, opts: ApprovalDeskOptions = {}) {
    this.client = client;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? 30 * 60_000;
  }

  private nextId(): string {
    return `P${++this.seq}`;
  }

  private base(): ProposalBase {
    const createdAt = this.now();
    return { id: this.nextId(), createdAt, expiresAt: new Date(createdAt.getTime() + this.ttlMs), status: "pending" };
  }

  /** Plans an order (validates stock, options, cutoff, prices; sends nothing) and stores it for approval. */
  async proposeOrder(request: OrderProposal["request"]): Promise<OrderProposal> {
    const { plan, existing } = await this.plan(request);
    const warnings = existing.map((o) => `Already ordered for ${o.studentName} · ${o.serviceName} on ${o.date}: ${o.items.map((i) => i.name).join(" + ")} (${money(o.total)}, ${o.state})`);
    const p: OrderProposal = { ...this.base(), kind: "order", request: structuredClone(request), summary: plan.summary, warnings };
    this.proposals.set(p.id, p);
    return p;
  }

  /** Checks the order can still be cancelled (sends nothing) and stores the cancellation for approval. */
  async proposeCancel(orderKey: string): Promise<CancelProposal> {
    const order = await this.client.getOrder(orderKey);
    if (!order.active) throw new FlexiError("precondition", `Order ${orderKey} is already ${order.state}`);
    if (!order.canCancel) throw new FlexiError("precondition", `Order ${orderKey} can no longer be cancelled (state ${order.state}; it has probably been sent to the canteen)`);
    const p: CancelProposal = { ...this.base(), kind: "cancel", orderKey, order };
    this.proposals.set(p.id, p);
    return p;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id.trim().toUpperCase());
  }

  /** Pending proposals, expiring stale ones first. */
  pending(): Proposal[] {
    for (const p of this.proposals.values()) this.expireIfDue(p);
    return [...this.proposals.values()].filter((p) => p.status === "pending");
  }

  reject(id: string, by: string): Proposal {
    const p = this.mustGetPending(id);
    p.status = "rejected";
    p.decidedBy = by;
    p.outcome = `Rejected by ${by}`;
    return p;
  }

  /**
   * Executes a proposal. Call ONLY from a human action (a button, a typed command): never from model output.
   * Never throws for Flexischools failures: the outcome is recorded on the proposal and returned.
   */
  async approve(id: string, by: string): Promise<Proposal> {
    const p = this.mustGetPending(id);
    p.status = "executing"; // synchronously, before any await: a second approve() now fails
    p.decidedBy = by;
    try {
      if (p.kind === "order") await this.executeOrder(p);
      else await this.executeCancel(p);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof FlexiError && e.kind === "outcome_unknown") {
        p.status = "unknown";
        p.outcome = `Outcome unknown: ${msg}`;
      } else {
        p.status = "failed";
        p.outcome = `Failed, nothing ${p.kind === "order" ? "ordered" : "cancelled"}: ${msg}`;
      }
    }
    return p;
  }

  private mustGetPending(id: string): Proposal {
    const p = this.get(id);
    if (!p) throw new FlexiError("not_found", `No proposal ${id}`);
    this.expireIfDue(p);
    if (p.status !== "pending") throw new FlexiError("precondition", `Proposal ${p.id} is ${p.status}${p.outcome ? ` (${p.outcome})` : ""}`);
    return p;
  }

  private expireIfDue(p: Proposal): void {
    if (p.status === "pending" && this.now() >= p.expiresAt) {
      p.status = "expired";
      p.outcome = "Expired before approval; ask for a new plan";
    }
  }

  private async plan(request: OrderProposal["request"]): Promise<{ plan: OrderPlan; existing: Order[] }> {
    const student = await this.client.findStudent(request.student);
    const service = FlexiClient.findService(student, request.service);
    const menu = await this.client.getMenu(student, service, request.date);
    const lines = request.items.map((i) => resolveLine(menu, i));
    const plan = await this.client.planOrder({ student, service, date: request.date, lines });
    const existing = (await this.client.listOrders({ from: request.date, to: request.date, studentKey: student.key })).filter((o) => o.serviceKey === service.key && o.date === request.date);
    return { plan, existing };
  }

  private async executeOrder(p: OrderProposal): Promise<void> {
    // Plan again: stock, cutoff and prices may have changed since the human looked.
    let fresh: OrderPlan;
    try {
      fresh = (await this.plan(p.request)).plan;
    } catch (e) {
      p.status = "stale";
      p.outcome = `Not placed: no longer valid (${e instanceof Error ? e.message : String(e)})`;
      return;
    }
    if (!sameSummary(fresh.summary, p.summary)) {
      p.status = "stale";
      p.outcome = `Not placed: the order changed since it was proposed (now: ${describeProposal({ ...p, summary: fresh.summary })}). Ask for a new plan.`;
      return;
    }
    const placed = await this.client.placeOrder(fresh);
    p.placed = placed;
    p.status = "done";
    p.outcome = `Placed order ${placed.key} (${placed.state}), total ${money(placed.total)}`;
  }

  private async executeCancel(p: CancelProposal): Promise<void> {
    const after = await this.client.cancelOrder(p.orderKey);
    p.cancelled = after;
    p.status = "done";
    p.outcome = `Cancelled order ${p.orderKey} (now ${after.state})`;
  }
}
