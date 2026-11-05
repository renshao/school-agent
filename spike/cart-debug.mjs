import { launch, login, clickText, sleep } from "./lib.mjs";
const { page, close } = await launch();
const logs = [];
page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e.message ?? e).slice(0, 300)}`));
try {
  await login(page);
  for (const s of ["Order food", "AliceExampleSchool", "Junior Recess", "Tomorrow, Fri", "Bacon, Tomato"]) await clickText(page, s);
  logs.length = 0;
  await page.evaluate(() => [...document.querySelectorAll("button")].find((x) => /^Add Item/.test(x.innerText.trim())).click());
  await sleep(3000);
  console.log("logs after Add Item click:\n" + (logs.filter((l) => !/LaunchDarkly|go\.apollo/.test(l)).join("\n") || "(none)"));
} catch (e) { console.error("FAILED:", e.message); } finally { await close(); }
