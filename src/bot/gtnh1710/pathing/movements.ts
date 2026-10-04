import type { Cell } from '../terrain.ts';
import type { Fence } from '../walking.ts';
import { CELL, type CellCache } from './cells.ts';
import { MAX_WATER_FALL, type PathCosts } from './costs.ts';

/**
 * The movements a path is made of, between feet blocks: whether each is possible from a feet
 * block, what it costs (ticks, costs.ts), and what it breaks and places. The set and the idea
 * of checking each against the blocks with its own rules are Baritone's (MovementTraverse,
 * MovementDiagonal, MovementAscend, MovementDescend, MovementFall, MovementParkour,
 * MovementPillar, MovementDownward, and the doors MovementTraverse opens); the rules here are
 * this agent's walker's, written anew.
 * The search calls them with no detail (nothing allocated); a found path is rebuilt with it.
 * Pure.
 *
 * Safety the movements themselves enforce, whatever the caller allows:
 *  - every cell the body passes is passable (or calm one-deep water, when water is allowed)
 *    and has no hazard, unloaded or unnamed block in the 3 x 3 x 3 cube around it; every feet
 *    block a movement ends on is standable (cells.ts);
 *  - a block is broken only if the caller's canBreak allows it, and never: next to a fluid
 *    (above or beside it: it would flow in), under sand or gravel (it would fall in), beside
 *    sand or gravel with nothing under it (it would be woken and fall), next to a hazard,
 *    outside the search area's columns, or the block the player stands on (except digging
 *    down, which the caller must allow);
 *  - a block is placed only into air or a plant a block replaces, against a plain full block
 *    (clicking anything else could open it), never next to a fluid or a hazard, never sand or
 *    gravel with nothing under it, and only while throwaway blocks are left;
 *  - a fall lands on a known full block at most maxFall (3) down, where it does no damage, or
 *    into calm one-deep water from a height the server's accounting does not punish;
 *  - a parkour jump crosses only gaps it would survive falling into (unless the caller allows
 *    deep ones), with the whole arc clear;
 *  - nothing leaves the search area (the fence): every feet block is inside it;
 *  - a doorway (a door or a fence gate, cells.ts) is entered only by the door movement, along
 *    an axis its box leaves clear, opened or closed first only when a right-click turns it (a
 *    wooden door, a gate; never an iron door), and left only along the same axis;
 *  - a ladder (cells.ts CLIMB) is climbed only when the caller allows it, the body centred in
 *    its column, clear of the ladder's slab: up and down within it, onto it from the floor at
 *    its foot, from a ledge at its top or from a floor beside it partway up, and off it onto
 *    one; never toward its wall but off its top; from a feet block held by a ladder with no
 *    floor under it nothing but a climb starts.
 */

