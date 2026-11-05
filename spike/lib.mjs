// Shared helpers for the Lightpanda spikes.
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

export const PORT = 9222;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

export async function launch() {
  mkdirSync("out", { recursive: true });
  const lp = spawn("lightpanda", ["serve", "--host", "127.0.0.1", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await sleep(800);
  const browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${PORT}` });
  const ctx = browser.browserContexts()[0] ?? (await browser.createBrowserContext());
  const page = await ctx.newPage();

  // Record GraphQL operations (name + variables) so we learn the API shape.
  const gql = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && /graphql/.test(req.url())) {
      try {
        const b = JSON.parse(req.postData() ?? "{}");
        const ops = Array.isArray(b) ? b : [b];
        for (const o of ops) gql.push({ op: o.operationName, variables: o.variables });
      } catch {}
    }
  });

  const close = async () => {
    try { await browser.disconnect(); } catch {}
    lp.kill();
  };
  return { page, gql, close };
}

export async function login(page) {
  const { FLEXISCHOOL_USERNAME: user, FLEXISCHOOL_PASSWORD: pass } = process.env;
  if (!user || !pass) throw new Error("Missing FLEXISCHOOL_USERNAME / FLEXISCHOOL_PASSWORD");
  await page.goto("https://user.flexischools.com.au/login", { waitUntil: "load", timeout: 30000 });
  await page.waitForSelector('input[type="password"]', { timeout: 10000 });
  await page.type('input[type="email"], input[name*="mail" i], input[name*="user" i], input[type="text"]', user);
  await page.type('input[type="password"]', pass);
  await page.evaluate(() => {
    [...document.querySelectorAll("button")].find((b) => /log\s*in/i.test(b.textContent))?.click();
  });
  await page.waitForFunction(() => !location.pathname.includes("/login"), { timeout: 20000 });
  await sleep(2000);
}

// Click the smallest element whose own text matches `pattern` (string => case-insensitive substring).
export async function clickText(page, pattern) {
  const ok = await page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const els = [...document.querySelectorAll("a, button, [role=button], [role=tab], [role=option], li, div, span, label")]
      .filter((e) => re.test((e.innerText ?? "").trim()) && e.offsetParent !== null || re.test((e.innerText ?? "").trim()));
    // prefer the deepest (smallest) match
    els.sort((a, b) => (a.innerText ?? "").length - (b.innerText ?? "").length);
    const target = els[0];
    if (!target) return false;
    target.scrollIntoView?.();
    target.click();
    return true;
  }, pattern);
  if (!ok) throw new Error(`nothing to click matching /${pattern}/`);
  await sleep(2500);
}

export async function snapshot(page, name) {
  const info = await page.evaluate(() => ({
    url: location.href,
    text: document.body.innerText,
    controls: [...document.querySelectorAll("a, button, [role=button], [role=tab], select, input")]
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        text: (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().slice(0, 80),
        href: e.getAttribute("href") || undefined,
        type: e.getAttribute("type") || undefined,
      }))
      .filter((c) => c.text || c.href),
  }));
  writeFileSync(`out/${name}.json`, JSON.stringify(info, null, 2));
  writeFileSync(`out/${name}.html`, await page.content());
  return info;
}
