import type { ExploreToward } from '../domain/actions.ts';
import type { GameState } from '../domain/game-state.ts';
import { formatPosition } from '../domain/geometry.ts';
import type { SafetyConfig, SafetyViolation } from '../domain/safety.ts';

/** EXPLORE rules: where it may lead and when (see safety-policy.ts). */

/**
 * EXPLORE toward a point: the point (x, z) must lie inside the boundary, which is the
 * exploration area. A compass direction always passes: the walk is pulled in to stay inside
 * the boundary, and the client never leaves it.
 */
export function exploreTargetChecks(
  toward: ExploreToward,
  config: SafetyConfig,
): SafetyViolation[] {
  if (typeof toward === 'string') return [];
  const b = config.boundary;
  if (toward.x >= b.min.x && toward.x <= b.max.x && toward.z >= b.min.z && toward.z <= b.max.z) {
    return [];
  }
  return [
    {
      code: 'OUT_OF_BOUNDS',
      severity: 'block',
      message: `EXPLORE target (${toward.x}, ${toward.z}) is outside the configured boundary`,
      details: {
        x: toward.x,
        z: toward.z,
        min: formatPosition(b.min),
        max: formatPosition(b.max),
      },
    },
  ];
}

/**
 * EXPLORE leads the player away from known ground, so only in daylight: refused in the
 * evening and at night (hostile mobs; the agent cannot shelter yet), and when the time of day
 * is unknown. Escapes are not affected: a retreat is RETURN_TO_SAFE_LOCATION, never EXPLORE.
 */
export function exploreTimeChecks(state: GameState): SafetyViolation[] {
  if (!state.time.known) {
    return [
      {
        code: 'STATE_UNKNOWN',
        severity: 'block',
        message: `EXPLORE needs daylight, and the time of day is unknown (${state.time.reason})`,
        details: { field: 'time' },
      },
    ];
  }
  const t = state.time.value;
  if (t.phase !== 'evening' && t.phase !== 'night') return [];
  return [
    {
      code: 'NOT_DAYTIME',
      severity: 'block',
      message: `EXPLORE only in daylight: it is ${t.phase} (${t.minutesUntilDay} min until sunrise)`,
      details: { phase: t.phase, timeOfDay: t.timeOfDay },
    },
  ];
}