export const MOVEMENT_KINDS = [
  'traverse',
  'diagonal',
  'ascend',
  'descend',
  'fall',
  'parkour',
  'pillar',
  'bridge',
  'downward',
  'door',
  'climbUp',
  'climbDown',
  'climbOn',
  'climbOff',
  'climbAcross',
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

const KIND = {
  traverse: 0,
  diagonal: 1,
  ascend: 2,
  descend: 3,
  fall: 4,
  parkour: 5,
  pillar: 6,
  bridge: 7,
  downward: 8,
  door: 9,
  climbUp: 10,
  climbDown: 11,
  climbOn: 12,
  climbOff: 13,
  climbAcross: 14,
} as const;

/** Unit steps across: the four cardinal ones, then the four diagonal ones. */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

const SIDES: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A block a movement breaks, and its dig time in ticks (the caller's canBreak). */
export interface BlockBreak {
  readonly cell: Cell;
  readonly ticks: number;
}

/**
 * A door or gate a movement opens or closes with a right-click before it walks in: the cell
 * clicked (a door's lower half: its metadata holds the open bit), and its metadata before and
 * after (bit 2, open, turned over; a gate may also turn to open away from the player).
 */
export interface DoorToggle {
  readonly cell: Cell;
  readonly block: string;
  readonly was: number;
  readonly meta: number;
}

/** A block a movement places: into `cell`, clicking face `face` of the block `against`. */
export interface BlockPlace {
  readonly cell: Cell;
  readonly against: Cell;
  /** 0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east (C08's face). */
  readonly face: number;
  /** The registry name of the block placed. */
  readonly block: string;
}

export interface Movement {
  readonly kind: MovementKind;
  readonly from: Cell;
  readonly to: Cell;
  /** The step across (a unit, cardinal or diagonal); 0, 0 for pillar, downward and climbs. */
  readonly dir: { readonly x: number; readonly z: number };
  /** Ticks, with the penalties. */
  readonly cost: number;
  /** Broken before the movement, standing at `from`, upper blocks first. */
  readonly breaks: readonly BlockBreak[];
  readonly place: BlockPlace | null;
  /** The feet are in calm one-deep water at its start, its end, or both (wading, a fall into water). */
  readonly water: boolean;
  /** Sprinting (a 3-block parkour jump needs it). */
  readonly sprint: boolean;
  /** Parkour: the blocks jumped over. */
  readonly gap: number;
  /** Descend and fall: the blocks dropped. */
  readonly drop: number;
  /** Door: the door or gate opened (or closed) to pass, or null when it was clear already. */
  readonly toggle: DoorToggle | null;
}

export interface Throwaway {
  /** How many blocks may be placed. */
  readonly count: number;
  /** The block they place (a surface the walker stands on: dirt, cobblestone...). */
  readonly block: string;
  /** Sand or gravel: it falls unless something is under it. */
  readonly falls: boolean;
}

export interface MoveOptions {
  readonly sprint: boolean;
  readonly parkour: boolean;
  /** Parkour over gaps that falling into would hurt (deep or with no safe floor). */
  readonly parkourOverDeepGaps: boolean;
  readonly pillar: boolean;
  readonly bridge: boolean;
  /** Digging down: breaking the block underfoot and dropping one block into the hole. */
  readonly downward: boolean;
  /** Whether the block underfoot at `cell` may be dug down through (null: canBreak alone). */
  readonly canDigDown: ((cell: Cell) => boolean) | null;
  /** Wading in calm one-deep water, and falls into it. */
  readonly water: boolean;
  /** The highest fall onto dry ground (at most 3: higher ones hurt). */
  readonly maxFall: number;
  readonly canBreak: ((cell: Cell) => number | null) | null;
  readonly canPlace: ((cell: Cell) => boolean) | null;
  readonly throwaway: Throwaway | null;
  /** Walking through doorways, opening (or closing) wooden doors and fence gates to pass. */
  readonly doors: boolean;
  /** Climbing ladders (cells.ts CLIMB): up, down, onto and off them. */
  readonly climb: boolean;
}

/** What a movement's evaluation collects when the path is rebuilt. */
interface Detail {
  breaks: BlockBreak[];
  place: BlockPlace | null;
  water: boolean;
  sprint: boolean;
  toggle: DoorToggle | null;
}

/** The face of a block pointing along (dx, dz): east 5, west 4, south 3, north 2. */
function faceTowards(dx: number, dz: number): number {
  return dx > 0 ? 5 : dx < 0 ? 4 : dz > 0 ? 3 : 2;
}

const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * One search's view of the movements: the cells, the area, the options and the costs, with
 * per-cell caches of what breaking and placing allow. Each evaluation leaves its result in the
 * scratch fields (kind, destination, parameter, blocks broken and placed).
 */
export class MoveContext {
  readonly cells: CellCache;
  readonly fence: Fence;
  readonly options: MoveOptions;
  readonly costs: PathCosts;
  kind = 0;
  nx = 0;
  ny = 0;
  nz = 0;
  param = 0;
  breaks = 0;
  places = 0;
  /**
   * The floor of the feet block being expanded is a block this path placed (it was reached
   * by a pillar or a bridge): placing may click it although the world still shows air there.
   */
  floorPlaced = false;
  /**
   * The feet block being expanded is solid in the world: a block this path broke (the search
   * reaches no other node with the body in a solid block). A pillar breaks the block over the
   * head, which two pillars on is the feet block: placing may fill it although the world still
   * shows the block (seen 2026-10-04: a climb up a shaft under a roof stopped two blocks up).
   */
  feetBroken = false;
  /**
   * The feet block being expanded is a doorway: the axes the body may leave it along (1 along
   * x, 2 along z: the one it came in on), with IN_DOORWAY set; 0 out of doorways.
   */
  doorway = 0;
  // Per cell, made when first needed (a search that breaks, places or jumps gaps).
  #breakTicks: Float32Array | null = null;
  #digDown: Map<string, boolean> | null = null;
  #placeOk: Int8Array | null = null;
  #gapSafe: Int8Array | null = null;

  constructor(cells: CellCache, fence: Fence, options: MoveOptions, costs: PathCosts) {
    this.cells = cells;
    this.fence = fence;
    this.options = options;
    this.costs = costs;
  }

  inFence(x: number, y: number, z: number): boolean {
    const f = this.fence;
    return (
      x >= f.min.x && x <= f.max.x && z >= f.min.z && z <= f.max.z && y >= f.min.y && y <= f.max.y
    );
  }

  begin(kind: number, x: number, y: number, z: number, param: number): void {
    this.breaks = 0;
    this.places = 0;
    this.dest(kind, x, y, z, param);
  }

  dest(kind: number, x: number, y: number, z: number, param: number): void {
    this.kind = kind;
    this.nx = x;
    this.ny = y;
    this.nz = z;
    this.param = param;
  }

  /** The code of the last evaluation, for direction `d`: kind, direction and parameter. */
  code(d: number): number {
    return this.kind | (d << 4) | (this.param << 8);
  }

  /**
   * Opens one cell of the body's way, from where the player stands: 0 when it is passable
   * already, else the break's cost (its dig ticks, the verdict and the penalty), or -1 when it
   * may not be broken. Counts the break, and records it when `detail` is given.
   */
  open(x: number, y: number, z: number, detail: Detail | null): number {
    if (this.cells.has(x, y, z, CELL.PASSABLE)) return 0;
    const t = this.breakTicks(x, y, z);
    if (t < 0) return -1;
    this.breaks++;
    detail?.breaks.push({ cell: { x, y, z }, ticks: t });
    return t + this.costs.breakExtra;
  }

  /** Whether the dig-down rules (options.canDigDown) allow the block at (x, y, z): cached. */
  digDownOk(x: number, y: number, z: number): boolean {
    const digDown = this.options.canDigDown;
    if (digDown === null) return true;
    const k = `${x},${y},${z}`;
    this.#digDown ??= new Map();
    const known = this.#digDown.get(k);
    if (known !== undefined) return known;
    const ok = digDown({ x, y, z });
    this.#digDown.set(k, ok);
    return ok;
  }

  /** The dig ticks for breaking the block at (x, y, z), or -1 when it may not be broken. */
  breakTicks(x: number, y: number, z: number): number {
    const canBreak = this.options.canBreak;
    if (canBreak === null) return -1;
    const i = this.cells.index(x, y, z);
    this.#breakTicks ??= new Float32Array(this.cells.volume).fill(NaN);
    if (i >= 0) {
      const known = this.#breakTicks[i] as number;
      if (!Number.isNaN(known)) return known;
    }
    const t = this.#breakTicksNow(x, y, z, canBreak);
    if (i >= 0) this.#breakTicks[i] = t;
    return t;
  }

  #breakTicksNow(x: number, y: number, z: number, canBreak: (cell: Cell) => number | null): number {
    const c = this.cells;
    const f = c.flags(x, y, z);
    if ((f & CELL.LOADED) === 0) return -1;
    if ((f & (CELL.PASSABLE | CELL.HAZARD | CELL.LIQUID)) !== 0) return -1;
    const fence = this.fence;
    if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) return -1;
    if (c.nearHazard(x, y, z)) return -1;
    // A fluid above or beside it would flow into the hole; sand or gravel on top would fall in.
    if (c.has(x, y + 1, z, CELL.LIQUID | CELL.FALLING)) return -1;
    for (const [dx, dz] of SIDES) {
      const s = c.flags(x + dx, y, z + dz);
      if ((s & CELL.LIQUID) !== 0) return -1;
      // Sand or gravel beside it with nothing under it: the break's update would drop it.
      if ((s & CELL.FALLING) !== 0 && !c.has(x + dx, y - 1, z + dz, CELL.SOLID)) return -1;
    }
    const t = canBreak({ x, y, z });
    return t === null || !Number.isFinite(t) || t < 0 ? -1 : t;
  }

  /**
   * Whether a throwaway block may go into (x, y, z), clicking the block at (ax, ay, az): the
   * caller's canPlace, and the pathfinder's own rules (see the file comment). The block
   * clicked is the floor of the feet block the movement starts from: with `floorPlaced` it is
   * one this path placed (a pillar or bridge before), which the world does not show yet.
   * With `broken`, (x, y, z) is a block this path broke (feetBroken): it takes a block
   * although the world still shows the old one.
   */
  canPlaceAt(
    x: number,
    y: number,
    z: number,
    ax: number,
    ay: number,
    az: number,
    broken = false,
  ): boolean {
    const t = this.options.throwaway;
    const canPlace = this.options.canPlace;
    if (t === null || t.count <= 0 || canPlace === null) return false;
    const c = this.cells;
    if (!this.floorPlaced && !c.has(ax, ay, az, CELL.CLICKABLE)) return false;
    const onPlaced = this.floorPlaced && ax === x && ay === y - 1 && az === z;
    if (t.falls && !onPlaced && !c.has(x, y - 1, z, CELL.SOLID)) return false;
    if (broken) return this.#cellTakesBlock(x, y, z, canPlace, true);
    // What does not depend on the block clicked, kept per cell.
    const i = c.index(x, y, z);
    const kept = (this.#placeOk ??= new Int8Array(c.volume));
    if (i >= 0 && kept[i] !== 0) return kept[i] === 1;
    const ok = this.#cellTakesBlock(x, y, z, canPlace);
    if (i >= 0) kept[i] = ok ? 1 : 2;
    return ok;
  }

  #cellTakesBlock(
    x: number,
    y: number,
    z: number,
    canPlace: (cell: Cell) => boolean,
    broken = false,
  ): boolean {
    const c = this.cells;
    if (!(broken || c.has(x, y, z, CELL.REPLACEABLE)) || c.nearHazard(x, y, z)) return false;
    for (const [dx, dy, dz] of FACES) if (c.has(x + dx, y + dy, z + dz, CELL.LIQUID)) return false;
    return canPlace({ x, y, z });
  }

  /**
   * Whether falling into the gap column (gx, gz) from feet level `y` lands safely: on a known
   * floor at most maxFall down, or in calm one-deep water from a safe height, past nothing
   * dangerous. A jump that fails (a correction, a stop) ends there. Kept per cell.
   */
  gapIsSafe(gx: number, y: number, gz: number): boolean {
    const i = this.cells.index(gx, y, gz);
    const kept = (this.#gapSafe ??= new Int8Array(this.cells.volume));
    if (i >= 0 && kept[i] !== 0) return kept[i] === 1;
    const ok = this.#gapIsSafeNow(gx, y, gz);
    if (i >= 0) kept[i] = ok ? 1 : 2;
    return ok;
  }

  #gapIsSafeNow(gx: number, y: number, gz: number): boolean {
    const c = this.cells;
    for (let h = 1; h <= MAX_WATER_FALL; h++) {
      const fy = y - h;
      if (fy < c.box.min.y) return false;
      if (c.has(gx, fy, gz, CELL.WATER)) {
        return (
          this.options.water &&
          c.wadeable(gx, fy, gz) &&
          Number.isFinite(this.costs.waterFall[h] ?? Infinity)
        );
      }
      if (!c.open(gx, fy, gz)) return false;
      if (c.has(gx, fy - 1, gz, CELL.SURFACE)) return h <= this.options.maxFall;
      if (c.has(gx, fy - 1, gz, CELL.SOLID)) return false;
    }
    return false;
  }
}

