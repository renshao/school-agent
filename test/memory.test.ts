// Memory: paused checks (standing rules and day exceptions) and notes. The model proposes a pause and a parent saves
// it; notes save at once; both reach the model at the start of each day, and the Today strip / check_orders honour
// pauses. Fake Flexischools (Alice, Bob), fake Messages API.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Agent } from "../src/agent/agent.ts";
import { ApprovalDesk } from "../src/agent/approvals.ts";
import { describeSkip, memoryBlock, skipApplies, weekdayOf } from "../src/agent/memory.ts";
import type { Skip, SkipDraft } from "../src/agent/memory.ts";
import { Household } from "../src/web/household.ts";
import { Store } from "../src/web/store.ts";
import { upcomingDay } from "../src/web/today.ts";
import { fakeFlexi } from "./flexi-fake.ts";
import { fakeModel, text, toolUse } from "./model-fake.ts";
import type { Step } from "./model-fake.ts";

const NOW = new Date("2026-11-05T20:00:00Z"); // Fri 6 Nov 07:00 Sydney

const draft = (over: Partial<SkipDraft> = {}): SkipDraft => ({
  studentKey: "stu-bbbb",
  studentName: "Bob",
  serviceKey: null,
  serviceName: null,
  from: "2026-11-05",
  to: null,
  weekdays: null,
  reason: "buys his own lunch",
  ...over,
});
const saved = (over: Partial<SkipDraft> = {}, removed = false): Skip => ({ ...draft(over), id: 1, createdBy: "Ren", createdAt: NOW.toISOString(), removedAt: removed ? NOW.toISOString() : null, removedBy: null });

