// The web chat server. Usage: npm run web   (settings in .env; see .env.example and DEPLOY.md)
import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { join } from "node:path";
import { configFromEnv } from "./agent/agent.ts";
import { createFlexiClient } from "./flexischools/index.ts";
import { loadWebConfig } from "./web/config.ts";
import { GoogleLogin } from "./web/google.ts";
import { Household } from "./web/household.ts";
import { createHandler } from "./web/server.ts";
import { Store } from "./web/store.ts";

const log = (m: string): void => console.log(`${new Date().toISOString()} ${m}`);

function main(): void {
  const config = loadWebConfig();
  const store = new Store(config.dbPath);
  const household = new Household({
    store,
    client: createFlexiClient(),
    anthropic: new Anthropic(),
    config: configFromEnv(),
    ...(process.env.TODAY_SERVICES ? { todayServices: new RegExp(process.env.TODAY_SERVICES, "i") } : {}),
  });
  const google = config.google ? new GoogleLogin({ ...config.google, redirectUri: new URL("/auth/google/callback", config.publicUrl).toString() }) : undefined;
  const server = createServer(createHandler({ config, store, household, ...(google ? { google } : {}), staticDir: join(import.meta.dirname, "..", "web"), log }));

  const prune = setInterval(() => store.pruneSessions(new Date()), 3600_000);
  prune.unref();

  server.listen(config.port, config.host, () => {
    log(`school-agent web on http://${config.host}:${config.port} (public ${config.publicUrl.origin}); users: ${[...config.allowedUsers.values()].join(", ")}${config.devLogin ? "; DEV LOGIN ON" : ""}`);
  });

  const shutdown = (): void => {
    log("shutting down");
    server.close();
    server.closeAllConnections(); // open event streams; browsers reconnect and catch up
    void household.idle().finally(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
