import { standingCell, standProblem, TERRAIN_SURFACES, type Cell } from '../terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../walking.ts';
import { CELL, CellCache, changedWorld, type BlockChange, type CellBox } from './cells.ts';
import {
  DEFAULT_PENALTIES,
  heuristicRates,
  pathCosts,
  WADE_ONE_BLOCK,
  WALK_ONE_BLOCK,
  type Penalties,
  type PathCosts,
} from './costs.ts';
import { compileGoal, describeGoal, type Goal } from './goals.ts';
import { NodeHeap } from './heap.ts';
import { overlappedCells } from './physics.ts';
import {
  describe,
  DIRECTIONS,
  directionOf,
  expand,
  MoveContext,
  placesFloor,
  walkCode,
  type Emit,
  type Movement,
  type MoveOptions,
} from './movements.ts';

/**
 * The pathfinder's search: A* over feet blocks inside the search area (the fence: a box that is
 * a hard bound), with the movements of movements.ts and a goal of goals.ts. Pure: it reads the
 * blocks it is given and returns a path; nothing is sent.
 *
 *  - Node keys are the feet block's index in the area box, one integer; the costs, parents,
 *    resources and open/closed state live in typed arrays of the area's size, and the open
 *    list is a binary heap with decrease-key (heap.ts).
 *  - Resources: blocks broken and placed so far travel with each node's best way there; a
 *    movement that would exceed maxBreaks or the throwaway count is not taken (as the walker's
 *    break cap: a cheaper way that spends more can hide a dearer one that spends less).
 *  - Limits: a node limit and a time limit. When the goal cannot be reached inside the area
 *    (it lies beyond the loaded chunks or the area), or a limit stops the search, the result
 *    is Baritone's best-so-far partial path: for each of its coefficients K, the node that
 *    minimises heuristic + cost / K, taking the first K whose node is at least
 *    minPartialDistance from the start; a long trip is then walked in segments, re-planning
 *    from each end as new chunks arrive (the idea only; no code was taken).
 *  - The world changes along a path (blocks broken, placed). The search, like Baritone's,
 *    checks each movement against the world as it was; the found path is then replayed over
 *    the blocks it changes, each movement checked again (and rebuilt: a block an earlier
 *    movement broke need not be broken again), and cut where one no longer holds.
 */

export interface PathOptions {
  /** Nodes expanded at most (default 100,000). */
  readonly maxNodes?: number;
  /** Milliseconds at most (default 1,000). */
  readonly maxTimeMs?: number;
  /** The clock for the time limit (default performance.now). */
  readonly now?: () => number;
  readonly sprint?: boolean;
  readonly parkour?: boolean;
  readonly parkourOverDeepGaps?: boolean;
  readonly pillar?: boolean;
  readonly bridge?: boolean;
  readonly downward?: boolean;
  /** Wading in calm one-deep water and falls into it (off by default: walks never enter water). */
  readonly water?: boolean;
  /** The highest fall onto dry ground, 1..3 (default 3: higher ones hurt). */
  readonly maxFall?: number;
  /** The dig time in ticks (with the tool the player would hold), or null: may not be broken. */
  readonly canBreak?: (cell: Cell) => number | null;
  /** Blocks broken per path at most (default no limit beyond canBreak). */
  readonly maxBreaks?: number;
  /** Whether a block may be placed into the cell (the caller's placing rules). */
  readonly canPlace?: (cell: Cell) => boolean;
  /** The blocks to place: how many, which (a surface the walker stands on), whether they fall. */
  readonly throwaway?: { readonly count: number; readonly block: string; readonly falls?: boolean };
  readonly penalties?: Partial<Penalties>;
  /** A partial path must end at least this far (blocks) from the start (default 5). */
  readonly minPartialDistance?: number;
}

export type PathStatus = 'reached' | 'partial' | 'none';
/** Why the search stopped: at the goal, out of nodes inside the area, at a limit, or refused at once. */
export type PathStop = 'goal' | 'exhausted' | 'node-limit' | 'time-limit' | 'refused';

export interface PathResult {
  readonly status: PathStatus;
  readonly stop: PathStop;
  readonly reason: string;
  readonly movements: readonly Movement[];
  /** The feet block the path starts from (the walk first centres on it), null when refused. */
  readonly start: Cell | null;
  /** The feet block it ends at. */
  readonly end: Cell | null;
  /** Ticks: centring on the start block, then the movements. */
  readonly cost: number;
  readonly nodesExpanded: number;
  readonly nodesOpened: number;
  readonly elapsedMs: number;
}

