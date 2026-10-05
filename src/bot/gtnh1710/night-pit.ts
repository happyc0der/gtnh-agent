import type { BlockPosition } from '../../domain/common.ts';
import {
  FALLING_DIGGABLE_BLOCKS,
  placedBlockOf,
  type DiggableBlock,
  type PlaceableItem,
} from '../../domain/blocks.ts';
import { NIGHT_PIT_DEPTH, PIT_ROOF_ITEMS, type ShelterStep } from '../../domain/night-shelter.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import {
  checkDig,
  checkDigDown,
  inOneColumn,
  onBlockTop,
  type BlockPos,
  type DigArea,
} from './digging.ts';
import { passProblem } from './passable.ts';
import { goalBlock, goalOut } from './pathing/goals.ts';
import { planPath, type PathOptions } from './pathing/search.ts';
import { checkPlace } from './placing.ts';
import {
  planTerrainWalk,
  reachableFeet,
  standProblem,
  TERRAIN_SURFACES,
  walksAway,
} from './terrain.ts';
import { WALKABLE_SURFACES, type Fence, type Vec3, type WalkWorld } from './walking.ts';

/**
 * The night pit and the way out of a shelter in the morning, planned by code with the live
 * client's own rules (pure; no I/O). A first-night player on flat ground digs straight down
 * three times and roofs the hole with a block placed in the ground layer it dug through:
 * that cell's four side neighbours are natural ground, whose inner faces look at the eyes
 * from the pit's floor, so the roof can be placed against them (seen live 2026-10-01: a
 * raised box cannot be roofed from inside). Every step the plan lists is an action the
 * executor validates again when it runs; the plan only decides what to do and in what order.
 *
 * Before the agent digs itself in, the plan checks on a what-if copy of the world
 * (PlannedWorld) that each of the three digs passes checkDigDown (exactly one block down,
 * no fluid, hazard or unloaded block near), that the 3 x 3 columns around stay solid down to
 * the pit's floor (natural walls; sand and gravel only on solid ground), that the roof can
 * be placed (checkPlace) with a block it can dig again in the morning, and that a way out
 * exists then (planShelterExit: checkDig for every dig, the walker for the walk out).
 */

/** Where a pit is: its column and its ground layer (the top block, dug first, the roof's cell). */
export interface PitSite {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
}

export interface PitOptions {
  /** The fence and dig heights the client uses now (digging.ts). */
  area: DigArea;
  /** The walker's longest path (movement.maxPathLength). */
  maxPathLength: number;
  /**
   * Why the player could not harvest `block` with what it carries (a block that needs a
   * pickaxe, and none is carried), or null when it can. Digs the way out plans are left to
   * blocks it can harvest: seen live, a staircase out through cobblestone, which only a
   * pickaxe may dig, was refused at every try and the agent stayed in its pit. Without it,
   * every block checkDig allows counts.
   */
  canHarvest?: (block: DiggableBlock) => string | null;
}

export type PitPlan =
  | {
      ok: true;
      site: PitSite;
      /** The roof block (placed by the last step), or null when the roof is in place. */
      roof: PlaceableItem | null;
      /** What is left to do, in order: a walk to the spot, the digs down, the roof. */
      steps: ShelterStep[];
      /** The morning's way out, as planned now (it is planned again in the morning). */
      exit: ShelterStep[];
    }
  | { ok: false; reason: string };

/**
 * A way out: its steps, how many blocks it digs, and whether a walk that breaks nothing can
 * leave where it ends (`free`: OUT_FREE_DISTANCE).
 */
export type ExitPlan =
  { ok: true; steps: ShelterStep[]; digs: number; free: boolean } | { ok: false; reason: string };

/** One side's way out, with the world as it leaves it and the feet block it ends on. */
type ExitTry =
  | { ok: true; steps: ShelterStep[]; digs: number; world: WalkWorld; end: BlockPos }
  | { ok: false; reason: string };

/**
 * How far across a walk that breaks and places nothing must get from where a way out ends,
 * within OUT_FREE_WALK blocks of walking, for the player to be out rather than in another hole
 * (an independent review, 2026-10-05: a pit dug in an old staircase's notch had its way out end
 * two blocks under the ground, on the first step of another old staircase whose next step's
 * floor it had dug, where such a walk reached four cells: no retreat or flee could leave).
 */
export const OUT_FREE_DISTANCE = 8;
export const OUT_FREE_WALK = 24;

/** The most steps up a way out digs before it must reach open ground. */
export const MAX_EXIT_STEPS = 4;

