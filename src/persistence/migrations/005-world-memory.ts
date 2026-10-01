import type { Migration } from './index.ts';

/**
 * World memory: what the agent has seen, per chunk (src/domain/world-memory.ts). Chunk
 * coordinates are plain integers, so chunk-grid rules (GregTech's ore-vein grid) can be
 * queried later. Counts and examples are JSON (per kind), re-validated on read.
 */
export const migration005WorldMemory: Migration = {
  version: 5,
  name: 'world-memory',
  sql: /* sql */ `
    CREATE TABLE world_chunks (
      dimension      TEXT NOT NULL,
      chunk_x        INTEGER NOT NULL,
      chunk_z        INTEGER NOT NULL,
      biome_id       INTEGER,
      biome_name     TEXT,
      biome_share    REAL,
      counts_json    TEXT NOT NULL,
      examples_json  TEXT NOT NULL,
      seen_at        TEXT NOT NULL,
      PRIMARY KEY (dimension, chunk_x, chunk_z)
    ) STRICT;
  `,
};
