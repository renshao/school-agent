// Append-only JSONL event log per session, in .state/sessions/ (gitignored, 0600). A stand-in for the SQLite event log
// in ARCHITECTURE.md: enough to read back what happened (and what it cost) while the loop is being tuned.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent } from "./agent.ts";

export class SessionLog {
  readonly path: string;

  constructor(dir: string, sessionId: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, `${sessionId}.jsonl`);
  }

  append(e: AgentEvent): void {
    appendFileSync(this.path, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n", { mode: 0o600 });
  }
}
