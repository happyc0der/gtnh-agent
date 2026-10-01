import { z } from 'zod';
import { EXPLORE_DIRECTIONS, ExploreDirectionSchema, type ExploreDirection } from './actions.ts';
import {
  BlockPositionSchema,
  COORDINATE_LIMIT,
  DimensionSchema,
  TimestampSchema,
  type BlockPosition,
  type Position,
} from './common.ts';
import type { Box } from './geometry.ts';

/**
 * World memory: what the agent has SEEN while moving, per chunk (16 x 16 columns). Only what
 * a player could see counts: blocks near the surface with a face touching air, in a clear
 * line of sight from the eyes, in daylight (src/bot/gtnh1710/world-survey.ts). Chunks never
 * seen are unknown, whatever the server sent. Chunk coordinates are kept as integers, so
 * chunk-grid rules (such as GregTech's ore-vein grid) can be applied to them later.
 */

/** What a survey counts, by block name (world-survey.ts maps names to kinds). */
export const SURVEY_KINDS = [
  'log',
  'leaves',
  'dirt',
  'sand',
  'gravel',
  'clay',
  'water',
  'lava',
  'stone',
  'ore',
] as const;
export const SurveyKindSchema = z.enum(SURVEY_KINDS);
export type SurveyKind = z.infer<typeof SurveyKindSchema>;

/** Seen blocks kept per kind and chunk, as examples. */
export const MAX_EXAMPLES = 3;
const CHUNK_LIMIT = Math.ceil(COORDINATE_LIMIT / 16);

export const SeenBiomeSchema = z.strictObject({
  id: z.int().min(0).max(255),
  name: z.string().min(1).max(64),
  /** Share of the chunk's 256 columns in this biome. */
  share: z.number().min(0).max(1),
});

export const SeenChunkSchema = z.strictObject({
  dimension: DimensionSchema,
  chunkX: z.int().min(-CHUNK_LIMIT).max(CHUNK_LIMIT),
  chunkZ: z.int().min(-CHUNK_LIMIT).max(CHUNK_LIMIT),
  /** The most common biome of its columns; null when the chunk data carried no biomes. */
  biome: SeenBiomeSchema.nullable(),
  /** How many blocks of each kind were seen (kinds not seen are absent). */
  counts: z.partialRecord(SurveyKindSchema, z.int().min(1).max(65_536)),
  /** A few of the seen blocks of each counted kind. */
  examples: z.partialRecord(
    SurveyKindSchema,
    z.array(BlockPositionSchema).min(1).max(MAX_EXAMPLES),
  ),
  seenAt: TimestampSchema,
});
export type SeenChunk = z.infer<typeof SeenChunkSchema>;

const samePosition = (a: BlockPosition, b: BlockPosition): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * Two sightings of one chunk. Each sees only what is in view from where the player stood, so
 * a count is the most seen of that kind in any sighting; examples are kept (newest first) up
 * to MAX_EXAMPLES; the biome and the time come from the newer sighting.
 */
export function mergeSeen(a: SeenChunk, b: SeenChunk): SeenChunk {
  const [older, newer] = Date.parse(a.seenAt) <= Date.parse(b.seenAt) ? [a, b] : [b, a];
  const counts: SeenChunk['counts'] = {};
  const examples: SeenChunk['examples'] = {};
  for (const kind of SURVEY_KINDS) {
    const n = Math.max(older.counts[kind] ?? 0, newer.counts[kind] ?? 0);
    if (n > 0) counts[kind] = n;
    const all = [...(newer.examples[kind] ?? []), ...(older.examples[kind] ?? [])];
    const kept = all
      .filter((p, i) => all.findIndex((q) => samePosition(p, q)) === i)
      .slice(0, MAX_EXAMPLES);
    if (kept.length > 0) examples[kind] = kept;
  }
  return { ...newer, biome: newer.biome ?? older.biome, counts, examples };
}

// ---------------------------------------------------------------------------
// Directions
// ---------------------------------------------------------------------------

