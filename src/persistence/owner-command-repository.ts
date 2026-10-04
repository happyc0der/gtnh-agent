import { z } from 'zod';
import { OwnerCommandSchema, type OwnerCommand } from '../domain/owner-commands.ts';
import type { Clock } from '../util/clock.ts';
import type { Db } from './database.ts';

export const COMMAND_SOURCES = ['chat', 'cli'] as const;
export type CommandSource = (typeof COMMAND_SOURCES)[number];

export const COMMAND_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** Longest raw text and reply kept. */
const MAX_TEXT = 500;

/** One owner command as stored (migration 008). */
export interface OwnerCommandRecord {
  id: number;
  source: CommandSource;
  sender: string;
  rawText: string;
  /** The command it parsed to; null until natural language has been translated. */
  command: OwnerCommand | null;
  status: CommandStatus;
  /** The bot's last reply about it. */
  reply: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const RowSchema = z.object({
  id: z.int(),
  source: z.enum(COMMAND_SOURCES),
  sender: z.string(),
  raw_text: z.string(),
  command_json: z.string().nullable(),
  status: z.enum(COMMAND_STATUSES),
  reply: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});

/** Re-validated on read: a hand-edited or corrupt row is an error, not a command. */
function toRecord(raw: unknown): OwnerCommandRecord {
  const r = RowSchema.parse(raw);
  return {
    id: r.id,
    source: r.source,
    sender: r.sender,
    rawText: r.raw_text,
    command:
      r.command_json === null
        ? null
        : OwnerCommandSchema.parse(JSON.parse(r.command_json) as unknown),
    status: r.status,
    reply: r.reply,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/**
 * The owners' commands (src/app/play/commands.ts runs them): queued as they are heard (chat)
 * or typed (`cli command`), one running at a time, then done, failed or cancelled, with the
 * bot's reply.
 */
export class OwnerCommandRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Queues a command; `command` is null when its text still needs translating. */
  add(input: {
    source: CommandSource;
    sender: string;
    rawText: string;
    command: OwnerCommand | null;
  }): OwnerCommandRecord {
    const ts = this.#clock.now().toISOString();
    const r = this.#db
      .prepare(
        `INSERT INTO owner_commands (source, sender, raw_text, command_json, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.source,
        input.sender,
        input.rawText.slice(0, MAX_TEXT),
        input.command === null ? null : JSON.stringify(OwnerCommandSchema.parse(input.command)),
        ts,
        ts,
      );
    return this.get(Number(r.lastInsertRowid)) as OwnerCommandRecord;
  }

  get(id: number): OwnerCommandRecord | null {
    const row = this.#db.prepare('SELECT * FROM owner_commands WHERE id = ?').get(id);
    return row === undefined ? null : toRecord(row);
  }

  /** The queued commands, oldest first. */
  queued(): OwnerCommandRecord[] {
    return this.#db
      .prepare("SELECT * FROM owner_commands WHERE status = 'queued' ORDER BY id")
      .all()
      .map(toRecord);
  }

  /**
   * Whether a command newer than `afterId` is queued: a running play polls this between
   * cycles, for the commands `cli command` queues (and play has not seen yet).
   */
  hasQueuedAfter(afterId: number): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM owner_commands WHERE status = 'queued' AND id > ? LIMIT 1")
        .get(afterId) !== undefined
    );
  }

  /** The newest command from `source` queued since `afterId` whose command is `verb`, or null. */
  queuedVerb(
    verb: OwnerCommand['verb'],
    source: CommandSource,
    afterId = 0,
  ): OwnerCommandRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM owner_commands
          WHERE status = 'queued' AND source = ? AND id > ?
            AND json_extract(command_json, '$.verb') = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(source, afterId, verb);
    return row === undefined ? null : toRecord(row);
  }

  /** The command running now (the newest, should there be more), or null. */
  running(): OwnerCommandRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM owner_commands WHERE status = 'running' ORDER BY id DESC LIMIT 1")
      .get();
    return row === undefined ? null : toRecord(row);
  }

  /** The command its natural language was translated to. */
  setCommand(id: number, command: OwnerCommand): void {
    this.#update(id, 'command_json = ?', [JSON.stringify(OwnerCommandSchema.parse(command))]);
  }

  /** It runs from now on (its reply: the acknowledgement). */
  start(id: number, reply: string | null): void {
    const ts = this.#clock.now().toISOString();
    this.#update(id, "status = 'running', started_at = ?, reply = COALESCE(?, reply)", [
      ts,
      reply === null ? null : reply.slice(0, MAX_TEXT),
    ]);
  }

  /** The bot's latest reply about it (progress, a deferral). */
  setReply(id: number, reply: string): void {
    this.#update(id, 'reply = ?', [reply.slice(0, MAX_TEXT)]);
  }

  /** It is over: done, failed or cancelled, with the reply that said so. */
  finish(id: number, status: 'done' | 'failed' | 'cancelled', reply: string): void {
    const ts = this.#clock.now().toISOString();
    this.#update(id, 'status = ?, reply = ?, finished_at = ?', [
      status,
      reply.slice(0, MAX_TEXT),
      ts,
    ]);
  }

  /** The most recent commands, newest first. */
  recent(limit: number): OwnerCommandRecord[] {
    return this.#db
      .prepare('SELECT * FROM owner_commands ORDER BY id DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, limit)))
      .map(toRecord);
  }

  #update(id: number, set: string, values: unknown[]): void {
    const r = this.#db
      .prepare(`UPDATE owner_commands SET ${set}, updated_at = ? WHERE id = ?`)
      .run(...values, this.#clock.now().toISOString(), id);
    if (r.changes === 0) throw new Error(`No owner command ${id}`);
  }
}
