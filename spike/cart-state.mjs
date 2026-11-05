import { launch, login, clickText, sleep } from "./lib.mjs";
const { page, net, close } = await launch();
try {
  await login(page);
  for (const s of ["Order food", "Alice[\\s\\S]*ExampleSchool", "Junior Recess", "Tomorrow, Fri", "Bacon, Tomato"]) await clickText(page, s);
  const how = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /^Add Item/.test(x.innerText.trim()));
    const f = b?.form ?? b?.closest("form");
    if (!f) return "no form";
    f.requestSubmit ? f.requestSubmit(b) : f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return "requestSubmit";
  });
  console.log("submit via:", how);
  await sleep(3000);
  const v = JSON.parse(JSON.parse(await page.evaluate(() => localStorage.getItem("USER_CART_MULTI")))["\u0000"]);
  const o = v.state.cartData.orders[0];
  console.log("orderItems:", JSON.stringify(o.orderItems).slice(0, 700), "| ordersCount:", v.state.ordersCount, "| totals:", JSON.stringify(v.state.orderPrices.combinedOrderTotals));
  console.log("page has cart bar text?", await page.evaluate(() => /view order|checkout|1 item/i.test(document.body.innerText)));
  console.log("calls:", net.filter((n) => !/nr-data|google|itemlist/.test(n.url)).slice(-4).map((n) => `${n.method} ${n.url.split(".com.au")[1]?.slice(0, 90)}`));
} catch (e) { console.error("FAILED:", e.message); } finally { await close(); }
