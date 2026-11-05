// Experiment (no payment): add item via a real CDP mouse click; look for cart state.
import { launch, login, clickText, log, sleep } from "./lib.mjs";
const { page, net, close } = await launch();
try {
  await login(page);
  for (const s of ["Order food", "AliceExampleSchool", "Junior Recess", "Tomorrow, Fri", "Bacon, Tomato"]) await clickText(page, s);
  const btn = await page.evaluateHandle(() => [...document.querySelectorAll("button")].find((b) => /^Add Item/.test(b.innerText.trim())));
  const before = net.length;
  try { await btn.asElement().click(); log("real click ok"); } catch (e) { log("real click failed:", e.message); }
  await sleep(4000);
  console.log("calls after click:", net.slice(before).filter((n) => !/nr-data|google/.test(n.url)).map((n) => `${n.method} ${n.url.split(".com.au")[1]?.slice(0, 90)}`));
  const st = await page.evaluate(async () => ({
    ls: Object.keys(localStorage), ss: Object.keys(sessionStorage),
    idb: (await indexedDB.databases?.().catch(() => []))?.map((d) => d.name),
    bodyHas580: document.body.innerText.includes("5.80"), tail: document.body.innerText.slice(-160).replace(/\n/g, " | "),
  }));
  console.log(JSON.stringify(st, null, 1));
} catch (e) { console.error("FAILED:", e.message); } finally { await close(); }
