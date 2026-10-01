import { BLOCK_CODE } from './block-hazards.ts';
import { passProblem } from './passable.ts';
import {
  PLAYER_HALF_WIDTH,
  WALK_BLOCKS_PER_TICK,
  WALKABLE_SURFACES,
  type Fence,
  type Vec3,
  type WalkWorld,
} from './walking.ts';

/**
 * Walking over real terrain: level moves, one-block steps up and drops of up to
 * MAX_DROP blocks, inside a 3D fence (a box of feet blocks with a height range). Pure.
 *
 * How moves look to the server (1.7.10 checks horizontal movement against its own
 * collisions, not vertical movement):
 *  - step up: rise 1.01 blocks in place (the column above must be clear), move across
 *    above the step, then settle onto it;
 *  - drop: move across the edge at the current height (the lower column must be clear),
 *    then fall with vanilla gravity and land exactly on the block. A drop of at most
 *    MAX_DROP blocks never causes fall damage (that starts above 3).
 * Water, lava and anything not passable (passable.ts: air and plants checked in their
 * code, some only at certain metadata) or standable is never entered.
 */

/** Natural full blocks the player may stand on, on top of the pen's list. */
const TERRAIN_SURFACES: ReadonlySet<string> = new Set([...WALKABLE_SURFACES, 'minecraft:mycelium']);

export const MAX_DROP = 2;
const EPS = 1e-6;
/** Height above a step at which the player crosses onto it. */
const STEP_CLEARANCE = 0.01;
const PLAYER_HEIGHT = 1.8;

/**
 * One move of a terrain walk. `breaks`: the blocks to break before it, top first (only
 * straight moves, only with WalkBreaks); absent when there are none.
 */
export type TerrainMove =
  | { kind: 'walk'; to: Vec3; breaks?: readonly Cell[] }
  | { kind: 'step-up'; to: Vec3; breaks?: readonly Cell[] }
  | { kind: 'drop'; to: Vec3; height: number; breaks?: readonly Cell[] };

export type TerrainPlan =
  { ok: true; moves: TerrainMove[]; length: number } | { ok: false; reason: string };

const name = (world: WalkWorld, id: number): string =>
  id === 0 ? 'minecraft:air' : (world.blockName(id) ?? `unnamed block id ${id}`);

/**
 * Why the player could not stand with its feet in block (x, y, z), or null: a known full
 * block under it, its feet and head cells passable (a plant the body passes is fine there),
 * and no hazard in the 3 x 3 columns around, from under the feet to above the head.
 */
export function standProblem(world: WalkWorld, x: number, y: number, z: number): string | null {
  const below = world.blockAt(x, y - 1, z);
  if (below === undefined) return 'chunk not loaded';
  const surface = name(world, below);
  if (!TERRAIN_SURFACES.has(surface)) {
    return `no known full block underfoot (${surface})`;
  }
  const body = passProblem(world, x, y, z) ?? passProblem(world, x, y + 1, z);
  if (body !== null) return body;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const id = world.blockAt(x + dx, y + dy, z + dz);
        if (id === undefined) return 'next to an unloaded chunk';
        if (world.hazardCode(id) !== BLOCK_CODE.safe) return `next to ${name(world, id)}`;
      }
    }
  }
  return null;
}

function inFence(fence: Fence, x: number, y: number, z: number): boolean {
  return (
    x >= fence.min.x &&
    x <= fence.max.x &&
    z >= fence.min.z &&
    z <= fence.max.z &&
    y >= fence.min.y &&
    y <= fence.max.y
  );
}

/**
 * Why the player's body could not be at `p` (any height, e.g. mid-step), or null: inside
 * the fence, and every block the body overlaps passable.
 */
