import type { BlockPosition } from '../../domain/common.ts';
import { FOOD_GARDENS } from '../../domain/food.ts';
import type { WorldTime } from '../../domain/game-state.ts';
import {
  MAX_EXAMPLES,
  mergeSeen,
  SURVEY_KINDS,
  type SeenChunk,
  type SurveyKind,
} from '../../domain/world-memory.ts';
import { biomeName, UNSET_BIOME } from './biomes.ts';
import type { ColumnSections, ColumnView } from './chunk-data.ts';
import { PLAYER_EYE_HEIGHT } from './packets.ts';
import type { Registry } from './registry.ts';
import { PASSABLE_BLOCKS } from './passable.ts';
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
 * Beyond SURVEY_RANGE, out to FAR_SIGHT_RANGE, FAR SIGHT looks for what a player makes out
 * from afar: a column's top block (under any plants), when far sight counts its kind
 * (FAR_SIGHT_KINDS: a lake, a river, a beach, a gravel bank, a cliff), by the face a player
 * sees of it: its top face when the eyes are above it, else an open side face turned toward
 * the eyes (from below, a slope shows its risers), in a clear line of sight by the same rules.
 * A player spots a river or a cliff much farther away than 40 blocks; seen live: the agent
 * walked 94 chunks of desert and forest without ever seeing water, gravel or clay. A chunk that
 * lies wholly beyond SURVEY_RANGE is recorded only when far sight saw something in it: a player
 * cannot tell what ground hidden behind a hill is, biome and all.
 * Everything else stays unknown. Ores count as 'ore' only when seen; their material is never
 * guessed (GregTech keeps it in a tile entity the client does not read).
 */

/** Blocks below a column's top block that a survey looks at. */
export const SURVEY_DEPTH = 24;
/** Farthest a survey looks from the eyes at every kind (blocks). */
export const SURVEY_RANGE = 40;
/**
 * Farthest far sight looks from the eyes (blocks). The server's view distance is 8 chunks: the
 * client holds the 17 x 17 chunks around the player's own, at least 128 blocks each way. 112
 * leaves a chunk's margin for the chunks still on their way after the player crosses a border
 * (the server sends them a few at a time; an unloaded block blocks a line of sight anyway),
 * and it is about as far as a player with that view distance still makes out a lake through
 * the fog. Every line of sight then stays inside this circle, so in loaded chunks.
 */
export const FAR_SIGHT_RANGE = 112;
/**
 * What far sight counts: what stands out from afar on the ground and is worth walking to.
 * Water, and sand, gravel and clay (on the beds and banks of rivers and lakes, beaches,
 * deserts); stone (cliffs and mountain tops: cobblestone); lava (a hazard that glows). Not
 * logs (from afar only a canopy's are in view, too high to dig: seen live), leaves and grass
 * (dirt): the cover of nearly all land, the most lines of sight for nothing worth walking to,
 * nor ores: from afar an ore is a speck in a cliff, no different from its stone.
 */
export const FAR_SIGHT_KINDS: ReadonlySet<SurveyKind> = new Set<SurveyKind>([
  'water',
  'lava',
  'sand',
  'gravel',
  'clay',
  'stone',
]);
/**
 * Far kinds that come in sheets (deserts, beaches, mountainsides): far sight looks at them on
 * every second column each way, a quarter of them, which still shows where they lie; their
 * counts from afar are lower bounds, about a quarter of what was in view. The other far kinds
 * are looked at on every column: gravel and clay lie in patches of a few blocks (seen in the
 * test world: gravel on mountain slopes in patches of 3 x 2), and water and lava are what far
 * sight is for. Each line of sight from afar crosses some 50 to 150 blocks, and from low ground
 * most end in a hill: with every sand and stone top traced, a full survey of the bench terrain
 * (scripts/survey-bench.ts) took 9-30 ms; with a quarter of them, 5-12 ms.
 */