export const DEFAULT_MAX_NODES = 100_000;
export const DEFAULT_MAX_TIME_MS = 1000;
/** Search areas larger than this many feet blocks are refused (64 x 64 x 32 is 131,072). */
export const MAX_AREA_CELLS = 1 << 21;
/** Baritone's coefficients for the best-so-far nodes. */
const COEFFICIENTS = [1.5, 2, 2.5, 3, 4, 5, 10] as const;
/** Costs this close are the same (sums of the same moves in another order). */
const TIE = 1e-9;

/** The resolved options of one search. */
export interface ResolvedPathOptions {
  readonly move: MoveOptions;
  readonly penalties: Penalties;
  readonly costs: PathCosts;
  readonly maxBreaks: number;
  readonly maxPlaced: number;
}

/** Defaults filled in and checked; a string says why the options cannot be used. */
export function resolvePathOptions(options: PathOptions): ResolvedPathOptions | string {
  const t = options.throwaway;
  if (t !== undefined && !TERRAIN_SURFACES.has(t.block)) {
    return `the throwaway block ${t.block} is not a block the walker stands on`;
  }
  const penalties: Penalties = { ...DEFAULT_PENALTIES, ...options.penalties };
  const move: MoveOptions = {
    sprint: options.sprint ?? false,
    parkour: options.parkour ?? false,
    parkourOverDeepGaps: options.parkourOverDeepGaps ?? false,
    pillar: options.pillar ?? false,
    bridge: options.bridge ?? false,
    downward: options.downward ?? false,
    water: options.water ?? false,
    maxFall: Math.max(1, Math.min(3, Math.floor(options.maxFall ?? 3))),
    canBreak: options.canBreak ?? null,
    canPlace: options.canPlace ?? null,
    throwaway:
      t === undefined
        ? null
        : { count: Math.max(0, Math.floor(t.count)), block: t.block, falls: t.falls ?? false },
  };
  return {
    move,
    penalties,
    costs: pathCosts({ ...penalties, ...move }),
    maxBreaks: Math.max(0, Math.floor(options.maxBreaks ?? Number.MAX_SAFE_INTEGER)),
    maxPlaced: move.throwaway?.count ?? 0,
  };
}

/** The cells a search over `area` reads: the area, and around it what its checks look at. */
export function cacheBox(area: Fence): CellBox {
  return {
    min: { x: area.min.x - 2, y: area.min.y - 3, z: area.min.z - 2 },
    max: { x: area.max.x + 2, y: area.max.y + 5, z: area.max.z + 2 },
  };
}

/**
 * Plans a path from `from` (feet on a block top) to `goal`, over the blocks of `world`, inside
 * `area`. See the file comment; `options` choose the movements and the limits.
 */
