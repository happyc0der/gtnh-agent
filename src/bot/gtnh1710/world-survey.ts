import type { BlockPosition } from '../../domain/common.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import {
  MAX_EXAMPLES,
  mergeSeen,
  SURVEY_KINDS,
  type SeenChunk,
  type SurveyKind,
} from '../../domain/world-memory.ts';
import { biomeName, UNSET_BIOME } from './biomes.ts';
import type { ColumnView } from './chunk-data.ts';
import { PLAYER_EYE_HEIGHT } from './packets.ts';
import type { Registry } from './registry.ts';
import { PASSABLE_BLOCKS } from './terrain.ts';
import type { Vec3 } from './walking.ts';

/**
 * What the agent SEES around it, per chunk, for world memory (pure, apart from the tracker's
 * own bookkeeping). The client has every block of every loaded chunk, which is x-ray; a
 * player does not. So a block counts as seen only when, like for a player:
 *  - it lies near the surface: within SURVEY_DEPTH blocks below its column's top block
 *    (trees, the ground, cliff faces; not caves deep below);
 *  - one of its faces touches air (water: its top), so a player could see that face; blocks
 *    seen only through water (a lake bed) are left out, since the agent cannot dig them;
 *  - a straight line from the player's eyes to that face passes only through see-through
 *    blocks (air, water, glass, plants) and at most MAX_FOLIAGE_CELLS leaf blocks, within
 *    SURVEY_RANGE blocks (unloaded and unknown blocks block it);
 *  - it is day (the tracker surveys nothing in the evening or at night: unlit faces are not
 *    seen).
 * Everything else stays unknown. Ores count as 'ore' only when seen; their material is never
 * guessed (GregTech keeps it in a tile entity the client does not read).
 */

/** Blocks below a column's top block that a survey looks at. */
export const SURVEY_DEPTH = 24;
/** Farthest a survey looks from the eyes (blocks). */
export const SURVEY_RANGE = 40;
/** Chunks around the player's chunk a survey covers: 2 is a 5 x 5 square. */
export const SURVEY_RADIUS_CHUNKS = 2;
/** Staying in the same chunk, the area is surveyed again at most this often. */
export const RESURVEY_MS = 30_000;
/** Sightings kept until drained; beyond this the oldest are dropped (nobody is taking them). */
export const MAX_PENDING_SIGHTINGS = 4096;

const BY_NAME: ReadonlyMap<string, SurveyKind> = new Map<string, SurveyKind>([
  ['minecraft:log', 'log'],
  ['minecraft:log2', 'log'],
  ['minecraft:leaves', 'leaves'],
  ['minecraft:leaves2', 'leaves'],
  ['minecraft:sand', 'sand'],
  ['minecraft:gravel', 'gravel'],
  ['minecraft:clay', 'clay'],
  ['minecraft:water', 'water'],
  ['minecraft:flowing_water', 'water'],
  ['minecraft:lava', 'lava'],
  ['minecraft:flowing_lava', 'lava'],
  ['minecraft:stone', 'stone'],
  ['minecraft:cobblestone', 'stone'],
  ['minecraft:mossy_cobblestone', 'stone'],
]);

/** How a block treats a line of sight. */
export const SIGHT = { blocked: 0, clear: 1, foliage: 2 } as const;
/**
 * Leaf blocks a line of sight may cross: leaves are not opaque in 1.7.10 (a player sees a
 * little way into a tree or a bush), but a canopy hides what is under it.
 */
export const MAX_FOLIAGE_CELLS = 2;

/** Vanilla blocks a line of sight passes through. */
const SEE_THROUGH: ReadonlySet<string> = new Set([
  ...PASSABLE_BLOCKS,
  'minecraft:water',
  'minecraft:flowing_water',
  'minecraft:glass',
  'minecraft:glass_pane',
  'minecraft:stained_glass',
  'minecraft:stained_glass_pane',
  'minecraft:snow_layer',
  'minecraft:torch',
  'minecraft:vine',
  'minecraft:reeds',
  'minecraft:waterlily',
  'minecraft:web',
]);
/**
 * Modded plants, which have no full block: BiomesOPlenty foliage, plants, flowers, saplings
 * and bamboo, Natura and Pam's crops and gardens (seen on the test world's surface).
 */
