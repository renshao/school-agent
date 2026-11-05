import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FlexiAuth, jwtExp, MemoryTokenStore } from "../src/flexischools/auth.ts";
import { FlexiError } from "../src/flexischools/errors.ts";
import { cognitoTarget, fakeFetch, fakeJwt, json } from "./helpers.ts";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const nowSec = NOW / 1000;
const PASSWORD = "hunter2-secret";

function cognitoOk(idToken: string, refreshToken?: string) {
  return json({ AuthenticationResult: { IdToken: idToken, AccessToken: "acc", ...(refreshToken ? { RefreshToken: refreshToken } : {}) } });
}

describe("FlexiAuth", () => {
  it("logs in with the password flow when there is no session, and stores tokens", async () => {
    const id = fakeJwt(nowSec + 3600);
    const { fetch, calls } = fakeFetch((c) => (cognitoTarget(c) === "InitiateAuth" ? cognitoOk(id, "refresh-1") : undefined));
    const store = new MemoryTokenStore();
    const auth = new FlexiAuth({ username: "u@example.com", password: PASSWORD, store, fetch, now: () => NOW });

    assert.equal(await auth.getIdToken(), id);
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0]!.body!);
    assert.equal(sent.AuthFlow, "USER_PASSWORD_AUTH");
    assert.deepEqual(await store.load(), { idToken: id, refreshToken: "refresh-1", idTokenExp: nowSec + 3600 });
  });

  it("uses the cached token without any network call while it is fresh", async () => {
    const id = fakeJwt(nowSec + 3600);
    const { fetch, calls } = fakeFetch();
    const store = new MemoryTokenStore({ idToken: id, refreshToken: "r", idTokenExp: nowSec + 3600 });
    const auth = new FlexiAuth({ store, fetch, now: () => NOW });
    assert.equal(await auth.getIdToken(), id);
    assert.equal(calls.length, 0);
  });

  it("refreshes (not re-logs-in) when the token is near expiry, keeping the refresh token", async () => {
    const fresh = fakeJwt(nowSec + 3600, "new");
    const { fetch, calls } = fakeFetch((c) => (cognitoTarget(c) === "InitiateAuth" ? cognitoOk(fresh) : undefined));
    const store = new MemoryTokenStore({ idToken: fakeJwt(nowSec + 30), refreshToken: "r-keep", idTokenExp: nowSec + 30 });
    const auth = new FlexiAuth({ username: "u", password: PASSWORD, store, fetch, now: () => NOW });

    assert.equal(await auth.getIdToken(), fresh);
    assert.equal(JSON.parse(calls[0]!.body!).AuthFlow, "REFRESH_TOKEN_AUTH");
    assert.equal((await store.load())!.refreshToken, "r-keep");
  });

  it("falls back to the password when the refresh token is rejected", async () => {
    const id = fakeJwt(nowSec + 3600);
    const { fetch, calls } = fakeFetch((c) => {
      const body = JSON.parse(c.body ?? "{}");
      if (body.AuthFlow === "REFRESH_TOKEN_AUTH") return json({ __type: "NotAuthorizedException", message: "Refresh Token has expired" }, 400);
      if (body.AuthFlow === "USER_PASSWORD_AUTH") return cognitoOk(id, "r-new");
      return undefined;
    });
    const store = new MemoryTokenStore({ idToken: "old", refreshToken: "dead", idTokenExp: 0 });
    const auth = new FlexiAuth({ username: "u", password: PASSWORD, store, fetch, now: () => NOW });
    assert.equal(await auth.getIdToken(), id);
    assert.equal(calls.length, 2);
    assert.equal((await store.load())!.refreshToken, "r-new");
  });

  it("explains itself when there is neither a session nor credentials", async () => {
    const { fetch } = fakeFetch();
    const auth = new FlexiAuth({ store: new MemoryTokenStore(), fetch, now: () => NOW });
    await assert.rejects(auth.getIdToken(), (e: unknown) => e instanceof FlexiError && e.kind === "auth" && /FLEXISCHOOL_USERNAME/.test(e.message));
  });

  it("never leaks the password or the Cognito message into errors", async () => {
    const { fetch } = fakeFetch(() => json({ __type: "NotAuthorizedException", message: `Incorrect username or password ${PASSWORD}` }, 400));
    const auth = new FlexiAuth({ username: "u@example.com", password: PASSWORD, store: new MemoryTokenStore(), fetch, now: () => NOW });
    await assert.rejects(auth.getIdToken(), (e: unknown) => {
      const m = (e as Error).message;
      return /NotAuthorizedException/.test(m) && !m.includes(PASSWORD) && !m.includes("u@example.com");
    });
  });

  it("concurrent callers share one login", async () => {
    const id = fakeJwt(nowSec + 3600);
    const { fetch, calls } = fakeFetch(async (c) => {
      await new Promise((r) => setTimeout(r, 10));
      return cognitoTarget(c) === "InitiateAuth" ? cognitoOk(id, "r") : undefined;
    });
    const auth = new FlexiAuth({ username: "u", password: PASSWORD, store: new MemoryTokenStore(), fetch, now: () => NOW });
    const tokens = await Promise.all([auth.getIdToken(), auth.getIdToken(), auth.getIdToken()]);
    assert.deepEqual(new Set(tokens), new Set([id]));
    assert.equal(calls.length, 1);
  });

  it("jwtExp reads the exp claim", () => {
    assert.equal(jwtExp(fakeJwt(1234567890)), 1234567890);
    assert.throws(() => jwtExp("not-a-jwt"));
  });
});