type Evaluate = (
  ctx: MoveContext,
  x: number,
  y: number,
  z: number,
  d: number,
  detail: Detail | null,
) => number;

/**
 * One block cardinal at the same level: walking, wading in calm one-deep water (into it, out
 * of it or within it), or with the body's way broken open (head first), or onto a block
 * placed in the gap against the side of the block underfoot (a bridge).
 */
const traverse: Evaluate = (ctx, x, y, z, d, detail) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.traverse, nx, y, nz, 0);
  if (!ctx.inFence(nx, y, nz)) return Infinity;
  const c = ctx.cells;
  const o = ctx.options;
  if (o.water && (c.has(x, y, z, CELL.WATER) || c.wadeable(nx, y, nz))) {
    if (!c.footing(nx, y, nz, true)) return Infinity;
    if (detail !== null) detail.water = true;
    return ctx.costs.wade;
  }
  if (c.standable(nx, y, nz)) {
    if (detail !== null) detail.sprint = o.sprint;
    return ctx.costs.walk;
  }
  // Onto a ladder at its foot: the feet in its column, on the floor under it.
  if (o.climb && c.held(nx, y, nz) && c.has(nx, y - 1, nz, CELL.SURFACE)) return ctx.costs.walk;
  const head = ctx.open(nx, y + 1, nz, detail);
  if (head < 0) return Infinity;
  const feet = ctx.open(nx, y, nz, detail);
  if (feet < 0) return Infinity;
  if (c.nearHazard(nx, y, nz) || c.nearHazard(nx, y + 1, nz)) return Infinity;
  if (feet === 0 && c.has(nx, y, nz, CELL.LADDER)) return Infinity;
  const opening = head + feet + (ctx.breaks > 0 ? ctx.costs.breakStart : 0);
  if (c.has(nx, y - 1, nz, CELL.SURFACE)) {
    // Standable once opened; with nothing to break it was refused for another reason.
    return ctx.breaks > 0 ? ctx.costs.walk + opening : Infinity;
  }
  if (!o.bridge || !ctx.canPlaceAt(nx, y - 1, nz, x, y - 1, z)) return Infinity;
  ctx.kind = KIND.bridge;
  ctx.places = 1;
  if (detail !== null) {
    detail.place = {
      cell: { x: nx, y: y - 1, z: nz },
      against: { x, y: y - 1, z },
      face: faceTowards(dx, dz),
      block: (o.throwaway as Throwaway).block,
    };
  }
  return ctx.costs.bridge + opening;
};

