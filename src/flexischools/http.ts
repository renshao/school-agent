import { BRAND_ID, CHANNEL_USER_PORTAL, ORDERING_BASE_URL } from "./config.ts";
import { FlexiError } from "./errors.ts";

type FetchLike = typeof fetch;

export interface TokenSource {
  getIdToken(force?: boolean): Promise<string>;
}

export interface RequestOptions {
  /** JSON body. */
  body?: unknown;
  /** Raw string body (some endpoints, e.g. cancel, take a bare string). */
  rawBody?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Default true. The menu (itemlist) endpoint needs no auth. */
  auth?: boolean;
}

export interface FlexiHttpOptions {
  fetch?: FetchLike;
  baseUrl?: string;
}

export class FlexiHttp {
  private tokens: TokenSource;
  private fetchFn: FetchLike;
  private baseUrl: string;

  constructor(tokens: TokenSource, opts: FlexiHttpOptions = {}) {
    this.tokens = tokens;
    this.fetchFn = opts.fetch ?? fetch;
    this.baseUrl = opts.baseUrl ?? ORDERING_BASE_URL;
  }

  /** Returns parsed JSON (or null for an empty body). Retries once with a fresh token on 401. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<unknown> {
    const auth = opts.auth ?? true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(path, this.baseUrl);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

      const headers: Record<string, string> = {
        "x-channel": CHANNEL_USER_PORTAL,
        "x-brandid": BRAND_ID,
        "content-type": "application/json",
        ...opts.headers,
      };
      if (auth) headers.authorization = `Bearer ${await this.tokens.getIdToken(attempt > 0)}`;

      const body = opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const res = await this.fetchFn(url, { method, headers, body });

      if (res.status === 401 && auth && attempt === 0) continue;
      const text = await res.text();
      if (!res.ok) {
        // Path only (no query string, no body): error messages end up in logs and chat.
        throw new FlexiError("http", `${method} ${url.pathname} -> HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`, res.status);
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new FlexiError("schema", `${method} ${url.pathname}: response was not JSON`, res.status);
      }
    }
    throw new FlexiError("auth", "Unauthorized even after refreshing the token", 401);
  }
}