export const FAR_SHEET_KINDS: ReadonlySet<SurveyKind> = new Set<SurveyKind>(['sand', 'stone']);
/** Staying in the same chunk, the area is surveyed again at most this often (near only). */
export const RESURVEY_MS = 30_000;
/** Sightings kept until drained; beyond this the oldest are dropped (nobody is taking them). */
export const MAX_PENDING_SIGHTINGS = 4096;

const BY_NAME: ReadonlyMap<string, SurveyKind> = new Map<string, SurveyKind>([
  ['minecraft:log', 'log'],
  ['minecraft:log2', 'log'],
  ['minecraft:leaves', 'leaves'],
  ['minecraft:leaves2', 'leaves'],
  // Dirt, and the blocks that drop it when dug (the quest book's first quest wants 8 dirt).
  ['minecraft:dirt', 'dirt'],
  ['minecraft:grass', 'dirt'],
  ['minecraft:mycelium', 'dirt'],
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
  // Gardens that give food (seen: a plant with a face to the air), for the food trips.
  ...FOOD_GARDENS.map((g): [string, SurveyKind] => [g, 'garden']),
]);

/** How a block treats a line of sight. */
export const SIGHT = { blocked: 0, clear: 1, foliage: 2 } as const;
/**
 * Leaf blocks a line of sight may cross: leaves are not opaque in 1.7.10 (a player sees a
 * little way into a tree or a bush), but a canopy hides what is under it.
 */
export const MAX_FOLIAGE_CELLS = 2;

/** Blocks a line of sight passes through: the walker's passable plants, water, glass... */
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
  /**
   * Registry id -> 1 + index in SURVEY_KINDS of a kind far sight counts (0: not counted), plus
   * FAR_SHEET for the kinds in FAR_SHEET_KINDS.
   */
  readonly far: Uint8Array;
  /** Registry id -> SIGHT class (0 blocked: unnamed ids too). */
  readonly sight: Uint8Array;
}

/** In SurveyTables.far: a kind that comes in sheets (FAR_SHEET_KINDS). */
const FAR_SHEET = 0x80;
const FAR_KIND = 0x7f;

/** Ids are per world, so the tables are rebuilt from each login's registry. */
export function buildSurveyTables(registry: Registry): SurveyTables {
  const kinds = new Uint8Array(65536);
  const far = new Uint8Array(65536);
  const sight = new Uint8Array(65536);
  sight[0] = SIGHT.clear;
  for (const [id, name] of registry.blocks) {
    if (id <= 0 || id >= 65536) continue;
    const kind = surveyKindOf(name);
    if (kind !== null) kinds[id] = SURVEY_KINDS.indexOf(kind) + 1;
    if (kind !== null && FAR_SIGHT_KINDS.has(kind)) {
      far[id] = (SURVEY_KINDS.indexOf(kind) + 1) | (FAR_SHEET_KINDS.has(kind) ? FAR_SHEET : 0);
    }
    sight[id] = sightOf(name);
  }
  return { kinds, far, sight };
}