/**
 * One block diagonally at the same level, only between two open corners (no corner cutting),
 * walking or wading. Nothing is broken on a diagonal.
 */
const diagonal: Evaluate = (ctx, x, y, z, d, detail) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.diagonal, nx, y, nz, 0);
  if (!ctx.inFence(nx, y, nz)) return Infinity;
  const c = ctx.cells;
  const water = ctx.options.water;
  if (!c.footing(nx, y, nz, water)) return Infinity;
  let wet = water && (c.has(x, y, z, CELL.WATER) || c.has(nx, y, nz, CELL.WATER));
  for (let corner = 0; corner < 2; corner++) {
    const cx = corner === 0 ? nx : x;
    const cz = corner === 0 ? z : nz;
    if (!c.open(cx, y + 1, cz)) return Infinity;
    if (!c.open(cx, y, cz)) {
      if (!(water && c.calmWater(cx, y, cz) && !c.nearHazard(cx, y, cz))) return Infinity;
      wet = true;
    }
  }
  if (detail !== null) {
    detail.water = wet;
    detail.sprint = !wet && ctx.options.sprint;
  }
  return wet ? ctx.costs.wadeDiagonal : ctx.costs.diagonal;
};

/**
 * A jump onto the next block, one higher: room for the jump above the start and for the body
 * on the step (each broken open if need be, upper blocks first). A block above either head
 * only cuts the jump short; it still clears the step.
 */
const ascend: Evaluate = (ctx, x, y, z, d, detail) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.ascend, nx, y + 1, nz, 0);
  if (!ctx.inFence(nx, y + 1, nz)) return Infinity;
  const c = ctx.cells;
  if (!c.has(nx, y, nz, CELL.SURFACE)) return Infinity;
  if (c.has(x, y, z, CELL.WATER)) {
    // Out of the water onto a bank one higher: swimming up against it until the water pushes
    // the player up (execute.ts waterExit). The body rises to 1.5 above the water's floor:
    // the cells up to 3 above it must be open. Nothing is broken.
    if (!ctx.options.water || !c.standable(nx, y + 1, nz)) return Infinity;
    if (!c.open(x, y + 2, z) || !c.open(x, y + 3, z) || !c.open(nx, y + 3, nz)) return Infinity;
    if (detail !== null) detail.water = true;
    return ctx.costs.waterExit;
  }
  // Sand or gravel over the head is never broken (the client's dig rules refuse it: digging.ts
  // checkDig), so the planner does not count on it either.
  if (c.has(x, y + 2, z, CELL.FALLING)) return Infinity;
  const above = ctx.open(x, y + 2, z, detail);
  if (above < 0) return Infinity;
  const head = ctx.open(nx, y + 2, nz, detail);
  if (head < 0) return Infinity;
  const feet = ctx.open(nx, y + 1, nz, detail);
  if (feet < 0) return Infinity;
  if (c.nearHazard(x, y + 2, z) || c.nearHazard(nx, y + 1, nz) || c.nearHazard(nx, y + 2, nz)) {
    return Infinity;
  }
  // The feet rise through the cell above the start and end in the step's: no vines there.
  if (c.has(x, y + 1, z, CELL.LADDER) || (feet === 0 && c.has(nx, y + 1, nz, CELL.LADDER))) {
    return Infinity;
  }
  // The head peaks 3.05 above the start's feet: an open cell there must be safe too.
  if (c.has(x, y + 3, z, CELL.PASSABLE) && !c.open(x, y + 3, z)) return Infinity;
  if (c.has(nx, y + 3, nz, CELL.PASSABLE) && !c.open(nx, y + 3, nz)) return Infinity;
  return ctx.costs.ascend + above + head + feet + (ctx.breaks > 0 ? ctx.costs.breakStart : 0);
};

