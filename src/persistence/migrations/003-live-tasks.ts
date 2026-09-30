import type { Migration } from './index.ts';

/**
 * Agent memory for tasks on the live server:
 *  - agent_state: small named values, e.g. which task the live agent is working on (the
 *    live server has no notion of tasks, and mock scenario tasks share this database);
 *  - container_contents: the last contents seen in each configured container, so a later
 *    cycle (a new connection, chest closed) can still check that a withdrawal is feasible.
 */
export const migration003LiveTasks: Migration = {
  version: 3,
  name: 'live-tasks',
  sql: /* sql */ `
    CREATE TABLE agent_state (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    ) STRICT;
    CREATE TABLE container_contents (
      container_id  TEXT PRIMARY KEY,
      items_json    TEXT NOT NULL,
      observed_at   TEXT NOT NULL
    ) STRICT;
  `,
};
