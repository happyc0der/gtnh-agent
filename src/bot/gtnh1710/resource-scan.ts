import { DIGGABLE_BLOCKS, GT_ORE_BLOCK, type DiggableBlock } from '../../domain/blocks.ts';
import { MAX_REPORTED_IN_REACH, MAX_REPORTED_RESOURCES } from '../../domain/game-state.ts';
import type { ChunkStore } from './chunk-data.ts';
import { MAX_DIG_REACH, reachTo } from './digging.ts';
import type { Registry } from './registry.ts';
import { SIGHT, sightOf } from './world-survey.ts';

/** Blocks around the player searched for diggable blocks (a sphere around the feet). */
export const RESOURCE_SCAN_RADIUS = 16;
/**
 * The nearest blocks this close to the feet (about as far as a dig reaches: 4.5 from the eyes,
 * 1.62 above the feet) fill up to half the list before the fair share between kinds, so a dig
 * a plan makes next to the player is not refused for a block the list left out. Seen live: in
 * a night pit's way out, the grass of the next step, 2.5 blocks away, was cut from a list of
 * 64 full of the pit's walls, and the dig was refused (NOT_DIGGABLE). Half, so that farther
 * kinds still show (a pit's walls must not crowd the logs out of view either).
 */
export const LISTED_FIRST_RADIUS = 5.5;

export interface FoundResource {
  block: DiggableBlock;
  position: { x: number; y: number; z: number };
  distance: number;
  /** A GT ore's material, when the server sent it (world-model.ts oreMetaAt). */
  ore?: number;
}

/** The kind a resource counts as in the fair share: its block, a GT ore by its material too. */
const kindOf = (f: FoundResource): string =>
  f.ore === undefined ? f.block : `${f.block}@${f.ore}`;

export type ResourceScan =
  | {
      ok: true;
      scanRadius: number;
      resources: FoundResource[];
      /** The rest within dig reach of the eyes, nearest to them first (NearbyBlocks.inReach). */
      inReach: FoundResource[];
    }
  | { ok: false; reason: string };

/**
 * Registry id -> 1 + index in DIGGABLE_BLOCKS (0 = not diggable). Ids are per world, so this
 * is rebuilt from each login's registry.
 */
export function buildDiggableTable(registry: Registry): Uint8Array {
  const table = new Uint8Array(65536);
  for (const [id, name] of registry.blocks) {
    const k = (DIGGABLE_BLOCKS as readonly string[]).indexOf(name);
    if (k >= 0 && id > 0 && id < 65536) table[id] = k + 1;
  }
  return table;
}

/**
 * Registry id -> 1 when a face touching that block is in view: leaves and plants, which sight
 * crosses (world-survey.ts sightOf), but not water (a riverbed block shows through it, yet
 * nothing dug there is safe). Seen live: in bushy Hot Forest trees every trunk log touches
 * leaves on all sides, so with air alone no log below the canopy was ever listed.
 */
export function buildSeeThroughTable(registry: Registry): Uint8Array {
  const table = new Uint8Array(65536);
  for (const [id, name] of registry.blocks) {
    if (id <= 0 || id >= 65536 || /water|lava/.test(name)) continue;
    if (sightOf(name) !== SIGHT.blocked) table[id] = 1;
  }
  return table;
}

export function diggableOf(table: Uint8Array, id: number): DiggableBlock | undefined {
  const k = table[id] ?? 0;
  return k === 0 ? undefined : DIGGABLE_BLOCKS[k - 1];
}

/**
 * Blocks one level below the feet that are listed: the ground a player digs for sand,
 * gravel and clay. Grass, dirt and the rest are left out down there: they are the floor
 * almost everywhere and would crowd out everything else.
 */
export const GROUND_RESOURCES: ReadonlySet<DiggableBlock> = new Set<DiggableBlock>([
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
]);

/**
 * Dirt and grass one level below the feet: the floor almost everywhere, so only the nearest
 * GROUND_DIRT_SAMPLE are listed (seen live: the first quest wants 8 dirt, and on flat grass
 * the agent saw none it could dig). A sample, not every one within the scan's radius.
 */
