import { z } from 'zod';
import { PlanSchema, type Plan } from '../planner/plan-schema.ts';
import type { Clock } from '../util/clock.ts';
import type { Db } from './database.ts';

export const PLAN_STATUSES = [
  'pending_approval',
  'active',
  'completed',
  'failed',
  'rejected',
  'superseded',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Statuses of a plan that is still in play for its task (at most one per task). */
const OPEN: readonly PlanStatus[] = ['pending_approval', 'active'];

export interface StoredPlan {
  id: number;
  taskId: string;
  status: PlanStatus;
  planner: string;
  plan: Plan;
  /** Index of the next step to execute (0-based). */
  nextStep: number;
  /** Consecutive failures of the current step. */
  stepFailures: number;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

const RowSchema = z.object({
  id: z.int(),
  task_id: z.string(),
  status: z.enum(PLAN_STATUSES),
  planner: z.string(),
  plan_json: z.string(),
  next_step: z.int().min(0),
  step_failures: z.int().min(0),
  status_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export class PlanRepository {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** Stores a validated plan; any open plan for the task is superseded (one open plan per task). */
  create(
    taskId: string,
    plan: Plan,
    status: 'pending_approval' | 'active',
    planner: string,
  ): StoredPlan {
    const valid = PlanSchema.parse(plan);
    const ts = this.#clock.now().toISOString();
    return this.#db.transaction(() => {
      this.#db
        .prepare(
          `UPDATE plans SET status = 'superseded', status_reason = 'replaced by a newer plan', updated_at = ?
            WHERE task_id = ? AND status IN ('pending_approval','active')`,
        )
        .run(ts, taskId);
      const r = this.#db
        .prepare(
          `INSERT INTO plans (task_id, status, planner, plan_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, status, planner, JSON.stringify(valid), ts, ts);
      return this.get(Number(r.lastInsertRowid)) as StoredPlan;
    })();
  }

  get(id: number): StoredPlan | null {
    const row = this.#db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
    return row === undefined ? null : toPlan(row);
  }

  /** The task's open plan (awaiting approval or active), if any. */
  openForTask(taskId: string): StoredPlan | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM plans WHERE task_id = ? AND status IN (${OPEN.map(() => '?').join(',')})
          ORDER BY id DESC LIMIT 1`,
      )
      .get(taskId, ...OPEN);
    return row === undefined ? null : toPlan(row);
  }

  /** Every open plan (awaiting approval or active), oldest first. */
  listOpen(): StoredPlan[] {
    return this.#db
      .prepare(`SELECT * FROM plans WHERE status IN (${OPEN.map(() => '?').join(',')}) ORDER BY id`)
      .all(...OPEN)
      .map(toPlan);
  }

  /** The task's most recent plan in any status. */
  latestForTask(taskId: string): StoredPlan | null {
    const row = this.#db
      .prepare('SELECT * FROM plans WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId);
    return row === undefined ? null : toPlan(row);
  }

  setStatus(id: number, status: PlanStatus, reason: string | null = null): void {
    const r = this.#db
      .prepare('UPDATE plans SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, reason, this.#clock.now().toISOString(), id);
    if (r.changes === 0) throw new Error(`No plan ${id}`);
  }

  /**
   * The current step succeeded: move to the next one (completing the plan after the last).
   * A plan that stopped being active meanwhile (rejected or superseded) is left as it is.
   */
  advance(id: number): StoredPlan {
    const plan = this.get(id);
    if (plan === null) throw new Error(`No plan ${id}`);
    if (plan.status !== 'active') return plan;
    const next = plan.nextStep + 1;
    const done = next >= plan.plan.steps.length;
    this.#db
      .prepare(
        `UPDATE plans SET next_step = ?, step_failures = 0, status = ?, status_reason = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next,
        done ? 'completed' : 'active',
        done ? 'all steps verified' : plan.statusReason,
        this.#clock.now().toISOString(),
        id,
      );
    return this.get(id) as StoredPlan;
  }

  /** The current step failed once more; returns the updated consecutive-failure count. */
  recordStepFailure(id: number): number {
    this.#db
      .prepare('UPDATE plans SET step_failures = step_failures + 1, updated_at = ? WHERE id = ?')
      .run(this.#clock.now().toISOString(), id);
    return this.get(id)?.stepFailures ?? 0;
  }
}

function toPlan(raw: unknown): StoredPlan {
  const r = RowSchema.parse(raw);
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status,
    planner: r.planner,
    plan: PlanSchema.parse(JSON.parse(r.plan_json)),
    nextStep: r.next_step,
    stepFailures: r.step_failures,
    statusReason: r.status_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
