import { FALLING_DIGGABLE_BLOCKS } from '../../../domain/blocks.ts';
import { BLOCK_CODE, hazardKindOfBlock } from '../block-hazards.ts';
import { PASSABLE_BLOCKS, PASSABLE_BY_METADATA, passProblem } from '../passable.ts';
import { CLICKABLE_SUPPORTS, PLACE_TARGETS } from '../placing.ts';
import { TERRAIN_SURFACES, type Cell } from '../terrain.ts';
import type { WalkWorld } from '../walking.ts';
import type { PhysicsWorld } from './physics.ts';

/**
 * What the pathfinder knows about each block cell of its search box, read once from the
 * blocks the server sent and kept in typed arrays, so a search over a play area reads each
 * block once instead of once per neighbour it is checked for (the chunk store's lookups go
 * through a map keyed by strings). Pure; the world is only read.
 *
 * The rules are the walkers' own: what the body passes is passable.ts's (air, and plants
 * checked in their code, some only at certain metadata), what can be stood on is terrain.ts's
 * surfaces, hazards are block-hazards.ts's codes (an unnamed id counts as one). `standable`
 * is terrain.ts's standProblem, plus: never with the feet in a vine (a game client climbs
 * vines like a ladder, which the pathfinder's physics does not model). Everything not known
 * is refused (fail closed): an unloaded cell is solid, not passable, and makes every cell
 * next to it unsafe.
 */

export const CELL = {
  /** The flags below are known. */
  KNOWN: 1 << 0,
  LOADED: 1 << 1,
  /** The body may be in it (air, or a plant passable.ts lets it through). */
  PASSABLE: 1 << 2,
  /** A known full block to stand on (terrain.ts's surfaces). */
  SURFACE: 1 << 3,
  /** A collision box, taken as a full cube: anything loaded that is neither passable nor a fluid, and anything unloaded. */
  SOLID: 1 << 4,
  /** Vanilla water, still or flowing. */
  WATER: 1 << 5,
  /** Any fluid (water, lava, modded fluids): it would flow into a hole made next to it. */
  LIQUID: 1 << 6,
  /** Sand or gravel: falls when what holds it up goes. */
  FALLING: 1 << 7,
  /** Lava, fire, a harmful fluid, a block that hurts on contact, or an id the registry does not name. */
  HAZARD: 1 << 8,
  /** A vine (Forge makes vines ladders: a game client climbs them). */
  LADDER: 1 << 9,
  /** A placed block may go here: air, tall grass, a dead bush (placing.ts). */
  REPLACEABLE: 1 << 10,
  /** A plain full block to place against: clicking it opens nothing (placing.ts). */
  CLICKABLE: 1 << 11,
} as const;

/** Internal: a plant passable only at some metadata, decided per cell. */
const BY_METADATA = 1 << 15;

const WATER_BLOCKS: ReadonlySet<string> = new Set(['minecraft:water', 'minecraft:flowing_water']);
const LAVA_BLOCKS: ReadonlySet<string> = new Set(['minecraft:lava', 'minecraft:flowing_lava']);
/**
 * Vines: BlockVine.isLadder (Forge) is true, and BiomesOPlenty's ivy, willow, tree moss,
 * flower vines and moss extend BlockVine (passable.ts). Ladders themselves are never passable.
 */
const LADDER_BLOCKS: ReadonlySet<string> = new Set([
  'minecraft:vine',
  'minecraft:ladder',
  'BiomesOPlenty:ivy',
  'BiomesOPlenty:willow',
  'BiomesOPlenty:treeMoss',
  'BiomesOPlenty:flowerVine',
  'BiomesOPlenty:moss',
]);

function isLiquidName(name: string): boolean {
  if (WATER_BLOCKS.has(name) || LAVA_BLOCKS.has(name)) return true;
  const hazard = hazardKindOfBlock(name);
  // Modded fluids are registered as "...fluid..." blocks (IC2:fluidUuMatter, ...); the hazard
  // table's lava-like and harmful fluids too.
  return hazard === 'lava' || hazard === 'harmful_fluid' || /fluid/i.test(name);
}

