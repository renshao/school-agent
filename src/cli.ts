// Plain command-line interface to Flexischools (no LLM). Usage: npm run flexi -- <command> [args]
import { parseArgs } from "node:util";
import { createFlexiClient, FlexiClient, FlexiError, parseItemSpec, resolveDate, resolveLine } from "./flexischools/index.ts";
import type { CheckRow, MenuItem, Order, OrderDetail, OrderDay, Student } from "./flexischools/index.ts";

const USAGE = `flexi: Flexischools from the command line

  students                              Students and their services
  services <student>                    Services with the next cutoff time
  days <student> <service>              Orderable days (cutoff passed? closures?)
  orders [--student S] [--from D] [--to D] [--all]     Orders (D: today|tomorrow|yesterday|+N|YYYY-MM-DD)
  order <orderKey>                      One order with its state history
  menu <student> <service> <date> [--all]              Menu (in-stock only unless --all)
  check [--date D] [--student S] [--service RE]        Is lunch ordered? exit 1 if something is missing
  place <student> <service> <date> <item>... [--yes]   Place an order (dry run unless --yes)
        item: "Name [Option; Set=Option] xN", e.g. "Up & Go [Chocolate]" "Ham & Cheese Sandwich [Bread Options=GLUTEN FREE] x2"
  cancel <orderKey> [--yes]             Cancel an order (dry run unless --yes)

  --json   machine-readable output for read commands`;

const money = (n: number): string => `$${n.toFixed(2)}`;

function fmtOrder(o: Order): string {
  const items = o.items.map((i) => (i.quantity > 1 ? `${i.quantity} x ${i.name}` : i.name)).join(" + ");
  return `${o.date}  ${o.studentName} · ${o.serviceName} · ${items} · ${money(o.total)} [${o.state}]${o.active ? "" : "  (inactive)"}`;
}

function fmtMenuItem(i: MenuItem): string {
  const price = i.optionSets.some((s) => s.required) ? `from ${money(i.priceFrom)}` : money(i.basePrice);
  const opts = i.optionSets.map((s) => `${s.name}${s.required ? "*" : ""}: ${s.options.map((o) => `${o.name}${o.price ? ` ${money(o.price)}` : ""}${o.inStock ? "" : " (sold out)"}`).join("/")}`).join("; ");
  return `  ${i.inStock ? " " : "✗"} ${i.name}  ${price}${i.labels.length ? `  [${i.labels.join(", ")}]` : ""}${opts ? `\n      ${opts}` : ""}`;
}

function fmtCheck(r: CheckRow): string {
  const mark = { ordered: "✓", missing: "✗ MISSING", missed_cutoff: "✗ missed cutoff", no_order_day: "–" }[r.status];
  const detail =
    r.status === "ordered"
      ? r.orders.map((o) => o.items.map((i) => i.name).join(" + ")).join("; ")
      : r.status === "missing" && r.minutesToCutoff !== undefined
        ? `${r.minutesToCutoff} min until cutoff`
        : r.status === "no_order_day"
          ? (r.closureReason ?? "not an order day")
          : "";
  return `${mark}  ${r.student} · ${r.service} · ${r.date}${detail ? `  (${detail})` : ""}`;
}