export function planPath(
  world: WalkWorld,
  area: Fence,
  from: Vec3,
  goal: Goal,
  options: PathOptions = {},
): PathResult {
  const now = options.now ?? (() => performance.now());
  const t0 = now();
  const refused = (reason: string, start: Cell | null = null): PathResult => ({
    status: 'none',
    stop: 'refused',
    reason,
    movements: [],
    start,
    end: null,
    cost: 0,
    nodesExpanded: 0,
    nodesOpened: 0,
    elapsedMs: now() - t0,
  });
  const resolved = resolvePathOptions(options);
  if (typeof resolved === 'string') return refused(resolved);
  const { move, costs } = resolved;
  const sx = area.max.x - area.min.x + 1;
  const sy = area.max.y - area.min.y + 1;
  const sz = area.max.z - area.min.z + 1;
  if (sx <= 0 || sy <= 0 || sz <= 0) return refused('the search area is empty');
  const volume = sx * sy * sz;
  if (volume > MAX_AREA_CELLS) {
    return refused(`the search area holds ${volume} feet blocks (at most ${MAX_AREA_CELLS})`);
  }
  if (Math.abs(from.y - Math.round(from.y)) > 1e-6) {
    return refused(`the player's feet are at y=${from.y}, not on a block top`);
  }
  const cells = new CellCache(world, cacheBox(area));
  const ctx = new MoveContext(cells, area, move, costs);
  const start = standingCell(world, from);
  if (!ctx.inFence(start.x, start.y, start.z)) {
    return refused('the start is outside the search area', start);
  }
  if (!cells.footing(start.x, start.y, start.z, move.water)) {
    const why = cells.has(start.x, start.y, start.z, CELL.WATER)
      ? 'its feet are in water (wading is off, or the water is not calm and one deep)'
      : (standProblem(world, start.x, start.y, start.z) ??
        'its feet are in a vine (a game client would climb it)');
    return refused(`cannot walk from here: ${why}`, start);
  }
  // Where the player is, its box must be clear already (a walk begins by centring from there).
  const [bx0, bx1, by0, by1, bz0, bz1] = overlappedCells(from.x, from.y, from.z);
  for (let x = bx0; x <= bx1; x++) {
    for (let y = by0; y <= by1; y++) {
      for (let z = bz0; z <= bz1; z++) {
        const open = cells.has(x, y, z, CELL.PASSABLE) || (move.water && cells.calmWater(x, y, z));
        if (!open || cells.nearHazard(x, y, z)) {
          return refused(
            `cannot walk from here: the body touches the block at (${x}, ${y}, ${z}), which is not open or is next to a hazard`,
            start,
          );
        }
      }
    }
  }
  const rates = heuristicRates(costs, {
    pillar: move.pillar,
    downward: move.downward,
    minDigTicks: 0,
  });
  const target = compileGoal(goal, rates);
  const maxNodes = Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES));
  const maxTimeMs = options.maxTimeMs ?? DEFAULT_MAX_TIME_MS;
  const minDistance = options.minPartialDistance ?? 5;

  const x0 = area.min.x;
  const y0 = area.min.y;
  const z0 = area.min.z;
  const indexOf = (x: number, y: number, z: number): number =>
    ((y - y0) * sz + (z - z0)) * sx + (x - x0);
  const cellAt = (i: number): Cell => {
    const x = i % sx;
    const rest = (i - x) / sx;
    const z = rest % sz;
    return { x: x + x0, y: (rest - z) / sz + y0, z: z + z0 };
  };

  const g = new Float64Array(volume).fill(Infinity);
  const parent = new Int32Array(volume).fill(-1);
  const via = new Int32Array(volume);
  const broken = new Uint16Array(volume);
  const placed = new Uint16Array(volume);
  const closed = new Uint8Array(volume);
  const heap = new NodeHeap(volume);
  const bestNode = new Int32Array(COEFFICIENTS.length).fill(-1);
  const bestValue = new Float64Array(COEFFICIENTS.length).fill(Infinity);

  const startIndex = indexOf(start.x, start.y, start.z);
  // A walk begins by centring on its start block.
  const wet = cells.has(start.x, start.y, start.z, CELL.WATER);
  const startCost =
    Math.hypot(start.x + 0.5 - from.x, start.z + 0.5 - from.z) *
    (wet ? WADE_ONE_BLOCK : WALK_ONE_BLOCK);
  g[startIndex] = startCost;
  const startH = target.heuristic(start.x, start.y, start.z);
  heap.push(startIndex, startCost + startH);
  for (let k = 0; k < COEFFICIENTS.length; k++) {
    bestNode[k] = startIndex;
    bestValue[k] = startH + startCost / (COEFFICIENTS[k] as number);
  }

  let current = 0;
  let currentCost = 0;
  let currentBroken = 0;
  let currentPlaced = 0;
  let opened = 1;
  let capBreaks = false;
  let capBlocks = false;
  const emit: Emit = (nx, ny, nz, cost, code, nBreaks, nPlaces) => {
    const i = indexOf(nx, ny, nz);
    if (closed[i] === 1) return;
    const b = currentBroken + nBreaks;
    if (b > resolved.maxBreaks) {
      capBreaks = true;
      return;
    }
    const p = currentPlaced + nPlaces;
    if (p > resolved.maxPlaced) {
      capBlocks = true;
      return;
    }
    const cost2 = currentCost + cost;
    const known = g[i] as number;
    if (cost2 > known + TIE) return;
    if (cost2 >= known - TIE) {
      // As cheap as the way known: take it only if it goes on straight and that one turned.
      // Equal paths differ in how often they turn, and every turn costs the walk ticks.
      const dir = directionOf(code);
      const straight =
        dir >= 0 && current !== startIndex && dir === directionOf(via[current] as number);
      const old = parent[i] as number;
      const wasStraight =
        old !== startIndex && directionOf(via[i] as number) === directionOf(via[old] as number);
      if (!straight || wasStraight) return;
      parent[i] = current;
      via[i] = code;
      broken[i] = b;
      placed[i] = p;
      return;
    }
    g[i] = cost2;
    parent[i] = current;
    via[i] = code;
    broken[i] = b;
    placed[i] = p;
    const h = target.heuristic(nx, ny, nz);
    heap.push(i, cost2 + h);
    opened++;
    // A partial path never ends in water: it may have no way out.
    if (cells.has(nx, ny, nz, CELL.WATER)) return;
    for (let k = 0; k < COEFFICIENTS.length; k++) {
      const v = h + cost2 / (COEFFICIENTS[k] as number);
      if (v < (bestValue[k] as number)) {
        bestValue[k] = v;
        bestNode[k] = i;
      }
    }
  };

  let expanded = 0;
  let stop: PathStop = 'exhausted';
  let reachedAt = -1;
  while (heap.size > 0) {
    if ((expanded & 127) === 0 && now() - t0 > maxTimeMs) {
      stop = 'time-limit';
      break;
    }
    const i = heap.pop();
    if (closed[i] === 1) continue;
    closed[i] = 1;
    const x = i % sx;
    const rest = (i - x) / sx;
    const z = rest % sz;
    const y = (rest - z) / sz + y0;
    if (target.isGoal(x + x0, y, z + z0)) {
      reachedAt = i;
      stop = 'goal';
      break;
    }
    if (expanded >= maxNodes) {
      stop = 'node-limit';
      break;
    }
    expanded++;
    current = i;
    currentCost = g[i] as number;
    currentBroken = broken[i] as number;
    currentPlaced = placed[i] as number;
    // Reached by a pillar or a bridge: its floor is a block the path places.
    ctx.floorPlaced = (parent[i] as number) >= 0 && placesFloor(via[i] as number);
    expand(ctx, x + x0, y, z + z0, emit);
  }
  ctx.floorPlaced = false;

  const result = (status: PathStatus, end: number, reason: string): PathResult => {
    const codes: number[] = [];
    const sources: number[] = [];
    for (let i = end; (parent[i] as number) >= 0; i = parent[i] as number) {
      codes.push(via[i] as number);
      sources.push(parent[i] as number);
    }
    codes.reverse();
    sources.reverse();
    const straight = straighten(ctx, sources.map(cellAt), codes);
    const replayed = replay(world, area, move, costs, straight.sources, straight.codes, ctx);
    const movements = replayed.movements;
    const last = movements.at(-1);
    const cost = movements.reduce((sum, m) => sum + m.cost, startCost);
    const cut = replayed.cutAt !== null;
    return {
      status: cut ? 'partial' : status,
      stop,
      reason: cut
        ? `${reason}; cut after ${movements.length} movement(s): the next one no longer holds once the path has changed blocks on the way (re-plan from there)`
        : reason,
      movements,
      start,
      end: last?.to ?? start,
      cost,
      nodesExpanded: expanded,
      nodesOpened: opened,
      elapsedMs: now() - t0,
    };
  };

  const goalWords = describeGoal(goal);
  if (reachedAt >= 0) {
    return result('reached', reachedAt, `reached ${goalWords}`);
  }
  const caps = [
    capBreaks ? `breaking at most ${resolved.maxBreaks} blocks` : null,
    capBlocks ? `placing at most ${resolved.maxPlaced} blocks` : null,
  ].filter((c) => c !== null);
  const why =
    stop === 'node-limit'
      ? `the search stopped at its limit of ${maxNodes} nodes`
      : stop === 'time-limit'
        ? `the search stopped at its time limit of ${maxTimeMs} ms`
        : `${goalWords} cannot be reached inside the search area${caps.length > 0 ? ` (${caps.join(', ')})` : ''}`;
  for (let k = 0; k < COEFFICIENTS.length; k++) {
    const b = bestNode[k] as number;
    if (b < 0) continue;
    const c = cellAt(b);
    if (Math.hypot(c.x - start.x, c.y - start.y, c.z - start.z) >= minDistance) {
      return result(
        'partial',
        b,
        `${why}: a partial path toward it (re-plan from its end as new chunks arrive)`,
      );
    }
  }
  return {
    status: 'none',
    stop,
    reason: `${why}, and no spot ${minDistance} or more blocks away gets closer to it`,
    movements: [],
    start,
    end: null,
    cost: 0,
    nodesExpanded: expanded,
    nodesOpened: opened,
    elapsedMs: now() - t0,
  };
}

