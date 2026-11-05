import { login } from "./flexi.mjs";
const { api } = await login();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
for (const [label, body] of [["default", { pageIndex: 1, pageSize: 5, fromDate: null, toDate: null }], ["range today..+10", { pageIndex: 1, pageSize: 20, fromDate: day(0), toDate: day(10) }]]) {
  const r = await api("POST", "/api/v1.0/orders/order-history", body);
  console.log(`\n## ${label}: ${r.status} keys=${Object.keys(r.json)} orderCount=${r.json.orderCount}`);
  for (const k of Object.keys(r.json).filter((k) => Array.isArray(r.json[k])))
    for (const d of r.json[k]) for (const o of d.orders) console.log(`  [${k}] ${d.dueDate.slice(0,10)} ${o.supplierServiceName}: ${o.orderItems.map((i) => i.itemDisplayName).join(", ")} $${o.orderTotal} state=${o.orderState} key=${o.orderKey.value.slice(0,8)}`);
}
