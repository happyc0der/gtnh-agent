import type { Migration } from './index.ts';

/**
 * When a human last resumed a task (`task-resume`): the repeated-failure rule counts only the
 * failures after it, so a resumed task's actions may be tried again (docs/action-contract.md,
 * rule 6: a task blocked for repeated failures waits until a human resumes it). Null: never.
 */
export const migration010TaskFailuresReset: Migration = {
  version: 10,
  name: 'task-failures-reset',
  sql: /* sql */ `
    ALTER TABLE tasks ADD COLUMN failures_reset_at TEXT;
  `,
};