export function bodyProblem(world: WalkWorld, fence: Fence, p: Vec3): string | null {
  const h = PLAYER_HALF_WIDTH;
  if (
    p.x - h < fence.min.x - EPS ||
    p.x + h > fence.max.x + 1 + EPS ||
    p.z - h < fence.min.z - EPS ||
    p.z + h > fence.max.z + 1 + EPS ||
    p.y < fence.min.y - EPS ||
    p.y > fence.max.y + 1 + EPS
  ) {
    return `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}) is outside the movement fence`;
  }
  for (let x = Math.floor(p.x - h + EPS); x <= Math.ceil(p.x + h - EPS) - 1; x++) {
    for (let z = Math.floor(p.z - h + EPS); z <= Math.ceil(p.z + h - EPS) - 1; z++) {
      for (let y = Math.floor(p.y + EPS); y <= Math.ceil(p.y + PLAYER_HEIGHT - EPS) - 1; y++) {
        const problem = passProblem(world, x, y, z);
        if (problem !== null) return `block (${x}, ${y}, ${z}): ${problem}`;
      }
    }
  }
  return null;
}

interface Node {
  x: number;
  y: number;
  z: number;
}

/** A block's position: a cell the body passes, or a block a walk breaks. */
export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * What a walk may break on its way (digging enabled: leaves; digging.ts walkBreaks builds it
 * from checkDig's rules and the dig time), as a person punches through a leaf bush rather
 * than walk all the way round it. Only straight moves break, the cells their body passes: a
 * level move's destination (head, then feet), a step up's head-room above the player and its
 * destination, the column a drop passes and its landing. Diagonal moves never break: they
 * keep the walker's corner rule. planTerrainWalk and reachableFeet take the same one, so a
 * feet block the flood reaches by breaking is one a walk plans to the same way.
 */
export interface WalkBreaks {
  /** At most this many blocks broken per walk. */
  readonly max: number;
  /** The block names it may break at all (a quick test; `check` decides). */
  readonly blocks: ReadonlySet<string>;
  /**
   * Whether the player, standing at `feet` (the centre of the block a move starts from), may
   * break the block at `cell`, and what that costs, in blocks walked.
   */
  check(
    world: WalkWorld,
    feet: Vec3,
    cell: Cell,
  ): { ok: true; cost: number } | { ok: false; reason: string };
}

const key = (n: Node | Cell): string => `${n.x},${n.y},${n.z}`;
const centre = (n: Node): Vec3 => ({ x: n.x + 0.5, y: n.y, z: n.z + 0.5 });

/** A way to a feet block: what the search minimises, the blocks walked, the blocks broken. */
interface Label {
  cost: number;
  length: number;
  breaks: number;
}

/** `world` with `cells` read as air: the world as a walk leaves it once it has broken them. */
function withAir(world: WalkWorld, cells: readonly Cell[]): WalkWorld {
  if (cells.length === 0) return world;
  const air = new Set(cells.map(key));
  const broken = (x: number, y: number, z: number): boolean => air.has(`${x},${y},${z}`);
  return {
    blockAt: (x, y, z) => (broken(x, y, z) ? 0 : world.blockAt(x, y, z)),
    metaAt: (x, y, z) => (broken(x, y, z) ? 0 : world.metaAt?.(x, y, z)),
    blockName: (id) => world.blockName(id),
    hazardCode: (id) => world.hazardCode(id),
  };
}

/** The player's two body cells with its feet in block `n`, head first. */
const bodyCells = (n: Node): Cell[] => [
  { x: n.x, y: n.y + 1, z: n.z },
  { x: n.x, y: n.y, z: n.z },
];

/**
 * Why the player could not stand with its feet in block `n`, even once a walk has broken
 * what `breaks` may break in its body's cells (by name only: whether a move may break them
 * is the search's question), or null. Without `breaks`, standProblem.
 */
function standOnceOpened(world: WalkWorld, n: Node, breaks: WalkBreaks | undefined): string | null {
  const plain = standProblem(world, n.x, n.y, n.z);
  if (plain === null || breaks === undefined) return plain;
  const breakable = bodyCells(n).filter((c) => {
    const id = world.blockAt(c.x, c.y, c.z);
    return id !== undefined && id !== 0 && breaks.blocks.has(world.blockName(id) ?? '');
  });
  return breakable.length === 0 ? plain : standProblem(withAir(world, breakable), n.x, n.y, n.z);
}

/**
 * Plans a walk over terrain from `from` (feet exactly on a block top) to the block
 * containing `to` (feet level = the block the target stands in). A* over feet blocks
 * with level moves (8 directions, no corner cutting), steps up of one block and drops
 * of up to MAX_DROP, at most `maxLength` blocks walked. With `breaks`, straight moves may
 * break what is in the way (WalkBreaks): each break adds its cost, so a way round that is
 * not much longer wins, and at most `breaks.max` per walk. Ends at the target block's
 * centre.
 */
export function planTerrainWalk(
  world: WalkWorld,
  fence: Fence,
  from: Vec3,
  to: Vec3,
  maxLength: number,
  breaks?: WalkBreaks,
): TerrainPlan {
  const refuse = (reason: string): TerrainPlan => ({ ok: false, reason });
  if (Math.abs(from.y - Math.round(from.y)) > EPS) {
    return refuse(`the player's feet are at y=${from.y}, not on a block top`);
  }
  const start: Node = { x: Math.floor(from.x), y: Math.round(from.y), z: Math.floor(from.z) };
  const goal: Node = { x: Math.floor(to.x), y: Math.floor(to.y + EPS), z: Math.floor(to.z) };
  if (!inFence(fence, goal.x, goal.y, goal.z))
    return refuse('the target is outside the movement fence');
  const here = bodyProblem(world, fence, from);
  if (here !== null) return refuse(`cannot walk from here: ${here}`);
  const startStand = standProblem(world, start.x, start.y, start.z);
  if (startStand !== null) return refuse(`cannot walk from here: ${startStand}`);
  const goalStand = standOnceOpened(world, goal, breaks);
  if (goalStand !== null) return refuse(`the target block is not walkable: ${goalStand}`);

  const edges = terrainEdges(world, fence, breaks);
  const maxBreaks = breaks?.max ?? 0;

  const heuristic = (n: Node): number =>
    Math.hypot(n.x - goal.x, n.z - goal.z) + 0.5 * Math.abs(n.y - goal.y);
  // A walk begins by centring on its start block.
  const first = Math.hypot(start.x + 0.5 - from.x, start.z + 0.5 - from.z);
  const open: Array<{ f: number; n: Node }> = [{ f: first + heuristic(start), n: start }];
  const best = new Map<string, Label>([[key(start), { cost: first, length: first, breaks: 0 }]]);
  const came = new Map<string, { from: Node; edge: Edge }>();
  const closed = new Set<string>();
  let expanded = 0;
  // Ways cut off by the length limit or the break cap (said in a refusal).
  let tooLong = false;
  let tooManyBreaks = false;
  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f);
    const { n } = open.shift() as { f: number; n: Node };
    const k = key(n);
    if (closed.has(k)) continue;
    closed.add(k);
    if (++expanded > 20_000) return refuse('the search area is too large');
    if (n.x === goal.x && n.y === goal.y && n.z === goal.z) {
      const moves: TerrainMove[] = [];
      for (let cur = k; cur !== key(start);) {
        const c = came.get(cur);
        if (c === undefined) break;
        const [x, y, z] = cur.split(',').map(Number) as [number, number, number];
        const to = centre({ x, y, z });
        const e = c.edge;
        const move: TerrainMove =
          e.move === 'drop'
            ? { kind: 'drop', to, height: e.height }
            : { kind: e.move === 'walk' ? 'walk' : 'step-up', to };
        moves.push(e.breaks.length > 0 ? { ...move, breaks: e.breaks } : move);
        cur = key(c.from);
      }
      moves.reverse();
      // Begin by centring on the start block.
      moves.unshift({ kind: 'walk', to: centre(start) });
      let length = 0;
      let at = from;
      for (const m of moves) {
        length += Math.hypot(m.to.x - at.x, m.to.z - at.z) + Math.abs(m.to.y - at.y);
        at = m.to;
      }
      if (length > maxLength + EPS) {
        return refuse(`the path is ${length.toFixed(1)} blocks long (the limit is ${maxLength})`);
      }
      return { ok: true, moves, length };
    }
    const label = best.get(k) as Label;
    for (const e of edges(n)) {
      // The same limits as reachableFeet, while searching: so both settle the same ways.
      const length = label.length + e.length;
      if (length > maxLength + EPS) {
        tooLong = true;
        continue;
      }
      const broken = label.breaks + e.breaks.length;
      if (broken > maxBreaks) {
        tooManyBreaks = true;
        continue;
      }
      const nk = key(e.to);
      const cost = label.cost + e.cost;
      if (cost < (best.get(nk)?.cost ?? Infinity)) {
        best.set(nk, { cost, length, breaks: broken });
        came.set(nk, { from: n, edge: e });
        open.push({ f: cost + heuristic(e.to), n: e.to });
      }
    }
  }
  const limits = [
    tooLong ? `within ${maxLength} blocks` : null,
    tooManyBreaks ? `breaking at most ${maxBreaks} blocks on the way` : null,
  ].filter((l) => l !== null);
  return refuse(
    `there is no walkable path to the target inside the fence${limits.length > 0 ? ` ${limits.join(', ')}` : ''}`,
  );
}