const EPS = 1e-6;
/** Ids for blocks the plan places (above every real 16-bit id). */
const PLANNED_ID_BASE = 1 << 20;
const fmt = (p: BlockPos): string => `(${p.x}, ${p.y}, ${p.z})`;
const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** What a dig down drops, of the blocks that matter for the roof (grass and dirt: dirt). */
const DIRT_DROPPING: ReadonlySet<string> = new Set(['minecraft:grass', 'minecraft:dirt']);

/**
 * The world as it will be after the planned digs and placements: a what-if copy over the
 * blocks the server sent, so each step is checked as it will find the world.
 */
export class PlannedWorld implements WalkWorld {
  readonly #base: WalkWorld;
  readonly #cells = new Map<string, number>();
  readonly #names = new Map<number, string>();
  readonly #ids = new Map<string, number>();

  constructor(base: WalkWorld) {
    this.#base = base;
  }

  blockAt(x: number, y: number, z: number): number | undefined {
    const o = this.#cells.get(key(x, y, z));
    return o !== undefined ? o : this.#base.blockAt(x, y, z);
  }

  /** A dug cell is air (metadata 0); a placed block's metadata is not modelled (unknown). */
  metaAt(x: number, y: number, z: number): number | undefined {
    const o = this.#cells.get(key(x, y, z));
    if (o !== undefined) return o === 0 ? 0 : undefined;
    return this.#base.metaAt?.(x, y, z);
  }

  blockName(id: number): string | undefined {
    return this.#names.get(id) ?? this.#base.blockName(id);
  }

  hazardCode(id: number): number {
    return this.#names.has(id) ? BLOCK_CODE.safe : this.#base.hazardCode(id);
  }

  /** The block at `p` is dug: air. */
  dig(p: BlockPos): void {
    this.#cells.set(key(p.x, p.y, p.z), 0);
  }

  /** `block` (a registry name) is placed at `p`. */
  place(p: BlockPos, block: string): void {
    let id = this.#ids.get(block);
    if (id === undefined) {
      id = PLANNED_ID_BASE + this.#ids.size;
      this.#ids.set(block, id);
      this.#names.set(id, block);
    }
    this.#cells.set(key(p.x, p.y, p.z), id);
  }
}

const nameAt = (world: WalkWorld, p: BlockPos): string | undefined => {
  const id = world.blockAt(p.x, p.y, p.z);
  return id === undefined ? undefined : id === 0 ? 'minecraft:air' : world.blockName(id);
};

const falls = (name: string): boolean => FALLING_DIGGABLE_BLOCKS.has(name as DiggableBlock);

/**
 * A cell the body cannot pass (loaded and not air or a plant the walker passes:
 * passable.ts); null when not loaded.
 */
function solidAt(world: WalkWorld, p: BlockPos): boolean | null {
  const problem = passProblem(world, p.x, p.y, p.z);
  return problem === 'chunk not loaded' ? null : problem !== null;
}

