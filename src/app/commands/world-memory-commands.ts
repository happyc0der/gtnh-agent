import type { AgentConfig } from '../config/env.ts';
import { summarizeExploration } from '../domain/world-memory.ts';
import type { Repositories } from '../persistence/repositories.ts';

export type PlacesResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

const POINT = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(?:-?\d+(?:\.\d+)?\s*,\s*)?(-?\d+(?:\.\d+)?)\s*$/;

/** "x,z" or "x,y,z" as a point on the map; null if neither. */
export function parseMapPoint(text: string): { x: number; z: number } | null {
  const m = POINT.exec(text);
  return m === null ? null : { x: Number(m[1]), z: Number(m[2]) };
}

/**
 * What world memory knows (the CLI's `places`), as the planner sees it: from `at`, or from
 * the last live observation's position. Reads the database only; nothing connects.
 */
export function describeKnownPlaces(
  repos: Repositories,
  config: AgentConfig,
  at: { x: number; z: number } | null,
  now: Date,
): PlacesResult {
  const last = repos.snapshots.latest('gtnh1710');
  const seenFrom = last?.player.position.known === true ? last.player.position.value : null;
  const dimension =
    last?.player.dimension.known === true ? last.player.dimension.value : 'overworld';
  const from = at === null ? seenFrom : { x: at.x, y: seenFrom?.y ?? 64, z: at.z };
  if (from === null) {
    return { ok: false, error: 'no live observation is stored yet: pass --at x,z' };
  }
  const summary = summarizeExploration({
    chunks: repos.worldMemory.chunks(dimension),
    from,
    boundary: config.safety.boundary,
    now,
  });
  return {
    ok: true,
    value: { dimension, from: { x: from.x, z: from.z }, ...summary },
  };
}