const D = Math.SQRT1_2;
/** Unit vectors of the compass directions: north is -z, east is +x. */
export const COMPASS: Readonly<Record<ExploreDirection, { x: number; z: number }>> = {
  north: { x: 0, z: -1 },
  north_east: { x: D, z: -D },
  east: { x: 1, z: 0 },
  south_east: { x: D, z: D },
  south: { x: 0, z: 1 },
  south_west: { x: -D, z: D },
  west: { x: -1, z: 0 },
  north_west: { x: -D, z: -D },
};

/** Clockwise from east, 45 degrees apart (atan2 over x east, z south). */
const BY_ANGLE: readonly ExploreDirection[] = [
  'east',
  'south_east',
  'south',
  'south_west',
  'west',
  'north_west',
  'north',
  'north_east',
];

/** The compass direction from one point to another; 'here' when closer than `near` blocks. */
export function compassDirection(
  from: { x: number; z: number },
  to: { x: number; z: number },
  near = 8,
): ExploreDirection | 'here' {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < near) return 'here';
  const sector = Math.round(Math.atan2(dz, dx) / (Math.PI / 4));
  return BY_ANGLE[((sector % 8) + 8) % 8] as ExploreDirection;
}

/** Blocks from `from` to the edge of the box's x/z area, going in `direction` (0 when outside). */
export function roomToEdge(
  from: { x: number; z: number },
  direction: ExploreDirection,
  box: Box,
): number {
  const d = COMPASS[direction];
  if (from.x < box.min.x || from.x > box.max.x || from.z < box.min.z || from.z > box.max.z) {
    return 0;
  }
  let t = Infinity;
  if (d.x > 0) t = Math.min(t, (box.max.x - from.x) / d.x);
  if (d.x < 0) t = Math.min(t, (box.min.x - from.x) / d.x);
  if (d.z > 0) t = Math.min(t, (box.max.z - from.z) / d.z);
  if (d.z < 0) t = Math.min(t, (box.min.z - from.z) / d.z);
  return Math.max(0, t);
}

// ---------------------------------------------------------------------------
// The planner's view: known places and how far each way has been seen
// ---------------------------------------------------------------------------

/** Kinds offered to the planner as places to go (leaves go with logs; lava is a hazard). */
export const PLACE_KINDS = [
  'log',
  'dirt',
  'sand',
  'gravel',
  'clay',
  'water',
  'stone',
  'ore',
] as const;
export type PlaceKind = (typeof PLACE_KINDS)[number];

/** The fewest seen blocks of a kind for a chunk to count as a place to gather it. */
export const PLACE_MINIMUM: Readonly<Record<PlaceKind, number>> = {
  log: 3,
  dirt: 4,
  sand: 8,
  gravel: 3,
  clay: 2,
  water: 8,
  stone: 8,
  ore: 1,
};

const DirectionOrHereSchema = z.enum([...EXPLORE_DIRECTIONS, 'here']);

export const KnownPlaceSchema = z.strictObject({
  resource: z.enum(PLACE_KINDS),
  /** A seen block of it (EXPLORE toward this x and z); y is null when only its chunk is known. */
  x: z.int(),
  y: z.int().nullable(),
  z: z.int(),
  /** Blocks from the player (horizontal), and which way. */
  distance: z.int().min(0),
  direction: DirectionOrHereSchema,
  /** How many were seen in that chunk. */
  count: z.int().min(1),
  biome: z.string().nullable(),
  seenMinutesAgo: z.number().min(0),
});
export type KnownPlace = z.infer<typeof KnownPlaceSchema>;

/** At most this many places per resource (the nearest, and a much richer one). */
const PLACES_PER_KIND = 2;
const MAX_BIOMES = 8;

export const ExplorationSummarySchema = z.strictObject({
  /** Chunks (16 x 16 blocks) the agent has seen in this dimension. */
  chunksSeen: z.int().min(0),
  /**
   * Per compass direction: how far (blocks) the agent has seen that way, and the room left
   * to the exploration boundary (the safety boundary) that way.
   */
  directions: z.record(
    ExploreDirectionSchema,
    z.strictObject({ seen: z.int().min(0), room: z.int().min(0) }),
  ),
  /** Per resource, the nearest seen place with enough of it (and a much richer one). */
  places: z.array(KnownPlaceSchema).max(PLACE_KINDS.length * PLACES_PER_KIND),
  /** Biomes seen, nearest first. */
  biomes: z
    .array(
      z.strictObject({
        biome: z.string(),
        chunks: z.int().min(1),
        distance: z.int().min(0),
        direction: DirectionOrHereSchema,
      }),
    )
    .max(MAX_BIOMES),
});
export type ExplorationSummary = z.infer<typeof ExplorationSummarySchema>;

