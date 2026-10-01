import { z } from 'zod';
import { ExploreDirectionSchema } from '../../domain/actions.ts';
import { PositionSchema, type Position } from '../../domain/common.ts';
import type { ExplorationSummary } from '../../domain/world-memory.ts';
import type { MemoryRepository } from '../../persistence/memory-repository.ts';

/**
 * Dead ends: points an EXPLORE could not get one block closer to ("no way further": water, a
 * cliff, a wall or leaves all around), and compass directions it could not go, with where the
 * player stood. While it is still near there, world memory's places and biome patches around
 * such a point are left out of what the planner sees (seen live: the model planned EXPLORE
 * toward remembered logs it could not reach again and again, even when told it would be
 * refused, until the repeated-failure rule ended play), and such a direction shows no room
 * left, so the route's "new ground" hint names another (seen live: "EXPLORE north_west" three
 * times from one spot, then refused, and play stopped). From elsewhere the point may well be
 * reachable, so a dead end only holds near where it was found.
 */

/** Agent memory key of the dead ends. */
export const DEAD_ENDS_KEY = 'dead_ends';
/** Dead ends kept, the newest. */
const KEEP = 24;
/** A dead end holds while the player is within this many blocks (horizontally) of where it was. */
const NEAR_FROM = 24;
/** Places and biome patches within this many blocks of a dead-end point are left out. */
const NEAR_POINT = 12;

const DeadEndSchema = z.strictObject({
  /** The point the EXPLORE headed for, or the compass direction it took. */
  toward: z.union([z.strictObject({ x: z.number(), z: z.number() }), ExploreDirectionSchema]),
  from: PositionSchema,
});
export type DeadEnd = z.infer<typeof DeadEndSchema>;

export function readDeadEnds(memory: MemoryRepository): DeadEnd[] {
  const raw = memory.getValue(DEAD_ENDS_KEY);
  if (raw === null) return [];
  try {
    const parsed = z.array(DeadEndSchema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/**
 * Records the point or direction of an EXPLORE that could not start for want of a way ("no way
 * further"), from where it stood (`from`); or of one that got going but stopped short for want
 * of a way ("stopped: no way further"), from where it stopped (`after`).
 */
export function rememberDeadEnd(
  memory: MemoryRepository,
  action: { type: string; args: unknown },
  result: { ok: boolean; message: string } | null,
  from: Position | null,
  after: Position | null = null,
): void {
  if (action.type !== 'EXPLORE' || result === null) return;
  let where: Position | null = null;
  if (!result.ok && /no way further/.test(result.message)) where = from;
  if (result.ok && /stopped: no way further/.test(result.message)) where = after;
  if (where === null) return;
  const toward = DeadEndSchema.shape.toward.safeParse((action.args as { toward: unknown }).toward);
  if (!toward.success) return;
  const kept = readDeadEnds(memory);
  kept.push({ toward: toward.data, from: { ...where } });
  memory.setValue(DEAD_ENDS_KEY, JSON.stringify(kept.slice(-KEEP)));
}

/**
 * The summary without the places and biome patches near a dead-end point that holds at `at`,
 * and with no room left toward a dead-end direction that holds there.
 */
export function withoutDeadEnds(
  summary: ExplorationSummary,
  deadEnds: readonly DeadEnd[],
  at: Position,
): ExplorationSummary {
  const holding = deadEnds.filter((d) => Math.hypot(d.from.x - at.x, d.from.z - at.z) <= NEAR_FROM);
  if (holding.length === 0) return summary;
  const points = holding.flatMap((d) => (typeof d.toward === 'string' ? [] : [d.toward]));
  const ways = new Set<string>(
    holding.flatMap((d) => (typeof d.toward === 'string' ? [d.toward] : [])),
  );
  const blocked = (x: number, z: number): boolean =>
    points.some((p) => Math.hypot(p.x - x, p.z - z) <= NEAR_POINT);
  const directions = Object.fromEntries(
    Object.entries(summary.directions).map(([way, d]) => [
      way,
      ways.has(way) ? { ...d, room: 0 } : d,
    ]),
  ) as ExplorationSummary['directions'];
  return {
    ...summary,
    directions,
    places: summary.places.filter((p) => !blocked(p.x, p.z)),
    biomes: summary.biomes.filter((b) => !blocked(b.x, b.z)),
  };
}
