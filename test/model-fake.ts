// A scripted fake of the Messages API (no network, no spend), shared by the agent and web tests.
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

export type Block = Record<string, unknown>;
export type Step = { content: Block[]; stop_reason: string };
export const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
export const text = (t: string): Block => ({ type: "text", text: t });

/** A fake /v1/messages that answers from a script and records each request body and its headers. */
export function fakeModel(script: Step[]) {
  const requests: { body: any; headers: Headers }[] = [];
  let n = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    assert.equal(url.pathname, "/v1/messages");
    requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    await new Promise((r) => setTimeout(r, 1)); // let concurrent callers interleave if they could
    const step = script[n++];
    if (!step) throw new Error(`fake model: no scripted reply #${n}`);
    const msg = { id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-5-5", ...step, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
    return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { anthropic: new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 }), requests, push: (...steps: Step[]) => script.push(...steps) };
}
