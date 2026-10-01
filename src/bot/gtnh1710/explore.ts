import type { ExploreToward } from '../../domain/actions.ts';
import { COMPASS } from '../../domain/world-memory.ts';
import type { PointBox } from './play-area.ts';
import { MAX_DROP, passProblem, standProblem } from './terrain.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';

/**
 * EXPLORE's planning, pure: where to head, and the next hop. The client walks each hop as an
 * ordinary checked walk (planTerrainWalk inside the play area, every step re-checked), so
 * this module only chooses targets; it never decides what is safe to step on.
 */

/** Closer than this (blocks, horizontally) to the goal counts as arrived. */
export const ARRIVED = 2;
/** A hop must get at least this much closer to the goal. */
export const MIN_HOP_PROGRESS = 1.5;
/** Hops whose search length leaves this margin under the limit (the walker's A* may differ a bit). */
const LENGTH_MARGIN = 3;
/** Candidate hop targets offered, best first, spread at least this far apart. */
const CANDIDATES = 4;
const CANDIDATE_SPACING = 3;

export interface ExploreGoal {
  x: number;
  z: number;
  /** True when the goal was pulled in to stay inside the exploration boundary. */
  clipped: boolean;
}

/**
 * Where an EXPLORE heads. A direction: `maxDistance` blocks that way, pulled in so it stays at
 * least 1.5 blocks inside the boundary. A point: the point itself (the safety policy has
 * checked that it lies inside the boundary), pulled in the same way.
 */
export function exploreGoal(
  from: Vec3,
  toward: ExploreToward,
  maxDistance: number,
  boundary: PointBox,
): ExploreGoal {
  const inset = 1.5;
  const lo = { x: boundary.min.x + inset, z: boundary.min.z + inset };
  const hi = { x: boundary.max.x - inset, z: boundary.max.z - inset };
  if (typeof toward !== 'string') {
    const x = Math.min(hi.x, Math.max(lo.x, toward.x));
    const z = Math.min(hi.z, Math.max(lo.z, toward.z));
    return { x, z, clipped: x !== toward.x || z !== toward.z };
  }
  const d = COMPASS[toward];
  let t = maxDistance;
  if (d.x > 0) t = Math.min(t, (hi.x - from.x) / d.x);
  if (d.x < 0) t = Math.min(t, (lo.x - from.x) / d.x);
  if (d.z > 0) t = Math.min(t, (hi.z - from.z) / d.z);
  if (d.z < 0) t = Math.min(t, (lo.z - from.z) / d.z);
  t = Math.max(0, t);
  return { x: from.x + d.x * t, z: from.z + d.z * t, clipped: t < maxDistance };
}

export interface HopTarget {
  /** Feet position at a block centre. */
  target: Vec3;
  /** Blocks walked to get there (horizontal plus vertical, like the walker counts). */
  length: number;
  /** What is then left to the goal (blocks, horizontally). */
  distanceToGoal: number;
}

export type HopChoice = { ok: true; candidates: HopTarget[] } | { ok: false; reason: string };

interface Node {
  x: number;
  y: number;
  z: number;
}

const STRAIGHT: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * The next hop toward `goal`: spots inside `fence` that a walk from `from` reaches within
 * `maxLength` blocks, closest to the goal first (ties: shorter walks). The search follows the
 * walker's own rules (terrain.ts: level moves in 8 directions without cutting corners, one
 * block up with headroom, drops of up to MAX_DROP onto standable blocks; never into water,
 * lava, unloaded chunks or next to a hazard). `exclude` holds "x,y,z" spots already tried.
 */
