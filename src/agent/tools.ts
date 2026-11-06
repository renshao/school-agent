// The model's tools: thin wrappers over FlexiClient that return compact, normalized JSON (never raw API payloads and
// never internal keys the model does not need). Read-only tools run freely. The only tools that touch money are
// plan_order / plan_cancel, and they only PROPOSE: execution happens in ApprovalDesk.approve(), from a human action.
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { addDays, FlexiClient, FlexiError, mealsBetween, resolveDate, ymdInZone } from "../flexischools/index.ts";
import type { MenuItem, Order, OrderDetail, Student } from "../flexischools/index.ts";
import { describeProposal } from "./approvals.ts";
import type { ApprovalDesk, Proposal } from "./approvals.ts";
import { describeNote, describeSkip, findSkip, WEEKDAYS } from "./memory.ts";
import type { MemoryChange, MemoryStore, SkipDraft } from "./memory.ts";

export interface ToolContext {
  client: FlexiClient;
  desk: ApprovalDesk;
  now: () => Date;
  /** Called when the model creates a proposal, so the UI can show it with Approve / Reject. */
  onProposal?: (p: Proposal) => void;
  /** Saved rules and notes. Without it, the memory tools are not offered. */
  memory?: MemoryStore;
  /** Who the current turn is for (memory changes are attributed to them). */
  author?: () => string;
  onMemory?: (c: MemoryChange) => void;
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
  "Waiting for a household member to press Approve on the proposal card in the app. You cannot place or cancel anything yourself, and nothing has happened yet: do not say it is done.";

const idArg = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}?\\d+$`, "i"))
    .describe(`Id as listed, e.g. "${prefix}3"`);
const parseId = (s: string): number => Number(s.replace(/^\D+/, ""));

export function createTools(ctx: ToolContext): BetaRunnableTool<any>[] {
  const { client, desk, memory } = ctx;
  const day = (d: string | undefined, fallback: string): string => resolveDate(d ?? fallback, ctx.now());
  const author = (): string => ctx.author?.() ?? "a parent";
  /** from/to (to defaults to from), in order and at most `maxDays` long. */
  const dayRange = (from: string | undefined, to: string | undefined, maxDays: number): { from: string; to: string } => {
    const f = day(from, "today");
    const t = to ? day(to, "today") : f;
    if (t < f) throw new FlexiError("precondition", `"to" (${t}) is before "from" (${f})`);
    if (addDays(f, maxDays - 1) < t) throw new FlexiError("precondition", `At most ${maxDays} days at a time`);
    return { from: f, to: t };
  };

  const memoryTools: BetaRunnableTool<any>[] = !memory
    ? []
    : [
        betaZodTool({
          name: "plan_skip",
          description:
            "Propose pausing order checks and reminders for one or more children, when no canteen order is needed. A standing rule has no `to` date (e.g. \"Bob buys his own lunch\", or only on some weekdays); a day exception has dates (an excursion, camp, a sick day, a pupil-free day for one class). A parent must confirm it in the app before it takes effect; nothing is saved until then.",
          inputSchema: z.object({
            students: z.array(studentArg).min(1).describe("Each child it applies to"),
            service: z.string().optional().describe('Service name or a unique part of it, e.g. "lunch". Omit to pause every service.'),
            from: dateArg.optional().describe('First day it applies (default "today").'),
            to: dateArg.optional().describe("Last day it applies, inclusive. Omit for an ongoing rule; for a single day, the same as from."),
            weekdays: z.array(z.enum(WEEKDAYS as [string, ...string[]])).min(1).optional().describe('Only on these weekdays, e.g. ["Fri"]. Omit for every day.'),
            reason: z.string().min(1).max(120).describe('Short, in the parent\'s words, e.g. "excursion", "buys his own lunch"'),
          }),
          run: async ({ students, service, from, to, weekdays, reason }) => {
            const drafts: SkipDraft[] = [];
            for (const name of students) {
              const st: Student = await client.findStudent(name);
              const sv = service ? FlexiClient.findService(st, service) : null;
              drafts.push({
                studentKey: st.key,
                studentName: st.firstName,
                serviceKey: sv?.key ?? null,
                serviceName: sv?.name ?? null,
                from: day(from, "today"),
                to: to ? day(to, "today") : null,
                weekdays: (weekdays as SkipDraft["weekdays"]) ?? null,
                reason: reason.trim(),
              });
            }
            const p = desk.proposeSkip(drafts);
            ctx.onProposal?.(p);
            return out({ ...proposalView(p), note: "Waiting for a parent to press Save on the card. Nothing is saved yet." });
          },
        }),

        betaZodTool({
          name: "remove_skip",
          description: "Remove a paused check (by id from list_memory), so the child is checked and reminded again. Takes effect immediately.",
          inputSchema: z.object({ skip_id: idArg("S") }),
          run: async ({ skip_id }) => {
            const s = memory.removeSkip(parseId(skip_id), author(), ctx.now());
            if (!s) throw new FlexiError("not_found", `No active paused check ${skip_id}`);
            ctx.onMemory?.({ action: "skip_removed", skip: s, by: author() });
            return out({ removed: `S${s.id}`, was: describeSkip(s) });
          },
        }),

        betaZodTool({
          name: "remember",
          description:
            "Save a lasting note for future conversations: a preference, allergy, habit or household fact (e.g. \"Alice doesn't like tomato\"). Saved immediately; the parents can see and delete notes. Not for one-off requests, and not for skipping orders (use plan_skip).",
          inputSchema: z.object({
            student: studentArg.optional().describe("The child it is about; omit for the whole household."),
            text: z.string().min(1).max(300).describe("The note, short and self-contained, e.g. \"doesn't like tomato\" (the child's name is shown with it)."),
          }),
          run: async ({ student, text }) => {
            const studentName = student ? (await client.findStudent(student)).firstName : null;
            const n = memory.addNote({ studentName, text: text.trim() }, author(), ctx.now());
            ctx.onMemory?.({ action: "note_added", note: n, by: author() });
            return out({ saved: `N${n.id}`, note: describeNote(n) });
          },
        }),

        betaZodTool({
          name: "forget",
          description: "Delete a saved note (by id from list_memory).",
          inputSchema: z.object({ note_id: idArg("N") }),
          run: async ({ note_id }) => {
            const n = memory.removeNote(parseId(note_id), author(), ctx.now());
            if (!n) throw new FlexiError("not_found", `No saved note ${note_id}`);
            ctx.onMemory?.({ action: "note_removed", note: n, by: author() });
            return out({ forgotten: `N${n.id}`, was: describeNote(n) });
          },
        }),

        betaZodTool({
          name: "list_memory",
          description: "The current paused checks (standing rules and day exceptions, with ids) and saved notes (with ids).",
          inputSchema: z.object({}),
          run: async () =>
            out({
              paused_checks: memory.activeSkips(ymdInZone(ctx.now())).map((s) => ({ id: `S${s.id}`, what: describeSkip(s) })),
              notes: memory.activeNotes().map((n) => ({ id: `N${n.id}`, note: describeNote(n) })),
            }),
        }),
      ];

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
      name: "meals",
      description:
        'What each child had from the canteen on given days, from both sources: meals ordered online (source "order", with the service, on the day served) and purchases made at the counter with the student card (source "card", with the school-local time; no order exists for these). Use it for "what did X have for lunch/recess". Card purchases do not say recess or lunch: judge by the time (about 10-11am is usually recess, about 12-1pm lunch) and the item names.',
      inputSchema: z.object({
        student: studentArg.optional(),
        from: dateArg.optional().describe('First day (default "today"). "yesterday" and -N work too.'),
        to: dateArg.optional().describe("Last day, inclusive (default: the same as from)."),
      }),
      run: async ({ student, from, to }) => {
        const range = dayRange(from, to, 62);
        const students = student ? [await client.findStudent(student)] : await client.listStudents();
        const [orders, card] = await Promise.all([
          client.listOrders({ ...range, ...(student ? { studentKey: students[0]!.key } : {}), maxPages: 20 }),
          client.listTransactions(range).then(
            (t) => ({ transactions: t, error: undefined }),
            (e: unknown) => ({ transactions: [], error: e instanceof Error ? e.message : String(e) }),
          ),
        ]);
        const meals = mealsBetween({ ...range, students, orders, transactions: card.transactions });
        return out({
          ...range,
          meals: meals.map((m) => ({ date: m.date, student: m.student, source: m.source, ...(m.service ? { service: m.service } : {}), ...(m.time ? { time: m.time } : {}), items: m.items, total: m.total })),
          ...(card.error ? { warning: `Card purchases could not be read (${card.error}); only ordered meals are listed.` } : {}),
        });
      },
    }),

    betaZodTool({
      name: "list_transactions",
      description:
        "The Flexischools wallet: current balance and its history for a date range: card purchases at the counter (with items), order charges (posted the evening of the day an order was served), top-ups and fees. Use it for money questions (balance, spending, top-ups). For what a child ate, use meals.",
      inputSchema: z.object({
        from: dateArg.optional().describe('First day (default: 6 days before "to").'),
        to: dateArg.optional().describe('Last day, inclusive (default "today").'),
        student: studentArg.optional().describe("Only this child's rows."),
      }),
      run: async ({ from, to, student }) => {
        const end = day(to, "today");
        const range = dayRange(from ?? addDays(end, -6), end, 62);
        const [account, rows, s] = await Promise.all([client.getAccount(), client.listTransactions(range), student ? client.findStudent(student) : undefined]);
        const mine = s ? rows.filter((t) => t.userKey === s.key) : rows;
        const spent = new Map<string, number>();
        for (const t of mine) if (t.amount < 0) spent.set(t.name, Math.round(((spent.get(t.name) ?? 0) - t.amount) * 100) / 100);
        return out({
          balance: account.availableBalance,
          ...range,
          spent_by: Object.fromEntries(spent),
          transactions: mine.map((t) => ({
            date: t.date,
            time: t.time,
            who: t.name,
            kind: t.kind,
            amount: t.amount,
            ...(t.items.length ? { items: t.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name)) } : {}),
            ...(t.fee ? { fee: t.fee } : {}),
            ...(t.orderId ? { order_id: t.orderId } : {}),
            ...(t.place ? { place: t.place } : {}),
            ...(t.kind === "other" || t.kind === "fee" ? { description: t.description.slice(0, 120) } : {}),
          })),
        });
      },
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
        'Is food ordered for a date? Per child and matching service: "ordered", "missing" (nothing ordered, cutoff not passed yet), "missed_cutoff", or "no_order_day". A row with "paused" is covered by a saved rule or day exception: no order is needed then.',
      inputSchema: z.object({
        date: z.string().optional().describe('Default "today". Also "tomorrow", "+N", or YYYY-MM-DD (school-local).'),
        service: z.string().optional().describe('Services whose name contains this text; default "lunch".'),
        student: z.string().optional().describe("A child's first name; default all children."),
      }),
      run: async ({ date, service, student }) => {
        const students = student ? [await client.findStudent(student)] : await client.listStudents();
        const rows = await client.checkDay({ date: day(date, "today"), students, serviceMatch: new RegExp(escapeRe(service ?? "lunch"), "i"), now: ctx.now() });
        const skips = memory?.activeSkips(ymdInZone(ctx.now())) ?? [];
        const skipOf = (studentName: string, serviceName: string, date: string) => {
          const st = students.find((s) => s.firstName === studentName);
          const sv = st?.services.find((v) => v.name === serviceName);
          return st && sv ? findSkip(skips, st.key, sv.key, date) : undefined;
        };
        return out(
          rows.map((r) => ({
            student: r.student,
            service: r.service,
            date: r.date,
            status: r.status,
            ...(() => {
              const s = skipOf(r.student, r.service, r.date);
              return s ? { paused: `S${s.id}: ${s.reason} (no order needed${r.status === "ordered" ? ", yet one exists" : ""})` } : {};
            })(),
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

    ...memoryTools,
  ];
}
