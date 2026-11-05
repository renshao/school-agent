// Trace which requests the login performs (URLs + whether the body contains the credentials; never prints bodies).
import { launch, login, log } from "./lib.mjs";
const { page, close } = await launch();
const user = process.env.FLEXISCHOOL_USERNAME, pass = process.env.FLEXISCHOOL_PASSWORD;
const rows = [];
page.on("request", (r) => {
  const u = r.url();
  if (/google|newrelic|nr-data|launchdarkly|\.(js|css|png|svg|woff2?)(\?|$)/.test(u)) return;
  const b = r.postData() ?? "";
  rows.push(`${r.method()} ${u.slice(0, 150)}${b.includes(user) ? "  [BODY HAS USERNAME]" : ""}${b.includes(pass) ? "  [BODY HAS PASSWORD]" : ""}${r.headers().authorization ? "  [authorization hdr]" : ""}`);
});
try { await login(page); } catch (e) { console.error(e.message); }
console.log(rows.join("\n"));
console.log("\ncookies:", (await page.cookies()).map((c) => `${c.name}@${c.domain}`).join(", "));
console.log("localStorage keys:", await page.evaluate(() => Object.keys(localStorage).join(", ")));
console.log("sessionStorage keys:", await page.evaluate(() => Object.keys(sessionStorage).join(", ")));
await close();