describe("skip rules (pure)", () => {
  it("a standing rule covers every later day; a day exception only its dates; weekdays narrow either", () => {
    assert.equal(weekdayOf("2026-11-13"), "Fri");
    assert.equal(skipApplies(draft(), "stu-bbbb", "svc-x", "2027-03-01"), true);
    assert.equal(skipApplies(draft(), "stu-bbbb", "svc-x", "2026-11-04"), false, "not before it starts");
    assert.equal(skipApplies(draft(), "stu-aaaa", "svc-x", "2026-11-06"), false, "not another child");
    const excursion = draft({ from: "2026-11-13", to: "2026-11-13", reason: "excursion" });
    assert.deepEqual(["2026-11-12", "2026-11-13", "2026-11-14"].map((d) => skipApplies(excursion, "stu-bbbb", "s", d)), [false, true, false]);
    const fridays = draft({ weekdays: ["Fri"] });
    assert.deepEqual(["2026-11-12", "2026-11-13", "2026-11-20"].map((d) => skipApplies(fridays, "stu-bbbb", "s", d)), [false, true, true]);
    assert.equal(skipApplies(draft({ serviceKey: "svc-lunch" }), "stu-bbbb", "svc-recess", "2026-11-06"), false, "only its service");
    assert.equal(skipApplies(saved({}, true), "stu-bbbb", "s", "2026-11-06"), false, "a removed rule no longer applies");
  });

  it("describes rules in words, and gives the model ids it can act on", () => {
    assert.equal(describeSkip(draft({ weekdays: ["Fri"], serviceName: "Lunch" })), "Bob · Lunch · Fridays, ongoing from Thu 5 Nov · buys his own lunch");
    assert.equal(describeSkip(draft({ from: "2026-11-13", to: "2026-11-13", reason: "excursion", studentName: "Alice" })), "Alice · all services · Fri 13 Nov · excursion");
    const block = memoryBlock([saved()], [{ id: 4, studentName: "Alice", text: "no tomato", createdBy: "Eva", createdAt: "", removedAt: null, removedBy: null }]);
    assert.match(block, /^\[household memory/);
    assert.match(block, /- S1: Bob · all services · ongoing from Thu 5 Nov · buys his own lunch/);
    assert.match(block, /- N4: Alice: no tomato/);
    assert.equal(memoryBlock([], []), "", "nothing to say, no block");
  });
});

describe("pausing checks needs a parent's Save", () => {
  it("proposing saves nothing; Save stores it; Cancel stores nothing", () => {
    const store = new Store(":memory:");
    const desk = new ApprovalDesk(fakeFlexi().client, { now: () => NOW, memory: store });
    const p = desk.proposeSkip([draft()]);
    assert.equal(store.activeSkips("2026-11-06").length, 0, "nothing saved before Save");
    const q = desk.proposeSkip([draft({ reason: "camp", from: "2026-11-20", to: "2026-11-21" })]);
    desk.reject(q.id, "Ren");
    return desk.approve(p.id, "Eva").then((done) => {
      assert.equal(done.status, "done");
      const skips = store.activeSkips("2026-11-06");
      assert.equal(skips.length, 1);
      assert.equal(skips[0]!.createdBy, "Eva");
      assert.equal(skips[0]!.reason, "buys his own lunch");
    });
  });

  it("refuses nonsense dates and empty reasons", () => {
    const desk = new ApprovalDesk(fakeFlexi().client, { memory: new Store(":memory:") });
    assert.throws(() => desk.proposeSkip([draft({ from: "2026-11-13", to: "2026-11-12" })]), /before the start/);
    assert.throws(() => desk.proposeSkip([draft({ reason: " " })]), /reason/);
    assert.throws(() => new ApprovalDesk(fakeFlexi().client).proposeSkip([draft()]), /not available/);
  });

  it("a removed rule stays in the table (soft delete) but no longer counts", () => {
    const store = new Store(":memory:");
    const s = store.addSkip(draft(), "Ren", NOW);
    assert.equal(store.removeSkip(s.id, "Eva", NOW)?.removedBy, "Eva");
    assert.equal(store.removeSkip(s.id, "Eva", NOW), undefined, "removing twice is a no-op");
    assert.equal(store.activeSkips("2026-11-06").length, 0);
    assert.equal(store.activeSkips("2026-12-01").length, 0);
    const past = store.addSkip(draft({ from: "2026-11-01", to: "2026-11-02" }), "Ren", NOW);
    assert.ok(!store.activeSkips("2026-11-06").some((x) => x.id === past.id), "ended exceptions drop off the active list");
  });
});

describe("the Today strip and check_orders honour paused checks", () => {
  it("a paused child with nothing ordered shows as skipped, not missing", async () => {
    const f = fakeFlexi();
    const plain = await upcomingDay(f.client, { now: NOW, serviceMatch: /lunch/i });
    assert.equal(plain.rows.find((r) => r.student === "Bob")!.status, "missing");
    const paused = await upcomingDay(f.client, { now: NOW, serviceMatch: /lunch/i, skips: [saved()] });
    const bob = paused.rows.find((r) => r.student === "Bob")!;
    assert.equal(bob.status, "skipped");
    assert.deepEqual(bob.skip, { ref: "S1", reason: "buys his own lunch" });
    assert.equal(paused.rows.find((r) => r.student === "Alice")!.status, "ordered", "other children unaffected");
  });

  it("an existing order on a paused day still shows as ordered, flagged", async () => {
    const f = fakeFlexi();
    const alice = saved({ studentKey: "stu-aaaa", studentName: "Alice", from: "2026-11-06", to: "2026-11-06", reason: "excursion" });
    const t = await upcomingDay(f.client, { now: NOW, serviceMatch: /lunch/i, skips: [alice] });
    const row = t.rows.find((r) => r.student === "Alice")!;
    assert.equal(row.status, "ordered");
    assert.equal(row.skip?.reason, "excursion");
  });
});

// ---------------------------------------------------------------- through the agent

function household(script: Step[], now: () => Date = () => NOW) {
  const flexi = fakeFlexi();
  const model = fakeModel(script);
  const store = new Store(":memory:");
  const h = new Household({ store, client: flexi.client, anthropic: model.anthropic, now });
  return { ...flexi, ...model, store, household: h };
}

describe("memory through the agent", () => {
  it("the model can propose a pause but not save it; a parent's Save does, and check_orders then reports it paused", async () => {
    const { household: h, store, requests } = household([
      { content: [toolUse("t1", "plan_skip", { students: ["Bob"], service: "lunch", reason: "buys his own lunch" })], stop_reason: "tool_use" },
      { content: [text("Press Save to stop reminders for Bob's lunch.")], stop_reason: "end_turn" },
      { content: [toolUse("t2", "check_orders", { date: "tomorrow" })], stop_reason: "tool_use" },
      { content: [text("Bob is covered.")], stop_reason: "end_turn" },
    ]);
    await h.send("Ren", "Bob usually buys his own lunch");
    assert.equal(store.activeSkips("2026-11-06").length, 0, "the model alone saves nothing");
    const card = h.history().find((v) => v.kind === "proposal");
    assert.equal(card?.kind === "proposal" && card.proposal.kind, "skip");

    await h.approve("P1", "Eva");
    assert.equal(store.activeSkips("2026-11-06")[0]!.createdBy, "Eva");
    assert.deepEqual(h.memory().skips.map((s) => s.text), ["Bob · Lunch · ongoing from Fri 6 Nov · buys his own lunch"]);

    await h.send("Ren", "anything missing tomorrow?");
    const result = JSON.parse(requests[3]!.body.messages.at(-1).content[0].content) as { student: string; status: string; paused?: string }[];
    const bob = result.find((r) => r.student === "Bob")!;
    assert.match(bob.paused ?? "", /^S1: buys his own lunch/);
  });

  it("remember saves at once, attributed to who is speaking, and the next day's conversation starts with it", async () => {
    let now = NOW;
    const { household: h, store, requests } = household(
      [
        { content: [toolUse("t1", "remember", { student: "Alice", text: "doesn't like tomato" })], stop_reason: "tool_use" },
        { content: [text("Noted.")], stop_reason: "end_turn" },
        { content: [text("Morning!")], stop_reason: "end_turn" },
      ],
      () => now,
    );
    await h.send("Eva", "Alice doesn't like tomato");
    const notes = store.activeNotes();
    assert.deepEqual(notes.map((n) => [n.studentName, n.text, n.createdBy]), [["Alice", "doesn't like tomato", "Eva"]]);
    const line = h.history().find((v) => v.kind === "memory");
    assert.deepEqual(line?.kind === "memory" && line.change, { action: "note_added", by: "Eva", ref: "N1", text: "Alice: doesn't like tomato" });
    assert.equal(memoryBlock([], [{ ...notes[0]!, text: "Alice hates tomato" }]).split("\n")[2], "- N1: Alice hates tomato", "the name is not repeated");

    now = new Date(NOW.getTime() + 24 * 3600_000);
    await h.send("Ren", "good morning");
    const first = requests[2]!.body.messages[0].content;
    assert.match(first[0].text, /^\[household memory[^]*- N1: Alice: doesn't like tomato/);
    assert.match(first.at(-1).text, /good morning$/);
  });

  it("deleting from the app is immediate, logged, and the model is told on its next turn", async () => {
    const { household: h, store, requests } = household([{ content: [text("ok")], stop_reason: "end_turn" }]);
    const n = store.addNote({ studentName: null, text: "pickup is Dad on Wednesdays" }, "Ren", NOW);
    const snapshot = h.forget(`N${n.id}`, "Eva");
    assert.deepEqual(snapshot?.notes, []);
    assert.equal(h.forget(`N${n.id}`, "Eva"), undefined, "already gone");
    await h.send("Ren", "hi");
    const content = requests[0]!.body.messages[0].content;
    assert.match(content.map((b: { text: string }) => b.text).join("\n"), /\[host event\] Eva deleted note N1 \(pickup is Dad on Wednesdays\) in the app\./);
    assert.doesNotMatch(content[0].text, /household memory/, "deleted notes are not in the memory block");
  });

  it("memory tools exist only when memory is available", () => {
    const flexi = fakeFlexi();
    const anthropic = fakeModel([]).anthropic;
    const bare = new Agent({ anthropic, client: flexi.client, desk: new ApprovalDesk(flexi.client) });
    const store = new Store(":memory:");
    const full = new Agent({ anthropic, client: flexi.client, desk: new ApprovalDesk(flexi.client, { memory: store }), memory: store });
    assert.deepEqual(full.toolNames.filter((t) => !bare.toolNames.includes(t)).sort(), ["forget", "list_memory", "plan_skip", "remember", "remove_skip"]);
  });
});
