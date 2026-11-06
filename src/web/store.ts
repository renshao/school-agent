// SQLite (WAL) on the host, via Node's built-in node:sqlite: the household's append-only event log (every message,
// model reply, tool result, proposal and decision, with authorship) plus web login sessions and pending OAuth logins.
// The file lives in .state/ (gitignored) and is 0600.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemoryStore, Note, Skip, SkipDraft, Weekday } from "../agent/memory.ts";

export interface EventRow {
  seq: number;
  /** ISO instant. */
  ts: string;
  /** The conversation the event belongs to: the school-local date it started (YYYY-MM-DD). */
  thread: string;
  type: string;
  author: string | null;
  payload: unknown;
}

export interface SessionUser {
  email: string;
  name: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  thread  TEXT NOT NULL,
  type    TEXT NOT NULL,
  author  TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_thread ON events (thread, seq);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Paused order checks: a standing rule (to_date NULL) or a day exception. Soft-deleted (removed_at), never deleted.
CREATE TABLE IF NOT EXISTS lunch_skips (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_key  TEXT NOT NULL,
  student_name TEXT NOT NULL,
  service_key  TEXT,            -- NULL = every service
  service_name TEXT,
  from_date    TEXT NOT NULL,   -- YYYY-MM-DD, inclusive
  to_date      TEXT,            -- inclusive; NULL = ongoing
  weekdays     TEXT,            -- JSON ["Fri"]; NULL = every day
  reason       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  removed_by   TEXT,
  removed_at   TEXT
);

-- Free-text notes for the assistant. Soft-deleted.
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name TEXT,            -- NULL = the whole household
  text         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  removed_by   TEXT,
  removed_at   TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (v == null ? null : String(v));

const toSkip = (r: Row): Skip => ({
  id: Number(r.id),
  studentKey: String(r.student_key),
  studentName: String(r.student_name),
  serviceKey: str(r.service_key),
  serviceName: str(r.service_name),
  from: String(r.from_date),
  to: str(r.to_date),
  weekdays: r.weekdays == null ? null : (JSON.parse(String(r.weekdays)) as Weekday[]),
  reason: String(r.reason),
  createdBy: String(r.created_by),
  createdAt: String(r.created_at),
  removedBy: str(r.removed_by),
  removedAt: str(r.removed_at),
});

const toNote = (r: Row): Note => ({
  id: Number(r.id),
  studentName: str(r.student_name),
  text: String(r.text),
  createdBy: String(r.created_by),
  createdAt: String(r.created_at),
  removedBy: str(r.removed_by),
  removedAt: str(r.removed_at),
});

const toEvent = (r: Row): EventRow => ({
  seq: Number(r.seq),
  ts: String(r.ts),
  thread: String(r.thread),
  type: String(r.type),
  author: r.author == null ? null : String(r.author),
  payload: JSON.parse(String(r.payload)),
});

export class Store implements MemoryStore {
  private db: DatabaseSync;

  /** `path` ":memory:" for tests. */
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600); // SQLite gives the -wal / -shm files the same mode
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- events ------------------------------------------------------------------------------------------------

  appendEvent(e: Omit<EventRow, "seq">): EventRow {
    const r = this.db.prepare("INSERT INTO events (ts, thread, type, author, payload) VALUES (?, ?, ?, ?, ?)").run(e.ts, e.thread, e.type, e.author, JSON.stringify(e.payload));
    return { seq: Number(r.lastInsertRowid), ...e };
  }

  /** The newest `limit` events before `beforeSeq` (or the newest overall), oldest first. */
  eventsBefore(beforeSeq: number | undefined, limit: number): EventRow[] {
    const rows = this.db.prepare("SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?").all(beforeSeq ?? Number.MAX_SAFE_INTEGER, limit) as Row[];
    return rows.reverse().map(toEvent);
  }

  eventsAfter(afterSeq: number, limit = 1000): EventRow[] {
    return (this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(afterSeq, limit) as Row[]).map(toEvent);
  }

  eventsOfThread(thread: string, types: readonly string[]): EventRow[] {
    const marks = types.map(() => "?").join(", ");
    return (this.db.prepare(`SELECT * FROM events WHERE thread = ? AND type IN (${marks}) ORDER BY seq`).all(thread, ...types) as Row[]).map(toEvent);
  }

