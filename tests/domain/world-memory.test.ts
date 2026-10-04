import { describe, expect, it } from 'vitest';
import {
  compassDirection,
  ExplorationSummarySchema,
  mergeSeen,
  roomToEdge,
  SeenChunkSchema,
  summarizeExploration,
  wanderTarget,
  WANDER_DISTANCE,
  type ExplorationSummary,
  type SeenChunk,
} from '../../src/domain/world-memory.ts';

const T0 = '2026-09-30T12:00:00.000Z';
const chunk = (
  chunkX: number,
  chunkZ: number,
  counts: SeenChunk['counts'] = {},
  biome: string | null = 'Hot Desert',
  seenAt = T0,
): SeenChunk => ({
  dimension: 'overworld',
  chunkX,
  chunkZ,
  near: true,
  biome: biome === null ? null : { id: 230, name: biome, share: 1 },
  counts,
  examples: Object.fromEntries(
    Object.keys(counts).map((k) => [k, [{ x: chunkX * 16 + 3, y: 64, z: chunkZ * 16 + 5 }]]),
  ),
  seenAt,
});
const BOX = { min: { x: -256, y: 0, z: -256 }, max: { x: 256, y: 255, z: 256 } };

describe('world memory', () => {
  it('merges sightings of a chunk: the most seen of each kind, the newer biome and time', () => {
    const older = chunk(1, 2, { sand: 40, log: 3 }, 'Hot Desert', '2026-09-30T11:00:00.000Z');
    const newer = {
      ...chunk(1, 2, { sand: 12, water: 9 }, 'River Oasis', T0),
      examples: { sand: [{ x: 20, y: 63, z: 40 }], water: [{ x: 21, y: 63, z: 40 }] },
    };
    const merged = mergeSeen(newer, older); // order does not matter
    expect(merged.counts).toEqual({ log: 3, sand: 40, water: 9 });
    expect(merged.biome?.name).toBe('River Oasis');
    expect(merged.seenAt).toBe(T0);
    expect(merged.examples.sand).toEqual([
      { x: 20, y: 63, z: 40 },
      { x: 19, y: 64, z: 37 },
    ]);
    expect(SeenChunkSchema.safeParse(merged).success).toBe(true);
    expect(mergeSeen(newer, { ...older, biome: null }).biome?.name).toBe('River Oasis');
    expect(mergeSeen({ ...newer, biome: null }, older).biome?.name).toBe('Hot Desert');
  });

  it('a near look refines what far sight saw, and far sight never lowers it', () => {
    const afar = { ...chunk(6, 0, { water: 12, sand: 4 }), near: false };
    const close = chunk(
      6,
      0,
      { water: 40, sand: 90, dirt: 30 },
      'River Oasis',
      '2026-09-30T12:05:00.000Z',
    );
    const refined = mergeSeen(afar, close);
    expect(refined).toMatchObject({ near: true, counts: { water: 40, sand: 90, dirt: 30 } });
    // Seen from afar again later: still near, still the counts of the near look.
    const later = { ...afar, seenAt: '2026-09-30T12:10:00.000Z' };
    expect(mergeSeen(refined, later)).toMatchObject({ near: true, counts: { water: 40 } });
    expect(mergeSeen(afar, later).near).toBe(false);
  });

  it('offers what far sight saw as places, and counts its chunks toward how far a way is seen', () => {
    // Water far sight saw 104 blocks east, and nothing else that way.
    const lake = {
      ...chunk(7, 0, { water: 20 }, 'River Oasis'),
      near: false,
      examples: { water: [{ x: 115, y: 62, z: 9 }] },
    };
    const summary = summarizeExploration({
      chunks: [chunk(0, 0, { sand: 200 }), lake],
      from: { x: 8, y: 64, z: 8 },
      boundary: BOX,
      now: new Date('2026-09-30T12:03:00.000Z'),
    });
    expect(summary.places.find((p) => p.resource === 'water')).toMatchObject({
      x: 115,
      y: 62,
      z: 9,
      distance: 107,
      direction: 'east',
      count: 20,
      biome: 'River Oasis',
    });
    expect(summary.directions.east.seen).toBe(120);
    expect(summary.directions.west.seen).toBeLessThan(20);
    expect(summary.chunksSeen).toBe(2);
  });

  it('names directions (north is -z) and measures the room left to the boundary', () => {
    const o = { x: 0, z: 0 };
    expect(compassDirection(o, { x: 0, z: -20 })).toBe('north');
    expect(compassDirection(o, { x: 20, z: 20 })).toBe('south_east');
    expect(compassDirection(o, { x: -20, z: 1 })).toBe('west');
    expect(compassDirection(o, { x: 3, z: 3 })).toBe('here');
    expect(roomToEdge({ x: 200, z: 0 }, 'east', BOX)).toBe(56);
    expect(roomToEdge({ x: 0, z: 0 }, 'north_west', BOX)).toBeCloseTo(256 * Math.SQRT2, 6);
    expect(roomToEdge({ x: 300, z: 0 }, 'west', BOX)).toBe(0);
  });

  it('tells the planner the nearest place per resource, a much richer one, biomes and directions', () => {
    const chunks = [
      chunk(0, 0, { sand: 200 }), // around the player
      chunk(0, 3, { log: 4, leaves: 30 }, 'Hot Forest'), // 48 blocks south
      chunk(1, 5, { log: 40, leaves: 300 }, 'Hot Forest'), // farther, ten times the logs
      chunk(4, 0, { water: 30, gravel: 6, clay: 2, sand: 9 }, 'River Oasis'),
      chunk(-2, -1, { stone: 5 }), // too few to count as a place
    ];
    const summary = summarizeExploration({
      chunks,
      from: { x: 8, y: 64, z: 8 },
      boundary: BOX,
      now: new Date('2026-09-30T12:03:00.000Z'),
    });
    expect(ExplorationSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.chunksSeen).toBe(5);
    const logs = summary.places.filter((p) => p.resource === 'log');
    expect(logs.map((p) => [p.x, p.z, p.count, p.direction])).toEqual([
      [3, 53, 4, 'south'],
      [19, 85, 40, 'south'],
    ]);
    expect(logs[0]).toMatchObject({ biome: 'Hot Forest', seenMinutesAgo: 3 });
    expect(summary.places.find((p) => p.resource === 'sand')).toMatchObject({
      direction: 'here',
      count: 200,
    });
    expect(summary.places.find((p) => p.resource === 'clay')).toMatchObject({
      x: 67,
      z: 5,
      direction: 'east',
    });
    expect(summary.places.some((p) => p.resource === 'stone')).toBe(false);
    expect(summary.biomes.map((b) => [b.biome, b.chunks])).toEqual([
      ['Hot Desert', 2],
      ['Hot Forest', 2],
      ['River Oasis', 1],
    ]);
    expect(summary.directions.south.seen).toBeGreaterThan(80);
    expect(summary.directions.north.seen).toBeLessThan(20);
    // The river's chunk: its centre is 64 blocks east, its far side 72.
    expect(summary.directions.east).toEqual({ seen: 72, room: 248 });
  });

  it('is empty, but complete, before anything was seen', () => {
    const summary = summarizeExploration({
      chunks: [],
      from: { x: 0, y: 64, z: 0 },
      boundary: BOX,
      now: new Date(T0),
    });
    expect(summary).toMatchObject({ chunksSeen: 0, places: [], biomes: [] });
    expect(Object.keys(summary.directions)).toHaveLength(8);
    expect(summary.directions.north).toEqual({ seen: 0, room: 256 });
  });
});

