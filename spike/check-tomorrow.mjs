import { login } from "./flexi.mjs";
const { api } = await login();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const r = await api("POST", "/api/v1.0/orders/order-history", { pageIndex: 1, pageSize: 20, fromDate: day(0), toDate: day(10) });
console.log("orders in next 10 days (server):", r.json.orderCount);
for (const k of ["presentOrders", "pastOrders"]) for (const d of r.json[k] ?? []) for (const o of d.orders) console.log(`  [${k}] ${d.dueDate.slice(0,10)} ${o.supplierServiceName}: ${o.orderItems.map(i=>i.itemDisplayName).join(", ")} ${o.orderState}`);
