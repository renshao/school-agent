// Spike: no browser. Cognito login over HTTP, then READ-ONLY calls with the token.
// Prints summaries only; never prints tokens or the password.
const { FLEXISCHOOL_USERNAME: user, FLEXISCHOOL_PASSWORD: pass } = process.env;
if (!user || !pass) throw new Error("Missing credentials in ../.env");

// Public app-client id (visible in the site's own cookie names / JS bundle); not a secret.
const COGNITO_CLIENT_ID = "1g1a80gfo3ovuq75c8fqjrg3ma";
const COGNITO_URL = "https://cognito-idp.ap-southeast-2.amazonaws.com/";
const ORDERING = "https://bffordering.flexischools.com.au";
const APP_HEADERS = { "x-channel": "USERPORTAL", "x-brandid": "8", "content-type": "application/json" };

async function cognito(target, body) {
  const res = await fetch(COGNITO_URL, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
    body: JSON.stringify({ ClientId: COGNITO_CLIENT_ID, ...body }),
  });
  return { status: res.status, json: await res.json() };
}

const t0 = Date.now();
const init = await cognito("InitiateAuth", {
  AuthFlow: "USER_PASSWORD_AUTH",
  AuthParameters: { USERNAME: user, PASSWORD: pass },
});
console.log(`InitiateAuth -> ${init.status} in ${Date.now() - t0}ms`);
if (init.status !== 200 || !init.json.AuthenticationResult) {
  console.log("no tokens. keys:", Object.keys(init.json), "challenge/error:", init.json.ChallengeName ?? init.json.__type ?? init.json.message);
  process.exit(1);
}
const { IdToken, AccessToken, RefreshToken, ExpiresIn } = init.json.AuthenticationResult;
console.log(`tokens: id=${!!IdToken} access=${!!AccessToken} refresh=${!!RefreshToken} expiresIn=${ExpiresIn}s`);

// Which token does the BFF accept, and in what header format?
const body = JSON.stringify({ pageIndex: 1, pageSize: 10, fromDate: null, toDate: null });
let auth;
for (const [label, value] of [["idToken", IdToken], ["accessToken", AccessToken], ["Bearer idToken", `Bearer ${IdToken}`], ["Bearer accessToken", `Bearer ${AccessToken}`]]) {
  const r = await fetch(`${ORDERING}/api/v1.0/orders/order-history`, { method: "POST", headers: { ...APP_HEADERS, authorization: value }, body });
  console.log(`order-history with ${label}: ${r.status}`);
  if (r.ok) { auth = { label, value, data: await r.json() }; break; }
}
if (!auth) process.exit(1);

console.log(`\nauthorization format that works: ${auth.label}`);
console.log(`orderCount=${auth.data.orderCount}, present days=${auth.data.presentOrders.length}`);
for (const day of auth.data.presentOrders)
  for (const o of day.orders)
    console.log(`  TODAY ${o.studentName} ${o.supplierServiceName}: ${o.orderItems.map((i) => i.itemDisplayName).join(", ")} $${o.orderTotal} [${o.orderState}]`);

// Order days + cutoff status for the first student/service seen in history.
const sample = auth.data.pastOrders[0].orders[0];
const dates = await fetch(
  `${ORDERING}/api/v1.0/students/${sample.studentKey.value}/supplierservices/${sample.supplierServiceKey}/next-order-fulfillment-dates?startDate=&includeUnavailableDates=true`,
  { method: "POST", headers: { ...APP_HEADERS, authorization: auth.value } },
);
console.log(`\nnext-order-fulfillment-dates: ${dates.status}`);
if (dates.ok) for (const d of (await dates.json()).slice(0, 5)) console.log(`  ${d.fulfillmentDate} cutoffPassed=${d.hasCutOffTimePassed} closure=${d.closureReason}`);

// Refresh flow: can we stay logged in without the password?
const t1 = Date.now();
const ref = await cognito("InitiateAuth", { AuthFlow: "REFRESH_TOKEN_AUTH", AuthParameters: { REFRESH_TOKEN: RefreshToken } });
console.log(`\nREFRESH_TOKEN_AUTH -> ${ref.status} in ${Date.now() - t1}ms, new tokens=${!!ref.json.AuthenticationResult}`);
