import { z } from 'zod';
import { GameStateSchema, type GameState } from '../domain/game-state.ts';
import {
  NamedLocationSchema,
  StoredSafetyViolationSchema,
  type NamedLocation,
  type SafetyViolation,
  type StoredSafetyViolation,
} from '../domain/safety.ts';
import {
  TaskCheckpointSchema,
  TaskSchema,
  type Task,
  type TaskCheckpoint,
  type TaskStatus,
} from '../domain/tasks.ts';
import type { FailureHistory } from '../safety/safety-policy.ts';
import type { Clock } from '../util/clock.ts';
import type { Db } from './database.ts';
import { PlanRepository } from './plan-repository.ts';
import { MemoryRepository } from './memory-repository.ts';
import { WorldMemoryRepository } from './world-memory-repository.ts';
import { WindowLayoutRepository } from './window-layout-repository.ts';

/*
 * Repositories are thin, synchronous and typed. Rows are re-validated with Zod on
 * read, so a corrupted or hand-edited database surfaces as an error, not bad data.
 * No secrets are stored anywhere in this schema.
 */

const now = (clock: Clock): string => clock.now().toISOString();
const json = (value: unknown): string => JSON.stringify(value);
const parseJson = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

// ---------------------------------------------------------------------------

export class TaskRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Inserts the task, or updates goal/subgoal of an existing one (status is left alone). */
  ensure(input: { id: string; goal: string; subgoal: string | null; status: TaskStatus }): Task {
    const ts = now(this.#clock);
    this.#db
      .prepare(
        `INSERT INTO tasks (id, goal, subgoal, status, created_at, updated_at)
         VALUES (@id, @goal, @subgoal, @status, @ts, @ts)
         ON CONFLICT(id) DO UPDATE SET goal = excluded.goal, subgoal = excluded.subgoal, updated_at = excluded.updated_at`,
      )
      .run({ ...input, ts });
    return this.get(input.id) as Task;
  }

  get(id: string): Task | null {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | {
          id: string;
          goal: string;
          subgoal: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (row === undefined) return null;
    return TaskSchema.parse({
      id: row.id,
      goal: row.goal,
      subgoal: row.subgoal,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  setStatus(id: string, status: TaskStatus): void {
    const r = this.#db
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now(this.#clock), id);
    if (r.changes === 0) throw new Error(`No task ${id}`);
  }

  /** Machines (observed ids) the task depends on; replaces any earlier list. */
  setRequiredMachines(taskId: string, machineIds: readonly string[]): void {
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM task_machines WHERE task_id = ?').run(taskId);
      const insert = this.#db.prepare(
        'INSERT INTO task_machines (task_id, machine_id) VALUES (?, ?)',
      );
      for (const id of new Set(machineIds)) insert.run(taskId, id);
    })();
  }

  requiredMachines(taskId: string): string[] {
    return (
      this.#db
        .prepare('SELECT machine_id FROM task_machines WHERE task_id = ? ORDER BY machine_id')
        .all(taskId) as Array<{ machine_id: string }>
    ).map((r) => r.machine_id);
  }

  list(): Task[] {
    const ids = this.#db.prepare('SELECT id FROM tasks ORDER BY created_at, id').all() as Array<{
      id: string;
    }>;
    return ids.map((r) => this.get(r.id) as Task);
  }
}

// ---------------------------------------------------------------------------

export class CheckpointRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Appends a checkpoint with the next sequence number for the task (atomically). */
  add(
    taskId: string,
    label: string,
    data: Record<string, unknown>,
    stateSnapshotId: number | null,
  ): TaskCheckpoint {
    return this.#db.transaction(() => {
      const { next } = this.#db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM task_checkpoints WHERE task_id = ?')
        .get(taskId) as { next: number };
      const r = this.#db
        .prepare(
          `INSERT INTO task_checkpoints (task_id, seq, label, data_json, state_snapshot_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, next, label, json(data), stateSnapshotId, now(this.#clock));
      return this.#byId(Number(r.lastInsertRowid));
    })();
  }

  list(taskId: string): TaskCheckpoint[] {
    const rows = this.#db
      .prepare('SELECT id FROM task_checkpoints WHERE task_id = ? ORDER BY seq')
      .all(taskId) as Array<{ id: number }>;
    return rows.map((r) => this.#byId(r.id));
  }

  #byId(id: number): TaskCheckpoint {
    const row = this.#db.prepare('SELECT * FROM task_checkpoints WHERE id = ?').get(id) as {
      id: number;
      task_id: string;
      seq: number;
      label: string;
      data_json: string;
      state_snapshot_id: number | null;
      created_at: string;
    };
    return TaskCheckpointSchema.parse({
      id: row.id,
      taskId: row.task_id,
      seq: row.seq,
      label: row.label,
      data: parseJson(row.data_json),
      stateSnapshotId: row.state_snapshot_id,
      createdAt: row.created_at,
    });
  }
}

// ---------------------------------------------------------------------------

export class SnapshotRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  insert(cycleId: string | null, state: GameState): number {
    const valid = GameStateSchema.parse(state);
    const r = this.#db
      .prepare(
        'INSERT INTO state_snapshots (cycle_id, observed_at, source, state_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(cycleId, valid.timestamp, valid.source, json(valid), now(this.#clock));
    return Number(r.lastInsertRowid);
  }

  get(id: number): GameState | null {
    const row = this.#db.prepare('SELECT state_json FROM state_snapshots WHERE id = ?').get(id) as
      { state_json: string } | undefined;
    return row === undefined ? null : GameStateSchema.parse(parseJson(row.state_json));
  }

  /** The most recent snapshot (optionally from one source, e.g. 'gtnh1710'), or null. */
  latest(source?: string): GameState | null {
    const row = (
      source === undefined
        ? this.#db.prepare('SELECT state_json FROM state_snapshots ORDER BY id DESC LIMIT 1').get()
        : this.#db
            .prepare(
              'SELECT state_json FROM state_snapshots WHERE source = ? ORDER BY id DESC LIMIT 1',
            )
            .get(source)
    ) as { state_json: string } | undefined;
    return row === undefined ? null : GameStateSchema.parse(parseJson(row.state_json));
  }

  count(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM state_snapshots').get() as { n: number }).n;
  }
}

// ---------------------------------------------------------------------------

export const ACTION_STATUSES = [
  'proposed',
  'rejected',
  'executing',
  'succeeded',
  'failed',
  'verification_failed',
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

const ActionLogRowSchema = z.object({
  action_id: z.string(),
  cycle_id: z.string().nullable(),
  task_id: z.string().nullable(),
  action_type: z.string(),
  origin: z.string(),
  fingerprint: z.string(),
  reason: z.string(),
  action_json: z.string(),
  status: z.enum(ACTION_STATUSES),
  validation_json: z.string().nullable(),
  execution_json: z.string().nullable(),
  verification_json: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export interface ActionLogRecord {
  actionId: string;
  cycleId: string | null;
  taskId: string | null;
  actionType: string;
  origin: string;
  fingerprint: string;
  reason: string;
  action: unknown;
  status: ActionStatus;
  validation: unknown;
  execution: unknown;
  verification: unknown;
  createdAt: string;
  updatedAt: string;
}

export class ActionLogRepository implements FailureHistory {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  insert(entry: {
    actionId: string;
    cycleId: string | null;
    taskId: string | null;
    actionType: string;
    origin: string;
    fingerprint: string;
    reason: string;
    action: unknown;
    status: ActionStatus;
    validation: unknown;
  }): void {
    const ts = now(this.#clock);
    this.#db
      .prepare(
        `INSERT INTO action_logs (action_id, cycle_id, task_id, action_type, origin, fingerprint, reason,
                                  action_json, status, validation_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actionId,
        entry.cycleId,
        entry.taskId,
        entry.actionType,
        entry.origin,
        entry.fingerprint,
        entry.reason,
        json(entry.action),
        entry.status,
        json(entry.validation),
        ts,
        ts,
      );
  }

  update(
    actionId: string,
    fields: { status: ActionStatus; execution?: unknown; verification?: unknown },
  ): void {
    const r = this.#db
      .prepare(
        `UPDATE action_logs
            SET status = @status,
                execution_json = COALESCE(@execution, execution_json),
                verification_json = COALESCE(@verification, verification_json),
                updated_at = @ts
          WHERE action_id = @actionId`,
      )
      .run({
        actionId,
        status: fields.status,
        execution: fields.execution === undefined ? null : json(fields.execution),
        verification: fields.verification === undefined ? null : json(fields.verification),
        ts: now(this.#clock),
      });
    if (r.changes === 0) throw new Error(`No action log ${actionId}`);
  }

  get(actionId: string): ActionLogRecord | null {
    const row = this.#db.prepare('SELECT * FROM action_logs WHERE action_id = ?').get(actionId);
    return row === undefined ? null : toRecord(row);
  }

  recent(limit: number, taskId?: string | null): ActionLogRecord[] {
    const rows =
      taskId === undefined
        ? this.#db
            .prepare('SELECT * FROM action_logs ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(limit)
        : this.#db
            .prepare(
              'SELECT * FROM action_logs WHERE task_id IS ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
            )
            .all(taskId, limit);
    return rows.map(toRecord);
  }

  /**
   * Executed-and-failed attempts (execution or verification) of this exact action for this
   * task, by the agent itself: failures of actions a human requested directly (origin
   * 'user', e.g. a stopped test walk) do not count against the agent's own attempts, nor do
   * actions the client could not even try (NOT_IMPLEMENTED: seen live, EAT_FOOD before the
   * client could eat, which then refused every meal of a task id reused each night).
   */
  countFailures(taskId: string | null, fingerprint: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM action_logs
          WHERE task_id IS ? AND fingerprint = ? AND status IN ('failed','verification_failed')
            AND origin <> 'user' AND ${NOT_UNTRIED}`,
      )
      .get(taskId, fingerprint) as { n: number };
    return row.n;
  }

  failureSummary(
    taskId: string | null,
    limit: number,
  ): Array<{ actionType: string; fingerprint: string; failures: number }> {
    return this.#db
      .prepare(
        `SELECT action_type AS actionType, fingerprint, COUNT(*) AS failures FROM action_logs
            WHERE task_id IS ? AND status IN ('failed','verification_failed') AND ${NOT_UNTRIED}
            GROUP BY action_type, fingerprint ORDER BY failures DESC, fingerprint LIMIT ?`,
      )
      .all(taskId, limit) as Array<{ actionType: string; fingerprint: string; failures: number }>;
  }
}

/** SQL: the action was tried (not refused by the client as NOT_IMPLEMENTED). */
const NOT_UNTRIED =
  "(execution_json IS NULL OR json_extract(execution_json, '$.code') IS NOT 'NOT_IMPLEMENTED')";

function toRecord(raw: unknown): ActionLogRecord {
  const r = ActionLogRowSchema.parse(raw);
  return {
    actionId: r.action_id,
    cycleId: r.cycle_id,
    taskId: r.task_id,
    actionType: r.action_type,
    origin: r.origin,
    fingerprint: r.fingerprint,
    reason: r.reason,
    action: parseJson(r.action_json),
    status: r.status,
    validation: parseJson(r.validation_json),
    execution: parseJson(r.execution_json),
    verification: parseJson(r.verification_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  'CYCLE_START',
  'STATE',
  'DECISION',
  'PROPOSAL',
  'VALIDATION',
  'EXECUTION',
  'VERIFICATION',
  'PLAN',
  'CYCLE_END',
  'ERROR',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AgentEvent {
  id: number;
  cycleId: string;
  kind: EventKind;
  actionId: string | null;
  payload: unknown;
  createdAt: string;
}

export class EventRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  append(cycleId: string, kind: EventKind, payload: unknown, actionId: string | null = null): void {
    this.#db
      .prepare(
        'INSERT INTO agent_events (cycle_id, kind, action_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(cycleId, kind, actionId, json(payload), now(this.#clock));
  }

  forCycle(cycleId: string): AgentEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_events WHERE cycle_id = ? ORDER BY id')
      .all(cycleId) as Array<{
      id: number;
      cycle_id: string;
      kind: EventKind;
      action_id: string | null;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      cycleId: r.cycle_id,
      kind: r.kind,
      actionId: r.action_id,
      payload: parseJson(r.payload_json),
      createdAt: r.created_at,
    }));
  }
}

// ---------------------------------------------------------------------------

export class SafetyViolationRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  insertMany(
    cycleId: string | null,
    actionId: string | null,
    violations: readonly SafetyViolation[],
  ): void {
    const stmt = this.#db.prepare(
      `INSERT INTO safety_violations (cycle_id, action_id, code, severity, message, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = now(this.#clock);
    for (const v of violations)
      stmt.run(cycleId, actionId, v.code, v.severity, v.message, json(v.details), ts);
  }

  recent(limit: number): StoredSafetyViolation[] {
    const rows = this.#db
      .prepare('SELECT * FROM safety_violations ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{
      id: number;
      cycle_id: string | null;
      action_id: string | null;
      code: string;
      severity: string;
      message: string;
      details_json: string;
      created_at: string;
    }>;
    return rows.map((r) =>
      StoredSafetyViolationSchema.parse({
        id: r.id,
        cycleId: r.cycle_id,
        actionId: r.action_id,
        code: r.code,
        severity: r.severity,
        message: r.message,
        details: parseJson(r.details_json),
        createdAt: r.created_at,
      }),
    );
  }
}

// ---------------------------------------------------------------------------

export class LocationRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  upsert(name: string, location: NamedLocation): void {
    const l = NamedLocationSchema.parse(location);
    this.#db
      .prepare(
        `INSERT INTO named_locations (name, dimension, x, y, z, kind, note, updated_at)
         VALUES (@name, @dimension, @x, @y, @z, @kind, @note, @ts)
         ON CONFLICT(name) DO UPDATE SET dimension = excluded.dimension, x = excluded.x, y = excluded.y,
           z = excluded.z, kind = excluded.kind, note = excluded.note, updated_at = excluded.updated_at`,
      )
      .run({
        name,
        dimension: l.dimension,
        ...l.position,
        kind: l.kind,
        note: l.note,
        ts: now(this.#clock),
      });
  }

  all(): Map<string, NamedLocation> {
    const rows = this.#db.prepare('SELECT * FROM named_locations ORDER BY name').all() as Array<{
      name: string;
      dimension: string;
      x: number;
      y: number;
      z: number;
      kind: string;
      note: string | null;
    }>;
    return new Map(
      rows.map((r) => [
        r.name,
        NamedLocationSchema.parse({
          dimension: r.dimension,
          position: { x: r.x, y: r.y, z: r.z },
          kind: r.kind,
          note: r.note,
        }),
      ]),
    );
  }
}

// ---------------------------------------------------------------------------

export interface ProtectedItemRow {
  item: string;
  reason: string;
  source: 'config' | 'user';
  addedAt: string;
}

export class ProtectedItemRepository {
  readonly #db: Db;
  readonly #clock: Clock;
  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  add(item: string, reason: string, source: 'config' | 'user'): void {
    this.#db
      .prepare(
        `INSERT INTO protected_items (item, reason, source, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(item) DO NOTHING`,
      )
      .run(item, reason, source, now(this.#clock));
  }

  /**
   * Mirrors the config list into the table. Config items are only ever added:
   * removing an item from the config does not silently unprotect it in the database.
   */
  syncFromConfig(items: readonly string[]): void {
    this.#db.transaction(() => {
      for (const item of items) this.add(item, 'from configuration', 'config');
    })();
  }

  list(): ProtectedItemRow[] {
    const rows = this.#db
      .prepare('SELECT item, reason, source, added_at FROM protected_items ORDER BY item')
      .all() as Array<{
      item: string;
      reason: string;
      source: 'config' | 'user';
      added_at: string;
    }>;
    return rows.map((r) => ({
      item: r.item,
      reason: r.reason,
      source: r.source,
      addedAt: r.added_at,
    }));
  }

  items(): string[] {
    return this.list().map((r) => r.item);
  }
}

// ---------------------------------------------------------------------------

export interface Repositories {
  tasks: TaskRepository;
  checkpoints: CheckpointRepository;
  snapshots: SnapshotRepository;
  actions: ActionLogRepository;
  events: EventRepository;
  violations: SafetyViolationRepository;
  locations: LocationRepository;
  protectedItems: ProtectedItemRepository;
  plans: PlanRepository;
  memory: MemoryRepository;
  /** What the agent has seen of the world, per chunk. */
  worldMemory: WorldMemoryRepository;
  /** Window layouts of blocks the agent opened (src/domain/interactions.ts). */
  windowLayouts: WindowLayoutRepository;
  /** Runs `fn` in a single SQLite transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T;
}

export function createRepositories(db: Db, clock: Clock): Repositories {
  return {
    tasks: new TaskRepository(db, clock),
    checkpoints: new CheckpointRepository(db, clock),
    snapshots: new SnapshotRepository(db, clock),
    actions: new ActionLogRepository(db, clock),
    events: new EventRepository(db, clock),
    violations: new SafetyViolationRepository(db, clock),
    locations: new LocationRepository(db, clock),
    protectedItems: new ProtectedItemRepository(db, clock),
    plans: new PlanRepository(db, clock),
    memory: new MemoryRepository(db, clock),
    worldMemory: new WorldMemoryRepository(db),
    windowLayouts: new WindowLayoutRepository(db),
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
  };
}