/** A plain walk across at the same level: a traverse or diagonal on dry ground, breaking nothing. */
function plainWalk(m: Movement | null): m is Movement {
  return (
    m !== null &&
    (m.kind === 'traverse' || m.kind === 'diagonal') &&
    !m.water &&
    m.breaks.length === 0
  );
}

/**
 * Fewer turns, the same cost. An 8-way grid has many shortest paths between two blocks (the
 * same diagonal and straight steps in any order), and A* returns whichever it met first: a
 * zigzag, where every turn costs the walk ticks (a turn slows the body down). So each run of
 * plain walks is laid out again with the same steps in one turn (diagonal steps first, or
 * straight ones first), when every step of it is possible; a run where neither works is
 * split in two and each half tried. The cost does not change; neither does the end.
 */
function straighten(
  ctx: MoveContext,
  sources: readonly Cell[],
  codes: readonly number[],
): { sources: Cell[]; codes: number[] } {
  const outSources: Cell[] = [];
  const outCodes: number[] = [];
  /** The steps from `from` with these codes, if each is a plain walk: their ends. */
  const walk = (from: Cell, steps: readonly number[]): Cell[] | null => {
    const ends: Cell[] = [];
    let at = from;
    for (const code of steps) {
      const m = describe(ctx, at, code);
      if (!plainWalk(m) || m.to.y !== from.y) return null;
      ends.push(m.to);
      at = m.to;
    }
    return ends;
  };
  const lay = (from: Cell, steps: readonly number[]): void => {
    let dx = 0;
    let dz = 0;
    let diagonals = 0;
    for (const code of steps) {
      const [sx, sz] = DIRECTIONS[(code >> 4) & 15] as readonly [number, number];
      dx += sx;
      dz += sz;
      if (sx !== 0 && sz !== 0) diagonals++;
    }
    const ax = Math.abs(dx);
    const az = Math.abs(dz);
    const diagonal = Math.min(ax, az);
    const straight = Math.max(ax, az) - diagonal;
    // Only a shortest run (no detour) can be laid out again.
    if (steps.length >= 3 && diagonals === diagonal && steps.length === diagonal + straight) {
      const d = diagonal > 0 ? walkCode(Math.sign(dx), Math.sign(dz)) : -1;
      const s = ax > az ? walkCode(Math.sign(dx), 0) : walkCode(0, Math.sign(dz));
      const diagonalSteps = Array.from({ length: diagonal }, () => d);
      const straightSteps = Array.from({ length: straight }, () => s);
      for (const order of [
        [...diagonalSteps, ...straightSteps],
        [...straightSteps, ...diagonalSteps],
      ]) {
        const ends = walk(from, order);
        if (ends === null) continue;
        let at = from;
        for (let i = 0; i < order.length; i++) {
          outSources.push(at);
          outCodes.push(order[i] as number);
          at = ends[i] as Cell;
        }
        return;
      }
    }
    if (steps.length >= 4) {
      const half = steps.length >> 1;
      lay(from, steps.slice(0, half));
      const mid = walk(from, steps.slice(0, half));
      if (mid !== null) {
        lay(mid.at(-1) as Cell, steps.slice(half));
        return;
      }
    }
    let at = from;
    for (const code of steps) {
      const m = describe(ctx, at, code) as Movement;
      outSources.push(at);
      outCodes.push(code);
      at = m.to;
    }
  };
  let k = 0;
  while (k < codes.length) {
    const from = sources[k] as Cell;
    let e = k;
    while (e < codes.length) {
      const m = describe(ctx, sources[e] as Cell, codes[e] as number);
      if (!plainWalk(m) || m.from.y !== from.y || m.to.y !== from.y) break;
      e++;
    }
    if (e > k) {
      lay(from, codes.slice(k, e));
      k = e;
    } else {
      outSources.push(from);
      outCodes.push(codes[k] as number);
      k++;
    }
  }
  return { sources: outSources, codes: outCodes };
}

