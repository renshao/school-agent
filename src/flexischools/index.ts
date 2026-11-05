import { join } from "node:path";
import { FileTokenStore, FlexiAuth } from "./auth.ts";
import { FlexiClient } from "./client.ts";
import { FlexiHttp } from "./http.ts";

export { FlexiAuth, FileTokenStore, MemoryTokenStore } from "./auth.ts";
export { FlexiClient } from "./client.ts";
export { FlexiHttp } from "./http.ts";
export { FlexiError } from "./errors.ts";
export { checkOrders } from "./check.ts";
export { resolveDate, ymdInZone, addDays } from "./dates.ts";
export type * from "./types.ts";
export type { CheckRow, CheckStatus } from "./check.ts";

/** Builds a client from FLEXISCHOOL_USERNAME / FLEXISCHOOL_PASSWORD, caching tokens in `.state/` (0600). */
export function createFlexiClient(env: NodeJS.ProcessEnv = process.env, stateDir: string = join(process.cwd(), ".state")): FlexiClient {
  const auth = new FlexiAuth({
    username: env.FLEXISCHOOL_USERNAME,
    password: env.FLEXISCHOOL_PASSWORD,
    store: new FileTokenStore(join(stateDir, "flexischools-tokens.json")),
  });
  return new FlexiClient(new FlexiHttp(auth));
}
