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
 * line of sight from the eyes, in daylight; and farther away, by far sight, the landmarks a
 * player makes out from afar on the top blocks: water, sand, gravel, clay, stone, lava
 * (src/bot/gtnh1710/world-survey.ts). Chunks never seen are unknown, whatever the server
 * sent. Chunk coordinates are kept as integers, so chunk-grid rules (such as GregTech's
 * ore-vein grid) can be applied to them later.
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
  // HarvestCraft's land gardens that give food (src/domain/food.ts FOOD_GARDENS).
  'garden',
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
  /**
   * Seen near at least once: some of it lay within the survey's range, where every kind is
   * looked for. False while only far sight has seen it, which counts landmarks on the top
   * blocks and nothing else (no trees, no grass): a lake spotted from afar is no look around.
   */
  near: z.boolean(),
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
 * a count is the most seen of that kind in any sighting (a later near look refines what far
 * sight saw, and a far one never lowers it); examples are kept (newest first) up to
 * MAX_EXAMPLES; the biome and the time come from the newer sighting; it is near once either is.
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
  return {
    ...newer,
    near: older.near || newer.near,
    biome: newer.biome ?? older.biome,
    counts,
    examples,
  };
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

/** The farthest an EXPLORE that looks for more of something goes in one go (blocks). */
export const WANDER_DISTANCE = 48;

/**
 * Where to look for more of something when none is in view and none is remembered: toward
 * the compass direction seen least (the summary's `seen`), with room left to explore that way
 * (at least `minRoom` blocks), as a person walks on into ground not yet seen to find more
 * trees; ties go to more room. A point up to WANDER_DISTANCE from `from`, or null when every
 * direction is out of room.
 */
export function wanderTarget(
  summary: ExplorationSummary,
  from: { x: number; z: number },
  minRoom: number,
): { x: number; z: number; direction: ExploreDirection; distance: number } | null {
  let best: { d: ExploreDirection; seen: number; room: number } | null = null;
  for (const [d, v] of Object.entries(summary.directions) as Array<
    [ExploreDirection, { seen: number; room: number }]
  >) {
    if (v.room < minRoom) continue;
    if (best === null || v.seen < best.seen || (v.seen === best.seen && v.room > best.room)) {
      best = { d, seen: v.seen, room: v.room };
    }
  }
  if (best === null) return null;
  const distance = Math.min(best.room, WANDER_DISTANCE);
  const u = COMPASS[best.d];
  return {
    x: Math.round(from.x + u.x * distance),
    z: Math.round(from.z + u.z * distance),
    direction: best.d,
    distance,
  };
}

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
  'garden',
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
  // One garden is a meal or three, and they are scattered.
  garden: 1,
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

/** Places per resource for the planner (the nearest, and a much richer one). */
const PLACES_PER_KIND = 2;
/**
 * The most places per resource a summary may hold: a GATHER asks for more (the nearest ones,
 * one after another: GATHER_PLACES in src/app/loop/plan-steps.ts).
 */
export const MAX_PLACES_PER_KIND = 8;
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
  places: z.array(KnownPlaceSchema).max(PLACE_KINDS.length * MAX_PLACES_PER_KIND),
  /** Biomes seen, nearest first. */
  biomes: z
    .array(
      z.strictObject({
        biome: z.string(),
        chunks: z.int().min(1),
        /** The centre of its nearest seen chunk (EXPLORE toward this x and z). */
        x: z.int(),
        z: z.int(),
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
 *
 * Chunks seen only from afar count like any other: their places are blocks that were seen
 * (water at x, y, z), their biomes were read from the chunk data, and a direction is seen as
 * far as a landmark was made out that way. Far sight records a chunk only where something
 * stood out, so a way whose view a hill or a canopy hid stays little seen: that is where a
 * player would go to look.
 */
export function summarizeExploration(input: {
  chunks: readonly SeenChunk[];
  from: Position;
  boundary: Box;
  now: Date;
  /**
   * Places per resource (default PLACES_PER_KIND, at most MAX_PLACES_PER_KIND): beyond the
   * nearest and a much richer one, the next nearest.
   */
  placesPerKind?: number;
}): ExplorationSummary {
  const { chunks, from, boundary, now } = input;
  const perKind = Math.min(MAX_PLACES_PER_KIND, input.placesPerKind ?? PLACES_PER_KIND);
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
    if (perKind > PLACES_PER_KIND) {
      for (const c of candidates) {
        if (picked.length >= perKind) break;
        if (!picked.includes(c)) picked.push(c);
      }
      picked.sort((a, b) => a.distance - b.distance);
    }
    for (const p of picked.slice(0, perKind)) {
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
        x: centreOf(b.nearest).x,
        z: centreOf(b.nearest).z,
        distance: Math.round(b.distance),
        direction: compassDirection(from, centreOf(b.nearest)),
      })),
  };
}
