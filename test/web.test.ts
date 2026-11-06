// The web chat: SQLite persistence and restore, Google sign-in, sessions, CSRF, approvals over HTTP and the live
// stream. Fake Flexischools, fake Messages API, fake Google token endpoint: no network.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadWebConfig, parseAllowedUsers } from "../src/web/config.ts";
import type { WebConfig } from "../src/web/config.ts";
import { GoogleLogin, LoginError } from "../src/web/google.ts";
import { Household } from "../src/web/household.ts";
import type { LiveEvent } from "../src/web/household.ts";
import { createHandler } from "../src/web/server.ts";
import { Store } from "../src/web/store.ts";
import { fakeFlexi, isPlaceOrder } from "./flexi-fake.ts";
import { fakeModel, text, toolUse } from "./model-fake.ts";
import type { Step } from "./model-fake.ts";

const NOW = new Date("2026-11-05T20:00:00Z"); // Fri 6 Nov 07:00 Sydney
const planCall = toolUse("tu_1", "plan_order", { student: "Alice", service: "lunch", date: "2026-11-06", items: [{ item: "Up & Go", choices: [{ option: "Chocolate" }] }] });
const proposeTurn: Step[] = [
  { content: [{ type: "thinking", thinking: "plan it", signature: "sig" }, text("Let me price that."), planCall], stop_reason: "tool_use" },
  { content: [text("Proposed P1: $4.19. Press Approve.")], stop_reason: "end_turn" },
];

function household(script: Step[], opts: { store?: Store; now?: () => Date } = {}) {
  const flexi = fakeFlexi();
  const model = fakeModel(script);
  const store = opts.store ?? new Store(":memory:");
  const h = new Household({ store, client: flexi.client, anthropic: model.anthropic, now: opts.now ?? (() => NOW) });
  return { ...flexi, ...model, store, household: h };
}

