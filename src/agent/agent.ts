// The agent loop: one conversation (session) on top of the SDK's tool runner.
//
// - History is append-only and owned here (thread: false), so thinking blocks go back unchanged and the session can
//   later be persisted / replayed from the event log.
// - Turns are serialized: if two parents send at once, the second waits for the first.
// - Approvals are host methods (approve / reject), never tools. Their outcome reaches the model as a [host event] note
//   at the start of the next user turn.
import type Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { DEFAULT_TIMEZONE } from "../flexischools/config.ts";
import { ymdInZone } from "../flexischools/index.ts";
import type { FlexiClient } from "../flexischools/index.ts";
import { describeProposal } from "./approvals.ts";
import type { ApprovalDesk, Proposal } from "./approvals.ts";
import { memoryBlock } from "./memory.ts";
import type { MemoryChange, MemoryStore } from "./memory.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { createTools } from "./tools.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** API requests per user turn before the loop stops. */
  maxIterations: number;
  /** Server-side refusal fallback ("default" routing). */
  fallbacks: boolean;
}

export const DEFAULT_CONFIG: AgentConfig = {
  model: "claude-opus-5-5",
  effort: "medium",
  maxTokens: 16000,
  maxIterations: 12,
  fallbacks: true,
};

export type AgentEvent =
  | { type: "user"; author: string; text: string; content: BetaContentBlockParam[] }
  | { type: "assistant"; message: BetaMessage }
  | { type: "tool_results"; message: BetaMessageParam }
  | { type: "proposal"; proposal: Proposal }
  /** `note` is the [host event] text the model will see at the start of its next turn. */
  | { type: "decision"; proposal: Proposal; note: string }
  | { type: "memory"; change: MemoryChange }
  | { type: "error"; error: string };

export interface TurnResult {
  /** The assistant's text from the final message of the turn. */
  text: string;
  stopReason: BetaMessage["stop_reason"];
  /** Proposals created during this turn, waiting for approval. */
  proposals: Proposal[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number };
}

export interface AgentOptions {
  anthropic: Anthropic;
  client: FlexiClient;
  desk: ApprovalDesk;
  config?: Partial<AgentConfig>;
  now?: () => Date;
  onEvent?: (e: AgentEvent) => void;
  /** Saved rules and notes: enables the memory tools, and the conversation starts with what is saved. */
  memory?: MemoryStore;
  /** Resume a conversation, e.g. after a restart: its messages (from the event log) and undelivered host notes. */
  restore?: { messages?: readonly BetaMessageParam[]; notes?: readonly string[] };
}

/** Agent settings from AGENT_MODEL / AGENT_EFFORT, leaving the rest at their defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<AgentConfig> {
  return {
    ...(env.AGENT_MODEL ? { model: env.AGENT_MODEL } : {}),
    ...(env.AGENT_EFFORT ? { effort: env.AGENT_EFFORT as Effort } : {}),
  };
}

const INTERRUPTED = "Interrupted: the server restarted before this tool finished. Nothing was placed or cancelled by it.";

/**
 * Makes restored history valid to send again. A crash between a tool call and its result would leave a tool_use with
 * no tool_result (a 400 from the API), so each unanswered call gets an error result. Tools never spend money (only
 * proposals, which do not survive a restart), so nothing needs undoing.
 */
export function repairHistory(messages: readonly BetaMessageParam[]): BetaMessageParam[] {
  const out = [...messages];
  const last = out.at(-1);
  if (last?.role === "assistant" && Array.isArray(last.content)) {
    const calls = last.content.filter((b) => b.type === "tool_use");
    if (calls.length) out.push({ role: "user", content: calls.map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: INTERRUPTED, is_error: true })) });
  }
  return out;
}

