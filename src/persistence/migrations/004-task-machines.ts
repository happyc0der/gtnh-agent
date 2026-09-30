import type { Migration } from './index.ts';

/** Machines a task depends on (observed ids such as gt:3.200.-9): the task waits while one is busy. */
export const migration004TaskMachines: Migration = {
  version: 4,
  name: 'task-machines',
  sql: /* sql */ `
    CREATE TABLE task_machines (
      task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      machine_id  TEXT NOT NULL,
      PRIMARY KEY (task_id, machine_id)
    ) STRICT;
  `,
};
