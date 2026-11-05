// Spike: can Lightpanda log into Flexischools and read the post-login page?
// READ-ONLY. Never submits an order. Writes page dumps to spike/out/ (gitignored).
//
// Run:  cd spike && npm run login     (needs ../.env with FLEXISCHOOL_USERNAME / _PASSWORD)

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const { FLEXISCHOOL_USERNAME: user, FLEXISCHOOL_PASSWORD: pass } = process.env;
if (!user || !pass) {
  console.error("Missing FLEXISCHOOL_USERNAME / FLEXISCHOOL_PASSWORD in ../.env");
  process.exit(1);
}

const LOGIN_URL = "https://user.flexischools.com.au/login";
const PORT = 9222;
mkdirSync("out", { recursive: true });

const lp = spawn("lightpanda", ["serve", "--host", "127.0.0.1", "--port", String(PORT)], {
  stdio: ["ignore", "ignore", "inherit"],
});
const stop = () => lp.kill();
process.on("exit", stop);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await sleep(800); // let the CDP server come up
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${PORT}` });
  const ctx = browser.browserContexts()[0] ?? (await browser.createBrowserContext());
  const page = await ctx.newPage();

  // Log network responses that look like API calls, to find the GraphQL endpoint.
  const calls = [];
  page.on("response", (res) => {
    const u = res.url();
    if (/graphql|api|login|auth|token/i.test(u)) calls.push(`${res.status()} ${res.request().method()} ${u}`);
  });

  log("goto", LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: "networkidle0", timeout: 30000 });

  log("fill form");
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  const emailSel = 'input[type="email"], input[name*="mail" i], input[name*="user" i], input[type="text"]';
  await page.type(emailSel, user);
  await page.type('input[type="password"]', pass);

  log("submit");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 }).catch(() => log("(no navigation event; SPA route change?)")),
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /log\s*in/i.test(b.textContent));
      btn?.click();
    }),
  ]);
  await sleep(2000);

  log("url after login:", page.url());
  const text = await page.evaluate(() => document.body.innerText);
  writeFileSync("out/after-login.txt", text);
  writeFileSync("out/after-login.html", await page.content());
  log(`saved out/after-login.{txt,html} (${text.length} chars of text)`);
  log("API-looking calls:\n  " + (calls.join("\n  ") || "(none)"));
  log("first lines of page text:\n" + text.split("\n").filter(Boolean).slice(0, 25).join("\n"));

  await browser.disconnect();
} catch (e) {
  console.error("SPIKE FAILED:", e.message);
  process.exitCode = 1;
} finally {
  stop();
}
