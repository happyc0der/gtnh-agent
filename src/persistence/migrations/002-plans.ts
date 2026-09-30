import type { Migration } from './index.ts';

/**
 * Plans with their progress, so a multi-step plan advances one verified step per cycle
 * (instead of re-planning every cycle) and plans that need approval wait for a human.
 */
export const migration002Plans: Migration = {
  version: 2,
  name: 'plans',
  sql: /* sql */ `
    CREATE TABLE plans (
      id             INTEGER PRIMARY KEY,
      task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status         TEXT NOT NULL
                     CHECK (status IN ('pending_approval','active','completed','failed','rejected','superseded')),
      planner        TEXT NOT NULL,
      plan_json      TEXT NOT NULL,
      next_step      INTEGER NOT NULL DEFAULT 0,
      step_failures  INTEGER NOT NULL DEFAULT 0,
      status_reason  TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_plans_task_status ON plans(task_id, status);
  `,
};