describe("Household: shared conversation persisted in SQLite", () => {
  it("records every event, and the page view leaks no thinking, tool inputs or raw payloads", async () => {
    const { household: h } = household([...proposeTurn]);
    const live: LiveEvent[] = [];
    h.subscribe((e) => live.push(e));
    await h.send("Eva", "chocolate up & go for Alice tomorrow", "c-1");

    const views = h.history();
    assert.deepEqual(views.map((v) => v.kind), ["user", "assistant", "proposal", "assistant"]);
    assert.deepEqual(views[0], { seq: 1, ts: NOW.toISOString(), thread: "2026-11-06", kind: "user", author: "Eva", text: "chocolate up & go for Alice tomorrow", clientId: "c-1" });
    const reply = views[1]!;
    assert.deepEqual(reply.kind === "assistant" && [reply.text, reply.steps, reply.final], ["Let me price that.", ["priced an order"], false]);
    const page = JSON.stringify(views);
    assert.doesNotMatch(page, /plan it|"sig"|tu_1|"input"|itemKey|\[host event\]|\[Fri/, "views carry display text only");
    assert.ok(live.some((e) => e.kind === "status" && e.answering === "Eva"), "browsers see who is being answered");
    assert.ok(live.some((e) => e.kind === "event" && e.event.kind === "proposal"));
  });

  it("after a restart the model's history is rebuilt verbatim, old proposals are expired, ids continue, and undelivered outcomes reach the model", async () => {
    const store = new Store(":memory:");
    const first = household([...proposeTurn], { store });
    await first.household.send("Ren", "chocolate up & go for Alice tomorrow");
    const p1 = await first.household.approve("P1", "Ren");
    assert.equal(p1.status, "done");
    const before = structuredClone(first.household.historyForModel);

    const second = household(
      [
        { content: [planCall], stop_reason: "tool_use" },
        { content: [text("Proposed again.")], stop_reason: "end_turn" },
      ],
      { store },
    );
    assert.deepEqual(second.household.historyForModel, before, "same messages, thinking blocks included");
    await second.household.send("Eva", "and another one");
    const sent = second.requests[0]!.body.messages;
    assert.equal(sent.length, before.length + 1);
    assert.match(sent.at(-1).content[0].text, /^\[host event\] Ren approved proposal P1 .*Result: done/, "the approval outcome is delivered once, after the restart");
    assert.equal(second.household.desk.get("P2")?.status, "pending", "ids continue after the log's last proposal");

    // A proposal still pending at restart cannot be approved afterwards, and shows as expired.
    const third = household([], { store });
    await assert.rejects(third.household.approve("P2", "Ren"), /No proposal P2/);
    const p2 = third.household.history().find((v) => v.kind === "proposal" && v.proposal.id === "P2");
    assert.equal(p2?.kind === "proposal" && p2.proposal.status, "expired");
    assert.equal(third.writes().length, 0);
  });

  it("starts a fresh model context each school day, carrying undelivered outcomes over", async () => {
    let now = NOW;
    const store = new Store(":memory:");
    const { household: h, requests } = household([...proposeTurn, { content: [text("Morning!")], stop_reason: "end_turn" }], { store, now: () => now });
    await h.send("Ren", "order it");
    h.reject("P1", "Ren");
    now = new Date(NOW.getTime() + 24 * 3600_000);
    await h.send("Ren", "good morning");
    const msgs = requests[2]!.body.messages;
    assert.equal(msgs.length, 1, "yesterday's messages are not sent");
    assert.match(msgs[0].content[0].text, /^\[host event\] Ren rejected proposal P1/);
    assert.equal(h.currentThread, "2026-11-07");
    assert.deepEqual([...new Set(h.history().map((v) => v.thread))], ["2026-11-06", "2026-11-07"], "the page still shows both days");
  });

  it("a failed turn is recorded as a plain-words error and the next message still works", async () => {
    const { household: h } = household([{ content: [text("ok")], stop_reason: "end_turn" }]);
    // No scripted reply for the first message: the fake model throws (like a network failure).
    const { household: broken } = household([]);
    await broken.send("Ren", "hello");
    const err = broken.history().at(-1)!;
    assert.equal(err.kind, "error");
    assert.equal(broken.history().filter((v) => v.kind === "error").length, 1, "one error, in plain words");
    await h.send("Ren", "hello");
    assert.equal(h.history().at(-1)!.kind, "assistant");
  });
});

// ---------------------------------------------------------------- Google sign-in

const CLIENT_ID = "cid.apps.googleusercontent.com";
const jwt = (claims: Record<string, unknown>): string => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function fakeGoogle(claims: (form: URLSearchParams) => Record<string, unknown>, status = 200) {
  const forms: URLSearchParams[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    const body = status === 200 ? { id_token: jwt(claims(form)), access_token: "at" } : { error: "invalid_grant" };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, forms };
}

const goodClaims = (nonce: string) => ({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "123", email: "Eva@Example.com", email_verified: true, nonce, exp: NOW.getTime() / 1000 + 600 });

describe("GoogleLogin", () => {
  const login = (claims: Record<string, unknown>) =>
    new GoogleLogin({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: "https://school.example.com/auth/google/callback", now: () => NOW, fetch: fakeGoogle(() => claims).fetch });

  it("builds a PKCE + nonce authorization URL", () => {
    const s = login({}).start();
    const u = new URL(s.url);
    assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("state"), s.state);
    assert.equal(u.searchParams.get("nonce"), s.nonce);
    assert.notEqual(u.searchParams.get("code_challenge"), s.verifier, "the verifier itself never leaves the server");
  });

  it("accepts a valid token and lowercases the email", async () => {
    assert.deepEqual(await login(goodClaims("n1")).finish("code", { nonce: "n1", verifier: "v" }), { sub: "123", email: "eva@example.com" });
  });

  for (const [what, claims] of [
    ["wrong audience", { ...goodClaims("n1"), aud: "someone-else" }],
    ["wrong issuer", { ...goodClaims("n1"), iss: "https://evil.example" }],
    ["expired", { ...goodClaims("n1"), exp: NOW.getTime() / 1000 - 1 }],
    ["wrong nonce", goodClaims("other")],
    ["unverified email", { ...goodClaims("n1"), email_verified: false }],
  ] as const) {
    it(`refuses a token with ${what}`, async () => {
      await assert.rejects(login(claims).finish("code", { nonce: "n1", verifier: "v" }), LoginError);
    });
  }
});

