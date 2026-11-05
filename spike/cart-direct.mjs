// Deep-link to Alice's Junior Recess item list for a date, add the Bacon roll to the CLIENT cart, report cart state.
// Does NOT check out. Use LIGHTPANDA_BIN to pick a binary.
import { launch, login, clickText, sleep } from "./lib.mjs";
const K = { student: "student-key-2", supplier: "supplier-key-2", service: "service-key-6", dist: "dist-key-1", school: "school-key-2" };
const url = `https://ordering.flexischools.com.au/Food/${K.student}/items-list-V2/${K.supplier}/${K.service}/${K.dist}?refreshCart=true&fulfillmentDate=2026-11-06T10%3A30%3A00&supplierDistributionTimeKey=${K.dist}&schoolKey=${K.school}`;
const { page, net, close } = await launch();
const cart = async () => { const raw = await page.evaluate(() => localStorage.getItem("USER_CART_MULTI")); if (!raw) return null; const s = JSON.parse(JSON.parse(raw)["\u0000"]).state; return { items: s.cartData.orders.flatMap((o) => o.orderItems), count: s.ordersCount, totals: s.orderPrices.combinedOrderTotals }; };
try {
  await login(page);
  await page.goto(url, { waitUntil: "load", timeout: 30000 }); await sleep(3000);
  console.log("at:", page.url().slice(0, 90), "| has item list:", await page.evaluate(() => document.body.innerText.includes("Bacon, Tomato")));
  await clickText(page, "Bacon, Tomato");
  const before = net.length;
  await clickText(page, "Add Item - ");
  await sleep(2500);
  console.log("cart after Add Item:", JSON.stringify(await cart()));
  console.log("write calls:", net.slice(before).filter((n) => n.method !== "GET" && !/nr-data|google/.test(n.url)).map((n) => `${n.method} ${n.url.split(".com.au")[1]}`));
  console.log("page shows cart UI:", await page.evaluate(() => /view order|checkout|view cart/i.test(document.body.innerText)));
} catch (e) { console.error("FAILED:", e.message); } finally { await close(); }
