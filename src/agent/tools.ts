// The model's tools: thin wrappers over FlexiClient that return compact, normalized JSON (never raw API payloads and
// never internal keys the model does not need). Read-only tools run freely. The only tools that touch money are
// plan_order / plan_cancel, and they only PROPOSE: execution happens in ApprovalDesk.approve(), from a human action.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { FlexiClient, resolveDate } from "../flexischools/index.ts";
import type { MenuItem, Order, OrderDetail } from "../flexischools/index.ts";
import { describeProposal } from "./approvals.ts";
import type { ApprovalDesk, Proposal } from "./approvals.ts";

export interface ToolContext {
  client: FlexiClient;
  desk: ApprovalDesk;
  now: () => Date;
  /** Called when the model creates a proposal, so the UI can show it with Approve / Reject. */
  onProposal?: (p: Proposal) => void;
}

const out = (data: unknown): string => JSON.stringify(data);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const dateArg = z.string().describe('A date: "today", "tomorrow", "+N" (days from today), or YYYY-MM-DD. School-local (Sydney) dates.');
const studentArg = z.string().describe("The child's first name, e.g. as returned by list_students.");
const serviceArg = z.string().describe('Service name or a unique part of it, e.g. "lunch" or "Junior Recess".');

function orderView(o: Order) {
  return { order_key: o.key, date: o.date, student: o.studentName, service: o.serviceName, items: o.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name)), total: o.total, state: o.state, active: o.active };
}

function orderDetailView(o: OrderDetail) {
  return { ...orderView(o), fee: o.fee, can_cancel: o.canCancel, history: o.history };
}

function menuItemView(i: MenuItem) {
  return {
    name: i.name,
    category: i.category,
    ...(i.optionSets.some((s) => s.required) ? { price_from: i.priceFrom } : { price: i.basePrice }),
    ...(i.inStock ? {} : { sold_out: true }),
    ...(i.labels.length ? { labels: i.labels } : {}),
    ...(i.hasQuestions ? { unsupported: "asks questions at checkout; cannot be ordered here" } : {}),
    ...(i.optionSets.length
      ? {
          options: i.optionSets.map((s) => ({
            set: s.name,
            ...(s.required || s.min > 0 ? { pick_at_least: Math.max(s.min, 1) } : {}),
            ...(s.max > 0 ? { pick_at_most: s.max } : {}),
            choices: s.options.map((o) => `${o.name}${o.price ? ` (+$${o.price.toFixed(2)})` : ""}${o.inStock ? "" : " (sold out)"}`),
          })),
        }
      : {}),
  };
}

function proposalView(p: Proposal) {
  return {
    proposal_id: p.id,
    kind: p.kind,
    status: p.status,
    summary: describeProposal(p),
    ...(p.kind === "order" && p.warnings.length ? { warnings: p.warnings } : {}),
    ...(p.outcome ? { outcome: p.outcome } : {}),
    expires_at: p.expiresAt.toISOString(),
  };
}

const awaitingNote =
  "Waiting for a household member to approve it in the app (Approve button or /approve). You cannot place or cancel anything yourself, and nothing has happened yet: do not say it is done.";

