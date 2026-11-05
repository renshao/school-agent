// The agent loop against a scripted fake of the Messages API (no network, no spend) and the fake Flexischools API.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../src/agent/agent.ts";
import { ApprovalDesk } from "../src/agent/approvals.ts";
import { fakeFlexi } from "./flexi-fake.ts";

type Block = Record<string, unknown>;
const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

/** A fake /v1/messages that answers from a script and records each request body and its headers. */
function fakeModel(script: { content: Block[]; stop_reason: string }[]) {
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
  return { anthropic: new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 }), requests };
}

const NOW = new Date("2026-11-05T20:00:00Z"); // Fri 6 Nov 07:00 Sydney

function setup(script: Parameters<typeof fakeModel>[0]) {
  const flexi = fakeFlexi();
  const model = fakeModel(script);
  const desk = new ApprovalDesk(flexi.client, { now: () => NOW });
  const agent = new Agent({ anthropic: model.anthropic, client: flexi.client, desk, now: () => NOW });
  return { ...flexi, ...model, desk, agent };
}

const planCall = toolUse("tu_1", "plan_order", { student: "Alice", service: "lunch", date: "2026-11-06", items: [{ item: "Up & Go", choices: [{ option: "Chocolate" }] }] });

describe("agent loop", () => {
  it("a proposed order is stored for approval and nothing is placed; history stays well-formed", async () => {
    const { agent, requests, writes, desk } = setup([
      { content: [text("Let me set that up."), planCall], stop_reason: "tool_use" },
      { content: [text("Proposed: Up & Go (Chocolate) for Alice, $4.19. Press Approve to place it.")], stop_reason: "end_turn" },
    ]);
    const r = await agent.send("Ren", "Order Alice a chocolate Up & Go for lunch tomorrow");

    assert.equal(r.text, "Proposed: Up & Go (Chocolate) for Alice, $4.19. Press Approve to place it.");
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0]!.status, "pending");
    assert.equal(desk.pending().length, 1);
    assert.equal(writes().length, 0, "the model must not be able to place an order");

    assert.deepEqual(agent.history.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    const toolResult = (requests[1]!.body.messages.at(-1).content as Block[])[0]!;
    assert.equal(toolResult.type, "tool_result");
    assert.equal(toolResult.is_error, undefined);
    const payload = JSON.parse(toolResult.content as string);
    assert.equal(payload.proposal_id, "P1");
    assert.match(payload.summary, /Alice · Junior Lunch · 2026-11-06 · 1 x Up & Go \(Chocolate\) \$3\.80 \+ fee \$0\.39 = \$4\.19/);
    assert.match(payload.note, /cannot place/);
  });

  it("sends the configured request: model, effort, caching, refusal fallback, stable system prompt; time and author in the user turn", async () => {
    const { agent, requests } = setup([{ content: [text("hi")], stop_reason: "end_turn" }]);
    await agent.send("Ren", "hello");
    const { body, headers } = requests[0]!;
    assert.equal(body.model, "claude-opus-5-5");
    assert.deepEqual(body.output_config, { effort: "medium" });
    assert.deepEqual(body.cache_control, { type: "ephemeral" });
    assert.equal(body.fallbacks, "default");
    assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
    assert.equal(body.thinking, undefined, "Opus 5.5 thinks adaptively by default; disabling it is a 400");
    assert.doesNotMatch(JSON.stringify(body.system), /2026|Ren/, "system prompt must stay byte-stable for caching");
    assert.equal(body.messages[0].content.at(-1).text, "[Fri, 6 Nov 2026, 07:00 · Ren]\nhello");
  });

  it("exposes no tool that places, cancels or approves", () => {
    const { agent } = setup([]);
    assert.deepEqual(agent.toolNames.sort(), ["check_orders", "get_menu", "get_order", "get_order_days", "list_orders", "list_proposals", "list_service_slots", "list_students", "plan_cancel", "plan_order"]);
  });

  it("a call to a tool that does not exist (e.g. a hallucinated place_order) is an error result, and nothing is sent", async () => {
    const { agent, requests, writes } = setup([
      { content: [toolUse("tu_1", "place_order", { proposal_id: "P1" })], stop_reason: "tool_use" },
      { content: [text("I can't place orders myself.")], stop_reason: "end_turn" },
    ]);
    await agent.send("Ren", "just place it");
    const result = requests[1]!.body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /not found/);
    assert.equal(writes().length, 0);
  });

  it("tool failures go back to the model as error results instead of crashing the turn", async () => {
    const { agent, requests } = setup([
      { content: [toolUse("tu_1", "plan_order", { student: "Alice", service: "lunch", date: "2026-11-06", items: [{ item: "Unicorn Pie" }] })], stop_reason: "tool_use" },
      { content: [text("That item isn't on the menu.")], stop_reason: "end_turn" },
    ]);
    const r = await agent.send("Ren", "order unicorn pie");
    const result = requests[1]!.body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /No item matching "Unicorn Pie"/);
    assert.equal(r.proposals.length, 0);
  });

  it("invalid tool input is rejected by the schema before anything runs", async () => {
    const { agent, requests, calls } = setup([
      { content: [toolUse("tu_1", "plan_order", { student: "Alice", service: "lunch", date: "tomorrow", items: [] })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await agent.send("Ren", "order nothing");
    assert.equal(requests[1]!.body.messages.at(-1).content[0].is_error, true);
    assert.equal(calls.length, 0, "no Flexischools call for invalid input");
  });

  it("a human approval places the order and the outcome reaches the model in the next turn", async () => {
    const { agent, requests, writes } = setup([
      { content: [planCall], stop_reason: "tool_use" },
      { content: [text("Press Approve.")], stop_reason: "end_turn" },
      { content: [text("Done, it's ordered.")], stop_reason: "end_turn" },
    ]);
    const r = await agent.send("Ren", "chocolate up & go for Alice tomorrow");
    const p = await agent.approve(r.proposals[0]!.id, "Ren");
    assert.equal(p.status, "done");
    assert.equal(writes().length, 1);

    await agent.send("Ren", "thanks");
    const content = requests[2]!.body.messages.at(-1).content;
    assert.match(content[0].text, /^\[host event\] Ren approved proposal P1 \(ORDER Alice .*\$4\.19\)\. Result: done\. Placed order ord-new/);
    assert.match(content[1].text, /thanks$/);
  });

  it("turns are serialized: a second message waits for the first turn to finish", async () => {
    const { agent, requests } = setup([
      { content: [toolUse("tu_1", "list_students", {})], stop_reason: "tool_use" },
      { content: [text("Alice and Bob.")], stop_reason: "end_turn" },
      { content: [text("You're welcome.")], stop_reason: "end_turn" },
    ]);
    const [a, b] = await Promise.all([agent.send("Ren", "who are my kids?"), agent.send("Wife", "thanks")]);
    assert.equal(a.text, "Alice and Bob.");
    assert.equal(b.text, "You're welcome.");
    // The third request carries the whole first turn before the second user message.
    assert.deepEqual(requests[2]!.body.messages.map((m: { role: string }) => m.role), ["user", "assistant", "user", "assistant", "user"]);
    assert.match(requests[2]!.body.messages.at(-1).content.at(-1).text, /· Wife\]\nthanks$/);
  });

  it("stops at the iteration cap without leaving an unanswered tool call in the history", async () => {
    const loop = { content: [toolUse("tu_x", "list_students", {})], stop_reason: "tool_use" };
    const flexi = fakeFlexi();
    const model = fakeModel([loop, loop, loop]);
    const agent = new Agent({ anthropic: model.anthropic, client: flexi.client, desk: new ApprovalDesk(flexi.client), config: { maxIterations: 2 }, now: () => NOW });
    const r = await agent.send("Ren", "loop");
    assert.equal(model.requests.length, 2);
    assert.match(r.text, /Stopped after 2 steps/);
    assert.equal(agent.history.at(-1)!.role, "user", "the last tool call was answered");
  });
});
