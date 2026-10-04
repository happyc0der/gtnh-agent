import { BLOCK_CODE } from './block-hazards.ts';
import { passProblem } from './passable.ts';

/**
 * Walking for the live GTNH client: path planning and the safety checks for every step.
 * Pure functions over the block data the server sent; no I/O.
 *
 * The scope is deliberately small. The player walks on ONE flat level inside a configured
 * fence: no jumping, climbing, stepping up or down, swimming, falling or block changes.
 * Every block the player's body touches must be air or a plant it passes through
 * (passable.ts), every block under it must be a known full block (WALKABLE_SURFACES), and
 * nothing dangerous may touch those blocks. Unloaded chunks, unnamed block ids and anything
 * not listed count as obstacles (fail closed). Straight stretches are checked exactly (the
 * swept body, not samples).
 */

/** Half the player's width: its body is 0.6 x 1.8 x 0.6 blocks around its feet position. */
export const PLAYER_HALF_WIDTH = 0.3;
/** Vanilla walking covers 0.216 blocks per tick (4.3 m/s); the agent walks a little slower. */
export const WALK_BLOCKS_PER_TICK = 0.2;
const EPS = 1e-6;

/**
 * Full-cube 1.7.10 blocks the player may stand on. Anything else (slabs, stairs, soul
 * sand, farmland, ice, leaves, liquids, every modded block, ...) is not walkable until it
 * has been checked and added here.
 */
export const WALKABLE_SURFACES: ReadonlySet<string> = new Set([
  'minecraft:stone',
  'minecraft:grass',
  'minecraft:dirt',
  'minecraft:cobblestone',
  'minecraft:mossy_cobblestone',
  'minecraft:planks',
  'minecraft:log',
  'minecraft:log2',
  'minecraft:bedrock',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:sandstone',
  'minecraft:glass',
  'minecraft:stained_glass',
  'minecraft:stonebrick',
  'minecraft:brick_block',
  'minecraft:wool',
  'minecraft:clay',
  'minecraft:hardened_clay',
  'minecraft:stained_hardened_clay',
  'minecraft:obsidian',
  'minecraft:snow',
  'minecraft:double_stone_slab',
  'minecraft:double_wooden_slab',
  'minecraft:quartz_block',
]);

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Inclusive block bounds at the feet level; min.y === max.y (one walking level). */
export interface Fence {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Read access to the blocks the server sent. */
export interface WalkWorld {
  /** Block id at integer block coordinates, or undefined if its chunk is not loaded. */
  blockAt(x: number, y: number, z: number): number | undefined;
  /**
   * Block metadata at integer block coordinates, or undefined when it is not known. Without
   * it, blocks the body passes only at some metadata (passable.ts) count as walls.
   */
  metaAt?(x: number, y: number, z: number): number | undefined;
  /** Registry name of a block id (undefined if the registry does not name it). */
  blockName(id: number): string | undefined;
  /** Hazard code (block-hazards.ts BLOCK_CODE) of a block id. */
  hazardCode(id: number): number;
  /**
   * Whether a player built the block at (x, y, z): the client saw it placed while another
   * player stood near, and did not place it itself (world-model.ts). The agent never breaks
   * such a block. Absent: no builds are known.
   */
  builtByPlayer?(x: number, y: number, z: number): boolean;
}

export type CellProblem =
  | { kind: 'unloaded'; detail: string }
  | { kind: 'blocked'; detail: string }
  | { kind: 'no-floor'; detail: string }
  | { kind: 'hazard'; detail: string };

const describe = (world: WalkWorld, id: number): string =>
  world.blockName(id) ?? `unnamed block id ${id}`;

/** Why the player could not stand with its feet in block (x, y, z), or null if it can. */
export function cellProblem(world: WalkWorld, x: number, y: number, z: number): CellProblem | null {
  const below = world.blockAt(x, y - 1, z);
  const feet = world.blockAt(x, y, z);
  const head = world.blockAt(x, y + 1, z);
  if (below === undefined || feet === undefined || head === undefined) {
    return { kind: 'unloaded', detail: 'chunk not loaded' };
  }
  const body = passProblem(world, x, y, z) ?? passProblem(world, x, y + 1, z);
  if (body !== null) return { kind: 'blocked', detail: body };
  const surface = world.blockName(below);
  if (surface === undefined || !WALKABLE_SURFACES.has(surface)) {
    return {
      kind: 'no-floor',
      detail: `no known full block underfoot (${describe(world, below)})`,
    };
  }
  // Nothing dangerous may touch it: lava flows, fire spreads, cactus hurts on contact.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const id = world.blockAt(x + dx, y + dy, z + dz);
        if (id === undefined) return { kind: 'unloaded', detail: 'next to an unloaded chunk' };
        if (world.hazardCode(id) !== BLOCK_CODE.safe) {
          return { kind: 'hazard', detail: `next to ${describe(world, id)}` };
        }
      }
    }
  }
  return null;
}