const SIDES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const AROUND: ReadonlyArray<readonly [number, number]> = [
  ...SIDES,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Whether the player is walled in: the four cells beside its feet and the four beside its
 * head are all solid. Null when one of them is not loaded.
 */
export function walledIn(world: WalkWorld, feet: Vec3): boolean | null {
  const x = Math.floor(feet.x);
  const y = Math.floor(feet.y + EPS);
  const z = Math.floor(feet.z);
  let all = true;
  for (const [dx, dz] of SIDES) {
    for (const dy of [0, 1]) {
      const s = solidAt(world, { x: x + dx, y: y + dy, z: z + dz });
      if (s === null) return null;
      all &&= s;
    }
  }
  return all;
}

/** Walled in, and the cell above the head is solid too: no mob can reach the player. */
export function enclosedIn(world: WalkWorld, feet: Vec3): boolean | null {
  const walled = walledIn(world, feet);
  if (walled !== true) return walled;
  return solidAt(world, {
    x: Math.floor(feet.x),
    y: Math.floor(feet.y + EPS) + 2,
    z: Math.floor(feet.z),
  });
}

/**
 * Sealed in, as the safety rules trust it (GameState player.sealed): the four cells beside
 * the feet, the four beside the head, the one above the head and the one below the feet are
 * all known full blocks (TERRAIN_SURFACES). Stricter than enclosedIn, which takes any block
 * the body cannot pass: no door (a zombie breaks one on Hard), no fluid a mob swims through,
 * no thin block it steps over. Null when one of them is not loaded.
 */
export function sealedIn(world: WalkWorld, feet: Vec3): boolean | null {
  const x = Math.floor(feet.x);
  const y = Math.floor(feet.y + EPS);
  const z = Math.floor(feet.z);
  const cells: BlockPos[] = [
    { x, y: y - 1, z },
    { x, y: y + 2, z },
    ...SIDES.flatMap(([dx, dz]) => [0, 1].map((dy) => ({ x: x + dx, y: y + dy, z: z + dz }))),
  ];
  let all = true;
  for (const p of cells) {
    if (world.blockAt(p.x, p.y, p.z) === undefined) return null;
    const name = nameAt(world, p);
    all &&= name !== undefined && TERRAIN_SURFACES.has(name);
  }
  return all;
}

/**
 * Why the ground around a pit at column (x, z) would not make natural walls, or null: the
 * 3 x 3 columns around it must be plain full blocks from the ground layer down to the pit's
 * floor level, and sand or gravel there must stand on a plain full block (a block update
 * would drop it, opening the wall). In the ground layer itself, the roof's, a cell may also
 * be air or a plant the body passes (a neighbour column one lower, under tall grass): the
 * player's body is below it, walled in, and a mob standing there is too high to reach it.
 * The roof still needs a solid side to be placed against (checkPlace, below).
 */
function wallProblem(world: WalkWorld, x: number, groundY: number, z: number): string | null {
  for (const [dx, dz] of AROUND) {
    for (let k = 0; k < NIGHT_PIT_DEPTH; k++) {
      const p = { x: x + dx, y: groundY - k, z: z + dz };
      // Seen live 2026-10-01: tall grass beside the roof cell ruled out every pit nearby.
      if (k === 0 && passProblem(world, p.x, p.y, p.z) === null) continue;
      const name = nameAt(world, p);
      if (name === undefined) return `the ground at ${fmt(p)} is not loaded or not named`;
      if (!WALKABLE_SURFACES.has(name)) {
        return `the pit's wall at ${fmt(p)} would be ${name}, not natural ground (the 3 x 3 columns around must be solid down to its floor)`;
      }
      if (falls(name)) {
        const under = nameAt(world, { ...p, y: p.y - 1 });
        if (under === undefined || !WALKABLE_SURFACES.has(under)) {
          return `${name} in the pit's wall at ${fmt(p)} has ${under ?? 'an unknown block'} under it: it could fall`;
        }
      }
    }
  }
  return null;
}

/** The roof block: one carried (dirt first, then logs), else dirt the digs will drop. */
function roofItemFor(
  inventory: Readonly<Record<string, number>>,
  dirtFromDigs: number,
): PlaceableItem | null {
  const carried = PIT_ROOF_ITEMS.find((i) => (inventory[i] ?? 0) > 0);
  if (carried !== undefined) return carried;
  return dirtFromDigs > 0 ? 'minecraft:dirt' : null;
}

const centreOf = (x: number, y: number, z: number): Vec3 => ({ x: x + 0.5, y, z: z + 0.5 });
const sameSpot = (a: Vec3, b: Vec3): boolean =>
  Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS && Math.abs(a.z - b.z) < EPS;

/**
 * The digs down from `from` (feet on the column's centre) until the feet are at `bottom`,
 * each checked with checkDigDown on the planned world, which they change. Null on success.
 */
function digsDown(
  w: PlannedWorld,
  area: DigArea,
  from: Vec3,
  bottom: number,
  steps: ShelterStep[],
): { at: Vec3; dirt: number } | { reason: string } {
  let at = from;
  let dirt = 0;
  while (at.y > bottom + EPS) {
    const target = { x: Math.floor(at.x), y: Math.round(at.y) - 1, z: Math.floor(at.z) };
    const c = checkDigDown(w, area, at, target);
    if (!c.ok) return { reason: `digging down at ${fmt(target)}: ${c.reason}` };
    steps.push({
      spec: { type: 'DIG_DOWN', args: { position: target } },
      text: `dig down: the ${c.block} under the feet at ${fmt(target)}`,
    });
    if (DIRT_DROPPING.has(c.block)) dirt += 1;
    w.dig(target);
    at = { ...at, y: at.y - 1 };
  }
  return { at, dirt };
}

/** The roof step (checked with checkPlace from the pit's floor), placed on the planned world. */
function roofStep(
  w: PlannedWorld,
  area: DigArea,
  at: Vec3,
  cell: BlockPosition,
  item: PlaceableItem,
): ShelterStep | { reason: string } {
  const placed = checkPlace(w, area, at, cell, item, []);
  if (!placed.ok) return { reason: `the roof at ${fmt(cell)}: ${placed.reason}` };
  w.place(cell, placedBlockOf(item));
  return {
    spec: { type: 'PLACE_BLOCK', args: { position: { ...cell }, item } },
    text: `place ${item} at ${fmt(cell)}: the roof, against the ground beside it`,
  };
}

/**
 * A pit with its feet spot at `spot` (feet level spot.y, on the column's centre), reached
 * from `feet`: every step checked on the planned world, and a way out in the morning.
 */
function pitAt(
  world: WalkWorld,
  feet: Vec3,
  spot: BlockPos,
  inventory: Readonly<Record<string, number>>,
  opts: PitOptions,
  needFree: boolean,
): PitPlan {
  const refuse = (reason: string): PitPlan => ({ ok: false, reason });
  const { area } = opts;
  const centre = centreOf(spot.x, spot.y, spot.z);
  const steps: ShelterStep[] = [];
  if (!sameSpot(feet, centre)) {
    const walk = planTerrainWalk(world, area.fence, feet, centre, opts.maxPathLength);
    if (!walk.ok) return refuse(`the walker cannot reach ${fmt(spot)}: ${walk.reason}`);
    steps.push({
      spec: { type: 'MOVE_TO', args: { target: centre, tolerance: 0.5 } },
      text: `walk to the pit's spot ${fmt(spot)}`,
    });
  }
  const groundY = spot.y - 1;
  const walls = wallProblem(world, spot.x, groundY, spot.z);
  if (walls !== null) return refuse(walls);
  const w = new PlannedWorld(world);
  const dug = digsDown(w, area, centre, spot.y - NIGHT_PIT_DEPTH, steps);
  if ('reason' in dug) return refuse(dug.reason);
  const roof = roofItemFor(inventory, dug.dirt);
  if (roof === null) {
    return refuse('no block for the roof: dirt or logs, which can be dug again in the morning');
  }
  const cell = { x: spot.x, y: groundY, z: spot.z };
  const placed = roofStep(w, area, dug.at, cell, roof);
  if ('reason' in placed) return refuse(placed.reason);
  steps.push(placed);
  // The agent never digs itself in without a way out for the morning.
  const exit = planShelterExit(w, dug.at, opts, groundY);
  if (!exit.ok) return refuse(`no way out in the morning: ${exit.reason}`);
  // Out where a walk that breaks nothing can leave, as it can from where the player stands.
  if (needFree && !exit.free) {
    return refuse(
      `its way out in the morning would end in a hole: a walk that breaks nothing gets no ${OUT_FREE_DISTANCE} blocks away from there`,
    );
  }
  return {
    ok: true,
    site: { x: spot.x, z: spot.z, groundY },
    roof,
    steps,
    exit: exit.steps,
  };
}

/**
 * A new night pit near the player: in its own column, else in a column next to it the
 * walker reaches (nearest first). The first spot where every step passes the client's
 * rules wins; otherwise why the player's own column cannot take one.
 */
export function planNightPit(
  world: WalkWorld,
  feet: Vec3,
  inventory: Readonly<Record<string, number>>,
  opts: PitOptions,
): PitPlan {
  const { fence } = opts.area;
  if (fence.min.y === fence.max.y) {
    return {
      ok: false,
      reason: 'a pit needs a terrain fence (a height range): the pen keeps its floor',
    };
  }
  if (!onBlockTop(feet)) return { ok: false, reason: 'the player is not standing on a block' };
  const fx = Math.floor(feet.x);
  const fy = Math.round(feet.y);
  const fz = Math.floor(feet.z);
  // A way out must leave the player as free as it is now (OUT_FREE_DISTANCE).
  const needFree = walksAway(world, fence, feet, OUT_FREE_DISTANCE, OUT_FREE_WALK);
  const own = pitAt(world, feet, { x: fx, y: fy, z: fz }, inventory, opts, needFree);
  if (own.ok) return own;
  const spots: BlockPos[] = [];
  for (const [dx, dz] of AROUND) {
    const dy = [0, 1, -1].find((d) => standProblem(world, fx + dx, fy + d, fz + dz) === null);
    if (dy !== undefined) spots.push({ x: fx + dx, y: fy + dy, z: fz + dz });
  }
  const distance = (s: BlockPos): number =>
    Math.hypot(s.x + 0.5 - feet.x, s.y - feet.y, s.z + 0.5 - feet.z);
  spots.sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
  for (const spot of spots) {
    const next = pitAt(world, feet, spot, inventory, opts, needFree);
    if (next.ok) return next;
  }
  // Nowhere here or next to it: a few steps away, as a person walks off a bush to open
  // ground. Seen live: by a tree, the pit's wall would have been leaves, a box on open ground
  // cannot be roofed from inside, and the agent went offline for the night. The nearest
  // spots the walker reaches, within PIT_SEARCH_WALK blocks, at most PIT_SEARCH_SPOTS of them.
  const tried = new Set([`${fx},${fy},${fz}`, ...spots.map((p) => `${p.x},${p.y},${p.z}`)]);
  const reach = reachableFeet(world, fence, feet, Math.min(PIT_SEARCH_WALK, opts.maxPathLength));
  const farther = [...reach.values()]
    .filter((f) => !tried.has(`${f.x},${f.y},${f.z}`))
    .sort((a, b) => a.length - b.length || a.x - b.x || a.z - b.z)
    .slice(0, PIT_SEARCH_SPOTS);
  for (const f of farther) {
    const next = pitAt(world, feet, { x: f.x, y: f.y, z: f.z }, inventory, opts, needFree);
    if (next.ok) return next;
  }
  return {
    ok: false,
    reason: `no spot for a pit within ${PIT_SEARCH_WALK} blocks' walk (here: ${own.reason})`,
  };
}

/** How far the agent walks, at most, to a spot for its night pit. */
export const PIT_SEARCH_WALK = 12;
/** Spots beyond the neighbours it looks at, nearest first (each plans a walk and the pit). */
export const PIT_SEARCH_SPOTS = 40;

/**
 * The rest of a pit the agent started at `site`, when the player is in its column below the
 * ground (at least one dig done): the remaining digs down, the roof, and a block in each cell
 * beside the body that is open (a way out dug there, that stopped halfway or ran before a night
 * spent in the same pit: seen live 2026-10-04, the roof put back left the first step of the
 * morning's staircase open beside the head; with no step left to run, the planner was asked
 * and dug the pit's walls). Null when the site does not apply (the player is elsewhere): the
 * caller plans a new pit.
 */
export function continueNightPit(
  world: WalkWorld,
  feet: Vec3,
  inventory: Readonly<Record<string, number>>,
  site: PitSite,
  opts: PitOptions,
): PitPlan | null {
  const level = Math.floor(feet.y + EPS);
  const bottom = site.groundY - (NIGHT_PIT_DEPTH - 1);
  if (Math.floor(feet.x) !== site.x || Math.floor(feet.z) !== site.z) return null;
  if (level > site.groundY || level < bottom) return null;
  const refuse = (reason: string): PitPlan => ({ ok: false, reason });
  if (!onBlockTop(feet)) return refuse('the player is not standing on the pit floor');
  const { area } = opts;
  const centre = centreOf(site.x, level, site.z);
  const steps: ShelterStep[] = [];
  if (!inOneColumn(feet) || !sameSpot(feet, centre)) {
    const walk = planTerrainWalk(world, area.fence, feet, centre, opts.maxPathLength);
    if (!walk.ok) return refuse(`the walker cannot centre on the pit: ${walk.reason}`);
    steps.push({
      spec: { type: 'MOVE_TO', args: { target: centre, tolerance: 0.5 } },
      text: `walk to the pit's centre ${fmt({ x: site.x, y: level, z: site.z })}`,
    });
  }
  const w = new PlannedWorld(world);
  const dug = digsDown(w, area, centre, bottom, steps);
  if ('reason' in dug) return refuse(dug.reason);
  const cell = { x: site.x, y: site.groundY, z: site.z };
  const open = solidAt(w, cell);
  if (open === null) return refuse(`the roof's cell ${fmt(cell)} is not loaded`);
  let roof: PlaceableItem | null = null;
  if (!open) {
    roof = roofItemFor(inventory, dug.dirt);
    if (roof === null) {
      return refuse('no block for the roof: dirt or logs, which can be dug again in the morning');
    }
    const placed = roofStep(w, area, dug.at, cell, roof);
    if ('reason' in placed) return refuse(placed.reason);
    steps.push(placed);
  }
  const gaps: BlockPos[] = [];
  for (const [dx, dz] of SIDES) {
    for (const dy of [0, 1]) {
      const wall = { x: site.x + dx, y: bottom + dy, z: site.z + dz };
      const solid = solidAt(w, wall);
      if (solid === null) return refuse(`the pit's wall at ${fmt(wall)} is not loaded`);
      if (!solid) gaps.push(wall);
    }
  }
  if (gaps.length > 0) {
    // Carried, or dug on the way down; the roof takes one of its own kind first.
    const have = (i: PlaceableItem): number =>
      (inventory[i] ?? 0) + (i === 'minecraft:dirt' ? dug.dirt : 0) - (roof === i ? 1 : 0);
    const item = PIT_ROOF_ITEMS.find((i) => have(i) >= gaps.length);
    if (item === undefined) {
      return refuse(
        `${gaps.length} open cell(s) in the pit's walls and too few blocks to close them`,
      );
    }
    for (const gap of gaps) {
      const placed = checkPlace(w, area, dug.at, gap, item, []);
      if (!placed.ok) return refuse(`the pit's open wall at ${fmt(gap)}: ${placed.reason}`);
      w.place(gap, placedBlockOf(item));
      steps.push({
        spec: { type: 'PLACE_BLOCK', args: { position: { ...gap }, item } },
        text: `place ${item} at ${fmt(gap)}: closes the pit's wall`,
      });
    }
  }
  return { ok: true, site, roof, steps, exit: [] };
}

// ---------------------------------------------------------------------------
// The way out in the morning

/**
 * The way out of a shelter the player is walled into: the plan with the fewest digs among,
 * for each side (east, west, south, north):
 *  - a level way out (the raised box): dig the wall beside the player, head level first,
 *    and walk out onto open ground two blocks away;
 *  - a staircase (the pit): dig the roof (the headroom of the first step), then for each
 *    step up the two cells of the next column, the upper one first, up to MAX_EXIT_STEPS
 *    steps, until the next step is open ground; then walk out onto it (the terrain walker
 *    climbs one block at a time).
 * Every dig passes checkDig from where the player stands (and nothing beside it may fall),
 * the steps it stands on are left solid, and the walk out passes the walker's planner, all
 * on the planned world. Each step runs later as an ordinary action, validated again.
 *
 * `minY` is the lowest feet level out of the shelter (the pit's ground layer, as for
 * planClimbOut); by default the feet's own (the box stands on the ground). Open cells below
 * it are no way out: a cave, or the staircase of a way out that stopped halfway (seen live
 * 2026-10-04: a restart stopped one after its first step; the next morning's plan walked out
 * onto that step, two blocks under the ground, where no retreat could leave).
 */
export function planShelterExit(
  world: WalkWorld,
  feet: Vec3,
  opts: PitOptions,
  minY = Math.floor(feet.y + EPS),
): ExitPlan {
  const found: Array<Extract<ExitTry, { ok: true }>> = [];
  const reasons: string[] = [];
  for (const [dx, dz] of SIDES) {
    for (const plan of [levelExit, stairExit]) {
      const r = plan(world, feet, dx, dz, opts, minY);
      if (r.ok) found.push(r);
      else reasons.push(r.reason);
    }
  }
  if (found.length === 0) {
    return { ok: false, reason: reasons.slice(0, 2).join('; ') || 'no side to dig out of' };
  }
  found.sort((a, b) => a.digs - b.digs);
  // The fewest digs that end where a walk that breaks nothing can leave; else the fewest.
  const free = found.find((f) =>
    walksAway(
      f.world,
      opts.area.fence,
      centreOf(f.end.x, f.end.y, f.end.z),
      OUT_FREE_DISTANCE,
      OUT_FREE_WALK,
    ),
  );
  const best = free ?? found[0];
  if (best === undefined) return { ok: false, reason: 'no side to dig out of' };
  return { ok: true, steps: best.steps, digs: best.digs, free: free !== undefined };
}

/** A dig of the way out, if the cell is not open already: checked, then done on `w`. */
function exitDig(
  w: PlannedWorld,
  opts: PitOptions,
  feet: Vec3,
  cell: BlockPos,
  label: string,
  steps: ShelterStep[],
): string | null {
  const solid = solidAt(w, cell);
  if (solid === null) return `${label} ${fmt(cell)} is not loaded`;
  if (!solid) return null;
  const c = checkDig(w, opts.area, feet, cell);
  if (!c.ok) return `${label} ${fmt(cell)}: ${c.reason}`;
  const harvest = opts.canHarvest?.(c.block) ?? null;
  if (harvest !== null) return `${label} ${fmt(cell)} is ${c.block}: ${harvest}`;
  for (const [dx, dz] of SIDES) {
    const n = { x: cell.x + dx, y: cell.y, z: cell.z + dz };
    const name = nameAt(w, n);
    if (name !== undefined && falls(name)) {
      const under = nameAt(w, { ...n, y: n.y - 1 });
      if (under === undefined || !WALKABLE_SURFACES.has(under)) {
        return `${name} beside ${label} ${fmt(cell)} has nothing solid under it: it would fall`;
      }
    }
  }
  w.dig(cell);
  steps.push({
    spec: { type: 'DIG_BLOCK', args: { position: { ...cell } } },
    text: `dig the ${c.block} at ${fmt(cell)} (${label})`,
  });
  return null;
}

/** The walk out onto `to` (open ground), checked with the walker's planner on `w`. */
function walkOut(
  w: PlannedWorld,
  feet: Vec3,
  to: BlockPos,
  opts: PitOptions,
): ShelterStep | string {
  const stand = standProblem(w, to.x, to.y, to.z);
  if (stand !== null) return `the way out at ${fmt(to)}: ${stand}`;
  const target = centreOf(to.x, to.y, to.z);
  const walk = planTerrainWalk(w, opts.area.fence, feet, target, opts.maxPathLength);
  if (!walk.ok) return `the walk out to ${fmt(to)}: ${walk.reason}`;
  return {
    spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } },
    text: `walk out to ${fmt(to)}`,
  };
}