export function createTools(ctx: ToolContext): BetaRunnableTool<any>[] {
  const { client, desk } = ctx;
  const day = (d: string | undefined, fallback: string): string => resolveDate(d ?? fallback, ctx.now());

  return [
    betaZodTool({
      name: "list_students",
      description: "List the household's children (Flexischools students) with their school and the canteen services each can order from.",
      inputSchema: z.object({}),
      run: async () => {
        const students = await client.listStudents();
        return out(students.map((s) => ({ name: s.firstName, last_name: s.lastName, school: s.schoolName, services: s.services.map((v) => v.name) })));
      },
    }),

    betaZodTool({
      name: "list_service_slots",
      description: "For one child: the next orderable occasion of each service and its exact order cutoff (school-local time), with minutes left.",
      inputSchema: z.object({ student: studentArg }),
      run: async ({ student }) => {
        const s = await client.findStudent(student);
        const now = ctx.now().getTime();
        const slots = await client.listServiceSlots(s);
        return out(slots.map((x) => ({ service: x.name, next: x.nextFulfillmentLocal, cutoff_local: x.cutoffLocal, minutes_to_cutoff: Math.round((Date.parse(x.cutoffUtc) - now) / 60000) })));
      },
    }),

    betaZodTool({
      name: "get_order_days",
      description: "Upcoming days a service can be ordered for one child, with closures (holidays, staff days) and whether each day's cutoff has passed.",
      inputSchema: z.object({ student: studentArg, service: serviceArg }),
      run: async ({ student, service }) => {
        const s = await client.findStudent(student);
        const v = FlexiClient.findService(s, service);
        const days = await client.getOrderDays(s.key, v.key);
        return out({ service: v.name, days: days.map((d) => ({ date: d.date, ...(d.closureReason ? { closed: d.closureReason } : { cutoff_passed: d.cutoffPassed }) })) });
      },
    }),

    betaZodTool({
      name: "list_orders",
      description:
        "Orders, newest date first, including future ones. Cancelled orders are excluded unless include_cancelled is true; an order with active=false does NOT count as ordered. Without from/to only the most recent page is returned.",
      inputSchema: z.object({
        student: studentArg.optional(),
        from: dateArg.optional(),
        to: dateArg.optional(),
        include_cancelled: z.boolean().optional(),
      }),
      run: async ({ student, from, to, include_cancelled }) => {
        const s = student ? await client.findStudent(student) : undefined;
        const ranged = Boolean(from || to);
        const orders = await client.listOrders({
          ...(from ? { from: day(from, "today") } : {}),
          ...(to ? { to: day(to, "today") } : {}),
          ...(s ? { studentKey: s.key } : {}),
          includeInactive: include_cancelled ?? false,
          maxPages: ranged ? 20 : 1,
        });
        return out(orders.map(orderView));
      },
    }),

    betaZodTool({
      name: "get_order",
      description: "One order in detail: items, fee, state, its state history, and whether it can still be cancelled.",
      inputSchema: z.object({ order_key: z.string().describe("order_key from list_orders") }),
      run: async ({ order_key }) => out(orderDetailView(await client.getOrder(order_key))),
    }),

    betaZodTool({
      name: "get_menu",
      description:
        "The menu of one service for one child on one date, as the canteen will serve it that day (availability is the server's, per item and per option). Option prices add to the item price; an order fee is added once per order.",
      inputSchema: z.object({ student: studentArg, service: serviceArg, date: dateArg, include_sold_out: z.boolean().optional() }),
      run: async ({ student, service, date, include_sold_out }) => {
        const s = await client.findStudent(student);
        const menu = await client.getMenu(s, FlexiClient.findService(s, service), day(date, "today"));
        const items = include_sold_out ? menu.items : menu.items.filter((i) => i.inStock);
        return out({ service: menu.serviceName, date: menu.date, items: items.map(menuItemView) });
      },
    }),

    betaZodTool({
      name: "check_orders",
      description:
        'Is food ordered for a date? Per child and matching service: "ordered", "missing" (nothing ordered, cutoff not passed yet), "missed_cutoff", or "no_order_day".',
      inputSchema: z.object({
        date: z.string().optional().describe('Default "today". Also "tomorrow", "+N", or YYYY-MM-DD (school-local).'),
        service: z.string().optional().describe('Services whose name contains this text; default "lunch".'),
        student: z.string().optional().describe("A child's first name; default all children."),
      }),
      run: async ({ date, service, student }) => {
        const students = student ? [await client.findStudent(student)] : undefined;
        const rows = await client.checkDay({ date: day(date, "today"), ...(students ? { students } : {}), serviceMatch: new RegExp(escapeRe(service ?? "lunch"), "i"), now: ctx.now() });
        return out(
          rows.map((r) => ({
            student: r.student,
            service: r.service,
            date: r.date,
            status: r.status,
            ...(r.orders.length ? { orders: r.orders.map(orderView) } : {}),
            ...(r.closureReason ? { closure: r.closureReason } : {}),
            ...(r.minutesToCutoff !== undefined ? { minutes_to_cutoff: r.minutesToCutoff } : {}),
          })),
        );
      },
    }),

    betaZodTool({
      name: "plan_order",
      description:
        "Propose an order for one child, one service and one date (several items allowed). Validates the items, option choices, stock, cutoff and total against the live menu, then submits the plan for human approval. It does NOT place the order. Use exact names from get_menu.",
      inputSchema: z.object({
        student: studentArg,
        service: serviceArg,
        date: dateArg,
        items: z
          .array(
            z.object({
              item: z.string().describe("Item name from get_menu"),
              quantity: z.number().int().min(1).max(10).optional(),
              choices: z
                .array(z.object({ set: z.string().optional().describe("Option set name, needed only if the option name is ambiguous"), option: z.string() }))
                .optional()
                .describe("Option choices, e.g. a flavour, bread or size. Required option sets must be chosen."),
            }),
          )
          .min(1),
      }),
      run: async ({ student, service, date, items }) => {
        const p = await desk.proposeOrder({
          student,
          service,
          date: day(date, "today"),
          items: items.map((i) => ({ item: i.item, ...(i.quantity ? { quantity: i.quantity } : {}), ...(i.choices ? { choices: i.choices.map((c) => ({ option: c.option, ...(c.set ? { set: c.set } : {}) })) } : {}) })),
        });
        ctx.onProposal?.(p);
        return out({ ...proposalView(p), note: awaitingNote });
      },
    }),

    betaZodTool({
      name: "plan_cancel",
      description: "Propose cancelling an order that is still cancellable. Submits it for human approval; it does NOT cancel anything.",
      inputSchema: z.object({ order_key: z.string().describe("order_key from list_orders") }),
      run: async ({ order_key }) => {
        const p = await desk.proposeCancel(order_key);
        ctx.onProposal?.(p);
        return out({ ...proposalView(p), note: awaitingNote });
      },
    }),

    betaZodTool({
      name: "list_proposals",
      description: "Proposals still waiting for approval (orders and cancellations), with their ids.",
      inputSchema: z.object({}),
      run: async () => out(desk.pending().map(proposalView)),
    }),
  ];
}