/**
 * True when the segment from `from` to `to` is not blocked: every block cell it passes
 * through, apart from the cells it starts and ends in, lets sight through (SIGHT.clear), or is
 * foliage, of which it crosses at most `foliage` cells (Amanatides-Woo voxel traversal). Plain
 * numbers only, no objects: a far survey traces tens of thousands of these.
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
  const endX = Math.floor(to.x);
  const endY = Math.floor(to.y);
  const endZ = Math.floor(to.z);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const sz = Math.sign(dz);
  // In units of the segment (0 at `from`, 1 at `to`): where the next cell boundary is crossed
  // on each axis, and how far apart the boundaries are.
  let tx = sx === 0 ? Infinity : (sx > 0 ? x + 1 - from.x : from.x - x) / Math.abs(dx);
  let ty = sy === 0 ? Infinity : (sy > 0 ? y + 1 - from.y : from.y - y) / Math.abs(dy);
  let tz = sz === 0 ? Infinity : (sz > 0 ? z + 1 - from.z : from.z - z) / Math.abs(dz);
  const dtx = sx === 0 ? Infinity : 1 / Math.abs(dx);
  const dty = sy === 0 ? Infinity : 1 / Math.abs(dy);
  const dtz = sz === 0 ? Infinity : 1 / Math.abs(dz);
  for (let step = 0; step < 1024; step++) {
    if (x === endX && y === endY && z === endZ) return true;
    const t = Math.min(tx, ty, tz);
    if (t > 1) return true; // every cell up to `to` was checked
    if (tx === t) {
      x += sx;
      tx += dtx;
    } else if (ty === t) {
      y += sy;
      ty += dty;
    } else {
      z += sz;
      tz += dtz;
    }
    if (x === endX && y === endY && z === endZ) continue;
    const cell = sight(x, y, z);
    if (cell === SIGHT.blocked) return false;
    if (cell === SIGHT.foliage && --leaves < 0) return false;
  }
  return false;
}

/** What a survey reads: loaded columns, with their biomes. */
export interface SurveyWorld {
  chunkColumn(cx: number, cz: number): ColumnView | undefined;
}

/** A block id at integer block coordinates; undefined where its column is not loaded. */
export type BlockReader = (x: number, y: number, z: number) => number | undefined;

/** The columns one survey reads, each looked up once. */
export interface SurveyReader {
  /** The loaded (and usable) column, or null. */
  column(cx: number, cz: number): ColumnView | null;
  /** As ChunkStore.blockAt: air above and below the world, undefined where not loaded. */
  blockAt: BlockReader;
}

/** Chunk coordinates as one number: |chunkZ| < 2^21 (the world is 30 M blocks across). */
const CHUNK_KEY = 4_194_304;
/** Not a chunk coordinate: no column is at hand yet. */
const NO_CHUNK = 1 << 30;

/**
 * Reads blocks through the columns of `world`, each looked up once and kept, with the last one
 * at hand: a line of sight reads one chunk's cells in a row, so it looks a column up per chunk
 * it crosses, not per cell. With ChunkStore.blockAt's string-keyed map lookup on every cell, a
 * near survey of the bench terrain (scripts/survey-bench.ts) took 50-80 ms for 5 x 5 chunks;
 * through a reader, 9-15 ms for every chunk within reach. One reader per survey: the columns
 * are read as they were when it began (a survey runs in one go, between packets).
 */
export function surveyReader(world: SurveyWorld): SurveyReader {
  const columns = new Map<number, ColumnView | null>();
  const column = (cx: number, cz: number): ColumnView | null => {
    const key = cx * CHUNK_KEY + cz;
    let c = columns.get(key);
    if (c === undefined) {
      c = world.chunkColumn(cx, cz) ?? null;
      columns.set(key, c);
    }
    return c;
  };
  let lastX = NO_CHUNK;
  let lastZ = NO_CHUNK;
  let last: ColumnSections | null = null;
  return {
    column,
    blockAt: (x, y, z) => {
      if (y < 0 || y > 255) return 0;
      const cx = x >> 4;
      const cz = z >> 4;
      if (cx !== lastX || cz !== lastZ) {
        last = column(cx, cz)?.sections ?? null;
        lastX = cx;
        lastZ = cz;
      }
      if (last === null) return undefined;
      const s = last[y >> 4];
      return s === null || s === undefined ? 0 : s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
    },
  };
}

export type ChunkSighting = Omit<SeenChunk, 'dimension' | 'seenAt'>;

/** A block's faces, as offsets to the cell they face: the top first (water's only one). */
const FACE_X = [0, 1, -1, 0, 0, 0] as const;
const FACE_Y = [1, 0, 0, 0, 0, -1] as const;
const FACE_Z = [0, 0, 0, 1, -1, 0] as const;
const WATER = SURVEY_KINDS.indexOf('water') + 1;

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

