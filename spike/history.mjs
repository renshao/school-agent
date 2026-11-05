// Read-only: how do past / future ranges behave on order-history?
import { login } from "./flexi.mjs";
const { api } = await login();
const day = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); };
const show = (label, r) => {
  const j = r.json;
  console.log(`\n## ${label}: ${r.status}  keys=${j && Object.keys(j)}  orderCount=${j?.orderCount} hasMore=${j?.hasMoreOrders}`);
  for (const k of Object.keys(j ?? {}).filter((k) => Array.isArray(j[k])))
    for (const d of j[k]) for (const o of d.orders ?? []) console.log(`  [${k}] ${d.dueDate?.slice(0, 10)} ${o.studentName} ${o.supplierServiceName}: ${o.orderItems.map((i) => i.itemDisplayName).join(" + ")} $${o.orderTotal} ${o.orderState}`);
};
show("default", await api("POST", "/api/v1.0/orders/order-history", { pageIndex: 1, pageSize: 10, fromDate: null, toDate: null }));
show("yesterday only", await api("POST", "/api/v1.0/orders/order-history", { pageIndex: 1, pageSize: 10, fromDate: day(-1), toDate: day(-1) }));
show("next 8 days", await api("POST", "/api/v1.0/orders/order-history", { pageIndex: 1, pageSize: 20, fromDate: day(0), toDate: day(8) }));
show("last 7 days", await api("POST", "/api/v1.0/orders/order-history", { pageIndex: 1, pageSize: 20, fromDate: day(-7), toDate: day(0) }));
// Other endpoints seen earlier that might list upcoming/placeable orders (GET, read-only):
const s = "student-key-2";
const lp = await api("GET", `/api/v2.0/students/${s}/orders/last-placeable-order`);
console.log(`\n## last-placeable-order: ${lp.status}`, JSON.stringify(lp.json).slice(0, 500));