/** Open t-interval where p + t*d lies strictly inside (lo, hi); null if never. */
function inside(p: number, d: number, lo: number, hi: number): [number, number] | null {
  if (Math.abs(d) < 1e-12) return p > lo && p < hi ? [-Infinity, Infinity] : null;
  const t1 = (lo - p) / d;
  const t2 = (hi - p) / d;
  return [Math.min(t1, t2), Math.max(t1, t2)];
}

/**
 * Every block column (x, z) the player's body overlaps while moving in a straight line
 * from a to b (exact: the swept body, not samples). Touching a face is not overlapping.
 */
export function sweptColumns(a: Vec3, b: Vec3): Array<[number, number]> {
  const h = PLAYER_HALF_WIDTH;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const out: Array<[number, number]> = [];
  const x0 = Math.floor(Math.min(a.x, b.x) - h + EPS);
  const x1 = Math.ceil(Math.max(a.x, b.x) + h - EPS) - 1;
  const z0 = Math.floor(Math.min(a.z, b.z) - h + EPS);
  const z1 = Math.ceil(Math.max(a.z, b.z) + h - EPS) - 1;
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      // The body overlaps column (x, z) when its centre is strictly inside the column
      // grown by the half-width on every side.
      const tx = inside(a.x, dx, x - h + EPS, x + 1 + h - EPS);
      const tz = inside(a.z, dz, z - h + EPS, z + 1 + h - EPS);
      if (tx === null || tz === null) continue;
      if (Math.max(tx[0], tz[0], 0) < Math.min(tx[1], tz[1], 1)) out.push([x, z]);
    }
  }
  return out;
}

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

function outsideFence(fence: Fence, p: Vec3): boolean {
  const h = PLAYER_HALF_WIDTH;
  return (
    p.x - h < fence.min.x - EPS ||
    p.x + h > fence.max.x + 1 + EPS ||
    p.z - h < fence.min.z - EPS ||
    p.z + h > fence.max.z + 1 + EPS
  );
}

/**
 * Why the player could not move in a straight line from a to b (both on the fence's
 * level), or null if every block its body would touch is walkable. The fence is a box,
 * so a stretch whose ends are inside stays inside.
 */
export function segmentProblem(world: WalkWorld, fence: Fence, a: Vec3, b: Vec3): string | null {
  const level = fence.min.y;
  for (const p of [a, b]) {
    if (Math.abs(p.y - level) > EPS)
      return `feet at y=${fmt(p.y)}, not on the walking level y=${level}`;
    if (outsideFence(fence, p)) return `(${fmt(p.x)}, ${fmt(p.z)}) is outside the movement fence`;
  }
  for (const [x, z] of sweptColumns(a, b)) {
    const problem = cellProblem(world, x, level, z);
    if (problem !== null) return `block (${x}, ${level}, ${z}): ${problem.detail}`;
  }
  return null;
}

/** Why the player could not be at p, or null if it can. */
export function positionProblem(world: WalkWorld, fence: Fence, p: Vec3): string | null {
  return segmentProblem(world, fence, p, p);
}

export type WalkPlan =
  { ok: true; waypoints: Vec3[]; length: number } | { ok: false; reason: string };

const center = (x: number, y: number, z: number): Vec3 => ({ x: x + 0.5, y, z: z + 0.5 });
const flatDistance = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.z - a.z);

/**
 * Plans a walk from `from` to `to` on the fence's level: A* over the fence's blocks
 * (diagonal steps only when both side blocks are walkable), then straightened wherever
 * a direct stretch is clear. Ends exactly at `to` when the player fits there, otherwise
 * at the centre of `to`'s block. Every stretch of the result passes segmentProblem().
 */