export function chooseHop(
  world: WalkWorld,
  fence: Fence,
  from: Vec3,
  goal: { x: number; z: number },
  maxLength: number,
  exclude: ReadonlySet<string> = new Set(),
): HopChoice {
  const start: Node = { x: Math.floor(from.x), y: Math.round(from.y), z: Math.floor(from.z) };
  const inside = (n: Node): boolean =>
    n.x >= fence.min.x &&
    n.x <= fence.max.x &&
    n.z >= fence.min.z &&
    n.z <= fence.max.z &&
    n.y >= fence.min.y &&
    n.y <= fence.max.y;
  if (!inside(start)) return { ok: false, reason: 'the player is outside the play area' };
  const startProblem = standProblem(world, start.x, start.y, start.z);
  if (startProblem !== null) return { ok: false, reason: `cannot walk from here: ${startProblem}` };

  const width = fence.max.x - fence.min.x + 1;
  const depth = fence.max.z - fence.min.z + 1;
  const levels = fence.max.y - fence.min.y + 1;
  const index = (n: Node): number =>
    ((n.y - fence.min.y) * depth + (n.z - fence.min.z)) * width + (n.x - fence.min.x);
  const standCache = new Int8Array(width * depth * levels); // 0 unknown, 1 yes, 2 no
  const canStand = (n: Node): boolean => {
    if (!inside(n)) return false;
    const i = index(n);
    if (standCache[i] === 0) standCache[i] = standProblem(world, n.x, n.y, n.z) === null ? 1 : 2;
    return standCache[i] === 1;
  };
  const clear = (x: number, y: number, z: number): boolean => passProblem(world, x, y, z) === null;

  const budget =
    maxLength - LENGTH_MARGIN - Math.hypot(from.x - start.x - 0.5, from.z - start.z - 0.5);
  const dist = new Float64Array(width * depth * levels).fill(Infinity);
  const heap = new NodeHeap();
  dist[index(start)] = 0;
  heap.push(0, start);
  const reached: Array<{ n: Node; length: number }> = [];
  while (heap.size > 0) {
    const { key: length, node: n } = heap.pop();
    if (length > (dist[index(n)] as number)) continue;
    reached.push({ n, length });
    const relax = (to: Node, step: number): void => {
      const l = length + step;
      if (l > budget) return;
      const i = index(to);
      if (l < (dist[i] as number)) {
        dist[i] = l;
        heap.push(l, to);
      }
    };
    for (const [dx, dz] of STRAIGHT) {
      const nx = n.x + dx;
      const nz = n.z + dz;
      const level = { x: nx, y: n.y, z: nz };
      if (canStand(level)) relax(level, 1);
      const up = { x: nx, y: n.y + 1, z: nz };
      if (clear(n.x, n.y + 2, n.z) && canStand(up)) relax(up, 2);
      for (let d = 1; d <= MAX_DROP; d++) {
        let open = clear(nx, n.y + 1, nz);
        for (let y = n.y; y >= n.y - d + 1 && open; y--) open = clear(nx, y, nz);
        if (!open) break;
        const down = { x: nx, y: n.y - d, z: nz };
        if (canStand(down)) {
          relax(down, 1 + d);
          break;
        }
      }
    }
    for (const [dx, dz] of DIAGONAL) {
      const to = { x: n.x + dx, y: n.y, z: n.z + dz };
      if (
        canStand(to) &&
        canStand({ x: n.x + dx, y: n.y, z: n.z }) &&
        canStand({ x: n.x, y: n.y, z: n.z + dz })
      ) {
        relax(to, Math.SQRT2);
      }
    }
  }

  const toGoal = (n: Node): number => Math.hypot(n.x + 0.5 - goal.x, n.z + 0.5 - goal.z);
  const here = Math.hypot(from.x - goal.x, from.z - goal.z);
  const ranked = reached
    .filter(({ n }) => !exclude.has(`${n.x},${n.y},${n.z}`))
    .map(({ n, length }) => ({ n, length, d: toGoal(n) }))
    .filter((c) => c.d <= here - MIN_HOP_PROGRESS)
    .sort((a, b) => a.d - b.d || a.length - b.length);
  const candidates: HopTarget[] = [];
  for (const c of ranked) {
    if (candidates.length >= CANDIDATES) break;
    const t = { x: c.n.x + 0.5, y: c.n.y, z: c.n.z + 0.5 };
    if (
      candidates.some((o) => Math.hypot(o.target.x - t.x, o.target.z - t.z) < CANDIDATE_SPACING)
    ) {
      continue;
    }
    candidates.push({ target: t, length: c.length, distanceToGoal: c.d });
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        'no walkable spot in the play area gets closer to the target (water, a cliff, a wall or ' +
        'unloaded chunks are in the way)',
    };
  }
  return { ok: true, candidates };
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
