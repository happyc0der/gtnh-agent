import type { Migration } from './index.ts';

/**
 * Window layouts the agent has seen, per block (src/domain/interactions.ts): how the window
 * of each block opened (a vanilla S2D type or a mod's FML GUI id), its slot count, where the
 * player's inventory appeared to be, and the items it showed. Blocks without a profile are
 * only looked at (observe-only); what was seen here is the material for writing a profile.
 */
export const migration006WindowLayouts: Migration = {
  version: 6,
  name: 'window-layouts',
  sql: /* sql */ `
    CREATE TABLE window_layouts (
      block            TEXT NOT NULL,
      opener           TEXT NOT NULL,
      slot_count       INTEGER NOT NULL,
      title            TEXT,
      profile          TEXT,
      container_slots  INTEGER,
      inventory_at     INTEGER,
      sample_json      TEXT NOT NULL,
      position_json    TEXT NOT NULL,
      times_seen       INTEGER NOT NULL,
      first_seen_at    TEXT NOT NULL,
      last_seen_at     TEXT NOT NULL,
      PRIMARY KEY (block, opener, slot_count)
    ) STRICT;
  `,
};
