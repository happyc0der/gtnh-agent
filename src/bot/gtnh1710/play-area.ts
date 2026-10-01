import type { MovementConfig } from '../../config/env.ts';
import type { Position } from '../../domain/common.ts';
import type { Fence, Vec3 } from './walking.ts';

/**
 * Where walks and digs may happen right now (pure). Movement mode 'fixed' uses the configured
 * fence, exactly as configured. Mode 'follow' uses a play area that moves with the player: a
 * terrain fence of `area.side` x `area.side` columns and `area.height` levels, centred on the
 * player's feet block, clipped so that every block of it lies inside the exploration boundary
 * (the safety boundary). A walk or dig takes its fence once, when it starts, and keeps it to
 * the end, so every step of it is checked against the same fence.
 */

/** A box of points, like the safety boundary. */
export interface PointBox {
  readonly min: Position;
  readonly max: Position;
}

export type PlayArea = { fence: Fence; problem: null } | { fence: null; problem: string };

const EPS = 1e-6;
/** Feet levels a fence may hold (the config's block positions allow y 1..254). */
const MIN_FEET_Y = 1;
const MAX_FEET_Y = 254;

export const NO_FENCE = 'no movement fence is configured (MC_MOVEMENT_FENCE_MIN/MAX)';

/** A copy of a configured fence (the walker's type). */
export function fenceOf(f: { min: Position; max: Position }): Fence {
  return { min: { ...f.min }, max: { ...f.max } };
}

export function playArea(
  movement: Pick<MovementConfig, 'mode' | 'fence' | 'area'>,
  boundary: PointBox | null,
  feet: Vec3 | null,
): PlayArea {
  const none = (problem: string): PlayArea => ({ fence: null, problem });
  if (movement.mode === 'fixed') {
    return movement.fence === null
      ? none(NO_FENCE)
      : { fence: fenceOf(movement.fence), problem: null };
  }
  if (boundary === null) {
    return none("movement mode 'follow' needs the exploration boundary (safety.boundary)");
  }
  if (feet === null) return none('the player position is unknown, so the play area is too');
  const { side, height } = movement.area;
  const fx = Math.floor(feet.x);
  const fz = Math.floor(feet.z);
  const fy = Math.floor(feet.y + EPS);
  const lowX = fx - Math.floor((side - 1) / 2);
  const lowZ = fz - Math.floor((side - 1) / 2);
  const lowY = fy - Math.floor(height / 2);
  /** The first whole block at or above `v` (never -0). */
  const from = (v: number): number => Math.ceil(v - EPS) || 0;
  // Whole blocks inside the boundary: block x spans [x, x + 1].
  const fence: Fence = {
    min: {
      x: Math.max(lowX, from(boundary.min.x)),
      y: Math.max(lowY, from(boundary.min.y), MIN_FEET_Y),
      z: Math.max(lowZ, from(boundary.min.z)),
    },
    max: {
      x: Math.min(lowX + side - 1, Math.floor(boundary.max.x + EPS) - 1),
      y: Math.min(lowY + height, Math.floor(boundary.max.y + EPS), MAX_FEET_Y),
      z: Math.min(lowZ + side - 1, Math.floor(boundary.max.z + EPS) - 1),
    },
  };
  const inside =
    fx >= fence.min.x &&
    fx <= fence.max.x &&
    fz >= fence.min.z &&
    fz <= fence.max.z &&
    fy >= fence.min.y &&
    fy <= fence.max.y;
  if (!inside) {
    return none(
      `the player (${feet.x.toFixed(1)}, ${feet.y.toFixed(1)}, ${feet.z.toFixed(1)}) is outside the exploration boundary (safety.boundary)`,
    );
  }
  return { fence, problem: null };
}
