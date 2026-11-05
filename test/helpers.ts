import { COGNITO_URL } from "../src/flexischools/config.ts";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** A fake fetch that records every call and answers from a list of handlers (first non-undefined wins). */
export function fakeFetch(...handlers: Handler[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { method: init?.method ?? "GET", url, headers, body: typeof init?.body === "string" ? init.body : undefined };
    calls.push(call);
    for (const h of handlers) {
      const r = await h(call);
      if (r) return r;
    }
    return json({ message: `no handler for ${call.method} ${url.pathname}` }, 500);
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** An unsigned JWT with the given expiry (epoch seconds); enough for jwtExp(). */
export function fakeJwt(exp: number, tag = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, tag })}.sig`;
}

export const isCognito = (c: Call): boolean => c.url.href === COGNITO_URL;
export const cognitoTarget = (c: Call): string => c.headers["x-amz-target"]?.split(".").pop() ?? "";
