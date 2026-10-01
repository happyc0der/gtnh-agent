import { z } from 'zod';
import { CALM_SPIDER_MIN_DISTANCE } from '../../domain/combat.ts';
import { DimensionSchema, PositionSchema } from '../../domain/common.ts';
import type { GameState } from '../../domain/game-state.ts';
import { distance } from '../../domain/geometry.ts';
import { LEAVE_SHELTER_TASK_ID, NIGHT_SHELTER_TASK_ID } from '../../domain/night-shelter.ts';
import type { NamedLocation } from '../../domain/safety.ts';
import type { MemoryRepository } from '../../persistence/memory-repository.ts';
import { assessDangers, type SafetyContext } from '../../safety/safety-policy.ts';

/**
 * The trail: where the player stood lately, out of danger, newest last. A person who meets a
 * mob steps back the way they came, a little way, not all the way home (seen live: one spider
 * sent the agent 108 blocks back to its spawn). The trail is that way back: every point on it
 * is ground the player stood on, so a walk can end there.
 */

/** Agent memory key of the trail. */
export const TRAIL_KEY = 'trail';
/** The named safe location a retreat along the trail walks to (this cycle only). */
export const TRAIL_LOCATION = 'trail';
/** A new point at least this far (blocks) from the last one. */
const TRAIL_SPACING = 4;
/** Points kept: some 200 blocks of travel. */
const TRAIL_POINTS = 48;
/** A point to retreat to lies this far from the player at least, and at most RETREAT_REACH. */
const RETREAT_MIN = 8;
const RETREAT_REACH = 48;
/** ...and this much beyond the threat radius from every hostile or unidentified creature. */
const RETREAT_CLEARANCE = 4;

const TrailPointSchema = z.strictObject({
  dimension: DimensionSchema,
  position: PositionSchema,
});
type TrailPoint = z.infer<typeof TrailPointSchema>;

export function readTrail(memory: MemoryRepository): TrailPoint[] {
  const raw = memory.getValue(TRAIL_KEY);
  if (raw === null) return [];
  try {
    const parsed = z.array(TrailPointSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Adds where the player stands to the trail, when nothing threatens it (no danger at all) and
 * it is not in a night task (a night pit is no place to come back to), at least TRAIL_SPACING
 * from the last point.
 */
export function recordTrail(memory: MemoryRepository, state: GameState, ctx: SafetyContext): void {
  const { position, dimension } = state.player;
  if (!position.known || !dimension.known) return;
  const task = state.currentTask?.taskId;
  if (task === NIGHT_SHELTER_TASK_ID || task === LEAVE_SHELTER_TASK_ID) return;
  if (assessDangers(state, ctx).length > 0) return;
  const trail = readTrail(memory);
  const last = trail.at(-1);
  if (
    last !== undefined &&
    last.dimension === dimension.value &&
    distance(last.position, position.value) < TRAIL_SPACING
  ) {
    return;
  }
  trail.push({ dimension: dimension.value, position: { ...position.value } });
  memory.setValue(TRAIL_KEY, JSON.stringify(trail.slice(-TRAIL_POINTS)));
}

/**
 * Where to retreat along the trail from the creatures that threaten the player now: the
 * newest point RETREAT_MIN to RETREAT_REACH blocks away, on the far side of the player from
 * the nearest of them (the walk heads away from it), and clear of every one of them by the
 * threat radius and RETREAT_CLEARANCE. A calm spider threatens nobody, but a point within
 * its leap would make it count again (CALM_SPIDER_MIN_DISTANCE), so points stay that far
 * and RETREAT_CLEARANCE from calm spiders too. Null when none is, or nothing threatens.
 */
export function trailRetreat(
  trail: readonly TrailPoint[],
  state: GameState,
  ctx: SafetyContext,
): NamedLocation | null {
  const { position, dimension } = state.player;
  if (!position.known || !dimension.known || !state.nearbyEntities.known) return null;
  const at = position.value;
  const creatures = state.nearbyEntities.value.entities.filter((e) => e.kind !== 'object');
  const threats = creatures.filter(
    (e) => (e.category === 'hostile' && !e.calm) || e.category === 'unclassified',
  );
  const calm = creatures.filter((e) => e.calm);
  const nearest = threats.reduce<(typeof threats)[number] | null>(
    (best, e) => (best === null || e.distance < best.distance ? e : best),
    null,
  );
  if (nearest === null) return null;
  const clear = ctx.config.hostileThreatRadius + RETREAT_CLEARANCE;
  for (let i = trail.length - 1; i >= 0; i--) {
    const p = trail[i] as TrailPoint;
    if (p.dimension !== dimension.value) continue;
    const d = distance(p.position, at);
    if (d < RETREAT_MIN || d > RETREAT_REACH) continue;
    // Away from the nearest one: the point and the creature on opposite sides of the player.
    const away =
      (p.position.x - at.x) * (nearest.position.x - at.x) +
        (p.position.z - at.z) * (nearest.position.z - at.z) <=
      0;
    if (!away) continue;
    if (threats.some((e) => distance(e.position, p.position) < clear)) continue;
    const calmClear = CALM_SPIDER_MIN_DISTANCE + RETREAT_CLEARANCE;
    if (calm.some((e) => distance(e.position, p.position) < calmClear)) continue;
    return {
      dimension: p.dimension,
      position: { ...p.position },
      kind: 'safe',
      note: `the trail: ${d.toFixed(0)} blocks back the way the player came`,
    };
  }
  return null;
}
