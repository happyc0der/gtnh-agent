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

/** A violation if `position` is within `radius` blocks of a known lava/void hazard. */
export function checkHazardClearance(
  position: Position,
  hazards: readonly Hazard[],
  radius: number,
  what: string,
): SafetyViolation[] {
  const nearest = nearestHazard(position, hazards);
  if (nearest === null || nearest.distance >= radius) return [];
  return [
    {
      code: 'HAZARD_PROXIMITY',
      severity: 'block',
      message: `${what} is ${nearest.distance.toFixed(1)} blocks from known ${nearest.hazard.kind} (minimum ${radius})`,
      details: {
        hazardKind: nearest.hazard.kind,
        hazardPosition: formatPosition(nearest.hazard.position),
        distance: Number(nearest.distance.toFixed(2)),
        radius,
      },
    },
  ];
}