// ---------------------------------------------------------------- the HTTP server

interface TestServer {
  base: string;
  store: Store;
  household: Household;
  writes: () => unknown[];
  calls: ReturnType<typeof fakeFlexi>["calls"];
  google: ReturnType<typeof fakeGoogle>;
  close: () => Promise<void>;
}

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function startServer(script: Step[] = [], env: Record<string, string> = {}): Promise<TestServer> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: WebConfig = loadWebConfig({ PUBLIC_URL: base, ALLOWED_USERS: "ren@example.com=Ren,eva@example.com=Eva", GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "secret", ...env }, "/tmp");
  const store = new Store(":memory:");
  const flexi = fakeFlexi();
  const model = fakeModel(script);
  const household = new Household({ store, client: flexi.client, anthropic: model.anthropic, now: () => NOW });
  const google = fakeGoogle((form) => goodClaims(nonces.get(form.get("code") ?? "") ?? "?"));
  const nonces = new Map<string, string>();
  const login = new GoogleLogin({ clientId: CLIENT_ID, clientSecret: "secret", redirectUri: `${base}/auth/google/callback`, now: () => NOW, fetch: google.fetch });
  // The fake token endpoint returns whatever email the test registered for a code (default eva).
  const realFinish = login.finish.bind(login);
  login.finish = (code, expected) => {
    nonces.set(code, expected.nonce);
    return realFinish(code, expected);
  };
  server.on("request", createHandler({ config, store, household, google: login, staticDir: join(import.meta.dirname, "..", "web"), now: () => NOW, log: () => {} }));
  return { base, store, household, writes: flexi.writes, calls: flexi.calls, google, close: () => new Promise((r) => server.close(() => r())) };
}

const cookieOf = (res: Response, name: string): string | undefined => {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return decodeURIComponent(c.slice(name.length + 1).split(";")[0]!);
  return undefined;
};

