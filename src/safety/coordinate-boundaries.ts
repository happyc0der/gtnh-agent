import type { Position } from '../domain/common.ts';
import type { Hazard } from '../domain/game-state.ts';
import { distance, formatPosition, isInsideBox } from '../domain/geometry.ts';
import type { Boundary, SafetyViolation } from '../domain/safety.ts';

/** Violations for a position/dimension pair that falls outside the configured work area. */
export function checkWithinBoundary(
  position: Position,
  dimension: string,
  boundary: Boundary,
  what: string,
): SafetyViolation[] {
  const violations: SafetyViolation[] = [];
  if (!boundary.allowedDimensions.includes(dimension)) {
    violations.push({
      code: 'DIMENSION_NOT_ALLOWED',
      severity: 'pause',
      message: `${what} is in dimension "${dimension}", which is not in the allowed list`,
      details: { dimension, allowed: boundary.allowedDimensions.join(',') },
    });
  }
  if (!isInsideBox(position, boundary)) {
    violations.push({
      code: 'OUT_OF_BOUNDS',
      severity: 'pause',
      message: `${what} ${formatPosition(position)} is outside the configured boundary`,
      details: {
        x: position.x,
        y: position.y,
        z: position.z,
        min: formatPosition(boundary.min),
        max: formatPosition(boundary.max),
      },
    });
  }
  return violations;
}

export interface NearestHazard {
  hazard: Hazard;
  distance: number;
}

export function nearestHazard(
  position: Position,
  hazards: readonly Hazard[],
): NearestHazard | null {
  let best: NearestHazard | null = null;
  for (const hazard of hazards) {
    const d = distance(position, hazard.position);
    if (best === null || d < best.distance) best = { hazard, distance: d };
  }
  return best;
}

/**
 * Blocks that hurt only on contact (cactus, berry bushes, thorns, spikes: 'damaging_block')
 * need this much clearance, centre to centre, instead of the full hazard radius. The walker
 * never stands next to one (walking.ts), and a desert full of cacti is no reason to flee.
 */
export const CONTACT_HAZARD_RADIUS = 1.5;

/** The clearance a hazard needs: `radius`, or less for a block that hurts only on contact. */
export function hazardRadius(hazard: Hazard, radius: number): number {
  return hazard.kind === 'damaging_block' ? Math.min(radius, CONTACT_HAZARD_RADIUS) : radius;
}

/**
 * A violation if `position` is closer to a known hazard than its clearance: `radius` for
 * lava, fire, harmful fluids and void, CONTACT_HAZARD_RADIUS for contact-only blocks.
 */
export function checkHazardClearance(
  position: Position,
  hazards: readonly Hazard[],
  radius: number,
  what: string,
): SafetyViolation[] {
  const nearest = nearestHazard(
    position,
    hazards.filter((h) => distance(position, h.position) < hazardRadius(h, radius)),
  );
  if (nearest === null) return [];
  const needed = hazardRadius(nearest.hazard, radius);
  return [
    {
      code: 'HAZARD_PROXIMITY',
      severity: 'block',
      message: `${what} is ${nearest.distance.toFixed(1)} blocks from known ${nearest.hazard.kind} (minimum ${needed})`,
      details: {
        hazardKind: nearest.hazard.kind,
        hazardPosition: formatPosition(nearest.hazard.position),
        distance: Number(nearest.distance.toFixed(2)),
        radius: needed,
      },
    },
  ];
}