type Edge = {
  to: Node;
  move: TerrainMove['kind'];
  /** What the search minimises: the move's own cost, plus each break's (WalkBreaks). */
  cost: number;
  /** Blocks walked: across, plus the height climbed or dropped. */
  length: number;
  height: number;
  /** Blocks to break before the move, top first. */
  breaks: readonly Cell[];
};

const NO_BREAKS: readonly Cell[] = Object.freeze([]);

/**
 * The walker's moves out of feet block `n`: level moves in 8 directions without cutting
 * corners, one block up with headroom, drops of up to MAX_DROP onto standable blocks (never
 * into water, lava, unloaded chunks or next to a hazard: standProblem). With `breaks`, a
 * straight move may first break the cells its body passes that block it (WalkBreaks, checked
 * from the centre of `n`, where the player stands while it breaks them); a destination must
 * then be standable as the breaks leave it. For one search: what can be stood on, and what
 * each break costs, is cached.
 */
function terrainEdges(world: WalkWorld, fence: Fence, breaks?: WalkBreaks): (n: Node) => Edge[] {
  const standable = new Map<string, boolean>();
  const canStand = (n: Node): boolean => {
    if (!inFence(fence, n.x, n.y, n.z)) return false;
    const k = key(n);
    let v = standable.get(k);
    if (v === undefined) {
      v = standProblem(world, n.x, n.y, n.z) === null;
      standable.set(k, v);
    }
    return v;
  };
  const clear = (c: Cell): boolean => passProblem(world, c.x, c.y, c.z) === null;
  // What breaking a cell costs from a feet block (null: it may not be broken).
  const breakCosts = new Map<string, number | null>();
  const breakCost = (from: Node, c: Cell): number | null => {
    if (breaks === undefined) return null;
    const k = `${key(from)}>${key(c)}`;
    let v = breakCosts.get(k);
    if (v === undefined) {
      const r = breaks.check(world, centre(from), c);
      v = r.ok ? r.cost : null;
      breakCosts.set(k, v);
    }
    return v;
  };
  /** The cells (top first) the body cannot pass, to break from `from`; null if one may not be. */
  const opening = (from: Node, cells: readonly Cell[]): { breaks: Cell[]; cost: number } | null => {
    const out: Cell[] = [];
    let cost = 0;
    for (const c of cells) {
      if (clear(c)) continue;
      const k = breakCost(from, c);
      if (k === null) return null;
      out.push(c);
      cost += k;
    }
    return { breaks: out, cost };
  };
  const openedStandable = new Map<string, boolean>();
  /** Feet block `n` can be stood in once `opened` is broken. */
  const standsAfter = (n: Node, opened: readonly Cell[]): boolean => {
    if (opened.length === 0) return canStand(n);
    if (!inFence(fence, n.x, n.y, n.z)) return false;
    const k = `${key(n)}|${opened.map(key).join(';')}`;
    let v = openedStandable.get(k);
    if (v === undefined) {
      v = standProblem(withAir(world, opened), n.x, n.y, n.z) === null;
      openedStandable.set(k, v);
    }
    return v;
  };
  const cell = (x: number, y: number, z: number): Cell => ({ x, y, z });
  return (n) => {
    const out: Edge[] = [];
    for (const [dx, dz] of DIRECTIONS) {
      const diagonal = dx !== 0 && dz !== 0;
      const nx = n.x + dx;
      const nz = n.z + dz;
      // Level. Diagonally only between two standable corners, and never breaking.
      const level = { x: nx, y: n.y, z: nz };
      if (diagonal) {
        if (
          canStand(level) &&
          canStand({ x: n.x + dx, y: n.y, z: n.z }) &&
          canStand({ x: n.x, y: n.y, z: n.z + dz })
        ) {
          const d = Math.SQRT2;
          out.push({ to: level, move: 'walk', cost: d, length: d, height: 0, breaks: NO_BREAKS });
        }
        continue; // steps and drops only straight ahead
      }
      const walk = opening(n, bodyCells(level));
      if (walk !== null && standsAfter(level, walk.breaks)) {
        out.push({
          to: level,
          move: 'walk',
          cost: 1 + walk.cost,
          length: 1,
          height: 0,
          breaks: walk.breaks,
        });
      }
      // Step up: headroom above the current block, then stand on the higher neighbour.
      const up = { x: nx, y: n.y + 1, z: nz };
      const climb = opening(n, [cell(n.x, n.y + 2, n.z), ...bodyCells(up)]);
      if (climb !== null && standsAfter(up, climb.breaks)) {
        out.push({
          to: up,
          move: 'step-up',
          cost: 1.5 + climb.cost,
          length: 2,
          height: 1,
          breaks: climb.breaks,
        });
      }
      // Drops: the neighbour column clear from the head height down to the landing.
      for (let d = 1; d <= MAX_DROP; d++) {
        const down = { x: nx, y: n.y - d, z: nz };
        const column: Cell[] = [];
        for (let y = n.y + 1; y >= n.y - d + 1; y--) column.push(cell(nx, y, nz));
        const fall = opening(n, column);
        if (fall === null) break;
        const landing = opening(n, [cell(nx, n.y - d, nz)]);
        if (landing === null) continue;
        const opened = [...fall.breaks, ...landing.breaks];
        if (standsAfter(down, opened)) {
          out.push({
            to: down,
            move: 'drop',
            cost: 1 + 0.5 * d + fall.cost + landing.cost,
            length: 1 + d,
            height: d,
            breaks: opened,
          });
          break;
        }
      }
    }
    return out;
  };
}

