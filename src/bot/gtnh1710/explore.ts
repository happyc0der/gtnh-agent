import type { ExploreToward } from '../../domain/actions.ts';
import { COMPASS } from '../../domain/world-memory.ts';
import type { PointBox } from './play-area.ts';
import type { Vec3 } from './walking.ts';

/**
 * Where an EXPLORE heads, pure. The client walks there in segments on the pathfinder
 * (client/travel-actions.ts: each planned toward this point inside the play area, every step
 * checked), so this module only chooses the point; it never decides what is safe to step on.
 */

/** Closer than this (blocks, horizontally) to the goal counts as arrived. */
export const ARRIVED = 2;

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