const open = (world: WalkWorld, p: BlockPos): boolean => solidAt(world, p) === false;

function levelExit(
  world: WalkWorld,
  feet: Vec3,
  dx: number,
  dz: number,
  opts: PitOptions,
  minY: number,
): ExitTry {
  const x = Math.floor(feet.x);
  const y = Math.floor(feet.y + EPS);
  const z = Math.floor(feet.z);
  if (y < minY) return { ok: false, reason: `no level way out: the feet are below y=${minY}` };
  const out = { x: x + 2 * dx, y, z: z + 2 * dz };
  // Open ground beyond the wall, as the world is now: not another hole in the ground.
  if (!open(world, out) || !open(world, { ...out, y: y + 1 })) {
    return { ok: false, reason: `no open ground at ${fmt(out)} beyond the wall` };
  }
  const w = new PlannedWorld(world);
  const steps: ShelterStep[] = [];
  for (const [dy, label] of [
    [1, 'the wall at head level'],
    [0, 'the wall at feet level'],
  ] as const) {
    const problem = exitDig(w, opts, feet, { x: x + dx, y: y + dy, z: z + dz }, label, steps);
    if (problem !== null) return { ok: false, reason: problem };
  }
  const walk = walkOut(w, feet, out, opts);
  if (typeof walk === 'string') return { ok: false, reason: walk };
  return { ok: true, steps: [...steps, walk], digs: steps.length, world: w, end: out };
}