/** A feet block a walk reaches, and the blocks walked to get there. */
export interface ReachedFeet {
  x: number;
  y: number;
  z: number;
  /** Across plus up or down, as planTerrainWalk measures a path (from `from` itself). */
  length: number;
  /** What the walk costs, as planTerrainWalk weighs it: its moves, plus each break's cost. */
  cost: number;
  /** Blocks the walk breaks on its way (WalkBreaks). */
  breaks: number;
}

/**
 * Every feet block inside `fence` that a walk from `from` reaches within `maxLength` blocks,
 * by "x,y,z": Dijkstra over the walker's own moves (terrainEdges), with planTerrainWalk's
 * costs and limits, so the walk it finds to each is the one a walk there plans (with
 * `breaks`, perhaps breaking leaves on the way). Empty when the player cannot walk from where
 * it stands (not on a block top, or not on standable ground). What a stand spot must be
 * among for a walk to it to be possible (seen live: logs 7 blocks away, walled in by leaves,
 * cactus and foliage, were offered again and again).
 */
export function reachableFeet(
  world: WalkWorld,
  fence: Fence,
  from: Vec3,
  maxLength: number,
  breaks?: WalkBreaks,
): Map<string, ReachedFeet> {
  const reached = new Map<string, ReachedFeet>();
  if (Math.abs(from.y - Math.round(from.y)) > EPS) return reached;
  const start: Node = { x: Math.floor(from.x), y: Math.round(from.y), z: Math.floor(from.z) };
  if (!inFence(fence, start.x, start.y, start.z)) return reached;
  if (standProblem(world, start.x, start.y, start.z) !== null) return reached;
  const edges = terrainEdges(world, fence, breaks);
  const maxBreaks = breaks?.max ?? 0;
  const best = new Map<string, Label>();
  const heap = new NodeHeap();
  // A walk begins by centring on its start block.
  const first = Math.hypot(start.x + 0.5 - from.x, start.z + 0.5 - from.z);
  best.set(key(start), { cost: first, length: first, breaks: 0 });
  heap.push(first, start);
  while (heap.size > 0) {
    const { key: cost, node: n } = heap.pop();
    const k = key(n);
    const label = best.get(k) as Label;
    if (reached.has(k) || cost > label.cost) continue;
    reached.set(k, { ...n, ...label });
    for (const e of edges(n)) {
      const length = label.length + e.length;
      if (length > maxLength + EPS) continue;
      const broken = label.breaks + e.breaks.length;
      if (broken > maxBreaks) continue;
      const c = label.cost + e.cost;
      const ek = key(e.to);
      if (c < (best.get(ek)?.cost ?? Infinity)) {
        best.set(ek, { cost: c, length, breaks: broken });
        heap.push(c, e.to);
      }
    }
  }
  return reached;
}