/**
 * Off the edge into the next column: a descend of one block (which may break its way open,
 * upper blocks first), a fall of 2..maxFall onto dry ground, or a fall into calm one-deep
 * water from a height the server does not punish. The column must be open down to the floor.
 */
const drop: Evaluate = (ctx, x, y, z, d, detail) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.descend, nx, y - 1, nz, 1);
  const c = ctx.cells;
  // A floor at the start's level is a traverse, not a drop.
  if (c.has(nx, y - 1, nz, CELL.SURFACE)) return Infinity;
  if (c.has(x, y, z, CELL.WATER) || !ctx.inFence(nx, y - 1, nz)) return Infinity;
  // The body crosses into the column at its own height.
  const head = ctx.open(nx, y + 1, nz, detail);
  if (head < 0) return Infinity;
  const feet = ctx.open(nx, y, nz, detail);
  if (feet < 0) return Infinity;
  if (c.nearHazard(nx, y + 1, nz) || c.nearHazard(nx, y, nz)) return Infinity;
  if (feet === 0 && c.has(nx, y, nz, CELL.LADDER)) return Infinity;
  if (ctx.breaks > 0 || !c.has(nx, y - 1, nz, CELL.PASSABLE | CELL.WATER)) {
    // Breaking its way: only a descend, one block down onto a known floor.
    const low = ctx.open(nx, y - 1, nz, detail);
    if (low < 0 || !c.has(nx, y - 2, nz, CELL.SURFACE) || c.nearHazard(nx, y - 1, nz)) {
      return Infinity;
    }
    if (low === 0 && c.has(nx, y - 1, nz, CELL.LADDER)) return Infinity;
    return (ctx.costs.fall[1] as number) + head + feet + low + ctx.costs.breakStart;
  }
  const o = ctx.options;
  for (let h = 1; h <= MAX_WATER_FALL; h++) {
    const fy = y - h;
    if (!ctx.inFence(nx, fy, nz)) return Infinity;
    if (c.has(nx, fy, nz, CELL.WATER)) {
      // Into calm one-deep water, from a height the server's accounting does not punish.
      const cost = ctx.costs.waterFall[h] ?? Infinity;
      if (!o.water || !c.wadeable(nx, fy, nz) || !Number.isFinite(cost)) return Infinity;
      ctx.dest(KIND.fall, nx, fy, nz, h);
      if (detail !== null) detail.water = true;
      return cost;
    }
    if (!c.open(nx, fy, nz) || c.has(nx, fy, nz, CELL.LADDER)) return Infinity;
    if (c.has(nx, fy - 1, nz, CELL.SURFACE)) {
      const cost = ctx.costs.fall[h] ?? Infinity;
      if (!Number.isFinite(cost) || !c.standable(nx, fy, nz)) return Infinity;
      ctx.dest(h === 1 ? KIND.descend : KIND.fall, nx, fy, nz, h);
      return cost;
    }
    // Something under it that is neither a floor nor open (nor water, next round): no landing.
    if (c.has(nx, fy - 1, nz, CELL.SOLID)) return Infinity;
  }
  return Infinity;
};

/**
 * A running jump over a gap of 1..3 blocks to the same level (3 only sprinting): the whole arc
 * clear (the body's cells up to 3 above the feet over the gap and the landing), a gap with no
 * floor at the feet level, and a standable landing. Nothing is broken.
 */
const parkour: Evaluate = (ctx, x, y, z, d, detail) => {
  ctx.begin(KIND.parkour, x, y, z, 0);
  const o = ctx.options;
  const c = ctx.cells;
  if (!o.parkour || d > 3 || c.has(x, y, z, CELL.WATER)) return Infinity;
  // The jump peaks 1.25 above the feet: inside the fence's heights.
  if (y > ctx.fence.max.y - 1) return Infinity;
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  // A floor right ahead: walk there instead (most of the time: checked first).
  if (c.has(x + dx, y - 1, z + dz, CELL.SOLID)) return Infinity;
  if (!c.open(x, y + 2, z)) return Infinity;
  for (let gap = 1; gap <= 3; gap++) {
    const gx = x + gap * dx;
    const gz = z + gap * dz;
    if (!ctx.inFence(gx, y, gz)) return Infinity;
    // A floor here: the gap ends (walk to it instead).
    if (c.has(gx, y - 1, gz, CELL.SOLID)) return Infinity;
    for (let cy = y; cy <= y + 3; cy++) if (!c.open(gx, cy, gz)) return Infinity;
    if (c.has(gx, y, gz, CELL.LADDER) || c.has(gx, y + 1, gz, CELL.LADDER)) return Infinity;
    if (!o.parkourOverDeepGaps && !ctx.gapIsSafe(gx, y, gz)) return Infinity;
    const lx = x + (gap + 1) * dx;
    const lz = z + (gap + 1) * dz;
    if (ctx.inFence(lx, y, lz) && c.standable(lx, y, lz)) {
      if (!c.open(lx, y + 2, lz) || !c.open(lx, y + 3, lz)) return Infinity;
      const cost = ctx.costs.parkour[gap] ?? Infinity;
      if (!Number.isFinite(cost)) return Infinity;
      ctx.dest(KIND.parkour, lx, y, lz, gap);
      if (detail !== null) detail.sprint = ctx.costs.parkourSprint[gap] ?? false;
      return cost;
    }
  }
  return Infinity;
};