function stairExit(
  world: WalkWorld,
  feet: Vec3,
  dx: number,
  dz: number,
  opts: PitOptions,
  minY: number,
): ExitTry {
  const w = new PlannedWorld(world);
  const steps: ShelterStep[] = [];
  let col = { x: Math.floor(feet.x), z: Math.floor(feet.z) };
  let y = Math.floor(feet.y + EPS);
  for (let step = 1; step <= MAX_EXIT_STEPS; step++) {
    // Headroom above where the player steps up from (the roof, for the first step).
    const headroom = exitDig(
      w,
      opts,
      feet,
      { x: col.x, y: y + 2, z: col.z },
      step === 1 ? 'the roof' : 'the headroom',
      steps,
    );
    if (headroom !== null) return { ok: false, reason: headroom };
    const next = { x: col.x + dx, z: col.z + dz };
    const ny = y + 1;
    // The step it stands on stays: solid ground, never dug.
    const step0 = nameAt(w, { x: next.x, y: ny - 1, z: next.z });
    if (step0 === undefined || !WALKABLE_SURFACES.has(step0)) {
      return {
        ok: false,
        reason: `no step to stand on at ${fmt({ x: next.x, y: ny - 1, z: next.z })} (${step0 ?? 'not loaded'})`,
      };
    }
    const body = { x: next.x, y: ny, z: next.z };
    const head = { x: next.x, y: ny + 1, z: next.z };
    // Open ground already there (as the world is now), out of the shelter: the way out ends
    // on it. Open cells below minY (a cave, or a step an earlier way out dug) are no way out:
    // the staircase goes on through them.
    if (ny >= minY && open(world, body) && open(world, head)) {
      const walk = walkOut(w, feet, body, opts);
      if (typeof walk === 'string') return { ok: false, reason: walk };
      return { ok: true, steps: [...steps, walk], digs: steps.length, world: w, end: body };
    }
    for (const [cell, label] of [
      [head, `step ${step}, upper block`],
      [body, `step ${step}, lower block`],
    ] as const) {
      const problem = exitDig(w, opts, feet, cell, label, steps);
      if (problem !== null) return { ok: false, reason: problem };
    }
    col = next;
    y = ny;
  }
  return { ok: false, reason: `no open ground within ${MAX_EXIT_STEPS} steps up` };
}