  /** Events of a type after the last event of another type, e.g. decisions the model has not been told about. */
  eventsSinceLast(type: string, sinceType: string): EventRow[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE type = ? AND seq > (SELECT COALESCE(MAX(seq), 0) FROM events WHERE type = ?) ORDER BY seq").all(type, sinceType) as Row[]
    ).map(toEvent);
  }

  /** The highest proposal number logged so far (P7 -> 7), so new ids never collide with old ones. */
  lastProposalSeq(): number {
    const r = this.db.prepare("SELECT MAX(CAST(SUBSTR(json_extract(payload, '$.proposal.id'), 2) AS INTEGER)) AS n FROM events WHERE type = 'proposal'").get() as Row | undefined;
    return Number(r?.n ?? 0);
  }

  lastSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM events").get() as Row;
    return Number(r.n);
  }

  // ---- memory: paused checks and notes ---------------------------------------------------------------------------

  addSkip(d: SkipDraft, by: string, now: Date): Skip {
    const r = this.db
      .prepare("INSERT INTO lunch_skips (student_key, student_name, service_key, service_name, from_date, to_date, weekdays, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *")
      .get(d.studentKey, d.studentName, d.serviceKey, d.serviceName, d.from, d.to, d.weekdays ? JSON.stringify(d.weekdays) : null, d.reason, by, now.toISOString()) as Row;
    return toSkip(r);
  }

  removeSkip(id: number, by: string, now: Date): Skip | undefined {
    const r = this.db.prepare("UPDATE lunch_skips SET removed_by = ?, removed_at = ? WHERE id = ? AND removed_at IS NULL RETURNING *").get(by, now.toISOString(), id) as Row | undefined;
    return r ? toSkip(r) : undefined;
  }

  activeSkips(today: string): Skip[] {
    return (this.db.prepare("SELECT * FROM lunch_skips WHERE removed_at IS NULL AND (to_date IS NULL OR to_date >= ?) ORDER BY from_date, id").all(today) as Row[]).map(toSkip);
  }

  addNote(n: { studentName: string | null; text: string }, by: string, now: Date): Note {
    return toNote(this.db.prepare("INSERT INTO notes (student_name, text, created_by, created_at) VALUES (?, ?, ?, ?) RETURNING *").get(n.studentName, n.text, by, now.toISOString()) as Row);
  }

  removeNote(id: number, by: string, now: Date): Note | undefined {
    const r = this.db.prepare("UPDATE notes SET removed_by = ?, removed_at = ? WHERE id = ? AND removed_at IS NULL RETURNING *").get(by, now.toISOString(), id) as Row | undefined;
    return r ? toNote(r) : undefined;
  }

  activeNotes(): Note[] {
    return (this.db.prepare("SELECT * FROM notes WHERE removed_at IS NULL ORDER BY id").all() as Row[]).map(toNote);
  }

  // ---- web sessions (cookie -> user) ---------------------------------------------------------------------------

  createSession(tokenHash: string, user: SessionUser, now: Date, ttlMs: number): void {
    this.db.prepare("INSERT INTO web_sessions (token_hash, email, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(tokenHash, user.email, user.name, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
  }

  getSession(tokenHash: string, now: Date): SessionUser | undefined {
    const r = this.db.prepare("SELECT email, name FROM web_sessions WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now.toISOString()) as Row | undefined;
    return r ? { email: String(r.email), name: String(r.name) } : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(tokenHash);
  }

  pruneSessions(now: Date): void {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(now.toISOString());
    this.db.prepare("DELETE FROM oauth_states WHERE created_at <= ?").run(new Date(now.getTime() - 15 * 60_000).toISOString());
  }

  // ---- OAuth login in progress -----------------------------------------------------------------------------------

  putOAuthState(state: string, nonce: string, verifier: string, now: Date): void {
    this.db.prepare("INSERT INTO oauth_states (state, nonce, verifier, created_at) VALUES (?, ?, ?, ?)").run(state, nonce, verifier, now.toISOString());
  }

  /** Single use: the state is deleted whether or not it is still fresh. */
  takeOAuthState(state: string, now: Date, maxAgeMs: number): { nonce: string; verifier: string } | undefined {
    const r = this.db.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING nonce, verifier, created_at").get(state) as Row | undefined;
    if (!r || now.getTime() - Date.parse(String(r.created_at)) > maxAgeMs) return undefined;
    return { nonce: String(r.nonce), verifier: String(r.verifier) };
  }
}
