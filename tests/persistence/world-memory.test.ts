import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SeenChunk } from '../../src/domain/world-memory.ts';
import { openDatabase, type Db } from '../../src/persistence/database.ts';
import { WorldMemoryRepository } from '../../src/persistence/world-memory-repository.ts';

let dir: string;
let db: Db;
let memory: WorldMemoryRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-world-memory-'));
  db = openDatabase(join(dir, 'agent.sqlite'));
  memory = new WorldMemoryRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seen = (over: Partial<SeenChunk> = {}): SeenChunk => ({
  dimension: 'overworld',
  chunkX: 2,
  chunkZ: -3,
  biome: { id: 229, name: 'Hot Forest', share: 0.8 },
  counts: { log: 12, leaves: 90 },
  examples: { log: [{ x: 35, y: 70, z: -40 }], leaves: [{ x: 36, y: 74, z: -40 }] },
  seenAt: '2026-09-30T12:00:00.000Z',
  ...over,
});

describe('world memory repository', () => {
  it('stores what was seen per chunk, and reads it back validated', () => {
    expect(memory.remember([seen(), seen({ chunkX: 3 })])).toBe(2);
    expect(memory.count()).toBe(2);
    expect(memory.count('overworld')).toBe(2);
    expect(memory.count('the_nether')).toBe(0);
    expect(memory.get('overworld', 2, -3)).toEqual(seen());
    expect(memory.chunks('overworld').map((c) => c.chunkX)).toEqual([2, 3]);
    expect(memory.get('overworld', 9, 9)).toBeNull();
    expect(memory.remember([])).toBe(0);
  });

  it('merges a new sighting into what is stored: a poor view never erases a good one', () => {
    memory.remember([seen()]);
    memory.remember([
      seen({
        biome: null,
        counts: { log: 2, water: 5 },
        examples: { log: [{ x: 33, y: 70, z: -45 }], water: [{ x: 40, y: 62, z: -40 }] },
        seenAt: '2026-09-30T12:10:00.000Z',
      }),
    ]);
    const c = memory.get('overworld', 2, -3);
    expect(c?.counts).toEqual({ log: 12, leaves: 90, water: 5 });
    expect(c?.examples.log).toEqual([
      { x: 33, y: 70, z: -45 },
      { x: 35, y: 70, z: -40 },
    ]);
    expect(c?.biome?.name).toBe('Hot Forest'); // the newer sighting carried none
    expect(c?.seenAt).toBe('2026-09-30T12:10:00.000Z');
    // Chunk coordinates are plain integers: chunk-grid rules can query them.
    const rows = db
      .prepare('SELECT chunk_x, chunk_z FROM world_chunks WHERE chunk_x % 3 = 2')
      .all();
    expect(rows).toEqual([{ chunk_x: 2, chunk_z: -3 }]);
  });

  it('refuses invalid sightings, and surfaces corrupted rows as errors', () => {
    expect(() => memory.remember([seen({ counts: { log: 0 } })])).toThrow();
    expect(memory.count()).toBe(0);
    memory.remember([seen()]);
    db.prepare('UPDATE world_chunks SET counts_json = \'{"diamonds": 3}\'').run();
    expect(() => memory.chunks('overworld')).toThrow();
  });
});