/** The deepest shaft shaftSite looks up from (blocks above the feet). */
export const MAX_SHAFT_DEPTH = 16;

/**
 * The shaft the player stands at the bottom of, as a pit for planClimbOut: its column, and its
 * ground layer (the lowest level above the feet where a side column has ground under two open
 * cells: the rim). For a shaft the player dug down by walking, deeper than the night pit's
 * staircase out reaches (seen live 2026-10-04: 8 deep to stone, roofed for the night, "no way
 * out"). Null when no rim lies within MAX_SHAFT_DEPTH.
 */
export function shaftSite(world: WalkWorld, feet: Vec3): PitSite | null {
  const x = Math.floor(feet.x);
  const y = Math.floor(feet.y + EPS);
  const z = Math.floor(feet.z);
  for (let ry = y + 2; ry <= y + MAX_SHAFT_DEPTH; ry++) {
    for (const [dx, dz] of SIDES) {
      const ground = solidAt(world, { x: x + dx, y: ry - 1, z: z + dz });
      if (
        ground === true &&
        open(world, { x: x + dx, y: ry, z: z + dz }) &&
        open(world, { x: x + dx, y: ry + 1, z: z + dz })
      ) {
        return { x, z, groundY: ry };
      }
    }
  }
  return null;
}

/** Nodes and milliseconds a climb out of the pit may search (a few blocks around it). */
const CLIMB_MAX_NODES = 20_000;
const CLIMB_MAX_MS = 300;
/** Searches a climb out may take: the first, and one from each place a cut path stops. */
const CLIMB_MAX_SEARCHES = 6;
/**
 * How far across from the hole's column a climb out ends, at least: clear of it, on ground a
 * walk can leave (seen live 2026-10-04: a climb that ended in the next column was still in a
 * hole an earlier pit had left, and the retreats that came back to it could go nowhere).
 */
