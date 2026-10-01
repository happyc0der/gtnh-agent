import type { ExploreToward } from '../../domain/actions.ts';
import { COMPASS } from '../../domain/world-memory.ts';
import type { PointBox } from './play-area.ts';
import { reachableFeet, standingCell, standProblem } from './terrain.ts';
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
  const start: Node = standingCell(world, from);
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

  const reached = [...reachableFeet(world, fence, from, maxLength - LENGTH_MARGIN).values()].map(
    (n) => ({ n, length: n.length }),
  );

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