export const GROUND_DIRT: ReadonlySet<DiggableBlock> = new Set<DiggableBlock>([
  'minecraft:dirt',
  'minecraft:grass',
]);
export const GROUND_DIRT_SAMPLE = 8;

/**
 * Diggable blocks within a sphere around the feet, at or above the feet level, plus the
 * GROUND_RESOURCES one level below it, and any kind one level below in the columns right
 * beside the player (the next step of stairs down); nearest first (ties by position). Like a player, the
 * scan sees only EXPOSED blocks: at least one face touches air (no x-ray through the
 * ground). The blocks under the player itself are left out: they are never dug. Fail
 * closed: any column in range that has not arrived or could not be decoded makes the scan
 * unknown. At most `max` are listed: the nearest within LISTED_FIRST_RADIUS (up to half of
 * them), then the rest shared fairly between kinds (as domain/blocks.ts nearestOfEachKind does): of each kind its
 * nearest, so a kind that is not listed has no visible block within the declared radius. Only when more kinds are found than `max` does that radius shrink, below
 * the nearest block of the first kind left out. Every block within dig reach of the eyes that
 * the list leaves out comes in `inReach`, nearest to the eyes first: what a dig from here may
 * take (code's own plans dig there).
 */
export function scanResources(
  store: ChunkStore,
  table: Uint8Array,
  feet: { x: number; y: number; z: number },
  radius = RESOURCE_SCAN_RADIUS,
  max = MAX_REPORTED_RESOURCES,
  seeThrough?: Uint8Array,
  /** Blocks never listed (a player's build: never dug). */
  skip?: (x: number, y: number, z: number) => boolean,
  /** A GT ore's material, when known (world-model.ts oreMetaAt). */
  oreMeta?: (x: number, y: number, z: number) => number | undefined,
): ResourceScan {
  const r2 = radius * radius;
  const minX = Math.floor(feet.x - radius);
  const maxX = Math.floor(feet.x + radius);
  const minZ = Math.floor(feet.z - radius);
  const maxZ = Math.floor(feet.z + radius);
  const feetLevel = Math.floor(feet.y + 1e-6);
  const minY = Math.max(0, feetLevel - 1);
  // The columns the player's body stands in (half width 0.3), whose blocks below the feet
  // hold the player up.
  const ownX = [Math.floor(feet.x - 0.3), Math.floor(feet.x + 0.3)];
  const ownZ = [Math.floor(feet.z - 0.3), Math.floor(feet.z + 0.3)];
  // A face is in view when it touches air, or leaves or a plant (buildSeeThroughTable).
  const open = (x: number, y: number, z: number): boolean => {
    const id = store.blockAt(x, y, z);
    return id === 0 || (id !== undefined && seeThrough !== undefined && seeThrough[id] === 1);
  };
  const exposed = (x: number, y: number, z: number): boolean =>
    open(x + 1, y, z) ||
    open(x - 1, y, z) ||
    open(x, y + 1, z) ||
    open(x, y - 1, z) ||
    open(x, y, z + 1) ||
    open(x, y, z - 1);
  const maxY = Math.min(255, Math.floor(feet.y + radius));

  let missing = 0;
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++) {
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const problem = store.problem(cx, cz);
      if (problem === undefined) missing += 1;
      else if (problem !== null) {
        return { ok: false, reason: `chunk ${cx},${cz} block data unusable: ${problem}` };
      }
    }
  }
  if (missing > 0)
    return { ok: false, reason: `waiting for ${missing} nearby chunk(s) of block data` };

  const found: FoundResource[] = [];
  const groundDirt: FoundResource[] = [];
  for (let x = minX; x <= maxX; x++) {
    const dx = x + 0.5 - feet.x;
    for (let z = minZ; z <= maxZ; z++) {
      const dz = z + 0.5 - feet.z;
      const h2 = dx * dx + dz * dz;
      if (h2 > r2) continue;
      const sections = store.columnSections(Math.floor(x / 16), Math.floor(z / 16));
      if (sections === undefined)
        return { ok: false, reason: 'chunk block data changed during the scan' };
      for (let y = minY; y <= maxY; y++) {
        const section = sections[y >> 4];
        if (section === null || section === undefined) {
          y = y | 15; // an all-air section
          continue;
        }
        const dy = y + 0.5 - feet.y;
        if (h2 + dy * dy > r2) continue;
        const id = section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] as number;
        if (id === 0) continue;
        const block = diggableOf(table, id);
        const support =
          y < feetLevel &&
          x >= (ownX[0] as number) &&
          x <= (ownX[1] as number) &&
          z >= (ownZ[0] as number) &&
          z <= (ownZ[1] as number);
        if (block === undefined || support || !exposed(x, y, z)) continue;
        if (skip?.(x, y, z) === true) continue;
        const resource: FoundResource = {
          block,
          position: { x, y, z },
          distance: Math.sqrt(h2 + dy * dy),
        };
        const ore = block === GT_ORE_BLOCK ? oreMeta?.(x, y, z) : undefined;
        if (ore !== undefined) resource.ore = ore;
        // One level down right beside the player (any kind; dirt and grass there are the
        // nearest of the sample anyway): the next step of stairs going down. Seen live
        // 2026-10-04: "!tunnel down 4" stopped at its first stone step, never listed, so the
        // dig was refused (NOT_DIGGABLE).
        const beside =
          y === feetLevel - 1 &&
          Math.abs(dx) < 1.5 &&
          Math.abs(dz) < 1.5 &&
          !GROUND_DIRT.has(block);
        if (y >= feetLevel || GROUND_RESOURCES.has(block) || beside) found.push(resource);
        else if (GROUND_DIRT.has(block)) groundDirt.push(resource);
      }
    }
  }
  const byDistance = (a: FoundResource, b: FoundResource): number =>
    a.distance - b.distance ||
    a.position.x - b.position.x ||
    a.position.y - b.position.y ||
    a.position.z - b.position.z;
  // Every block seen, the ground's dirt and grass too: what a dig from here may take.
  const seen = [...found, ...groundDirt];
  found.push(...groundDirt.sort(byDistance).slice(0, GROUND_DIRT_SAMPLE));
  found.sort(byDistance);
  // The nearest in reach first (up to half the list), then the rest shared fairly by kind,
  // those already listed counting for theirs (nearestOfEachKind's ranks, carried on).
  const nearFirst = found
    .filter((f) => f.distance <= LISTED_FIRST_RADIUS)
    .slice(0, Math.floor(max / 2));
  const first = new Set(nearFirst);
  const shown = new Map<string, number>();
  for (const f of nearFirst) shown.set(kindOf(f), (shown.get(kindOf(f)) ?? 0) + 1);
  const ranked = found
    .filter((f) => !first.has(f))
    .map((f, order) => {
      const kind = kindOf(f);
      const rank = shown.get(kind) ?? 0;
      shown.set(kind, rank + 1);
      return { f, order, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, Math.max(0, max - nearFirst.length))
    .map((r) => r.f);
  const listed = [...nearFirst, ...ranked].sort(byDistance);
  /** The blocks within dig reach that `list` leaves out, nearest to the eyes first. */
  const reachable = (list: FoundResource[]): FoundResource[] => {
    const listedNow = new Set(list);
    return seen
      .filter((f) => !listedNow.has(f))
      .map((f) => ({ f, reach: reachTo(feet, f.position) }))
      .filter((r) => r.reach <= MAX_DIG_REACH + 1e-9)
      .sort((a, b) => a.reach - b.reach || byDistance(a.f, b.f))
      .slice(0, MAX_REPORTED_IN_REACH)
      .map((r) => r.f);
  };
  const kinds = new Set(listed.map(kindOf));
  const leftOut = found.find((f) => !kinds.has(kindOf(f)));
  if (leftOut === undefined) {
    return { ok: true, scanRadius: radius, resources: listed, inReach: reachable(listed) };
  }
  const kept = listed.filter((f) => f.distance < leftOut.distance);
  const coverage = Math.max(0, Math.floor((leftOut.distance - 1e-6) * 1000) / 1000);
  return { ok: true, scanRadius: coverage, resources: kept, inReach: reachable(kept) };
}