/** Minimal binary min-heap of nodes by key. */
class NodeHeap {
  readonly #items: Array<{ key: number; node: Node }> = [];

  get size(): number {
    return this.#items.length;
  }

  push(key: number, node: Node): void {
    const a = this.#items;
    a.push({ key, node });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((a[parent] as { key: number }).key <= key) break;
      a[i] = a[parent] as { key: number; node: Node };
      i = parent;
    }
    a[i] = { key, node };
  }

  pop(): { key: number; node: Node } {
    const a = this.#items;
    const top = a[0] as { key: number; node: Node };
    const last = a.pop() as { key: number; node: Node };
    if (a.length > 0) {
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= a.length) break;
        const right = left + 1;
        const child =
          right < a.length && (a[right] as { key: number }).key < (a[left] as { key: number }).key
            ? right
            : left;
        if ((a[child] as { key: number }).key >= last.key) break;
        a[i] = a[child] as { key: number; node: Node };
        i = child;
      }
      a[i] = last;
    }
    return top;
  }
}

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

export interface TerrainStep {
  pos: Vec3;
  onGround: boolean;
}

/** Vanilla gravity per tick (motionY -= 0.08, then *= 0.98): the distance fallen after each tick. */
export function fallDistances(height: number): number[] {
  const out: number[] = [];
  let v = 0;
  let fallen = 0;
  while (fallen < height - EPS) {
    v = (v - 0.08) * 0.98;
    fallen = Math.min(height, fallen - v);
    out.push(fallen);
  }
  return out;
}

