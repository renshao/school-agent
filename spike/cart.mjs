// Cart-stage spike: reaches the item dialog, selects a required option via its real input, adds the item.
// NEVER clicks checkout/pay. Prints network calls made after each step.
import { writeFileSync } from "node:fs";
import { launch, login, clickText, snapshot, log, sleep } from "./lib.mjs";
const mode = process.argv[2] ?? "inspect"; // inspect | add
const { page, net, close } = await launch();
const mark = () => net.length;
const show = (from) => { for (const n of net.slice(from)) { if (/nr-data|google/.test(n.url)) continue; console.log(`  ${n.status} ${n.method} ${n.url.split(".com.au")[1]?.slice(0, 110)}`); if (n.req && n.method !== "GET") console.log(`     REQ: ${n.req.slice(0, 900)}`); console.log(`     RESP: ${n.body.slice(0, 700).replace(/\n/g, " ")}`); } };
try {
  await login(page);
  for (const s of ["Order food", "AliceExampleSchool", "Junior Lunch", "Mon 9th Nov", "Vegemite Sandwich"]) await clickText(page, s);
  const dlg = await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type=radio], input[type=checkbox]')];
    return radios.map((r) => ({ type: r.type, name: r.name, value: r.value, id: r.id, checked: r.checked, label: (r.closest("label") ?? document.querySelector(`label[for="${r.id}"]`))?.innerText?.trim() }));
  });
  console.log("option inputs:", JSON.stringify(dlg, null, 1));
  if (mode === "add") {
    const from = mark();
    const ok = await page.evaluate(() => { const r = [...document.querySelectorAll('input[type=radio]')].find((x) => /^white$/i.test(((x.closest("label") ?? document.querySelector(`label[for="${x.id}"]`))?.innerText ?? "").trim())); if (!r) return false; r.click(); return true; });
    console.log("selected White:", ok); await sleep(1500);
    console.log("after select:"); show(from);
    const from2 = mark();
    await clickText(page, "Add Item");
    console.log("after Add Item:"); show(from2);
    const info = await snapshot(page, "cart-after-add");
    console.log("\ntext tail:", info.text.slice(-400));
    if (mode === "add") {
      const f3 = mark();
      await clickText(page, "No thanks");
      console.log("after No thanks:"); show(f3);
      const i2 = await snapshot(page, "cart-summary");
      console.log("URL:", i2.url.slice(0, 160));
      console.log("summary text tail:", i2.text.slice(-600));
      console.log("controls:", i2.controls.map((c) => c.text).filter((t) => /cart|view|checkout|pay|order|remove|total|close/i.test(t) && t.length < 70));
    }
    console.log("controls:", info.controls.map((c) => c.text).filter((t) => /cart|view|checkout|order|remove|thanks|close/i.test(t) && t.length < 70));
  }
} catch (e) { console.error("FAILED:", e.message); process.exitCode = 1; } finally { await close(); }