function print(json: boolean, data: unknown, text: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : text);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      all: { type: "boolean" },
      yes: { type: "boolean" },
      student: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      date: { type: "string" },
      service: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }
  const json = values.json ?? false;
  const client = createFlexiClient();
  const need = (n: number, what: string): void => {
    if (args.length < n) throw new Error(`usage: ${cmd} ${what}`);
  };

  switch (cmd) {
    case "students": {
      const students = await client.listStudents();
      print(json, students, students.map((s) => `${s.firstName} ${s.lastName} · ${s.schoolName}\n    ${s.services.map((v) => v.name).join(", ")}`).join("\n"));
      return 0;
    }
    case "services": {
      need(1, "<student>");
      const student = await client.findStudent(args[0]!);
      const slots = await client.listServiceSlots(student);
      print(json, slots, slots.map((s) => `${s.name.padEnd(24)} next ${s.nextFulfillmentLocal.slice(0, 16)}  cutoff ${s.cutoffLocal.slice(0, 16)} (local)`).join("\n"));
      return 0;
    }
    case "days": {
      need(2, "<student> <service>");
      const student = await client.findStudent(args[0]!);
      const service = FlexiClient.findService(student, args[1]!);
      const days: OrderDay[] = await client.getOrderDays(student.key, service.key);
      print(json, days, days.map((d) => `${d.date}  ${d.closureReason ? `closed: ${d.closureReason}` : d.cutoffPassed ? "cutoff passed" : "open"}`).join("\n"));
      return 0;
    }
    case "orders": {
      const student = values.student ? await client.findStudent(values.student) : undefined;
      const orders = await client.listOrders({
        ...(values.from ? { from: resolveDate(values.from) } : {}),
        ...(values.to ? { to: resolveDate(values.to) } : {}),
        ...(student ? { studentKey: student.key } : {}),
        includeInactive: values.all ?? false,
        maxPages: values.from || values.to ? 20 : 1,
      });
      print(json, orders, orders.length ? orders.map(fmtOrder).join("\n") : "(no orders)");
      return 0;
    }
    case "order": {
      need(1, "<orderKey>");
      const o: OrderDetail = await client.getOrder(args[0]!);
      print(json, o, `${fmtOrder(o)}\n  fee ${money(o.fee)}  gst ${money(o.gst)}  cancellable: ${o.canCancel}\n  ${o.history.map((h) => `${h.at} ${h.state}`).join("\n  ")}`);
      return 0;
    }
    case "menu": {
      need(3, "<student> <service> <date>");
      const student = await client.findStudent(args[0]!);
      const menu = await client.getMenu(student, FlexiClient.findService(student, args[1]!), resolveDate(args[2]!));
      const items = values.all ? menu.items : menu.items.filter((i) => i.inStock);
      const cats = [...new Set(items.map((i) => i.category))];
      print(json, { ...menu, items }, `${menu.serviceName} · ${menu.date}\n` + cats.map((c) => `${c}\n${items.filter((i) => i.category === c).map(fmtMenuItem).join("\n")}`).join("\n"));
      return 0;
    }
    case "check": {
      const now = new Date();
      const date = resolveDate(values.date ?? "today", now);
      const students: Student[] | undefined = values.student ? [await client.findStudent(values.student)] : undefined;
      const serviceMatch = new RegExp(values.service ?? "lunch", "i");
      const rows = await client.checkDay({ date, ...(students ? { students } : {}), serviceMatch, now });
      print(json, rows, rows.length ? rows.map(fmtCheck).join("\n") : "(no matching services)");
      return rows.some((r) => r.status === "missing" || r.status === "missed_cutoff") ? 1 : 0;
    }
    case "place": {
      need(4, "<student> <service> <date> <item>...");
      const student = await client.findStudent(args[0]!);
      const service = FlexiClient.findService(student, args[1]!);
      const date = resolveDate(args[2]!);
      const menu = await client.getMenu(student, service, date);
      const lines = args.slice(3).map((spec) => resolveLine(menu, parseItemSpec(spec)));
      const plan = await client.planOrder({ student, service, date, lines });
      const s = plan.summary;
      console.log(`${s.student} · ${s.service} · ${s.date}`);
      for (const l of s.lines) console.log(`  ${l.quantity} x ${l.item}${l.options.length ? ` (${l.options.join(", ")})` : ""}  ${money(l.lineTotal)}`);
      console.log(`  items ${money(s.subtotal)} + fee ${money(s.fee)} = ${money(s.total)}`);
      if (!values.yes) {
        console.log("\nDRY RUN: nothing sent. Re-run with --yes to place this order (charges your account).");
        return 0;
      }
      const placed = await client.placeOrder(plan);
      console.log(`\nPLACED: ${fmtOrder(placed)}\n  key ${placed.key}`);
      return 0;
    }
    case "cancel": {
      need(1, "<orderKey>");
      const o = await client.getOrder(args[0]!);
      console.log(fmtOrder(o) + `\n  cancellable: ${o.canCancel}`);
      if (!values.yes) {
        console.log("\nDRY RUN: nothing sent. Re-run with --yes to cancel.");
        return 0;
      }
      const after = await client.cancelOrder(args[0]!);
      console.log(`\nCANCELLED: now ${after.state}`);
      return 0;
    }
    default:
      console.error(`unknown command "${cmd}"\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof FlexiError ? `error (${e.kind}): ${e.message}` : `error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