const PLANT_PATH =
  /(foliage|plants?|flowers?\d*|saplings?\d*|garden|crops?|tallgrass|mushrooms|bamboo)$/i;
const LEAVES_PATH = /leaves|leaf/i;

/** How a block treats a line of sight; anything not known to let light through blocks it. */
export function sightOf(name: string): number {
  if (SEE_THROUGH.has(name)) return SIGHT.clear;
  const path = name.slice(name.indexOf(':') + 1);
  if (LEAVES_PATH.test(path)) return SIGHT.foliage;
  return PLANT_PATH.test(path) ? SIGHT.clear : SIGHT.blocked;
}

/**
 * True when a block's registry name says it is an ore: one of its words is "ore" or "ores"
 * (minecraft:iron_ore, BiomesOPlenty:gemOre, gregtech:gt.blockores). Ore berries are bushes.
 */
export function namesAnOre(name: string): boolean {
  const path = name.slice(name.indexOf(':') + 1);
  const words = path
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  if (words.some((w) => w.startsWith('berr'))) return false;
  return words.some((w) => /^(block)?ores?\d*$/.test(w));
}

export function surveyKindOf(name: string): SurveyKind | null {
  return BY_NAME.get(name) ?? (namesAnOre(name) ? 'ore' : null);
}

export interface SurveyTables {
  /** Registry id -> 1 + index in SURVEY_KINDS (0: not counted). */
  readonly kinds: Uint8Array;
  /** Registry id -> SIGHT class (0 blocked: unnamed ids too). */
  readonly sight: Uint8Array;
}

/** Ids are per world, so the tables are rebuilt from each login's registry. */
export function buildSurveyTables(registry: Registry): SurveyTables {
  const kinds = new Uint8Array(65536);
  const sight = new Uint8Array(65536);
  sight[0] = SIGHT.clear;
  for (const [id, name] of registry.blocks) {
    if (id <= 0 || id >= 65536) continue;
    const kind = surveyKindOf(name);
    if (kind !== null) kinds[id] = SURVEY_KINDS.indexOf(kind) + 1;
    sight[id] = sightOf(name);
  }
  return { kinds, sight };
}

/**
 * True when the segment from `from` to `to` is not blocked: every block cell it passes
 * through, apart from the cells it starts and ends in, lets sight through (SIGHT.clear), or is
 * foliage, of which it crosses at most `foliage` cells (Amanatides-Woo voxel traversal).
 */
export function clearLine(
  from: Vec3,
  to: Vec3,
  sight: (x: number, y: number, z: number) => number,
  foliage = MAX_FOLIAGE_CELLS,
): boolean {
  let leaves = foliage;
  let x = Math.floor(from.x);
  let y = Math.floor(from.y);
  let z = Math.floor(from.z);
  const end = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const s = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
  // In units of the segment (0 at `from`, 1 at `to`): where the next cell boundary is crossed
  // on each axis, and how far apart the boundaries are.
  const first = (p: number, c: number, dp: number, sp: number): number =>
    sp === 0 ? Infinity : (sp > 0 ? c + 1 - p : p - c) / Math.abs(dp);
  let tx = first(from.x, x, d.x, s.x);
  let ty = first(from.y, y, d.y, s.y);
  let tz = first(from.z, z, d.z, s.z);
  const dtx = s.x === 0 ? Infinity : 1 / Math.abs(d.x);
  const dty = s.y === 0 ? Infinity : 1 / Math.abs(d.y);
  const dtz = s.z === 0 ? Infinity : 1 / Math.abs(d.z);
  for (let step = 0; step < 1024; step++) {
    if (x === end.x && y === end.y && z === end.z) return true;
    const t = Math.min(tx, ty, tz);
    if (t > 1) return true; // every cell up to `to` was checked
    if (tx === t) {
      x += s.x;
      tx += dtx;
    } else if (ty === t) {
      y += s.y;
      ty += dty;
    } else {
      z += s.z;
      tz += dtz;
    }
    if (x === end.x && y === end.y && z === end.z) continue;
    const cell = sight(x, y, z);
    if (cell === SIGHT.blocked) return false;
    if (cell === SIGHT.foliage && --leaves < 0) return false;
  }
  return false;
}