/**
 * A near column's cells as bits, from WINDOW_BELOW below its top block (bit 0) up: the band the
 * near survey looks at is bits 1 to WINDOW_BELOW (SURVEY_DEPTH below the top, to the top).
 */
const WINDOW_BELOW = SURVEY_DEPTH + 1;
/** Bits above the top block: air. */
const ABOVE_TOP = -1 << (WINDOW_BELOW + 1);
/** Columns a near survey reads each way from the eyes: those it looks at, and their neighbours. */
const NEAR_GRID = SURVEY_RANGE + 3;
const NOT_READ = 0;
const LOADED = 1;
const NOT_LOADED = 2;

/**
 * The near survey's columns around the eyes, each read once per survey: its top block, and as
 * bits which of its cells let sight through ("open": air, or what sight crosses) and which
 * hold a kind the survey counts. A block with no open neighbour cannot be seen, and most of the
 * band is buried ground: only blocks with an open neighbour get the close look (`seen`), which
 * decides exactly as before. Reading six neighbours of every block in the band (some 131
 * thousand blocks) was most of a near survey's time: on the bench terrain 9-15 ms became 4-11.
 */
interface NearColumns {
  readonly x0: number;
  readonly z0: number;
  readonly state: Uint8Array;
  readonly top: Int16Array;
  readonly open: Int32Array;
  readonly kinds: Int32Array;
}

const NEAR_SIDE = 2 * NEAR_GRID + 1;

function nearColumns(eye: Vec3): NearColumns {
  const n = NEAR_SIDE * NEAR_SIDE;
  return {
    x0: Math.floor(eye.x) - NEAR_GRID,
    z0: Math.floor(eye.z) - NEAR_GRID,
    state: new Uint8Array(n),
    top: new Int16Array(n),
    open: new Int32Array(n),
    kinds: new Int32Array(n),
  };
}

/** Column (x, z)'s index in `near`, read first if need be; -1 outside the grid. */
function nearColumn(
  near: NearColumns,
  reader: SurveyReader,
  tables: SurveyTables,
  x: number,
  z: number,
): number {
  const gx = x - near.x0;
  const gz = z - near.z0;
  if (gx < 0 || gz < 0 || gx >= NEAR_SIDE || gz >= NEAR_SIDE) return -1;
  const i = gz * NEAR_SIDE + gx;
  if (near.state[i] !== NOT_READ) return i;
  const sections = reader.column(x >> 4, z >> 4)?.sections ?? null;
  if (sections === null) {
    near.state[i] = NOT_LOADED;
    return i;
  }
  near.state[i] = LOADED;
  const lx = x & 15;
  const lz = z & 15;
  const top = topBlock(sections, lx, lz);
  near.top[i] = top;
  let open = ABOVE_TOP;
  let kinds = 0;
  for (let k = 0, y = top - WINDOW_BELOW; k <= WINDOW_BELOW; k++, y++) {
    if (y < 0) {
      open |= 1 << k; // below the world: air, as ChunkStore reads it
      continue;
    }
    const s = sections[y >> 4];
    const id = s === null || s === undefined ? 0 : (s[((y & 15) << 8) | (lz << 4) | lx] as number);
    if (tables.sight[id] !== SIGHT.blocked) open |= 1 << k;
    if (k > 0 && tables.kinds[id] !== 0) kinds |= 1 << k;
  }
  near.open[i] = open;
  near.kinds[i] = kinds;
  return i;
}

/**
 * Which cells of the window of a column whose top block is at `top` have their side open toward
 * neighbour column (x, z), as bits of that window. A neighbour not loaded opens nothing (a face
 * next to it does not count); cells the neighbour's window does not reach are above its top
 * (air), or below its window: not known here, so counted as open (seen() reads them).
 */