/**
 * Pillaring: a jump straight up, placing a block in the cell the feet just left (against the
 * top of the block underfoot), landing on it. Room for the jump above the head is broken open
 * if need be; a block above that only cuts the jump short.
 */
const pillar: Evaluate = (ctx, x, y, z, _d, detail) => {
  ctx.begin(KIND.pillar, x, y + 1, z, 0);
  const o = ctx.options;
  const c = ctx.cells;
  if (!o.pillar || c.has(x, y, z, CELL.WATER) || !ctx.inFence(x, y + 1, z)) return Infinity;
  if (!ctx.canPlaceAt(x, y, z, x, y - 1, z, ctx.feetBroken)) return Infinity;
  // As for an ascend: sand or gravel over the head is never broken.
  if (c.has(x, y + 2, z, CELL.FALLING)) return Infinity;
  const head = ctx.open(x, y + 2, z, detail);
  if (head < 0) return Infinity;
  if (c.nearHazard(x, y + 2, z) || c.has(x, y + 1, z, CELL.LADDER)) return Infinity;
  if (c.has(x, y + 3, z, CELL.PASSABLE) && !c.open(x, y + 3, z)) return Infinity;
  ctx.places = 1;
  if (detail !== null) {
    detail.place = {
      cell: { x, y, z },
      against: { x, y: y - 1, z },
      face: 1,
      block: (o.throwaway as Throwaway).block,
    };
  }
  return ctx.costs.pillar + head;
};

/**
 * Into a doorway (a door or a fence gate: cells.ts), one block cardinal, along an axis its box
 * leaves clear, on its floor: a right-click first when its box is in the way and turns (a
 * wooden door turns a quarter, a gate opens; an iron door never), which the walk's next
 * movement undoes once the body is through (execute.ts). Doors must be allowed. Nothing is
 * broken or placed; the body stands in it centred, and leaves along the same axis (expand).
 */
const door: Evaluate = (ctx, x, y, z, d, detail) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.door, nx, y, nz, 0);
  if (!ctx.options.doors || d > 3 || !ctx.inFence(nx, y, nz)) return Infinity;
  const c = ctx.cells;
  const f = c.flags(nx, y, nz);
  if ((f & CELL.DOORWAY) === 0 || !c.has(nx, y - 1, nz, CELL.SURFACE)) return Infinity;
  if (c.has(x, y, z, CELL.WATER)) return Infinity;
  if (c.nearHazard(nx, y, nz) || c.nearHazard(nx, y + 1, nz)) return Infinity;
  // A door's upper half is the head's cell (the same door: the same clear axis); over a gate
  // the head needs room.
  const head = c.flags(nx, y + 1, nz);
  const clear = CELL.CLEAR_X | CELL.CLEAR_Z;
  if ((head & CELL.DOORWAY) !== 0) {
    if ((head & clear) !== (f & clear)) return Infinity;
  } else if (!c.open(nx, y + 1, nz)) {
    return Infinity;
  }
  const axis = dx !== 0 ? CELL.CLEAR_X : CELL.CLEAR_Z;
  if ((f & axis) !== 0) return ctx.costs.walk;
  if ((f & CELL.TOGGLE) === 0) return Infinity;
  if (detail !== null) {
    const was = c.world.metaAt?.(nx, y, nz) ?? 0;
    detail.toggle = {
      cell: { x: nx, y, z: nz },
      block: c.name(nx, y, nz) ?? '',
      was,
      meta: was ^ 4,
    };
  }
  return ctx.costs.walk + ctx.costs.door;
};

/** Digging down: breaking the block underfoot and dropping one block onto a known floor. */
const downward: Evaluate = (ctx, x, y, z, _d, detail) => {
  ctx.begin(KIND.downward, x, y - 1, z, 1);
  const c = ctx.cells;
  if (!ctx.options.downward || c.has(x, y, z, CELL.WATER) || !ctx.inFence(x, y - 1, z)) {
    return Infinity;
  }
  if (!c.has(x, y - 2, z, CELL.SURFACE)) return Infinity;
  const t = ctx.breakTicks(x, y - 1, z);
  if (t < 0) return Infinity;
  // After the cheap cached check: the dig-down rules look at a dozen cells (cached too).
  if (!ctx.digDownOk(x, y - 1, z)) return Infinity;
  ctx.breaks = 1;
  detail?.breaks.push({ cell: { x, y: y - 1, z }, ticks: t });
  return ctx.costs.downward + t;
};

/**
 * Up a ladder one block: from a feet block a ladder holds (cells.ts held) to the one above, the
 * body centred in the column, clear of the ladder's slab. A client climbs pushing against the
 * ladder: 1.7.10 sets motionY to 0.2 while it is pressed there, and gravity and drag leave
 * 0.1176 a tick; the server checks only that no block stops the move (none does).
 */