/** What a survey reads: loaded columns (with biomes) and single blocks across chunk borders. */
export interface SurveyWorld {
  chunkColumn(cx: number, cz: number): ColumnView | undefined;
  blockAt(x: number, y: number, z: number): number | undefined;
}

export type ChunkSighting = Omit<SeenChunk, 'dimension' | 'seenAt'>;

const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
];
const TOP_ONLY: ReadonlyArray<readonly [number, number, number]> = [[0, 1, 0]];

function topBlock(sections: ColumnView['sections'], lx: number, lz: number): number {
  for (let sec = 15; sec >= 0; sec--) {
    const s = sections[sec];
    if (s === null || s === undefined) continue;
    for (let ly = 15; ly >= 0; ly--) {
      if (s[(ly << 8) | (lz << 4) | lx] !== 0) return sec * 16 + ly;
    }
  }
  return -1;
}

/** The most common biome of the columns (ids the server left unset are ignored). */
export function dominantBiome(biomes: Uint8Array | null): SeenChunk['biome'] {
  if (biomes === null || biomes.length === 0) return null;
  const counts = new Map<number, number>();
  for (const b of biomes) if (b !== UNSET_BIOME) counts.set(b, (counts.get(b) ?? 0) + 1);
  let best: [number, number] | null = null;
  for (const e of counts) {
    if (best === null || e[1] > best[1] || (e[1] === best[1] && e[0] < best[0])) best = e;
  }
  if (best === null) return null;
  return {
    id: best[0],
    name: biomeName(best[0]),
    share: Number((best[1] / biomes.length).toFixed(2)),
  };
}

/**
 * What the player, with its eyes at `eye`, sees of chunk (cx, cz); null when the chunk is not
 * loaded or lies wholly beyond SURVEY_RANGE.
 */
export function surveyChunk(
  world: SurveyWorld,
  tables: SurveyTables,
  cx: number,
  cz: number,
  eye: Vec3,
): ChunkSighting | null {
  const nearX = Math.max(cx * 16, Math.min(eye.x, cx * 16 + 16));
  const nearZ = Math.max(cz * 16, Math.min(eye.z, cz * 16 + 16));
  if (Math.hypot(nearX - eye.x, nearZ - eye.z) > SURVEY_RANGE) return null;
  const col = world.chunkColumn(cx, cz);
  if (col === undefined) return null;

  const sight = (x: number, y: number, z: number): number => {
    const id = world.blockAt(x, y, z);
    return id === undefined ? SIGHT.blocked : (tables.sight[id] ?? SIGHT.blocked);
  };
  const seen = (kind: SurveyKind, x: number, y: number, z: number): boolean => {
    for (const [fx, fy, fz] of kind === 'water' ? TOP_ONLY : FACES) {
      if (world.blockAt(x + fx, y + fy, z + fz) !== 0) continue;
      // Just past the face, in the air cell next to it.
      const p = { x: x + 0.5 + 0.51 * fx, y: y + 0.5 + 0.51 * fy, z: z + 0.5 + 0.51 * fz };
      if (Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z) > SURVEY_RANGE) continue;
      if (clearLine(eye, p, sight)) return true;
    }
    return false;
  };

  const counts: ChunkSighting['counts'] = {};
  const examples: ChunkSighting['examples'] = {};
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = cx * 16 + lx;
      const z = cz * 16 + lz;
      if (Math.hypot(x + 0.5 - eye.x, z + 0.5 - eye.z) > SURVEY_RANGE + 1) continue;
      const top = topBlock(col.sections, lx, lz);
      for (let y = top; y >= 0 && y >= top - SURVEY_DEPTH; y--) {
        const section = col.sections[y >> 4];
        if (section === null || section === undefined) continue;
        const id = section[((y & 15) << 8) | (lz << 4) | lx] as number;
        const k = id === 0 ? 0 : (tables.kinds[id] ?? 0);
        if (k === 0) continue;
        const kind = SURVEY_KINDS[k - 1] as SurveyKind;
        if (!seen(kind, x, y, z)) continue;
        counts[kind] = (counts[kind] ?? 0) + 1;
        const list: BlockPosition[] = examples[kind] ?? [];
        if (list.length < MAX_EXAMPLES) list.push({ x, y, z });
        examples[kind] = list;
      }
    }
  }
  return { chunkX: cx, chunkZ: cz, biome: dominantBiome(col.biomes), counts, examples };
}