export const CLIMB_OUT_DISTANCE = 3;

/**
 * The way out of the night pit when no wall or staircase can be dug (planShelterExit; seen
 * live 2026-10-03: cobblestone on three sides and no pickaxe, bamboo on the fourth): the
 * pathfinder, with MOVE_TO's own walk policy (`options`: what a walk may break, and the
 * throwaway blocks it may pillar with), to any feet block CLIMB_OUT_DISTANCE or more across
 * from the pit's column, no lower than its ground layer (the ground beside a pit may lie a
 * block lower: seen live), as
 * Baritone climbs out of a hole: through the roof, a pillar up, a step out. A path the search
 * found to the goal but had to cut (a later movement no longer holds once earlier ones changed
 * blocks) goes on from where the cut leaves the player, on the world as it leaves it (seen live
 * 2026-10-04: a pit 5 blocks deep, refused as "cut after 3 movement(s)"). One MOVE_TO for each
 * stretch: to where each cut stops, then to where the climb ends. A MOVE_TO takes no cut path,
 * so each is checked with the search its walk runs (to that block, from where the stretch
 * before ends); the walk plans its own path with the same rules, and checks every break and
 * placement again just before it.
 */
export function planClimbOut(
  world: WalkWorld,
  fence: Fence,
  feet: Vec3,
  site: PitSite,
  options: PathOptions,
): ExitPlan {
  const goal = goalOut(site.x, site.z, site.groundY, CLIMB_OUT_DISTANCE);
  const w = new PlannedWorld(world);
  const steps: ShelterStep[] = [];
  const fail = (reason: string): ExitPlan => ({
    ok: false,
    reason: `no climb out of the pit: ${reason}`,
  });
  let from = feet;
  let digs = 0;
  let placed = 0;
  for (let search = 0; search < CLIMB_MAX_SEARCHES; search++) {
    const t = options.throwaway;
    const limited: PathOptions = {
      ...options,
      ...(t === undefined ? {} : { throwaway: { ...t, count: t.count - placed } }),
      maxNodes: CLIMB_MAX_NODES,
      maxTimeMs: CLIMB_MAX_MS,
    };
    const found = planPath(w, fence, from, goal, limited);
    const cut = found.status === 'partial' && found.stop === 'goal' && found.movements.length > 0;
    if ((found.status !== 'reached' && !cut) || found.end === null) return fail(found.reason);
    const end = found.end;
    // The MOVE_TO that runs this stretch plans its own walk to `end` and takes no cut path:
    // the same search to that block, on the world as the stretches before leave it, must reach.
    const walk = planPath(w, fence, from, goalBlock(end.x, end.y, end.z), limited);
    if (walk.status !== 'reached') return fail(`the walk to ${fmt(end)}: ${walk.reason}`);
    let breaks = 0;
    let places = 0;
    for (const m of walk.movements) {
      for (const b of m.breaks) w.dig(b.cell);
      if (m.place !== null) w.place(m.place.cell, m.place.block);
      breaks += m.breaks.length;
      places += m.place === null ? 0 : 1;
    }
    digs += breaks;
    placed += places;
    steps.push({
      spec: { type: 'MOVE_TO', args: { target: centreOf(end.x, end.y, end.z), tolerance: 0.5 } },
      text: `climb ${cut ? 'up' : 'out'} to ${fmt(end)} (breaking ${breaks} block(s), placing ${places})`,
    });
    if (!cut) {
      const out = centreOf(end.x, end.y, end.z);
      const free = walksAway(w, fence, out, OUT_FREE_DISTANCE, OUT_FREE_WALK);
      return { ok: true, digs, steps, free };
    }
    from = centreOf(end.x, end.y, end.z);
  }
  return fail(`the path was still cut after ${CLIMB_MAX_SEARCHES} searches`);
}