const climbUp: Evaluate = (ctx, x, y, z) => {
  ctx.begin(KIND.climbUp, x, y + 1, z, 0);
  const c = ctx.cells;
  if (!ctx.options.climb || !ctx.inFence(x, y + 1, z)) return Infinity;
  if (!c.held(x, y, z) || !c.held(x, y + 1, z)) return Infinity;
  return ctx.costs.climbUp;
};

/** Down a ladder one block, to a feet block it holds (its foot, or on down): 0.15 a tick. */
const climbDown: Evaluate = (ctx, x, y, z) => {
  ctx.begin(KIND.climbDown, x, y - 1, z, 0);
  const c = ctx.cells;
  if (!ctx.options.climb || !ctx.inFence(x, y - 1, z)) return Infinity;
  if (!c.held(x, y, z) || !c.held(x, y - 1, z)) return Infinity;
  return ctx.costs.climbDown;
};

/**
 * Onto a ladder from a ledge at its top, one block cardinal: across at the ledge's level into
 * the column above the ladder's top (open for the body), then down into its top block.
 */
const climbOn: Evaluate = (ctx, x, y, z, d) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.climbOn, nx, y - 1, nz, 0);
  const c = ctx.cells;
  if (!ctx.options.climb || !ctx.inFence(nx, y - 1, nz)) return Infinity;
  if (!c.standable(x, y, z)) return Infinity;
  if (!c.open(nx, y, nz) || !c.open(nx, y + 1, nz) || !c.held(nx, y - 1, nz)) return Infinity;
  return ctx.costs.walk + ctx.costs.climbDown;
};

/**
 * Off a ladder onto a ledge at its top, one block cardinal: up out of the ladder's top block
 * into the open column above it, then across onto the ledge.
 */
const climbOff: Evaluate = (ctx, x, y, z, d) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.climbOff, nx, y + 1, nz, 0);
  const c = ctx.cells;
  if (!ctx.options.climb || !ctx.inFence(nx, y + 1, nz)) return Infinity;
  if (!c.held(x, y, z) || !c.open(x, y + 1, z) || !c.open(x, y + 2, z)) return Infinity;
  if (!c.standable(nx, y + 1, nz)) return Infinity;
  return ctx.costs.climbUp + ctx.costs.walk;
};

/**
 * Across one block cardinal at the same level, held by a ladder at one end or both where it has
 * no floor under it: off a ladder onto a floor beside it partway up, onto one from a floor
 * beside it, or along a row of them. Never toward a ladder's wall: its slab, then the wall, are
 * in the way. (Where both ends have floors it is a traverse.)
 */
const climbAcross: Evaluate = (ctx, x, y, z, d) => {
  const [dx, dz] = DIRECTIONS[d] as readonly [number, number];
  const nx = x + dx;
  const nz = z + dz;
  ctx.begin(KIND.climbAcross, nx, y, nz, 0);
  const c = ctx.cells;
  if (!ctx.options.climb || !ctx.inFence(nx, y, nz)) return Infinity;
  const fromHeld = c.held(x, y, z);
  const toHeld = c.held(nx, y, nz);
  const hanging =
    (fromHeld && !c.has(x, y - 1, z, CELL.SURFACE)) ||
    (toHeld && !c.has(nx, y - 1, nz, CELL.SURFACE));
  if (!hanging) return Infinity;
  if (!fromHeld && !c.standable(x, y, z)) return Infinity;
  if (!toHeld && !c.standable(nx, y, nz)) return Infinity;
  const wall = c.ladderWall(nx, y, nz);
  if (wall !== null && wall[0] === -dx && wall[1] === -dz) return Infinity;
  return ctx.costs.climbAcross;
};

/** The evaluation that decides each kind (traverse also yields bridges, drop descends and falls). */
const BY_KIND: readonly Evaluate[] = [
  traverse,
  diagonal,
  ascend,
  drop,
  drop,
  parkour,
  pillar,
  traverse,
  downward,
  door,
  climbUp,
  climbDown,
  climbOn,
  climbOff,
  climbAcross,
];

export type Emit = (
  x: number,
  y: number,
  z: number,
  cost: number,
  code: number,
  breaks: number,
  places: number,
) => void;

const CARDINAL_MOVES: readonly Evaluate[] = [
  traverse,
  ascend,
  drop,
  parkour,
  door,
  climbOn,
  climbAcross,
];
const VERTICAL_MOVES: readonly Evaluate[] = [pillar, downward, climbUp, climbDown];
/** From a feet block a ladder holds with no floor under it: only climbs. */
const HELD_VERTICAL: readonly Evaluate[] = [climbUp, climbDown];
const HELD_ACROSS: readonly Evaluate[] = [climbOff, climbAcross];
const DOORWAY_MOVES: readonly Evaluate[] = [traverse, door];

/** MoveContext.doorway: the feet block is a doorway (with the axes it may be left along). */
export const IN_DOORWAY = 4;

/** The axis bit (1 along x, 2 along z) of a cardinal direction (an index into DIRECTIONS). */
const axisOf = (d: number): number => (d < 2 ? 1 : 2);

/**
 * The axes a body that came into a doorway by the movement with `code` may leave it along,
 * for MoveContext.doorway: the door movement's own axis (back the same way, or on), else none.
 */
export function doorwayAxes(code: number): number {
  return (code & 15) === KIND.door ? IN_DOORWAY | axisOf((code >> 4) & 15) : IN_DOORWAY;
}