/** Runs the whole Google sign-in against the server and returns the session cookie header. */
async function signIn(t: TestServer, code = "code-eva"): Promise<string> {
  const start = await fetch(`${t.base}/auth/google`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = await fetch(`${t.base}/auth/google/callback?code=${code}&state=${state}`, { redirect: "manual", headers: { cookie: `oauth=${cookieOf(start, "oauth")}` } });
  assert.equal(cb.headers.get("location"), "/", `sign-in failed: ${cb.headers.get("location")}`);
  return `sid=${cookieOf(cb, "sid")}`;
}

const post = (t: TestServer, path: string, cookie: string, body: unknown = {}, origin = t.base) =>
  fetch(`${t.base}${path}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("web server", () => {
  it("everything needs a session: the page redirects to sign-in, the API says 401", async () => {
    const t = await startServer();
    const page = await fetch(`${t.base}/`, { redirect: "manual" });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get("location"), "/login");
    assert.equal((await fetch(`${t.base}/api/history`)).status, 401);
    assert.equal((await fetch(`${t.base}/api/me`, { headers: { cookie: "sid=forged" } })).status, 401);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(`${t.base}/login`)).status, 200);
  });

  it("Google sign-in creates a session for an allowlisted email; the token request carries the PKCE verifier", async () => {
    const t = await startServer();
    const cookie = await signIn(t);
    const me = await fetch(`${t.base}/api/me`, { headers: { cookie } });
    assert.deepEqual(await me.json(), { email: "eva@example.com", name: "Eva" });
    assert.ok(t.google.forms[0]!.get("code_verifier")!.length >= 43);
    const out = await post(t, "/auth/logout", cookie);
    assert.equal(out.status, 204);
    assert.equal((await fetch(`${t.base}/api/me`, { headers: { cookie } })).status, 401, "signed out sessions are gone");
  });

  it("refuses an email that is not on the allowlist", async () => {
    const t = await startServer([], { ALLOWED_USERS: "ren@example.com=Ren" });
    const start = await fetch(`${t.base}/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = await fetch(`${t.base}/auth/google/callback?code=x&state=${state}`, { redirect: "manual", headers: { cookie: `oauth=${cookieOf(start, "oauth")}` } });
    assert.match(decodeURIComponent(cb.headers.get("location")!), /^\/login\?error=eva@example.com is not allowed/);
    assert.equal(cookieOf(cb, "sid"), undefined);
  });

  it("refuses a callback whose state does not match this browser, and a state used twice", async () => {
    const t = await startServer();
    const start = await fetch(`${t.base}/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const noCookie = await fetch(`${t.base}/auth/google/callback?code=x&state=${state}`, { redirect: "manual" });
    assert.match(noCookie.headers.get("location")!, /^\/login\?error=/);
    const ok = await fetch(`${t.base}/auth/google/callback?code=x&state=${state}`, { redirect: "manual", headers: { cookie: `oauth=${state}` } });
    assert.equal(ok.headers.get("location"), "/");
    const replay = await fetch(`${t.base}/auth/google/callback?code=x&state=${state}`, { redirect: "manual", headers: { cookie: `oauth=${state}` } });
    assert.match(decodeURIComponent(replay.headers.get("location")!), /^\/login\?error=Sign-in expired/);
    assert.equal(t.google.forms.length, 1, "Google was asked once");
  });

  it("state-changing requests must come from our origin with a JSON body (CSRF)", async () => {
    const t = await startServer([...proposeTurn]);
    const cookie = await signIn(t);
    assert.equal((await post(t, "/api/messages", cookie, { text: "hi" }, "https://evil.example")).status, 403);
    const form = await fetch(`${t.base}/api/messages`, { method: "POST", headers: { cookie, origin: t.base, "content-type": "application/x-www-form-urlencoded" }, body: "text=hi" });
    assert.equal(form.status, 415);
    assert.equal((await post(t, "/api/proposals/P1/approve", cookie, {}, "https://evil.example")).status, 403);
    assert.equal(t.store.lastSeq(), 0, "nothing was sent to the assistant");
  });

  it("a message runs a turn; Approve places the order once, attributed to the signed-in parent", async () => {
    const t = await startServer([...proposeTurn]);
    const cookie = await signIn(t);
    assert.equal((await post(t, "/api/messages", cookie, { text: "chocolate up & go for Alice tomorrow", clientId: "abc" })).status, 202);
    await t.household.idle();
    const history = (await (await fetch(`${t.base}/api/history`, { headers: { cookie } })).json()) as { events: { kind: string; author?: string }[] };
    assert.deepEqual(history.events.map((e) => e.kind), ["user", "assistant", "proposal", "assistant"]);
    assert.equal(history.events[0]!.author, "Eva", "the author comes from the session, not the request");
    assert.equal(t.writes().length, 0, "nothing is placed before approval");

    const [a, b] = await Promise.all([post(t, "/api/proposals/P1/approve", cookie), post(t, "/api/proposals/P1/approve", cookie)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(t.calls.filter(isPlaceOrder).length, 1);
    const done = ((await (a.status === 200 ? a : b).json()) as { proposal: { status: string; decidedBy: string } }).proposal;
    assert.deepEqual([done.status, done.decidedBy], ["done", "Eva"]);
    assert.equal((await post(t, "/api/proposals/P9/approve", cookie)).status, 404);
  });

  it("the live stream catches a reconnecting browser up from Last-Event-ID, then streams new events", async () => {
    const t = await startServer([{ content: [text("hello")], stop_reason: "end_turn" }, { content: [text("again")], stop_reason: "end_turn" }]);
    const cookie = await signIn(t);
    await post(t, "/api/messages", cookie, { text: "one" });
    await t.household.idle(); // seq 1 user, 2 assistant, 3 usage (not shown)

    const ac = new AbortController();
    const res = await fetch(`${t.base}/api/stream?after=0`, { headers: { cookie, "last-event-id": "1" }, signal: ac.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = res.body!.getReader();
    let buf = "";
    const until = async (re: RegExp) => {
      while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value);
    };
    await until(/"kind":"status"/);
    assert.doesNotMatch(buf, /"text":"one"/, "events up to Last-Event-ID are not resent");
    assert.match(buf, /id: 2\ndata: .*"text":"hello"/);
    await post(t, "/api/messages", cookie, { text: "two" });
    await until(/"text":"again"/);
    ac.abort();
  });

  it("deleting a remembered item needs our origin, names who did it, and 404s when already gone", async () => {
    const t = await startServer();
    const cookie = await signIn(t);
    const n = t.store.addNote({ studentName: "Alice", text: "no tomato" }, "Ren", NOW);
    assert.equal((await post(t, `/api/memory/N${n.id}/delete`, cookie, {}, "https://evil.example")).status, 403);
    assert.equal(t.store.activeNotes().length, 1);
    const ok = await post(t, `/api/memory/N${n.id}/delete`, cookie);
    assert.equal(ok.status, 200);
    assert.deepEqual(((await ok.json()) as { memory: { notes: unknown[] } }).memory.notes, []);
    assert.equal((await post(t, `/api/memory/N${n.id}/delete`, cookie)).status, 404);
    const mem = await (await fetch(`${t.base}/api/memory`, { headers: { cookie } })).json();
    assert.deepEqual(mem, { skips: [], notes: [] });
    const logged = t.household.history().at(-1)!;
    assert.deepEqual(logged.kind === "memory" && [logged.change.action, logged.change.by], ["note_removed", "Eva"]);
  });

  it("validates messages", async () => {
    const t = await startServer();
    const cookie = await signIn(t);
    assert.equal((await post(t, "/api/messages", cookie, { text: "   " })).status, 400);
    assert.equal((await post(t, "/api/messages", cookie, { text: "x".repeat(5000) })).status, 413);
    assert.equal((await post(t, "/api/messages", cookie, { text: "x".repeat(20_000) })).status, 413);
  });

  it("serves only the known static files", async () => {
    const t = await startServer();
    assert.equal((await fetch(`${t.base}/static/app.js`)).status, 200);
    const traversal = await fetch(`${t.base}/static/..%2F.env`, { redirect: "manual" });
    assert.notEqual(traversal.status, 200);
    assert.equal((await fetch(`${t.base}/static/index.html`)).status, 404);
  });
});

describe("web config", () => {
  const base = { ALLOWED_USERS: "ren@example.com=Ren", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" };
  it("parses the allowlist", () => {
    assert.deepEqual([...parseAllowedUsers(" Ren@Example.com = Ren , eva@example.com")], [["ren@example.com", "Ren"], ["eva@example.com", "eva"]]);
    assert.throws(() => parseAllowedUsers("not-an-email=X"), /not an email/);
  });
  it("refuses unsafe settings", () => {
    assert.throws(() => loadWebConfig({ ...base, PUBLIC_URL: "http://school.example.com" }), /must be https/);
    assert.throws(() => loadWebConfig({ ...base, PUBLIC_URL: "https://school.example.com", DEV_LOGIN: "1" }), /only allowed when PUBLIC_URL is localhost/);
    assert.throws(() => loadWebConfig({ PUBLIC_URL: "https://school.example.com", GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" }), /ALLOWED_USERS is empty/);
    assert.throws(() => loadWebConfig({ ALLOWED_USERS: "a@b.co", PUBLIC_URL: "https://school.example.com" }), /GOOGLE_CLIENT_ID/);
    const ok = loadWebConfig({ ...base, PUBLIC_URL: "https://school.example.com" });
    assert.equal(ok.secure, true);
    assert.equal(ok.host, "127.0.0.1");
  });
});