const D = {
  NEAR_KNOWN: 1,
  NEAR: 2,
  STAND_KNOWN: 4,
  STAND: 8,
  WADE_KNOWN: 16,
  WADE: 32,
  CALM_KNOWN: 64,
  CALM: 128,
  OPEN_KNOWN: 256,
  OPEN: 512,
  ROW_KNOWN: 1024,
  ROW: 2048,
  LAYER_KNOWN: 4096,
  LAYER: 8192,
} as const;

/** An inclusive box of block cells. */
export interface CellBox {
  readonly min: Cell;
  readonly max: Cell;
}

const SIDES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class CellCache implements PhysicsWorld {
  readonly world: WalkWorld;
  readonly box: CellBox;
  readonly #sx: number;
  readonly #sy: number;
  readonly #sz: number;
  readonly #flags: Uint16Array;
  readonly #derived: Uint16Array;
  readonly #idFlags = new Map<number, number>();

  constructor(world: WalkWorld, box: CellBox) {
    this.world = world;
    this.box = box;
    this.#sx = box.max.x - box.min.x + 1;
    this.#sy = box.max.y - box.min.y + 1;
    this.#sz = box.max.z - box.min.z + 1;
    if (this.#sx <= 0 || this.#sy <= 0 || this.#sz <= 0) {
      throw new Error('internal: an empty cell box');
    }
    const volume = this.#sx * this.#sy * this.#sz;
    this.#flags = new Uint16Array(volume);
    this.#derived = new Uint16Array(volume);
  }

  /** The number of cells in the box (indices run from 0 below it). */
  get volume(): number {
    return this.#flags.length;
  }

  /** The cell's index in the box (for per-cell tables of the same size), or -1 outside it. */
  index(x: number, y: number, z: number): number {
    return this.#index(x, y, z);
  }

  /** The cell's index in the arrays, or -1 outside the box. */
  #index(x: number, y: number, z: number): number {
    const ix = x - this.box.min.x;
    const iy = y - this.box.min.y;
    const iz = z - this.box.min.z;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.#sx || iy >= this.#sy || iz >= this.#sz) return -1;
    return (iy * this.#sz + iz) * this.#sx + ix;
  }

  /** The cell's flags (CELL). Outside the box they are worked out each time, not kept. */
  flags(x: number, y: number, z: number): number {
    const i = this.#index(x, y, z);
    if (i < 0) return this.#read(x, y, z);
    const f = this.#flags[i] as number;
    if (f !== 0) return f;
    const read = this.#read(x, y, z);
    this.#flags[i] = read;
    return read;
  }

  #read(x: number, y: number, z: number): number {
    const world = this.world;
    const id = world.blockAt(x, y, z);
    if (id === undefined) return CELL.KNOWN | CELL.SOLID;
    let f = CELL.KNOWN | CELL.LOADED | this.#byId(id);
    if ((f & BY_METADATA) !== 0) {
      // A plant passable only at some metadata (passable.ts): this cell's own.
      f &= ~BY_METADATA;
      if (passProblem(world, x, y, z) === null) f |= CELL.PASSABLE;
    }
    if ((f & (CELL.PASSABLE | CELL.LIQUID)) === 0) f |= CELL.SOLID;
    return f;
  }

  /** What a block id's name says (the same for every cell of it), worked out once per id. */
  #byId(id: number): number {
    const known = this.#idFlags.get(id);
    if (known !== undefined) return known;
    const world = this.world;
    let f = 0;
    if (world.hazardCode(id) !== BLOCK_CODE.safe) f |= CELL.HAZARD;
    const name = id === 0 ? 'minecraft:air' : world.blockName(id);
    if (name !== undefined) {
      // passable.ts's rule: air and the listed plants, some only at listed metadata.
      if (name === 'minecraft:air' || PASSABLE_BLOCKS.has(name)) f |= CELL.PASSABLE;
      else if (PASSABLE_BY_METADATA.has(name)) f |= BY_METADATA;
      if (TERRAIN_SURFACES.has(name)) f |= CELL.SURFACE;
      if (WATER_BLOCKS.has(name)) f |= CELL.WATER;
      if (isLiquidName(name)) f |= CELL.LIQUID;
      if ((FALLING_DIGGABLE_BLOCKS as ReadonlySet<string>).has(name)) f |= CELL.FALLING;
      if (LADDER_BLOCKS.has(name)) f |= CELL.LADDER;
      if (PLACE_TARGETS.has(name)) f |= CELL.REPLACEABLE;
      if (CLICKABLE_SUPPORTS.has(name)) f |= CELL.CLICKABLE;
    }
    this.#idFlags.set(id, f);
    return f;
  }

  has(x: number, y: number, z: number, flag: number): boolean {
    return (this.flags(x, y, z) & flag) !== 0;
  }

  /** The block's registry name (air for id 0), or undefined when unloaded or unnamed. */
  name(x: number, y: number, z: number): string | undefined {
    const id = this.world.blockAt(x, y, z);
    if (id === undefined) return undefined;
    return id === 0 ? 'minecraft:air' : this.world.blockName(id);
  }

  // PhysicsWorld
  solid(x: number, y: number, z: number): boolean {
    return (this.flags(x, y, z) & CELL.SOLID) !== 0;
  }

  water(x: number, y: number, z: number): boolean {
    return (this.flags(x, y, z) & CELL.WATER) !== 0;
  }

  liquid(x: number, y: number, z: number): boolean {
    return (this.flags(x, y, z) & CELL.LIQUID) !== 0;
  }

  /**
   * A derived fact, kept: the value under bit `value` once bit `known` is set. (Written out in
   * each predicate below, without closures: they are the search's innermost calls.)
   */
  #known(i: number, known: number, value: number): number {
    if (i < 0) return -1;
    const d = this.#derived[i] as number;
    return (d & known) === 0 ? -1 : (d & value) !== 0 ? 1 : 0;
  }

  #keep(i: number, known: number, value: number, v: boolean): boolean {
    if (i >= 0) this.#derived[i] = (this.#derived[i] as number) | known | (v ? value : 0);
    return v;
  }

  /**
   * A hazard (or an unloaded or unnamed block) in the 3 x 3 x 3 cube around the cell: the
   * body must never be in such a cell, nor may a block next to one be broken or placed.
   */
  nearHazard(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.NEAR_KNOWN, D.NEAR);
    if (k >= 0) return k === 1;
    // The cube is three layers of 3 x 3, each three rows of 3: kept per cell too, so a cell
    // costs a few lookups once its neighbours are known.
    const near = this.#layer(x, y - 1, z) || this.#layer(x, y, z) || this.#layer(x, y + 1, z);
    return this.#keep(i, D.NEAR_KNOWN, D.NEAR, near);
  }

  /** A hazard or unloaded cell among the 3 x 3 at level y around (x, z). */
  #layer(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.LAYER_KNOWN, D.LAYER);
    if (k >= 0) return k === 1;
    const v = this.#row(x, y, z - 1) || this.#row(x, y, z) || this.#row(x, y, z + 1);
    return this.#keep(i, D.LAYER_KNOWN, D.LAYER, v);
  }

  /** A hazard or unloaded cell among (x - 1..x + 1, y, z). */
  #row(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.ROW_KNOWN, D.ROW);
    if (k >= 0) return k === 1;
    let v = false;
    for (let dx = -1; dx <= 1 && !v; dx++) {
      const f = this.flags(x + dx, y, z);
      v = (f & CELL.HAZARD) !== 0 || (f & CELL.LOADED) === 0;
    }
    return this.#keep(i, D.ROW_KNOWN, D.ROW, v);
  }

  /** The body may be in the cell: passable, and no hazard next to it. */
  open(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.OPEN_KNOWN, D.OPEN);
    if (k >= 0) return k === 1;
    const v = (this.flags(x, y, z) & CELL.PASSABLE) !== 0 && !this.nearHazard(x, y, z);
    return this.#keep(i, D.OPEN_KNOWN, D.OPEN, v);
  }

  /**
   * The player can stand with its feet in the cell (terrain.ts standProblem, and not in a
   * vine): a known full block under it, its feet and head cells passable, nothing dangerous
   * or unloaded in the 3 x 3 columns from under the feet to above the head.
   */
  standable(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.STAND_KNOWN, D.STAND);
    if (k >= 0) return k === 1;
    const v =
      (this.flags(x, y - 1, z) & CELL.SURFACE) !== 0 &&
      (this.flags(x, y, z) & CELL.LADDER) === 0 &&
      this.open(x, y, z) &&
      this.open(x, y + 1, z);
    return this.#keep(i, D.STAND_KNOWN, D.STAND, v);
  }

  /**
   * The player can stand with its feet in calm one-block-deep water: a known full block under
   * it, calm still water at the feet, the head out in a passable cell, nothing dangerous near.
   */
  wadeable(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.WADE_KNOWN, D.WADE);
    if (k >= 0) return k === 1;
    const v =
      (this.flags(x, y - 1, z) & CELL.SURFACE) !== 0 &&
      this.calmWater(x, y, z) &&
      !this.nearHazard(x, y, z) &&
      this.open(x, y + 1, z);
    return this.#keep(i, D.WADE_KNOWN, D.WADE, v);
  }

  /** Standable on dry ground, or (with water allowed) in calm one-deep water. */
  footing(x: number, y: number, z: number, water: boolean): boolean {
    return this.standable(x, y, z) || (water && this.wadeable(x, y, z));
  }

  /**
   * A water source that pushes nothing: vanilla's flow vector (BlockLiquid.getFlowVector) is
   * zero. A source block (metadata 0) has none unless a neighbour is water of another level, or
   * open to a drop with water below it; this asks every neighbour to agree (it does not count
   * on two pushes cancelling). Anything unknown is not calm.
   */
  calmWater(x: number, y: number, z: number): boolean {
    const i = this.#index(x, y, z);
    const k = this.#known(i, D.CALM_KNOWN, D.CALM);
    if (k >= 0) return k === 1;
    return this.#keep(i, D.CALM_KNOWN, D.CALM, this.#calmNow(x, y, z));
  }

  #calmNow(x: number, y: number, z: number): boolean {
    if ((this.flags(x, y, z) & CELL.WATER) === 0) return false;
    if (this.world.metaAt?.(x, y, z) !== 0) return false;
    for (const [dx, dz] of SIDES) {
      const decay = this.#flowDecay(x + dx, y, z + dz);
      if (decay === null) return false;
      if (decay > 0) return false;
      if (decay === 0) continue;
      // Not water: a fluid of another kind is never calm; a cell the water could fall past
      // (vanilla asks its material; this asks of every cell) must have no water under it.
      if ((this.flags(x + dx, y, z + dz) & CELL.LIQUID) !== 0) return false;
      const below = this.#flowDecay(x + dx, y - 1, z + dz);
      if (below === null || below >= 0) return false;
    }
    return true;
  }

  /** getEffectiveFlowDecay for water: -1 not water, the level (a falling flow counts 0), null unknown. */
  #flowDecay(x: number, y: number, z: number): number | null {
    const f = this.flags(x, y, z);
    if ((f & CELL.LOADED) === 0) return null;
    if ((f & CELL.WATER) === 0) return -1;
    const meta = this.world.metaAt?.(x, y, z);
    if (meta === undefined) return null;
    return meta >= 8 ? 0 : meta;
  }
}