/**
 * The found path, each movement checked again (and rebuilt) over the blocks the movements
 * before it break and place; cut before the first one that no longer holds.
 */
function replay(
  world: WalkWorld,
  area: Fence,
  move: MoveOptions,
  costs: PathCosts,
  sources: readonly Cell[],
  codes: readonly number[],
  ctx: MoveContext,
): { movements: Movement[]; cutAt: number | null } {
  const movements: Movement[] = [];
  const changes: BlockChange[] = [];
  for (let k = 0; k < codes.length; k++) {
    const from = sources[k] as Cell;
    const code = codes[k] as number;
    let here = ctx;
    if (changes.length > 0) {
      // A small box around the movement: cells outside it are read directly.
      const box: CellBox = {
        min: { x: from.x - 5, y: area.min.y - 3, z: from.z - 5 },
        max: { x: from.x + 5, y: area.max.y + 5, z: from.z + 5 },
      };
      here = new MoveContext(new CellCache(changedWorld(world, changes), box), area, move, costs);
    }
    const m = describe(here, from, code);
    if (m === null) return { movements, cutAt: k };
    movements.push(m);
    for (const b of m.breaks) changes.push({ cell: b.cell, block: null });
    if (m.place !== null) changes.push({ cell: m.place.cell, block: m.place.block });
  }
  return { movements, cutAt: null };
}