export function planWalk(
  world: WalkWorld,
  fence: Fence,
  from: Vec3,
  to: Vec3,
  maxLength: number,
): WalkPlan {
  const level = fence.min.y;
  const refuse = (reason: string): WalkPlan => ({ ok: false, reason });
  if (Math.abs(from.y - level) > EPS) {
    return refuse(`the player's feet are at y=${fmt(from.y)}, not on the walking level y=${level}`);
  }
  if (Math.abs(to.y - level) > EPS) {
    return refuse(
      `the target is at y=${fmt(to.y)}; walking stays on level y=${level} (no climbing or dropping)`,
    );
  }
  const here = positionProblem(world, fence, from);
  if (here !== null) return refuse(`cannot walk from here: ${here}`);

  const goal = { x: Math.floor(to.x), z: Math.floor(to.z) };
  if (
    goal.x < fence.min.x ||
    goal.x > fence.max.x ||
    goal.z < fence.min.z ||
    goal.z > fence.max.z
  ) {
    return refuse('the target is outside the movement fence');
  }
  const goalProblem = cellProblem(world, goal.x, level, goal.z);
  if (goalProblem !== null)
    return refuse(`the target block is not walkable: ${goalProblem.detail}`);

  const start = { x: Math.floor(from.x), z: Math.floor(from.z) };
  const cells = searchCells(world, fence, start, goal);
  if (cells === null) return refuse('there is no walkable path to the target inside the fence');

  const target: Vec3 = { x: to.x, y: level, z: to.z };
  const goalCenter = center(goal.x, level, goal.z);
  const raw: Vec3[] = [from, ...cells.map((c) => center(c.x, level, c.z))];
  if (segmentProblem(world, fence, goalCenter, target) === null) raw.push(target);
  const waypoints = straighten(world, fence, dedupe(raw));

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as Vec3;
    const b = waypoints[i] as Vec3;
    const problem = segmentProblem(world, fence, a, b);
    if (problem !== null) return refuse(`internal: planned stretch is not clear (${problem})`);
  }
  const length = waypoints.reduce(
    (sum, p, i) => (i === 0 ? 0 : sum + flatDistance(waypoints[i - 1] as Vec3, p)),
    0,
  );
  if (length > maxLength + EPS) {
    return refuse(`the path is ${fmt(length)} blocks long (the limit is ${maxLength})`);
  }
  return { ok: true, waypoints, length };
}

function dedupe(points: Vec3[]): Vec3[] {
  return points.filter((p, i) => i === 0 || flatDistance(points[i - 1] as Vec3, p) > EPS);
}

/** Greedy line of sight: from each kept point, jump to the farthest point with a clear stretch. */
function straighten(world: WalkWorld, fence: Fence, points: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  let i = 0;
  out.push(points[0] as Vec3);
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (
      j > i + 1 &&
      segmentProblem(world, fence, points[i] as Vec3, points[j] as Vec3) !== null
    ) {
      j--;
    }
    out.push(points[j] as Vec3);
    i = j;
  }
  return out;
}

interface Cell {
  x: number;
  z: number;
}

/** A* over the fence's blocks at its level; 8-connected without cutting corners. */
function searchCells(world: WalkWorld, fence: Fence, start: Cell, goal: Cell): Cell[] | null {
  const width = fence.max.x - fence.min.x + 1;
  const depth = fence.max.z - fence.min.z + 1;
  const index = (x: number, z: number): number => x - fence.min.x + (z - fence.min.z) * width;
  const cellAt = (i: number): Cell => ({
    x: (i % width) + fence.min.x,
    z: Math.floor(i / width) + fence.min.z,
  });
  const state = new Int8Array(width * depth); // 0 = not checked, 1 = walkable, 2 = not
  const walkable = (x: number, z: number): boolean => {
    if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) return false;
    const i = index(x, z);
    if (state[i] === 0) state[i] = cellProblem(world, x, fence.min.y, z) === null ? 1 : 2;
    return state[i] === 1;
  };
  const heuristic = (x: number, z: number): number => {
    const dx = Math.abs(x - goal.x);
    const dz = Math.abs(z - goal.z);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };

  const g = new Float64Array(width * depth).fill(Infinity);
  const cameFrom = new Int32Array(width * depth).fill(-1);
  const closed = new Uint8Array(width * depth);
  const open = new MinHeap();
  const s = index(start.x, start.z);
  g[s] = 0;
  open.push(heuristic(start.x, start.z), s);
  const goalIndex = index(goal.x, goal.z);

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === 1) continue;
    closed[current] = 1;
    if (current === goalIndex) {
      const path: Cell[] = [];
      for (let i = current; i !== -1; i = cameFrom[i] as number) path.push(cellAt(i));
      return path.reverse();
    }
    const c = cellAt(current);
    for (const [dx, dz] of NEIGHBOURS) {
      const nx = c.x + dx;
      const nz = c.z + dz;
      if (!walkable(nx, nz)) continue;
      const diagonal = dx !== 0 && dz !== 0;
      if (diagonal && !(walkable(c.x + dx, c.z) && walkable(c.x, c.z + dz))) continue;
      const n = index(nx, nz);
      const cost = (g[current] as number) + (diagonal ? Math.SQRT2 : 1);
      if (cost < (g[n] as number)) {
        g[n] = cost;
        cameFrom[n] = current;
        open.push(cost + heuristic(nx, nz), n);
      }
    }
  }
  return null;
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Minimal binary min-heap of (priority, value). */
class MinHeap {
  readonly #keys: number[] = [];
  readonly #values: number[] = [];

  get size(): number {
    return this.#keys.length;
  }

