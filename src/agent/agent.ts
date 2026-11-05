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
import type { FlexiClient } from "../flexischools/index.ts";
import { describeProposal } from "./approvals.ts";
import type { ApprovalDesk, Proposal } from "./approvals.ts";
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
  | { type: "user"; author: string; content: BetaContentBlockParam[] }
  | { type: "assistant"; message: BetaMessage }
  | { type: "tool_results"; message: BetaMessageParam }
  | { type: "proposal"; proposal: Proposal }
  | { type: "decision"; proposal: Proposal }
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

  constructor(opts: AgentOptions) {
    this.anthropic = opts.anthropic;
    this.desk = opts.desk;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.now = opts.now ?? (() => new Date());
    this.emit = opts.onEvent ?? (() => {});
    this.tools = createTools({
      client: opts.client,
      desk: opts.desk,
      now: this.now,
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
    this.notes.push(`${p.decidedBy ?? "A parent"} ${p.status === "rejected" ? "rejected" : "approved"} proposal ${p.id} (${describeProposal(p)}). Result: ${p.status}. ${p.outcome ?? ""}`.trim());
    this.emit({ type: "decision", proposal: p });
  }

  private async turn(author: string, text: string): Promise<TurnResult> {
    const content: BetaContentBlockParam[] = [
      ...this.notes.splice(0).map((n): BetaContentBlockParam => ({ type: "text", text: `[host event] ${n}` })),
      { type: "text", text: `[${localStamp(this.now())} · ${author}]\n${text}` },
    ];
    this.messages.push({ role: "user", content });
    this.emit({ type: "user", author, content });
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
