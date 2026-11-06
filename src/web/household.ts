// The household's one shared conversation, as the web app runs it: every event is written to SQLite as it happens
// and fanned out to every open browser; on restart the conversation is rebuilt from the log.
//
// - One thread per school-local day: the model's context starts fresh each day (cheap, and school logistics are
//   day-shaped), while the page shows the whole history. Undelivered approval outcomes carry over to the new day.
// - Turns are serialized household-wide: if Ren and Eva send at once, the second waits (and the page says so).
// - Proposals live in memory only. After a restart an old proposal can no longer be approved (it shows as expired);
//   ids continue from the log, so "P3" never means two different things.
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Agent } from "../agent/agent.ts";
import type { AgentConfig, AgentEvent } from "../agent/agent.ts";
import { ApprovalDesk } from "../agent/approvals.ts";
import { describeNote, describeSkip } from "../agent/memory.ts";
import type { MemoryChange } from "../agent/memory.ts";
import { ymdInZone } from "../flexischools/index.ts";
import type { FlexiClient } from "../flexischools/index.ts";
import type { EventRow, Store } from "./store.ts";
import { upcomingDay } from "./today.ts";
import type { TodayView } from "./today.ts";
import { proposalView, toJson, toView } from "./views.ts";
import type { ProposalView, ViewEvent } from "./views.ts";

export type LiveEvent =
  | { kind: "event"; event: ViewEvent }
  | ({ kind: "status" } & HouseholdStatus)
  | { kind: "today"; today: TodayView }
  | { kind: "memory"; memory: MemorySnapshot };

/** What the assistant remembers, for the page's panel. */
export interface MemorySnapshot {
  skips: { ref: string; text: string; student: string; reason: string; ongoing: boolean; by: string }[];
  notes: { ref: string; text: string; by: string }[];
}

export interface HouseholdStatus {
  /** Who the assistant is answering right now, if anyone. */
  answering?: string;
  /** Messages waiting for their turn. */
  queued: number;
}

export interface HouseholdOptions {
  store: Store;
  client: FlexiClient;
  anthropic: Anthropic;
  config?: Partial<AgentConfig>;
  now?: () => Date;
  /** Proposal lifetime (default 30 minutes). */
  ttlMs?: number;
  /** Services shown in the Today strip (default: lunch). */
  todayServices?: RegExp;
  todayCacheMs?: number;
}

const MODEL_TYPES = ["user", "assistant", "tool_results"] as const;

/** The model-facing message stored in a user / assistant / tool_results event. */
function toMessage(row: EventRow): BetaMessageParam {
  const p = row.payload as { content?: unknown; message?: { role?: string; content: unknown } };
  if (row.type === "user") return { role: "user", content: p.content } as BetaMessageParam;
  if (row.type === "assistant") return { role: "assistant", content: p.message!.content } as BetaMessageParam;
  return p.message as BetaMessageParam;
}

