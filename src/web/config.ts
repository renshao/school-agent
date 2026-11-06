// Web server settings from the environment (.env locally; the droplet's env file in production).
import { join } from "node:path";

export interface WebConfig {
  /** The URL people open, e.g. https://school.shao.io. Cookies, CSRF checks and the OAuth redirect derive from it. */
  publicUrl: URL;
  host: string;
  port: number;
  google?: { clientId: string; clientSecret: string };
  /** Lowercased email -> display name. Only these Google accounts can sign in. */
  allowedUsers: Map<string, string>;
  dbPath: string;
  /** Sign in without Google (local development only). */
  devLogin: boolean;
  /** HTTPS: Secure / __Host- cookies and HSTS. */
  secure: boolean;
}

/** "ren@example.com=Ren, eva@example.com=Eva" -> Map. A missing name defaults to the email's local part. */
export function parseAllowedUsers(s: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const part of s.split(",")) {
    const [rawEmail, ...rest] = part.split("=");
    const email = rawEmail?.trim().toLowerCase();
    if (!email) continue;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`ALLOWED_USERS: "${email}" is not an email address`);
    const name = rest.join("=").trim() || email.split("@")[0]!;
    users.set(email, name);
  }
  return users;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): WebConfig {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT must be a port number, got "${env.PORT}"`);
  const publicUrl = new URL(env.PUBLIC_URL ?? `http://localhost:${port}`);
  if (publicUrl.pathname !== "/" || publicUrl.search) throw new Error("PUBLIC_URL must be an origin only, e.g. https://school.example.com");
  const local = LOCAL_HOSTS.has(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !local) throw new Error("PUBLIC_URL must be https:// (plain http is only allowed for localhost)");

  const allowedUsers = parseAllowedUsers(env.ALLOWED_USERS ?? "");
  if (!allowedUsers.size) throw new Error('ALLOWED_USERS is empty: set it to who may sign in, e.g. "ren@example.com=Ren,eva@example.com=Eva"');

  const devLogin = env.DEV_LOGIN === "1";
  if (devLogin && !local) throw new Error("DEV_LOGIN=1 is only allowed when PUBLIC_URL is localhost");

  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined;
  if (!google && !devLogin) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required (or DEV_LOGIN=1 on localhost)");

  return {
    publicUrl,
    host: env.HOST ?? "127.0.0.1",
    port,
    ...(google ? { google } : {}),
    allowedUsers,
    dbPath: env.SCHOOL_DB ?? join(cwd, ".state", "school.db"),
    devLogin,
    secure: publicUrl.protocol === "https:",
  };
}