  push(key: number, value: number): void {
    const k = this.#keys;
    const v = this.#values;
    k.push(key);
    v.push(value);
    let i = k.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((k[parent] as number) <= key) break;
      k[i] = k[parent] as number;
      v[i] = v[parent] as number;
      i = parent;
    }
    k[i] = key;
    v[i] = value;
  }

  pop(): number {
    const k = this.#keys;
    const v = this.#values;
    const top = v[0] as number;
    const lastKey = k.pop() as number;
    const lastValue = v.pop() as number;
    if (k.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= k.length) break;
        const right = left + 1;
        const child = right < k.length && (k[right] as number) < (k[left] as number) ? right : left;
        if ((k[child] as number) >= lastKey) break;
        k[i] = k[child] as number;
        v[i] = v[child] as number;
        i = child;
      }
      k[i] = lastKey;
      v[i] = lastValue;
    }
    return top;
  }
}

/** Positions one tick apart along the waypoints (never more than `perTick` blocks per step). */
export function stepsAlong(waypoints: readonly Vec3[], perTick = WALK_BLOCKS_PER_TICK): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as Vec3;
    const b = waypoints[i] as Vec3;
    const n = Math.max(1, Math.ceil(flatDistance(a, b) / perTick - EPS));
    for (let k = 1; k < n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: b.y, z: a.z + ((b.z - a.z) * k) / n });
    }
    out.push({ x: b.x, y: b.y, z: b.z }); // exactly, not an interpolation
  }
  return out;
}

/** Minecraft yaw (degrees; 0 = +z/south, 90 = -x/west) for facing from a towards b. */
export function yawTowards(a: Vec3, b: Vec3): number {
  return (Math.atan2(-(b.x - a.x), b.z - a.z) * 180) / Math.PI;
}

export interface MapMarks {
  player?: Vec3 | null;
  target?: Vec3 | null;
  path?: readonly Vec3[];
  /** Entities to draw; threats are drawn as 'E', others as 'e'. */
  entities?: ReadonlyArray<{ x: number; z: number; threat: boolean }>;
}

/**
 * Top-down text map of the fence plus a one-block border (north up, west left):
 *   .  walkable   #  blocked   _  no floor   !  hazard next to it   ?  not loaded
 *   *  planned path   @  the player   T  target   E  threat   e  other entity
 */
export function renderWalkMap(world: WalkWorld, fence: Fence, marks: MapMarks = {}): string[] {
  const level = fence.min.y;
  const x0 = fence.min.x - 1;
  const x1 = fence.max.x + 1;
  const z0 = fence.min.z - 1;
  const z1 = fence.max.z + 1;
  const width = x1 - x0 + 1;
  const grid: string[][] = [];
  for (let z = z0; z <= z1; z++) {
    const row: string[] = [];
    for (let x = x0; x <= x1; x++) {
      const p = cellProblem(world, x, level, z);
      row.push(
        p === null ? '.' : { unloaded: '?', blocked: '#', 'no-floor': '_', hazard: '!' }[p.kind],
      );
    }
    grid.push(row);
  }
  const put = (x: number, z: number, ch: string): void => {
    const row = grid[Math.floor(z) - z0];
    const col = Math.floor(x) - x0;
    if (row !== undefined && col >= 0 && col < width) row[col] = ch;
  };
  const path = marks.path ?? [];
  for (let i = 1; i < path.length; i++) {
    for (const [x, z] of sweptColumns(path[i - 1] as Vec3, path[i] as Vec3)) {
      const a = path[i - 1] as Vec3;
      const b = path[i] as Vec3;
      // Mark only the columns the path's centre line crosses, not the body's full width.
      if (lineCrossesColumn(a, b, x, z)) put(x, z, '*');
    }
  }
  for (const e of marks.entities ?? []) put(e.x, e.z, e.threat ? 'E' : 'e');
  if (marks.target) put(marks.target.x, marks.target.z, 'T');
  if (marks.player) put(marks.player.x, marks.player.z, '@');
  return [
    `x ${x0}..${x1} (west to east), z ${z0}..${z1} (north to south), feet level y=${level}`,
    ...grid.map((row) => row.join(' ')),
    '. walkable  # blocked  _ no floor  ! hazard  ? not loaded  * path  @ player  T target  E threat',
  ];
}

function lineCrossesColumn(a: Vec3, b: Vec3, x: number, z: number): boolean {
  const tx = inside(a.x, b.x - a.x, x - EPS, x + 1 + EPS);
  const tz = inside(a.z, b.z - a.z, z - EPS, z + 1 + EPS);
  if (tx === null || tz === null) return false;
  return Math.max(tx[0], tz[0], 0) < Math.min(tx[1], tz[1], 1);
}