/** Plain words for API failures; the raw message is kept in the log. */
function friendlyError(e: unknown): string {
  const status = (e as { status?: unknown })?.status;
  if (status === 401 || status === 403) return "The assistant's API key was refused. Check ANTHROPIC_API_KEY on the server.";
  if (status === 429) return "The assistant is rate-limited right now. Try again in a minute.";
  if (status === 529 || status === 503) return "The assistant is overloaded right now. Try again in a minute.";
  return `The assistant hit an error and stopped: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
}

export class Household {
  readonly desk: ApprovalDesk;
  private store: Store;
  private client: FlexiClient;
  private anthropic: Anthropic;
  private config: Partial<AgentConfig>;
  private now: () => Date;
  private todayServices: RegExp;
  private todayCacheMs: number;
  private agent!: Agent;
  private thread!: string;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(e: LiveEvent) => void>();
  private answering: string | undefined;
  private queued = 0;
  private clientId: string | undefined;
  private todayCache: { at: number; value: Promise<TodayView> } | undefined;

  constructor(opts: HouseholdOptions) {
    this.store = opts.store;
    this.client = opts.client;
    this.anthropic = opts.anthropic;
    this.config = opts.config ?? {};
    this.now = opts.now ?? (() => new Date());
    this.todayServices = opts.todayServices ?? /lunch/i;
    this.todayCacheMs = opts.todayCacheMs ?? 60_000;
    this.desk = new ApprovalDesk(this.client, { now: this.now, lastSeq: this.store.lastProposalSeq(), memory: this.store, ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}) });
    // Approval outcomes recorded after the last user message never reached the model: deliver them on the next turn.
    const notes = this.store.eventsSinceLast("decision", "user").map((r) => String((r.payload as { note?: unknown }).note ?? "")).filter(Boolean);
    this.openThread(ymdInZone(this.now()), notes);
  }

  private openThread(thread: string, notes: readonly string[]): void {
    const messages = this.store.eventsOfThread(thread, MODEL_TYPES).map(toMessage);
    this.thread = thread;
    this.agent = new Agent({
      anthropic: this.anthropic,
      client: this.client,
      desk: this.desk,
      config: this.config,
      now: this.now,
      onEvent: (e) => this.record(e),
      memory: this.store,
      restore: { messages, notes },
    });
  }

  /** The thread (school-local date) the model's context currently covers. */
  get currentThread(): string {
    return this.thread;
  }

  get historyForModel(): readonly BetaMessageParam[] {
    return this.agent.history;
  }

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken stream must not break the others
      }
    }
  }

  status(): HouseholdStatus {
    return { ...(this.answering ? { answering: this.answering } : {}), queued: this.queued };
  }

  private emitStatus(): void {
    this.emit({ kind: "status", ...this.status() });
  }

  private append(type: string, author: string | null, payload: unknown): EventRow {
    const row = this.store.appendEvent({ ts: this.now().toISOString(), thread: this.thread, type, author, payload });
    const view = toView(row);
    if (view) this.emit({ kind: "event", event: this.patch(view) });
    return row;
  }

  private record(e: AgentEvent): void {
    if (e.type === "error") return; // the turn's caller records a friendlier one
    const payload = e.type === "user" && this.clientId ? { ...toJson(e), clientId: this.clientId } : toJson(e);
    const author = e.type === "user" ? e.author : e.type === "decision" ? (e.proposal.decidedBy ?? null) : e.type === "memory" ? e.change.by : null;
    this.append(e.type, author, payload);
    if (e.type === "memory" || (e.type === "decision" && e.proposal.kind === "skip")) this.memoryChanged();
  }

  // ---- memory ------------------------------------------------------------------------------------------------

  memory(): MemorySnapshot {
    return {
      skips: this.store.activeSkips(ymdInZone(this.now())).map((s) => ({ ref: `S${s.id}`, text: describeSkip(s), student: s.studentName, reason: s.reason, ongoing: s.to === null, by: s.createdBy })),
      notes: this.store.activeNotes().map((n) => ({ ref: `N${n.id}`, text: describeNote(n), by: n.createdBy })),
    };
  }

  private memoryChanged(): void {
    this.emit({ kind: "memory", memory: this.memory() });
    this.refreshToday();
  }

  /** HOST: a parent removed a note or a paused check in the app. The model is told on its next turn. */
  forget(ref: string, by: string): MemorySnapshot | undefined {
    const id = Number(ref.slice(1));
    const now = this.now();
    let change: MemoryChange | undefined;
    if (ref.startsWith("N")) {
      const note = this.store.removeNote(id, by, now);
      if (note) change = { action: "note_removed", note, by };
    } else if (ref.startsWith("S")) {
      const skip = this.store.removeSkip(id, by, now);
      if (skip) change = { action: "skip_removed", skip, by };
    }
    if (!change) return undefined;
    this.append("memory", by, toJson({ type: "memory", change }));
    const what = "note" in change ? `note N${change.note.id} (${describeNote(change.note)})` : `paused check S${change.skip.id} (${describeSkip(change.skip)})`;
    this.agent.queueNotes([`${by} deleted ${what} in the app.`]);
    this.memoryChanged();
    return this.memory();
  }

  /** Sends a parent's message. Resolves when the assistant has answered (or failed, which is recorded, not thrown). */
  send(author: string, text: string, clientId?: string): Promise<void> {
    this.queued++;
    this.emitStatus();
    const run = this.queue.then(async () => {
      this.queued--;
      this.answering = author;
      this.clientId = clientId;
      this.emitStatus();
      try {
        const day = ymdInZone(this.now());
        if (day !== this.thread) this.openThread(day, this.agent.takeNotes());
        const r = await this.agent.send(author, text);
        this.store.appendEvent({ ts: this.now().toISOString(), thread: this.thread, type: "usage", author: null, payload: { ...r.usage, stopReason: r.stopReason } });
      } catch (e) {
        this.append("error", null, { error: friendlyError(e), detail: e instanceof Error ? e.message : String(e) });
      } finally {
        this.answering = undefined;
        this.clientId = undefined;
        this.emitStatus();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** HOST ONLY: a signed-in parent pressed Approve. Throws FlexiError if the proposal is not pending. */
  async approve(id: string, by: string): Promise<ProposalView> {
    const agent = this.agent;
    const p = await agent.approve(id, by);
    if (agent !== this.agent) this.agent.queueNotes(agent.takeNotes()); // the day rolled over while it ran
    this.refreshToday();
    return proposalView(toJson(p));
  }

  /** HOST ONLY. */
  reject(id: string, by: string): ProposalView {
    return proposalView(toJson(this.agent.reject(id, by)));
  }

  /** A pending proposal from the log may be gone (restart) or past its time: show what is true now. */
  private patch(v: ViewEvent): ViewEvent {
    if (v.kind !== "proposal" || v.proposal.status !== "pending") return v;
    this.desk.pending(); // expires overdue proposals
    const live = this.desk.get(v.proposal.id);
    const status = live?.status ?? "expired";
    return status === "pending" ? v : { ...v, proposal: { ...v.proposal, status, ...(live?.outcome ? { outcome: live.outcome } : status === "expired" ? { outcome: "Expired before approval" } : {}) } };
  }

  /** Display events, newest page first loaded: the `limit` events before `beforeSeq`. */
  history(beforeSeq?: number, limit = 300): ViewEvent[] {
    return this.store.eventsBefore(beforeSeq, limit).flatMap((r) => {
      const v = toView(r);
      return v ? [this.patch(v)] : [];
    });
  }

  /** Display events after `afterSeq` (a reconnecting browser catching up). */
  since(afterSeq: number): ViewEvent[] {
    return this.store.eventsAfter(afterSeq).flatMap((r) => {
      const v = toView(r);
      return v ? [this.patch(v)] : [];
    });
  }

  /** The Today strip, cached briefly (it is several Flexischools calls). */
  today(force = false): Promise<TodayView> {
    const at = this.now().getTime();
    if (!force && this.todayCache && at - this.todayCache.at < this.todayCacheMs) return this.todayCache.value;
    const value = upcomingDay(this.client, { now: this.now(), serviceMatch: this.todayServices, skips: this.store.activeSkips(ymdInZone(this.now())) });
    this.todayCache = { at, value };
    value.catch(() => {
      if (this.todayCache?.value === value) this.todayCache = undefined;
    });
    return value;
  }

  private refreshToday(): void {
    this.today(true).then(
      (today) => this.emit({ kind: "today", today }),
      () => {},
    );
  }

  /** Waits for queued turns (tests, shutdown). */
  async idle(): Promise<void> {
    await this.queue;
  }
}