/** "Thu, 5 Nov 2026, 17:42" in school-local time. */
export function localStamp(d: Date, tz: string = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

const textOf = (m: BetaMessage): string =>
  m.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

export class Agent {
  readonly config: AgentConfig;
  private anthropic: Anthropic;
  private desk: ApprovalDesk;
  private now: () => Date;
  private emit: (e: AgentEvent) => void;
  private tools: ReturnType<typeof createTools>;
  private messages: BetaMessageParam[] = [];
  private notes: string[] = [];
  private turnProposals: Proposal[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private memory: MemoryStore | undefined;
  private author = "a parent";

  constructor(opts: AgentOptions) {
    this.anthropic = opts.anthropic;
    this.desk = opts.desk;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.now = opts.now ?? (() => new Date());
    this.emit = opts.onEvent ?? (() => {});
    this.messages = repairHistory(opts.restore?.messages ?? []);
    this.notes = [...(opts.restore?.notes ?? [])];
    this.memory = opts.memory;
    this.tools = createTools({
      client: opts.client,
      desk: opts.desk,
      now: this.now,
      ...(opts.memory ? { memory: opts.memory } : {}),
      author: () => this.author,
      onMemory: (change) => this.emit({ type: "memory", change }),
      onProposal: (p) => {
        this.turnProposals.push(p);
        this.emit({ type: "proposal", proposal: p });
      },
    });
  }

  /** The conversation so far (append-only). */
  get history(): readonly BetaMessageParam[] {
    return this.messages;
  }

  /** Host notes not yet delivered to the model (handed over when a new conversation replaces this one). */
  takeNotes(): string[] {
    return this.notes.splice(0);
  }

  /** Host notes to deliver at the start of the next turn. */
  queueNotes(notes: readonly string[]): void {
    this.notes.push(...notes);
  }

  get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  /** Sends a user message and runs the agent until it is done. Turns run one at a time. */
  send(author: string, text: string): Promise<TurnResult> {
    const run = this.queue.then(() => this.turn(author, text));
    this.queue = run.catch(() => {});
    return run;
  }

  /** HOST ONLY (a human pressed Approve). Executes the proposal and tells the model the outcome next turn. */
  async approve(id: string, by: string): Promise<Proposal> {
    const p = await this.desk.approve(id, by);
    this.decided(p);
    return p;
  }

  /** HOST ONLY. */
  reject(id: string, by: string): Proposal {
    const p = this.desk.reject(id, by);
    this.decided(p);
    return p;
  }

  private decided(p: Proposal): void {
    const note = `${p.decidedBy ?? "A parent"} ${p.status === "rejected" ? "rejected" : "approved"} proposal ${p.id} (${describeProposal(p)}). Result: ${p.status}. ${p.outcome ?? ""}`.trim();
    this.notes.push(note);
    this.emit({ type: "decision", proposal: p, note });
  }

  private async turn(author: string, text: string): Promise<TurnResult> {
    this.author = author;
    // The first message of a conversation carries what the household asked to remember. Later changes reach the model
    // as tool results (its own) or [host event] notes (a parent's, from the app).
    const memory = this.messages.length === 0 && this.memory ? memoryBlock(this.memory.activeSkips(ymdInZone(this.now())), this.memory.activeNotes()) : "";
    const content: BetaContentBlockParam[] = [
      ...(memory ? [{ type: "text" as const, text: memory }] : []),
      ...this.notes.splice(0).map((n): BetaContentBlockParam => ({ type: "text", text: `[host event] ${n}` })),
      { type: "text", text: `[${localStamp(this.now())} · ${author}]\n${text}` },
    ];
    this.messages.push({ role: "user", content });
    this.emit({ type: "user", author, text, content });
    this.turnProposals = [];

    const c = this.config;
    const runner = this.anthropic.beta.messages.toolRunner({
      model: c.model,
      max_tokens: c.maxTokens,
      system: SYSTEM_PROMPT,
      tools: this.tools,
      messages: [...this.messages],
      thread: false,
      max_iterations: c.maxIterations,
      output_config: { effort: c.effort },
      cache_control: { type: "ephemeral" },
      ...(c.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    let last: BetaMessage | undefined;
    try {
      for await (const message of runner) {
        last = message;
        usage.requests++;
        usage.input += message.usage.input_tokens;
        usage.output += message.usage.output_tokens;
        usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
        usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
        // Append the reply verbatim (thinking and fallback blocks included), then its tool results. The runner caches
        // the tool response, so tools run once whether we ask here or it asks on the next iteration.
        this.messages.push({ role: "assistant", content: message.content });
        this.emit({ type: "assistant", message });
        const toolResults = await runner.generateToolResponse();
        if (toolResults) {
          this.messages.push(toolResults);
          this.emit({ type: "tool_results", message: toolResults });
        }
      }
    } catch (e) {
      this.emit({ type: "error", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    if (!last) throw new Error("The model returned no message");

    let finalText = textOf(last);
    if (last.stop_reason === "refusal") finalText ||= "(The model declined to answer this.)";
    else if (last.stop_reason === "tool_use") finalText ||= `(Stopped after ${c.maxIterations} steps without finishing. Ask again or rephrase.)`;
    else if (last.stop_reason === "max_tokens") finalText += "\n(Reply cut off: it hit the length limit.)";
    return { text: finalText, stopReason: last.stop_reason, proposals: [...this.turnProposals], usage };
  }
}