function sideOpen(
  near: NearColumns,
  reader: SurveyReader,
  tables: SurveyTables,
  x: number,
  z: number,
  top: number,
): number {
  const j = nearColumn(near, reader, tables, x, z);
  if (j < 0) return -1;
  if (near.state[j] === NOT_LOADED) return 0;
  const shift = top - (near.top[j] as number);
  const open = near.open[j] as number;
  if (near.top[j] === -1 || shift >= 32 || shift <= -32) return -1;
  if (shift > 0) return (open >>> shift) | (-1 << (32 - shift));
  if (shift < 0) return (open << -shift) | ~(-1 << -shift);
  return open;
}

/**
 * Far sight's block in a column: its top block, under anything sight passes through (a plant,
 * a snow layer, a lily pad), when far sight counts its kind; as y * 256 + its SurveyTables.far
 * entry, or -1 (the top is leaves, grass, a log...: nothing to make out from afar). So its top
 * face is open: only air and see-through blocks are above it.
 */
function farTop(sections: ColumnView['sections'], lx: number, lz: number, t: SurveyTables): number {
  for (let sec = 15; sec >= 0; sec--) {
    const s = sections[sec];
    if (s === null || s === undefined) continue;
    for (let ly = 15; ly >= 0; ly--) {
      const id = s[(ly << 8) | (lz << 4) | lx] as number;
      if (id === 0) continue;
      const kind = t.far[id] as number;
      if (kind !== 0) return (sec * 16 + ly) * 256 + kind;
      if (t.sight[id] !== SIGHT.clear) return -1;
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
 * loaded, lies wholly beyond SURVEY_RANGE (or, with `farSight`, beyond FAR_SIGHT_RANGE), or
 * lies wholly beyond SURVEY_RANGE and far sight saw nothing in it.
 */
export function surveyChunk(
  world: SurveyWorld,
  tables: SurveyTables,
  cx: number,
  cz: number,
  eye: Vec3,
  farSight = true,
): ChunkSighting | null {
  return surveyChunkWith(
    { reader: surveyReader(world), tables, eye, near: nearColumns(eye) },
    cx,
    cz,
    farSight,
  );
}

/** One survey's state: the columns it has read, from one place. */
interface Survey {
  readonly reader: SurveyReader;
  readonly tables: SurveyTables;
  readonly eye: Vec3;
  readonly near: NearColumns;
}

function surveyChunkWith(
  survey: Survey,
  cx: number,
  cz: number,
  farSight: boolean,
): ChunkSighting | null {
  const { reader, tables, eye } = survey;
  const nearX = Math.max(cx * 16, Math.min(eye.x, cx * 16 + 16));
  const nearZ = Math.max(cz * 16, Math.min(eye.z, cz * 16 + 16));
  const gap = Math.hypot(nearX - eye.x, nearZ - eye.z);
  const near = gap <= SURVEY_RANGE;
  if (!near && (!farSight || gap > FAR_SIGHT_RANGE)) return null;
  const col = reader.column(cx, cz);
  if (col === null) return null;

  const read = reader.blockAt;
  const sightTable = tables.sight;
  const sight = (x: number, y: number, z: number): number => {
    const id = read(x, y, z);
    return id === undefined ? SIGHT.blocked : (sightTable[id] as number);
  };
  const seen = (k: number, x: number, y: number, z: number): boolean => {
    for (let f = 0, faces = k === WATER ? 1 : 6; f < faces; f++) {
      const fx = FACE_X[f] as number;
      const fy = FACE_Y[f] as number;
      const fz = FACE_Z[f] as number;
      // A face touching air, or what sight crosses: leaves round a trunk, plants, water over a
      // riverbed (seen live: in bushy trees only the canopy's logs were ever seen).
      const n = read(x + fx, y + fy, z + fz);
      if (n === undefined || (n !== 0 && sightTable[n] === SIGHT.blocked)) continue;
      // Just past the face, in the cell next to it (the line's end cell is not checked).
      const px = x + 0.5 + 0.51 * fx;
      const py = y + 0.5 + 0.51 * fy;
      const pz = z + 0.5 + 0.51 * fz;
      const ex = px - eye.x;
      const ey = py - eye.y;
      const ez = pz - eye.z;
      if (Math.sqrt(ex * ex + ey * ey + ez * ez) > SURVEY_RANGE) continue;
      if (clearLine(eye, { x: px, y: py, z: pz }, sight)) return true;
    }
    return false;
  };
  /**
   * Far sight's look at a column's top block: its top face when the eyes are above it, else its
   * open side faces turned toward the eyes (water: only its top). A face whose plane the eyes
   * are not in front of cannot be seen: from below, a player sees a mountainside's risers, not
   * its treads. Seen in the test world's saved chunks: from a plateau at y 92 the only gravel
   * within far sight lay on a slope at y 104-105, 103 m south, its top faces out of view.
   */
  const seenFromAfar = (k: number, x: number, y: number, z: number): boolean => {
    const within = (px: number, py: number, pz: number): boolean => {
      const ex = px - eye.x;
      const ey = py - eye.y;
      const ez = pz - eye.z;
      return Math.sqrt(ex * ex + ey * ey + ez * ez) <= FAR_SIGHT_RANGE;
    };
    if (eye.y > y + 1) {
      // Just above the top face's centre, in the open cell over it (farTop: nothing above blocks).
      const p = { x: x + 0.5, y: y + 1.01, z: z + 0.5 };
      return within(p.x, p.y, p.z) && clearLine(eye, p, sight);
    }
    if (k === WATER) return false;
    const sx = eye.x > x + 1 ? 1 : eye.x < x ? -1 : 0;
    const sz = eye.z > z + 1 ? 1 : eye.z < z ? -1 : 0;
    for (const [fx, fz] of [
      [sx, 0],
      [0, sz],
    ] as const) {
      if (fx === 0 && fz === 0) continue;
      const n = read(x + fx, y, z + fz);
      if (n === undefined || (n !== 0 && sightTable[n] === SIGHT.blocked)) continue;
      const p = { x: x + 0.5 + 0.51 * fx, y: y + 0.5, z: z + 0.5 + 0.51 * fz };
      if (within(p.x, p.y, p.z) && clearLine(eye, p, sight)) return true;
    }
    return false;
  };

  const counts: ChunkSighting['counts'] = {};
  const examples: ChunkSighting['examples'] = {};
  const count = (k: number, x: number, y: number, z: number): void => {
    const kind = SURVEY_KINDS[k - 1] as SurveyKind;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const list: BlockPosition[] = examples[kind] ?? [];
    if (list.length < MAX_EXAMPLES) list.push({ x, y, z });
    examples[kind] = list;
  };
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const x = cx * 16 + lx;
      const z = cz * 16 + lz;
      const dx = x + 0.5 - eye.x;
      const dz = z + 0.5 - eye.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (near && d <= SURVEY_RANGE + 1) {
        // The band, from the top block down: the counted blocks with an open neighbour cell.
        const i = nearColumn(survey.near, reader, tables, x, z);
        const top = survey.near.top[i] as number;
        if (top < 0) continue;
        const own = survey.near.open[i] as number;
        const exposed =
          (own >>> 1) |
          (own << 1) |
          sideOpen(survey.near, reader, tables, x + 1, z, top) |
          sideOpen(survey.near, reader, tables, x - 1, z, top) |
          sideOpen(survey.near, reader, tables, x, z + 1, top) |
          sideOpen(survey.near, reader, tables, x, z - 1, top);
        const candidates = (survey.near.kinds[i] as number) & exposed;
        if (candidates === 0) continue;
        for (let k = WINDOW_BELOW, y = top; k > 0; k--, y--) {
          if (((candidates >>> k) & 1) === 0) continue;
          const section = col.sections[y >> 4] as Uint16Array;
          const kind = tables.kinds[section[((y & 15) << 8) | (lz << 4) | lx] as number] as number;
          if (seen(kind, x, y, z)) count(kind, x, y, z);
        }
      } else if (farSight && d <= FAR_SIGHT_RANGE) {
        const top = farTop(col.sections, lx, lz, tables);
        // Sheets on every second column each way only (FAR_SHEET_KINDS).
        if (top < 0 || ((top & FAR_SHEET) !== 0 && ((x | z) & 1) !== 0)) continue;
        const kind = top & FAR_KIND;
        if (seenFromAfar(kind, x, top >> 8, z)) count(kind, x, top >> 8, z);
      }
    }
  }
  if (!near && Object.keys(counts).length === 0) return null;
  return { chunkX: cx, chunkZ: cz, near, biome: dominantBiome(col.biomes), counts, examples };
}

/**
 * What the player, with its eyes at `eye`, sees of the chunks around it: those within
 * SURVEY_RANGE, and with `farSight` those within FAR_SIGHT_RANGE, as surveyChunk.
 */
export function surveyAround(
  world: SurveyWorld,
  tables: SurveyTables,
  eye: Vec3,
  farSight: boolean,
): ChunkSighting[] {
  const survey: Survey = { reader: surveyReader(world), tables, eye, near: nearColumns(eye) };
  const pcx = Math.floor(eye.x / 16);
  const pcz = Math.floor(eye.z / 16);
  const r = Math.ceil((farSight ? FAR_SIGHT_RANGE : SURVEY_RANGE) / 16);
  const out: ChunkSighting[] = [];
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      const sighting = surveyChunkWith(survey, pcx + dx, pcz + dz, farSight);
      if (sighting !== null) out.push(sighting);
    }
  }
  return out;
}

