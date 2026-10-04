import type { Migration } from './index.ts';

/**
 * Owner commands (src/domain/owner-commands.ts): every command an owner gave, in chat or with
 * `cli command`, from the moment it was heard: who sent it and how, its raw text, the command
 * it parsed to (null until the model has translated natural language), where it stands
 * (queued, running, done, failed, cancelled) and the bot's last reply. A running `cli play`
 * picks up the ones queued from the command line between cycles.
 */
export const migration008OwnerCommands: Migration = {
  version: 8,
  name: 'owner-commands',
  sql: /* sql */ `
    CREATE TABLE owner_commands (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT NOT NULL CHECK (source IN ('chat','cli')),
      sender        TEXT NOT NULL,
      raw_text      TEXT NOT NULL,
      command_json  TEXT,
      status        TEXT NOT NULL
                    CHECK (status IN ('queued','running','done','failed','cancelled')),
      reply         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      started_at    TEXT,
      finished_at   TEXT
    ) STRICT;
    CREATE INDEX idx_owner_commands_status ON owner_commands(status, id);
  `,
};