/** A block a path breaks (block null: air afterwards) or places (its registry name). */
export interface BlockChange {
  readonly cell: Cell;
  readonly block: string | null;
}

/**
 * `world` with `changes` applied, in order (a later change to a cell wins): the world as a
 * path leaves it once it has broken and placed those blocks. A placed block gets an id of its
 * own (negative: no real id is), named as given, with metadata 0 and no hazard.
 */
export function changedWorld(world: WalkWorld, changes: readonly BlockChange[]): WalkWorld {
  if (changes.length === 0) return world;
  const ids = new Map<string, number>();
  const names = new Map<number, string>();
  const at = new Map<string, number>();
  for (const c of changes) {
    let id = 0;
    if (c.block !== null) {
      id = ids.get(c.block) ?? -1000 - ids.size;
      ids.set(c.block, id);
      names.set(id, c.block);
    }
    at.set(`${c.cell.x},${c.cell.y},${c.cell.z}`, id);
  }
  return {
    blockAt: (x, y, z) => at.get(`${x},${y},${z}`) ?? world.blockAt(x, y, z),
    metaAt: (x, y, z) => (at.has(`${x},${y},${z}`) ? 0 : world.metaAt?.(x, y, z)),
    blockName: (id) => names.get(id) ?? world.blockName(id),
    hazardCode: (id) => (names.has(id) ? BLOCK_CODE.safe : world.hazardCode(id)),
  };
}
