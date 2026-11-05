// Read-only explorer: log in, click through a list of text patterns, dump the final page.
// Usage: npm run explore -- "Order food" "Alice"
// Refuses to click anything that looks like a purchase.
import { writeFileSync } from "node:fs";
import { launch, login, clickText, snapshot, log } from "./lib.mjs";

const steps = process.argv.slice(2);
const FORBIDDEN = /checkout|pay|place order|add to (cart|order)|confirm|top up|\+/i;
for (const s of steps) if (FORBIDDEN.test(s)) { console.error(`refusing step "${s}" (read-only spike)`); process.exit(1); }

const { page, gql, net, close } = await launch();
try {
  log("login");
  await login(page);
  for (const s of steps) {
    log("click", JSON.stringify(s));
    await clickText(page, s);
    log("  now at", page.url());
  }
  const info = await snapshot(page, "explore");
  writeFileSync("out/network.json", JSON.stringify(net, null, 2));
  console.log("\n--- json responses ---\n" + net.map((n) => `${n.status} ${n.method} ${n.url.replace(/\?.*/, "")} (${n.body.length}b)${n.req ? " op=" + (JSON.parse(n.req).operationName ?? "?") : ""}`).join("\n"));
  log("URL:", info.url);
  console.log("\n--- page text ---\n" + info.text.split("\n").filter(Boolean).slice(0, 80).join("\n"));
  console.log("\n--- controls ---\n" + info.controls.slice(0, 60).map((c) => `${c.tag}${c.type ? `[${c.type}]` : ""} ${JSON.stringify(c.text)}${c.href ? " -> " + c.href : ""}`).join("\n"));
  console.log("\n--- graphql ops ---\n" + [...new Set(gql.map((g) => g.op))].join(", "));
} catch (e) {
  console.error("FAILED:", e.message);
  try { const i = await snapshot(page, "explore-failed"); console.error("at", i.url); } catch {}
  process.exitCode = 1;
} finally {
  await close();
}
