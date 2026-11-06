// Read-only probe of the account-history GraphQL (findTransactions). Raw output goes to spike/out/ (gitignored).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FileTokenStore, FlexiAuth, FlexiHttp } from "../src/flexischools/index.ts";

const auth = new FlexiAuth({ username: process.env.FLEXISCHOOL_USERNAME, password: process.env.FLEXISCHOOL_PASSWORD, store: new FileTokenStore(join(process.cwd(), ".state", "flexischools-tokens.json")) });
const http = new FlexiHttp(auth, { baseUrl: "https://servicebff.flexischools.com.au" });
const token = await auth.getIdToken();
const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
console.log("claim names:", Object.keys(claims).join(", "));
const userKey = claims["custom:toca_user_key"];
console.log("userKey claim found:", Boolean(userKey));

const gql = (query: string, variables: object) => http.request("POST", "/api/v1.0/graphql/", { body: { query, variables } });
const acct = (await gql(`query getUserAccount($userKey: String!) { getUserAccount(userKey: $userKey) { accountKey accountState } }`, { userKey })) as any;
console.log("getUserAccount:", JSON.stringify(acct).replace(/"accountKey":"[^"]+"/, '"accountKey":"<redacted>"'));
const accountKey = acct?.data?.getUserAccount?.accountKey;
const to = new Date(), from = new Date(to.getTime() - 45 * 86400_000);
const tx = (await gql(
  `query findTransactions($accountKey: ID!, $transactionDateFrom: DateTime!, $transactionDateTo: DateTime!) { findTransactions(accountKey: $accountKey, transactionDateFrom: $transactionDateFrom, transactionDateTo: $transactionDateTo) { balance firstName lastName description debitCredit orderId transactionDate userKey } }`,
  { accountKey, transactionDateFrom: from.toISOString(), transactionDateTo: to.toISOString() },
)) as any;
writeFileSync("spike/out/transactions.json", JSON.stringify(tx, null, 2));
const rows = tx?.data?.findTransactions ?? [];
console.log("errors:", JSON.stringify(tx?.errors ?? null).slice(0, 400));
console.log("rows:", rows.length);
for (const r of rows.slice(0, 40)) console.log([r.transactionDate, r.firstName, r.debitCredit, r.balance, r.orderId ?? "-", r.description].join(" | "));
