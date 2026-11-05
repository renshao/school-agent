import { login } from "./flexi.mjs";
const { api } = await login();
const r = await api("GET", "/api/v1.0/orders/order-key-4");
const j = r.json;
console.log("\nGET order detail:", r.status, "keys:", Object.keys(j).join(","));
console.log("stateHistory:", JSON.stringify(j.stateHistory));
console.log("total fields:", JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => /total|fee|gst|state|cancel|refund|payment/i.test(k)))));