const centreOf = (c: SeenChunk): { x: number; z: number } => ({
  x: c.chunkX * 16 + 8,
  z: c.chunkZ * 16 + 8,
});

/**
 * What the planner gets from world memory: per resource the nearest place seen with enough
 * of it (plus a much richer one, if any), the biomes seen, and per direction how far it has
 * been seen and how much room is left to the boundary. Distances are horizontal blocks from
 * `from`. Pure.
 */
export function summarizeExploration(input: {
  chunks: readonly SeenChunk[];
  from: Position;
  boundary: Box;
  now: Date;
}): ExplorationSummary {
  const { chunks, from, boundary, now } = input;
  const flat = (p: { x: number; z: number }): number => Math.hypot(p.x - from.x, p.z - from.z);
  const minutesAgo = (c: SeenChunk): number =>
    Math.max(0, Number(((now.getTime() - Date.parse(c.seenAt)) / 60_000).toFixed(1)));

  const places: KnownPlace[] = [];
  for (const resource of PLACE_KINDS) {
    const candidates = chunks
      .filter((c) => (c.counts[resource] ?? 0) >= PLACE_MINIMUM[resource])
      .map((c) => {
        const example = c.examples[resource]?.[0];
        const at = example ?? { ...centreOf(c), y: null };
        return { c, at, count: c.counts[resource] ?? 0, distance: flat(at) };
      })
      .sort((a, b) => a.distance - b.distance || b.count - a.count);
    const nearest = candidates[0];
    if (nearest === undefined) continue;
    const picked = [nearest];
    const richest = [...candidates].sort((a, b) => b.count - a.count || a.distance - b.distance)[0];
    if (richest !== undefined && richest !== nearest && richest.count >= 2 * nearest.count) {
      picked.push(richest);
    }
    for (const p of picked.slice(0, PLACES_PER_KIND)) {
      places.push({
        resource,
        x: p.at.x,
        y: p.at.y,
        z: p.at.z,
        distance: Math.round(p.distance),
        direction: compassDirection(from, p.at),
        count: p.count,
        biome: p.c.biome?.name ?? null,
        seenMinutesAgo: minutesAgo(p.c),
      });
    }
  }

  const biomes = new Map<string, { chunks: number; nearest: SeenChunk; distance: number }>();
  for (const c of chunks) {
    if (c.biome === null) continue;
    const d = flat(centreOf(c));
    const b = biomes.get(c.biome.name);
    if (b === undefined) biomes.set(c.biome.name, { chunks: 1, nearest: c, distance: d });
    else {
      b.chunks += 1;
      if (d < b.distance) Object.assign(b, { nearest: c, distance: d });
    }
  }

  const directions = Object.fromEntries(
    EXPLORE_DIRECTIONS.map((direction) => {
      const u = COMPASS[direction];
      let seen = 0;
      for (const c of chunks) {
        const p = centreOf(c);
        const d = flat(p);
        // A chunk counts toward a direction when its centre lies within 22.5 degrees of it
        // (the chunks right around the player count toward every direction).
        const inCone =
          d < 12 || ((p.x - from.x) * u.x + (p.z - from.z) * u.z) / d >= Math.cos(Math.PI / 8);
        if (inCone) seen = Math.max(seen, d + 8);
      }
      return [
        direction,
        {
          seen: Math.round(seen),
          room: Math.floor(roomToEdge(from, direction, boundary)),
        },
      ];
    }),
  ) as ExplorationSummary['directions'];

  return {
    chunksSeen: chunks.length,
    directions,
    places,
    biomes: [...biomes]
      .sort((a, b) => a[1].distance - b[1].distance)
      .slice(0, MAX_BIOMES)
      .map(([biome, b]) => ({
        biome,
        chunks: b.chunks,
        distance: Math.round(b.distance),
        direction: compassDirection(from, centreOf(b.nearest)),
      })),
  };
}
