import type { Migration } from './index.ts';

/**
 * Players' builds (src/domain/player-builds.ts): blocks the agent saw a player put down, which
 * it never breaks, one row per block, keyed by chunk too so the blocks of the chunks around
 * the player can be read at once. A restart keeps them.
 */
export const migration009PlayerBuilds: Migration = {
  version: 9,
  name: 'player-builds',
  sql: /* sql */ `
    CREATE TABLE player_builds (
      dimension  TEXT NOT NULL,
      chunk_x    INTEGER NOT NULL,
      chunk_z    INTEGER NOT NULL,
      x          INTEGER NOT NULL,
      y          INTEGER NOT NULL,
      z          INTEGER NOT NULL,
      block      TEXT NOT NULL,
      seen_at    TEXT NOT NULL,
      PRIMARY KEY (dimension, x, y, z)
    ) STRICT;
    CREATE INDEX idx_player_builds_chunk ON player_builds(dimension, chunk_x, chunk_z);
  `,
};