/**
 * A short account of sightings: "12 chunk(s) (Hot Desert 8, Hot Forest 4); log 40, sand 900",
 * or "40 chunk(s), 28 only from afar (...)" when far sight saw some of them.
 */
export function describeSightings(chunks: readonly SeenChunk[]): string {
  if (chunks.length === 0) return 'nothing (no survey: dark, or no chunk data yet)';
  const biomes = new Map<string, number>();
  const totals = new Map<SurveyKind, number>();
  const afar = chunks.filter((c) => !c.near).length;
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
    `${chunks.length} chunk(s)${afar === 0 ? '' : `, ${afar} only from afar`}` +
    `${named === '' ? '' : ` (${named})`}; ` +
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
 * EXPLORE hop). Far sight looks too on entering another chunk and when asked, not on the
 * re-surveys in the same chunk: from there the far view hardly changes, and far sight is most
 * of a survey's work. Only in daylight. Sightings are kept, merged per chunk, until drained.
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
    const here = `${dimension}:${Math.floor(feet.x / 16)},${Math.floor(feet.z / 16)}`;
    const t = now.getTime();
    const moved = here !== this.#lastChunk;
    if (!force && !moved && t - this.#lastAt < RESURVEY_MS) return [];
    if (registry !== this.#registry || this.#tables === null) {
      this.#tables = buildSurveyTables(registry);
      this.#registry = registry;
    }
    const tables = this.#tables;
    this.#lastChunk = here;
    this.#lastAt = t;
    const eye = { x: feet.x, y: feet.y + PLAYER_EYE_HEIGHT, z: feet.z };
    const out: SeenChunk[] = [];
    for (const sighting of surveyAround(world, tables, eye, force || moved)) {
      const seen: SeenChunk = { dimension, ...sighting, seenAt: now.toISOString() };
      out.push(seen);
      const key = `${dimension}:${seen.chunkX},${seen.chunkZ}`;
      const before = this.#pending.get(key);
      this.#pending.delete(key); // re-inserted last: the map stays oldest-first
      this.#pending.set(key, before === undefined ? seen : mergeSeen(before, seen));
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
