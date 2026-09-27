import type { Migration } from './index.ts';

export const migration001Initial: Migration = {
  version: 1,
  name: 'initial',
  sql: /* sql */ `
    CREATE TABLE tasks (
      id          TEXT PRIMARY KEY,
      goal        TEXT NOT NULL,
      subgoal     TEXT,
      status      TEXT NOT NULL
                  CHECK (status IN ('pending','active','blocked','paused','completed','failed')),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    ) STRICT;

    CREATE TABLE state_snapshots (
      id           INTEGER PRIMARY KEY,
      cycle_id     TEXT,
      observed_at  TEXT NOT NULL,
      source       TEXT NOT NULL,
      state_json   TEXT NOT NULL,
      created_at   TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_state_snapshots_cycle ON state_snapshots(cycle_id);

    CREATE TABLE task_checkpoints (
      id                 INTEGER PRIMARY KEY,
      task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      seq                INTEGER NOT NULL,
      label              TEXT NOT NULL,
      data_json          TEXT NOT NULL,
      state_snapshot_id  INTEGER REFERENCES state_snapshots(id),
      created_at         TEXT NOT NULL,
      UNIQUE (task_id, seq)
    ) STRICT;

    -- One row per proposed action, updated through its lifecycle.
    -- action_type is TEXT without a CHECK so rejected, unsupported types are still logged.
    CREATE TABLE action_logs (
      action_id          TEXT PRIMARY KEY,
      cycle_id           TEXT,
      task_id            TEXT,
      action_type        TEXT NOT NULL,
      origin             TEXT NOT NULL,
      fingerprint        TEXT NOT NULL,
      reason             TEXT NOT NULL,
      action_json        TEXT NOT NULL,
      status             TEXT NOT NULL
                         CHECK (status IN ('proposed','rejected','executing','succeeded','failed','verification_failed')),
      validation_json    TEXT,
      execution_json     TEXT,
      verification_json  TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_action_logs_failures ON action_logs(task_id, fingerprint, status);
    CREATE INDEX idx_action_logs_created ON action_logs(created_at);

    -- Append-only audit trail: every decision, validation, execution and verification.
    CREATE TABLE agent_events (
      id            INTEGER PRIMARY KEY,
      cycle_id      TEXT NOT NULL,
      kind          TEXT NOT NULL
                    CHECK (kind IN ('CYCLE_START','STATE','DECISION','PROPOSAL','VALIDATION',
                                    'EXECUTION','VERIFICATION','PLAN','CYCLE_END','ERROR')),
      action_id     TEXT,
      payload_json  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_agent_events_cycle ON agent_events(cycle_id);

    CREATE TABLE safety_violations (
      id            INTEGER PRIMARY KEY,
      cycle_id      TEXT,
      action_id     TEXT,
      code          TEXT NOT NULL,
      severity      TEXT NOT NULL CHECK (severity IN ('block','pause')),
      message       TEXT NOT NULL,
      details_json  TEXT NOT NULL,
      created_at    TEXT NOT NULL
    ) STRICT;

    CREATE TABLE named_locations (
      name        TEXT PRIMARY KEY,
      dimension   TEXT NOT NULL,
      x           REAL NOT NULL,
      y           REAL NOT NULL,
      z           REAL NOT NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('safe','storage','work','other')),
      note        TEXT,
      updated_at  TEXT NOT NULL
    ) STRICT;

    CREATE TABLE protected_items (
      item      TEXT PRIMARY KEY,
      reason    TEXT NOT NULL,
      source    TEXT NOT NULL CHECK (source IN ('config','user')),
      added_at  TEXT NOT NULL
    ) STRICT;
  `,
};
