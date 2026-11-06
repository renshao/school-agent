// "Sign in with Google": the OpenID Connect authorization-code flow with PKCE, a nonce and a single-use state.
//
// The ID token comes straight from Google's token endpoint over TLS in exchange for a one-time code, so its signature
// does not need checking (OpenID Connect Core 3.1.3.7, item 6); its claims are still checked: issuer, audience,
// expiry, nonce and a verified email. Who may sign in is decided by the caller (an email allowlist).
import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

export interface GoogleLoginOptions {
  clientId: string;
  clientSecret: string;
  /** Must match an "Authorized redirect URI" of the OAuth client exactly. */
  redirectUri: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
const s256 = (v: string): string => createHash("sha256").update(v).digest("base64url");

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new LoginError("Google returned a malformed ID token");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new LoginError("Google returned a malformed ID token");
  }
}

export class GoogleLogin {
  private opts: GoogleLoginOptions;
  private fetch: typeof globalThis.fetch;
  private now: () => Date;

  constructor(opts: GoogleLoginOptions) {
    this.opts = opts;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Where to send the browser, plus the secrets to keep (server-side) until the callback. */
  start(): { url: string; state: string; nonce: string; verifier: string } {
    const state = randomToken();
    const nonce = randomToken();
    const verifier = randomToken(48);
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.opts.clientId,
      redirect_uri: this.opts.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: s256(verifier),
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return { url: url.toString(), state, nonce, verifier };
  }

  /** Exchanges the callback's code and checks the ID token's claims. Throws LoginError. */
  async finish(code: string, expected: { nonce: string; verifier: string }): Promise<GoogleIdentity> {
    let res: Response;
    try {
      res = await this.fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
          redirect_uri: this.opts.redirectUri,
          grant_type: "authorization_code",
          code_verifier: expected.verifier,
        }).toString(),
      });
    } catch (e) {
      throw new LoginError(`Could not reach Google (${e instanceof Error ? e.message : String(e)})`);
    }
    const body = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_description?: unknown };
    if (!res.ok || typeof body.id_token !== "string") {
      // Google's error codes (e.g. invalid_grant) are safe to show; the request carried the secret, the response never does.
      throw new LoginError(`Google refused the sign-in (${String(body.error ?? res.status)}${body.error_description ? `: ${String(body.error_description)}` : ""})`);
    }

    const c = decodeJwtPayload(body.id_token);
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!ISSUERS.has(String(c.iss))) throw new LoginError("ID token has the wrong issuer");
    if (!aud.includes(this.opts.clientId)) throw new LoginError("ID token is for a different app");
    if (typeof c.exp !== "number" || c.exp * 1000 <= this.now().getTime()) throw new LoginError("ID token has expired");
    if (c.nonce !== expected.nonce) throw new LoginError("ID token nonce does not match this sign-in");
    if (typeof c.email !== "string" || c.email_verified !== true) throw new LoginError("Google account has no verified email");
    return { sub: String(c.sub), email: c.email.toLowerCase(), ...(typeof c.name === "string" ? { name: c.name } : {}) };
  }
}