function horizontal(a: Vec3, b: Vec3, y: number, onGround: boolean): TerrainStep[] {
  const out: TerrainStep[] = [];
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / WALK_BLOCKS_PER_TICK - EPS));
  for (let k = 1; k <= n; k++) {
    out.push({
      pos:
        k === n
          ? { x: b.x, y, z: b.z }
          : { x: a.x + ((b.x - a.x) * k) / n, y, z: a.z + ((b.z - a.z) * k) / n },
      onGround,
    });
  }
  return out;
}

/** Per-tick positions (and on-ground flags) for a planned terrain walk. */
/** The longest fall that does no damage (vanilla: damage = fall distance - 3). */
export const MAX_SAFE_FALL = 3;
/** The server's floating check: the player's box (0.3 each way) grown by 0.0625... */
export const FLOAT_CHECK_HALF_WIDTH = 0.3625;
/** ...reaching 0.55 (+ 0.0625) below the feet... */
const FLOAT_CHECK_BELOW = 0.6125;
/** ...and up to its head (1.8 + 0.0625). */
const FLOAT_CHECK_ABOVE = 1.8625;

export type Support =
  | { kind: 'supported' }
  | { kind: 'unknown' }
  /** Nothing holds the player up; landY is where its feet would land (null: no floor near). */
  | { kind: 'floating'; landY: number | null };

