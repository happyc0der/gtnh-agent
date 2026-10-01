import type { Migration } from './index.ts';

/**
 * World memory, far sight (src/bot/gtnh1710/world-survey.ts): whether a chunk has been seen
 * near at least once, every kind looked for (1), or only from afar, where far sight counts
 * landmarks on the top blocks (0). Every chunk stored before far sight was seen near.
 */
export const migration007WorldMemoryNear: Migration = {
  version: 7,
  name: 'world-memory-near',
  sql: /* sql */ `
    ALTER TABLE world_chunks ADD COLUMN near INTEGER NOT NULL DEFAULT 1 CHECK (near IN (0, 1));
  `,
};
