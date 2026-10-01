import { z } from 'zod';
import { PositionSchema, type Position } from '../domain/common.ts';
import type { ExplorationSummary } from '../domain/world-memory.ts';
import type { MemoryRepository } from '../persistence/memory-repository.ts';

/**
 * Dead ends: points an EXPLORE could not get one block closer to ("no way further": water, a
 * cliff, a wall or leaves all around), with where the player stood. While it is still near
 * there, world memory's places and biome patches around such a point are left out of what the
 * planner sees (seen live: the model planned EXPLORE toward remembered logs it could not reach
 * again and again, even when told it would be refused, until the repeated-failure rule ended
 * play). From elsewhere the point may well be reachable, so a dead end only holds near where it
 * was found.
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
  toward: z.strictObject({ x: z.number(), z: z.number() }),
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

/** Records the point of an EXPLORE that could not start for want of a way ("no way further"). */
export function rememberDeadEnd(
  memory: MemoryRepository,
  action: { type: string; args: unknown },
  result: { ok: boolean; message: string } | null,
  from: Position | null,
): void {
  if (action.type !== 'EXPLORE' || result === null || result.ok || from === null) return;
  const toward = (action.args as { toward: unknown }).toward;
  if (typeof toward !== 'object' || toward === null) return;
  if (!/no way further/.test(result.message)) return;
  const point = toward as { x: number; z: number };
  const kept = readDeadEnds(memory);
  kept.push({ toward: { x: point.x, z: point.z }, from: { ...from } });
  memory.setValue(DEAD_ENDS_KEY, JSON.stringify(kept.slice(-KEEP)));
}

/** The summary without the places and biome patches near a dead end that holds at `at`. */
export function withoutDeadEnds(
  summary: ExplorationSummary,
  deadEnds: readonly DeadEnd[],
  at: Position,
): ExplorationSummary {
  const holding = deadEnds.filter((d) => Math.hypot(d.from.x - at.x, d.from.z - at.z) <= NEAR_FROM);
  if (holding.length === 0) return summary;
  const blocked = (x: number, z: number): boolean =>
    holding.some((d) => Math.hypot(d.toward.x - x, d.toward.z - z) <= NEAR_POINT);
  return {
    ...summary,
    places: summary.places.filter((p) => !blocked(p.x, p.z)),
    biomes: summary.biomes.filter((b) => !blocked(b.x, b.z)),
  };
}
