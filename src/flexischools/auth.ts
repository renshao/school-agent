// Cognito auth for Flexischools: password login once, then refresh tokens.
// Tokens are cached in a TokenStore (a 0600 file on the host). Secrets are never logged or put in error messages.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { COGNITO_CLIENT_ID, COGNITO_URL } from "./config.ts";
import { FlexiError } from "./errors.ts";

export interface StoredTokens {
  idToken: string;
  refreshToken: string;
  /** Epoch seconds at which idToken expires. */
  idTokenExp: number;
}

export interface TokenStore {
  load(): Promise<StoredTokens | null>;
  save(tokens: StoredTokens): Promise<void>;
}

export class MemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null;
  constructor(initial: StoredTokens | null = null) {
    this.tokens = initial;
  }
  async load(): Promise<StoredTokens | null> {
    return this.tokens;
  }
  async save(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }
}

export class FileTokenStore implements TokenStore {
  private path: string;
  constructor(path: string) {
    this.path = path;
  }
  async load(): Promise<StoredTokens | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as StoredTokens;
    } catch {
      return null;
    }
  }
  async save(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(tokens), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

/** Reads the `exp` claim (epoch seconds) from a JWT without verifying it (we only use it to schedule refreshes). */
export function jwtExp(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new FlexiError("auth", "Malformed token");
  const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
  if (typeof exp !== "number") throw new FlexiError("auth", "Token has no exp claim");
  return exp;
}

type FetchLike = typeof fetch;

export interface FlexiAuthOptions {
  username?: string | undefined;
  password?: string | undefined;
  store: TokenStore;
  fetch?: FetchLike;
  /** Epoch milliseconds; injectable for tests. */
  now?: () => number;
  /** Refresh when fewer than this many seconds remain. */
  skewSeconds?: number;
}

export class FlexiAuth {
  private username: string | undefined;
  private password: string | undefined;
  private store: TokenStore;
  private fetchFn: FetchLike;
  private now: () => number;
  private skew: number;
  private inflight: Promise<string> | null = null;

  constructor(opts: FlexiAuthOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.store = opts.store;
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skew = opts.skewSeconds ?? 120;
  }

  /** A valid ID token (the one the BFF wants as `Authorization: Bearer`). Concurrent callers share one refresh. */
  async getIdToken(force = false): Promise<string> {
    if (!this.inflight) {
      this.inflight = this.resolve(force).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async resolve(force: boolean): Promise<string> {
    const stored = await this.store.load();
    const nowSec = this.now() / 1000;
    if (stored && !force && stored.idTokenExp - nowSec > this.skew) return stored.idToken;

    if (stored?.refreshToken) {
      try {
        return await this.refresh(stored.refreshToken);
      } catch (e) {
        if (!(e instanceof FlexiError && e.kind === "auth")) throw e;
        // Refresh token expired/revoked: fall through to a password login if we have credentials.
      }
    }
    return this.passwordLogin();
  }

  private async cognito(target: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    const res = await this.fetchFn(COGNITO_URL, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${target}` },
      body: JSON.stringify({ ClientId: COGNITO_CLIENT_ID, ...body }),
    });
    let json: Record<string, any> = {};
    try {
      json = (await res.json()) as Record<string, any>;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      // Only the error *type* (e.g. NotAuthorizedException), never the request or message text.
      throw new FlexiError("auth", `Cognito ${target} failed: ${String(json.__type ?? res.status)}`, res.status);
    }
    return json;
  }

  private async passwordLogin(): Promise<string> {
    if (!this.username || !this.password) {
      throw new FlexiError("auth", "No valid session and no credentials: set FLEXISCHOOL_USERNAME and FLEXISCHOOL_PASSWORD");
    }
    const json = await this.cognito("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      AuthParameters: { USERNAME: this.username, PASSWORD: this.password },
    });
    const r = json.AuthenticationResult;
    if (!r?.IdToken || !r.RefreshToken) {
      throw new FlexiError("auth", `Login did not return tokens${json.ChallengeName ? ` (challenge: ${String(json.ChallengeName)})` : ""}`);
    }
    await this.store.save({ idToken: r.IdToken, refreshToken: r.RefreshToken, idTokenExp: jwtExp(r.IdToken) });
    return r.IdToken as string;
  }

  private async refresh(refreshToken: string): Promise<string> {
    const json = await this.cognito("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    });
    const r = json.AuthenticationResult;
    if (!r?.IdToken) throw new FlexiError("auth", "Refresh did not return an ID token");
    // Cognito does not return a new refresh token on refresh; keep the one we have.
    await this.store.save({ idToken: r.IdToken, refreshToken: (r.RefreshToken as string | undefined) ?? refreshToken, idTokenExp: jwtExp(r.IdToken) });
    return r.IdToken as string;
  }
}