/** The block columns or levels a span from `lo` to `hi` touches. */
function cellsAcross(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let c = Math.floor(lo); c <= Math.floor(hi); c++) out.push(c);
  return out;
}

/**
 * Whether the server sees the player held up, by its own floating check (1.7.10
 * NetHandlerPlayServer.processPlayer: any block that is not air in the player's box, grown by
 * 0.0625 and reaching 0.55 lower; a player floating for 80 position packets, 4 s, is kicked:
 * "Flying is not enabled on this server"). If not, where its feet would land: on the highest
 * block below that stops a fall (one the body cannot pass), looked for MAX_SAFE_FALL + 1
 * levels down. 'unknown' when a block it needs is not loaded. A plant the body may not enter
 * (poison ivy, say) counts as a floor: the player stops on top of it, never in it, and the
 * server's check holds it up there (the plant is not air).
 */
export function checkSupport(world: WalkWorld, feet: Vec3): Support {
  const xs = cellsAcross(feet.x - FLOAT_CHECK_HALF_WIDTH, feet.x + FLOAT_CHECK_HALF_WIDTH);
  const zs = cellsAcross(feet.z - FLOAT_CHECK_HALF_WIDTH, feet.z + FLOAT_CHECK_HALF_WIDTH);
  const bottom = Math.floor(feet.y - FLOAT_CHECK_BELOW);
  for (let y = bottom; y <= Math.floor(feet.y + FLOAT_CHECK_ABOVE); y++) {
    for (const x of xs) {
      for (const z of zs) {
        const id = world.blockAt(x, y, z);
        if (id === undefined) return { kind: 'unknown' };
        if (id !== 0) return { kind: 'supported' };
      }
    }
  }
  for (let y = bottom - 1; y >= Math.max(0, bottom - 1 - MAX_SAFE_FALL); y--) {
    for (const x of xs) {
      for (const z of zs) {
        const problem = passProblem(world, x, y, z);
        if (problem === 'chunk not loaded') return { kind: 'unknown' };
        if (problem !== null) return { kind: 'floating', landY: y + 1 };
      }
    }
  }
  return { kind: 'floating', landY: null };
}

/** A hazard (lava, fire, harmful fluid, cactus...) next to where the feet would land, or null. */
export function landingHazard(world: WalkWorld, x: number, y: number, z: number): string | null {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        const id = world.blockAt(x + dx, y + dy, z + dz);
        if (id === undefined) return 'next to an unloaded chunk';
        if (world.hazardCode(id) !== BLOCK_CODE.safe) return `next to ${name(world, id)}`;
      }
    }
  }
  return null;
}

export function terrainSteps(from: Vec3, moves: readonly TerrainMove[]): TerrainStep[] {
  const out: TerrainStep[] = [];
  let at = from;
  for (const m of moves) {
    if (m.kind === 'walk') {
      out.push(...horizontal(at, m.to, m.to.y, true));
    } else if (m.kind === 'step-up') {
      const top = m.to.y + STEP_CLEARANCE;
      // Rise in place over a few ticks, cross above the step, settle.
      for (const f of [0.42, 0.75, 1])
        out.push({ pos: { x: at.x, y: at.y + (top - at.y) * f, z: at.z }, onGround: false });
      out.push(...horizontal(at, m.to, top, false));
      out.push({ pos: { ...m.to }, onGround: true });
    } else {
      out.push(...horizontal(at, { ...m.to, y: at.y }, at.y, false));
      const drops = fallDistances(m.height);
      drops.forEach((fallen, i) =>
        out.push({
          pos: { x: m.to.x, y: at.y - fallen, z: m.to.z },
          onGround: i === drops.length - 1,
        }),
      );
    }
    at = m.to;
  }
  return out;
}
