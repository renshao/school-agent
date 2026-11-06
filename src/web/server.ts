// The HTTP side of the web chat: Google sign-in, the JSON API, a live event stream (SSE) and the static page.
// Plain node:http, no framework. Runs behind Caddy (TLS) on 127.0.0.1.
//
// Security model:
//   - Every page and API call needs a session cookie from Google sign-in by an allowlisted, verified email.
//   - Session cookies are random, HttpOnly, SameSite=Lax, Secure (__Host-) on https; only their hash is stored.
//   - State-changing requests must come from our own origin (Origin header) with a JSON body (CSRF).
//   - Approve / Reject are host actions from a signed-in human; the model has no path to them.
//   - Strict CSP: scripts and styles from our origin only; model text is rendered as text, never HTML.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { FlexiError } from "../flexischools/index.ts";
import type { WebConfig } from "./config.ts";
import { LoginError, randomToken } from "./google.ts";
import type { GoogleLogin } from "./google.ts";
import type { Household, LiveEvent } from "./household.ts";
import type { SessionUser, Store } from "./store.ts";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
const OAUTH_TTL_MS = 10 * 60_000;
const MAX_BODY = 16 * 1024;
const MAX_MESSAGE = 4000;

export interface ServerDeps {
  config: WebConfig;
  store: Store;
  household: Household;
  google?: GoogleLogin;
  /** Directory with index.html, login.html, app.js, ... */
  staticDir: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

const STATIC: Record<string, string> = {
  "app.js": "text/javascript; charset=utf-8",
  "style.css": "text/css; charset=utf-8",
  "login.js": "text/javascript; charset=utf-8",
  "icon.svg": "image/svg+xml",
  "manifest.webmanifest": "application/manifest+json",
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createHandler(deps: ServerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { config, store, household, google } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  const sidName = config.secure ? "__Host-sid" : "sid";
  const oauthName = config.secure ? "__Host-oauth" : "oauth";
  const origin = config.publicUrl.origin;

  const cookie = (name: string, value: string, maxAgeSec: number): string =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${config.secure ? "; Secure" : ""}`;

  const userOf = (req: IncomingMessage): SessionUser | undefined => {
    const token = parseCookies(req.headers.cookie)[sidName];
    return token ? store.getSession(hash(token), now()) : undefined;
  };

  const headers = (res: ServerResponse): void => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (config.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const redirect = (res: ServerResponse, location: string, setCookies: string[] = []): void => {
    res.writeHead(302, { location, "cache-control": "no-store", ...(setCookies.length ? { "set-cookie": setCookies } : {}) });
    res.end();
  };

  const page = async (res: ServerResponse, file: string): Promise<void> => {
    const html = await readFile(join(deps.staticDir, file));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
  };

  /** Same-origin JSON POSTs only (a cross-site form or fetch cannot set both). */
  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    if (req.headers.origin !== origin) throw new HttpError(403, "Cross-origin request refused");
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "Expected application/json");
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "Request too large");
      chunks.push(c as Buffer);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
      return v as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "Body is not a JSON object");
    }
  };

  const startSession = (res: ServerResponse, user: SessionUser): void => {
    const token = randomToken();
    store.createSession(hash(token), user, now(), SESSION_TTL_MS);
    log(`sign-in: ${user.name}`);
    redirect(res, "/", [cookie(sidName, token, SESSION_TTL_MS / 1000), cookie(oauthName, "", 0)]);
  };

  const loginFailed = (res: ServerResponse, message: string): void => {
    log(`sign-in refused: ${message}`);
    redirect(res, `/login?error=${encodeURIComponent(message)}`, [cookie(oauthName, "", 0)]);
  };

  // ---- auth routes (no session needed) -------------------------------------------------------------------------

  const googleStart = (res: ServerResponse): void => {
    if (!google) throw new HttpError(404, "Google sign-in is not configured");
    const s = google.start();
    store.putOAuthState(s.state, s.nonce, s.verifier, now());
    redirect(res, s.url, [cookie(oauthName, s.state, OAUTH_TTL_MS / 1000)]);
  };

  const googleCallback = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (!google) throw new HttpError(404, "Google sign-in is not configured");
    const err = url.searchParams.get("error");
    if (err) return loginFailed(res, err === "access_denied" ? "Sign-in was cancelled" : `Google said: ${err}`);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    // The state must match the one this browser started with (cookie) and the one we stored (single use, 10 minutes).
    if (!state || parseCookies(req.headers.cookie)[oauthName] !== state) return loginFailed(res, "Sign-in expired or was started in another browser. Try again.");
    const pending = store.takeOAuthState(state, now(), OAUTH_TTL_MS);
    if (!pending || !code) return loginFailed(res, "Sign-in expired. Try again.");
    let identity;
    try {
      identity = await google.finish(code, pending);
    } catch (e) {
      if (e instanceof LoginError) return loginFailed(res, e.message);
      throw e;
    }
    const name = config.allowedUsers.get(identity.email);
    if (!name) return loginFailed(res, `${identity.email} is not allowed to use this app.`);
    startSession(res, { email: identity.email, name });
  };

  const devSignIn = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!config.devLogin) throw new HttpError(404, "Not found");
    if (req.headers.origin !== origin) throw new HttpError(403, "Cross-origin request refused");
    let body = "";
    for await (const c of req) body += String(c);
    const email = (new URLSearchParams(body).get("email") ?? "").trim().toLowerCase();
    const name = config.allowedUsers.get(email);
    if (!name) return loginFailed(res, `${email || "(no email)"} is not in ALLOWED_USERS.`);
    startSession(res, { email, name });
  };

  // ---- live stream -----------------------------------------------------------------------------------------------

  const stream = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (e: LiveEvent): void => {
      res.write(`${e.kind === "event" ? `id: ${e.event.seq}\n` : ""}data: ${JSON.stringify(e)}\n\n`);
    };
    res.write("retry: 3000\n\n");
    // Catch up and subscribe in one synchronous step, so no event can fall in between.
    // On reconnect the browser sends Last-Event-ID (newer than the URL's `after`, which stays as first opened).
    const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? NaN);
    if (Number.isFinite(after)) for (const event of household.since(after)) send({ kind: "event", event });
    const unsubscribe = household.subscribe(send);
    send({ kind: "status", ...household.status() });
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const close = (): void => {
      clearInterval(ping);
      unsubscribe();
    };
    req.on("close", close);
    res.on("error", close);
  };

  // ---- API (session needed) --------------------------------------------------------------------------------------

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL, user: SessionUser): Promise<void> => {
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /api/me") return json(res, 200, { email: user.email, name: user.name });

    if (route === "GET /api/history") {
      const before = url.searchParams.get("before");
      const events = household.history(before ? Number(before) : undefined);
      return json(res, 200, { events, hasMore: (events[0]?.seq ?? 1) > 1, lastSeq: store.lastSeq(), status: household.status(), thread: household.currentThread });
    }

    if (route === "GET /api/stream") return stream(req, res, url);

    if (route === "GET /api/today") {
      try {
        return json(res, 200, await household.today(url.searchParams.get("refresh") === "1"));
      } catch (e) {
        return json(res, 502, { error: `Could not reach Flexischools: ${e instanceof Error ? e.message : String(e)}` });
      }
    }

    if (route === "POST /api/messages") {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, "Message is empty");
      if (text.length > MAX_MESSAGE) throw new HttpError(413, `Message is longer than ${MAX_MESSAGE} characters`);
      const clientId = typeof body.clientId === "string" && /^[\w-]{1,64}$/.test(body.clientId) ? body.clientId : undefined;
      void household.send(user.name, text, clientId);
      return json(res, 202, { queued: true });
    }

    if (route === "GET /api/memory") return json(res, 200, household.memory());

    const forget = /^POST \/api\/memory\/([NS]\d{1,9})\/delete$/.exec(route);
    if (forget) {
      await readJson(req); // the CSRF checks
      const memory = household.forget(forget[1]!, user.name);
      if (!memory) return json(res, 404, { error: `${forget[1]} is not saved (already deleted?)` });
      log(`memory: ${forget[1]} deleted by ${user.name}`);
      return json(res, 200, { memory });
    }

    const decision = /^POST \/api\/proposals\/(P\d{1,9})\/(approve|reject)$/.exec(route);
    if (decision) {
      await readJson(req); // the CSRF checks
      const [, id, action] = decision as unknown as [string, string, "approve" | "reject"];
      try {
        const proposal = action === "approve" ? await household.approve(id, user.name) : household.reject(id, user.name);
        log(`${action}: ${id} by ${user.name} -> ${proposal.status}`);
        return json(res, 200, { proposal });
      } catch (e) {
        if (e instanceof FlexiError) return json(res, e.kind === "not_found" ? 404 : 409, { error: e.message });
        throw e;
      }
    }

    throw new HttpError(404, "Not found");
  };

  return async (req, res) => {
    headers(res);
    const url = new URL(req.url ?? "/", origin);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /healthz") {
        res.writeHead(200, { "content-type": "text/plain" });
        return void res.end("ok");
      }
      const staticName = /^GET \/static\/([\w.-]+)$/.exec(route)?.[1];
      if (staticName) {
        const type = STATIC[staticName];
        if (!type) throw new HttpError(404, "Not found");
        res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
        return void res.end(await readFile(join(deps.staticDir, staticName)));
      }
      if (route === "GET /auth/google") return googleStart(res);
      if (route === "GET /auth/google/callback") return await googleCallback(req, res, url);
      if (route === "POST /auth/dev") return await devSignIn(req, res);
      if (route === "GET /auth/options") return json(res, 200, { google: Boolean(google), dev: config.devLogin ? [...config.allowedUsers.keys()] : [] });

      const user = userOf(req);
      if (route === "GET /login") return user ? redirect(res, "/") : await page(res, "login.html");
      if (route === "POST /auth/logout") {
        await readJson(req);
        const token = parseCookies(req.headers.cookie)[sidName];
        if (token) store.deleteSession(hash(token));
        res.writeHead(204, { "set-cookie": cookie(sidName, "", 0) });
        return void res.end();
      }
      if (!user) {
        if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "Not signed in" });
        return redirect(res, "/login");
      }
      if (route === "GET /") return await page(res, "index.html");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url, user);
      throw new HttpError(404, "Not found");
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      log(`error: ${route}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return json(res, 500, { error: "Internal error" });
    }
  };
}