/** A short account of sightings: "12 chunk(s) (Hot Desert 8, Hot Forest 4); log 40, sand 900". */
export function describeSightings(chunks: readonly SeenChunk[]): string {
  if (chunks.length === 0) return 'nothing (no survey: dark, or no chunk data yet)';
  const biomes = new Map<string, number>();
  const totals = new Map<SurveyKind, number>();
  for (const c of chunks) {
    if (c.biome !== null) biomes.set(c.biome.name, (biomes.get(c.biome.name) ?? 0) + 1);
    for (const kind of SURVEY_KINDS) {
      const n = c.counts[kind] ?? 0;
      if (n > 0) totals.set(kind, (totals.get(kind) ?? 0) + n);
    }
  }
  const named = [...biomes]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
  const kinds = SURVEY_KINDS.filter((k) => totals.has(k))
    .map((k) => `${k} ${totals.get(k)}`)
    .join(', ');
  return (
    `${chunks.length} chunk(s)${named === '' ? '' : ` (${named})`}; ` +
    (kinds === '' ? 'no logs, sand, gravel, clay, water, stone or ore in view' : kinds)
  );
}

/** The world as the tracker reads it (WorldModel provides all of it). */
export interface TrackedWorld extends SurveyWorld {
  readonly registry: Registry | null;
  readonly dimension: string | null;
  worldTimeAt(now: Date): WorldTime | null;
}

/**
 * Surveys the chunks around the player as it moves: when it has entered another chunk since
 * the last survey, when RESURVEY_MS have passed, or when asked to (`force`, e.g. after each
 * EXPLORE hop). Only in daylight. Sightings are kept, merged per chunk, until drained.
 */
export class SurveyTracker {
  #registry: Registry | null = null;
  #tables: SurveyTables | null = null;
  #lastChunk: string | null = null;
  #lastAt = -Infinity;
  readonly #pending = new Map<string, SeenChunk>();
  readonly #maxPending: number;

  constructor(maxPending = MAX_PENDING_SIGHTINGS) {
    this.#maxPending = maxPending;
  }

  /** Surveys if due; returns this survey's sightings (also kept until drained). */
  update(world: TrackedWorld, feet: Vec3, now: Date, force = false): SeenChunk[] {
    const { registry, dimension } = world;
    if (registry === null || dimension === null) return [];
    const time = world.worldTimeAt(now);
    if (time === null || time.phase === 'evening' || time.phase === 'night') return [];
    const pcx = Math.floor(feet.x / 16);
    const pcz = Math.floor(feet.z / 16);
    const here = `${dimension}:${pcx},${pcz}`;
    const t = now.getTime();
    if (!force && here === this.#lastChunk && t - this.#lastAt < RESURVEY_MS) return [];
    if (registry !== this.#registry || this.#tables === null) {
      this.#tables = buildSurveyTables(registry);
      this.#registry = registry;
    }
    const tables = this.#tables;
    this.#lastChunk = here;
    this.#lastAt = t;
    const eye = { x: feet.x, y: feet.y + PLAYER_EYE_HEIGHT, z: feet.z };
    const out: SeenChunk[] = [];
    const r = SURVEY_RADIUS_CHUNKS;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const sighting = surveyChunk(world, tables, pcx + dx, pcz + dz, eye);
        if (sighting === null) continue;
        const seen: SeenChunk = { dimension, ...sighting, seenAt: now.toISOString() };
        out.push(seen);
        const key = `${dimension}:${seen.chunkX},${seen.chunkZ}`;
        const before = this.#pending.get(key);
        this.#pending.delete(key); // re-inserted last: the map stays oldest-first
        this.#pending.set(key, before === undefined ? seen : mergeSeen(before, seen));
      }
    }
    for (const key of this.#pending.keys()) {
      if (this.#pending.size <= this.#maxPending) break;
      this.#pending.delete(key);
    }
    return out;
  }

  /** Every sighting not yet taken (merged per chunk); they are then forgotten here. */
  drain(): SeenChunk[] {
    const out = [...this.#pending.values()];
    this.#pending.clear();
    return out;
  }
}