/** Every movement possible from feet block (x, y, z), each passed to `emit`. */
export function expand(ctx: MoveContext, x: number, y: number, z: number, emit: Emit): void {
  const c = ctx.cells;
  if (c.has(x, y, z, CELL.CLIMB) && !c.has(x, y - 1, z, CELL.SURFACE)) {
    // On a ladder in mid-air: up, down, off at its top, or across at this level (a walk from
    // here would fall).
    for (const evaluate of HELD_VERTICAL) {
      const cost = evaluate(ctx, x, y, z, 0, null);
      if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(0), 0, 0);
    }
    const wall = c.ladderWall(x, y, z);
    for (let d = 0; d < 4; d++) {
      for (const evaluate of HELD_ACROSS) {
        if (evaluate === climbAcross && wall !== null && towards(d, wall)) continue;
        const cost = evaluate(ctx, x, y, z, d, null);
        if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(d), 0, 0);
      }
    }
    return;
  }
  if (ctx.doorway !== 0) {
    // In a doorway: only a walk on (or back) along its clear axis, or into the next doorway.
    for (let d = 0; d < 4; d++) {
      if ((ctx.doorway & axisOf(d)) === 0) continue;
      for (const evaluate of DOORWAY_MOVES) {
        const cost = evaluate(ctx, x, y, z, d, null);
        if (cost < Infinity) {
          emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(d), ctx.breaks, ctx.places);
        }
      }
    }
    return;
  }
  // At a ladder's foot, nothing heads toward its wall but climbOff: the ladder's slab is in the
  // body's way until the feet are over its top (an independent review, 2026-10-04: a jump
  // from a ladder's foot onto the block it hangs on was planned, and its steps hit the slab).
  const wall = c.ladderWall(x, y, z);
  for (let d = 0; d < 4; d++) {
    if (wall !== null && towards(d, wall)) continue;
    for (const evaluate of CARDINAL_MOVES) {
      const cost = evaluate(ctx, x, y, z, d, null);
      if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(d), ctx.breaks, ctx.places);
    }
  }
  for (let d = 4; d < 8; d++) {
    if (wall !== null && towards(d, wall)) continue;
    const cost = diagonal(ctx, x, y, z, d, null);
    if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(d), 0, 0);
  }
  for (const evaluate of VERTICAL_MOVES) {
    const cost = evaluate(ctx, x, y, z, 0, null);
    if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(0), ctx.breaks, ctx.places);
  }
  if (c.has(x, y, z, CELL.CLIMB)) {
    // At a ladder's foot: off it onto a ledge one up is a climb too.
    for (let d = 0; d < 4; d++) {
      const cost = climbOff(ctx, x, y, z, d, null);
      if (cost < Infinity) emit(ctx.nx, ctx.ny, ctx.nz, cost, ctx.code(d), 0, 0);
    }
  }
}

/** Whether direction `d` (an index into DIRECTIONS) heads at all along (dx, dz). */
function towards(d: number, [dx, dz]: readonly [number, number]): boolean {
  const [x, z] = DIRECTIONS[d] as readonly [number, number];
  return x * dx + z * dz > 0;
}

/** Whether movement kind `kind` (KIND) goes straight up or down: no step across. */
const isVertical = (kind: number): boolean =>
  kind === KIND.pillar ||
  kind === KIND.downward ||
  kind === KIND.climbUp ||
  kind === KIND.climbDown;

/** The code of a plain traverse or diagonal in direction (dx, dz) (a unit step). */
export function walkCode(dx: number, dz: number): number {
  const d = DIRECTIONS.findIndex(([x, z]) => x === dx && z === dz);
  if (d < 0) throw new Error(`internal: no direction (${dx}, ${dz})`);
  return (d < 4 ? KIND.traverse : KIND.diagonal) | (d << 4);
}

/** The direction (an index into DIRECTIONS) the movement with `code` goes in; -1 for vertical ones. */
export function directionOf(code: number): number {
  const kind = code & 15;
  return isVertical(kind) ? -1 : (code >> 4) & 15;
}

/** Whether the movement with `code` leaves the player on a block it placed (pillar, bridge). */
export function placesFloor(code: number): boolean {
  const kind = code & 15;
  return kind === KIND.pillar || kind === KIND.bridge;
}

/**
 * The movement with `code` (from the search) out of feet block `from`, in full: what it breaks
 * and places. Null when it is not possible (on this world).
 */
export function describe(ctx: MoveContext, from: Cell, code: number): Movement | null {
  const kind = code & 15;
  const d = (code >> 4) & 15;
  const param = code >> 8;
  const evaluate = BY_KIND[kind];
  const name = MOVEMENT_KINDS[kind];
  if (evaluate === undefined || name === undefined) return null;
  const detail: Detail = { breaks: [], place: null, water: false, sprint: false, toggle: null };
  const cost = evaluate(ctx, from.x, from.y, from.z, d, detail);
  if (!(cost < Infinity) || ctx.kind !== kind || ctx.param !== param) return null;
  const [dx, dz] = isVertical(kind) ? [0, 0] : (DIRECTIONS[d] as readonly [number, number]);
  return {
    kind: name,
    from: { x: from.x, y: from.y, z: from.z },
    to: { x: ctx.nx, y: ctx.ny, z: ctx.nz },
    dir: { x: dx, z: dz },
    cost,
    breaks: detail.breaks,
    place: detail.place,
    water: detail.water,
    sprint: detail.sprint,
    gap: kind === KIND.parkour ? param : 0,
    drop: kind === KIND.descend || kind === KIND.fall ? param : 0,
    toggle: detail.toggle,
  };
}