describe('wanderTarget: where to look on for more of something', () => {
  const dirs = (seen: Partial<Record<string, number>>, room = 200) =>
    Object.fromEntries(
      [
        'north',
        'north_east',
        'east',
        'south_east',
        'south',
        'south_west',
        'west',
        'north_west',
      ].map((d) => [d, { seen: seen[d] ?? 100, room }]),
    ) as ExplorationSummary['directions'];
  const summary = (directions: ExplorationSummary['directions']): ExplorationSummary => ({
    chunksSeen: 40,
    directions,
    places: [],
    biomes: [],
  });

  it('heads the way seen least, at most WANDER_DISTANCE, with room left', () => {
    const t = wanderTarget(summary(dirs({ east: 10 })), { x: 0.5, z: 0.5 }, 8);
    expect(t).toEqual({ x: 49, z: 1, direction: 'east', distance: WANDER_DISTANCE });
    // Less room than that: as far as the room goes; none anywhere: nowhere.
    const close = wanderTarget(summary(dirs({ south: 0 }, 20)), { x: 0, z: 0 }, 8);
    expect(close).toEqual({ x: 0, z: 20, direction: 'south', distance: 20 });
    expect(wanderTarget(summary(dirs({}, 5)), { x: 0, z: 0 }, 8)).toBeNull();
  });
});
