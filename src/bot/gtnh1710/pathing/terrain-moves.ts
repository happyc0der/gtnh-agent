import type { Cell, TerrainMove } from '../terrain.ts';
import type { Movement } from './movements.ts';

/**
 * A path in terrain.ts's move kinds (walk, step-up, drop), so the existing executor
 * (client/movement-actions.ts walkTo: terrainSteps, its per-step checks, breaking on the way)
 * can walk paths from this pathfinder before it switches to execution plans. Traverses and
 * diagonals are walks, ascends are steps up, descends and falls onto dry ground are drops,
 * each with its breaks, upper blocks first (the same order terrain.ts plans them in). Parkour,
 * pillars, bridges, digging down and anything in water have no terrain move: the conversion
 * says which movement stops it. Pure.
 */

export type TerrainConversion =
  | { readonly ok: true; readonly moves: TerrainMove[] }
  | { readonly ok: false; readonly index: number; readonly reason: string };

const centre = (c: Cell): { x: number; y: number; z: number } => ({
  x: c.x + 0.5,
  y: c.y,
  z: c.z + 0.5,
});

/**
 * The terrain moves of `movements` (from planPath) out of feet block `start`: first a walk to
 * its centre (a walk begins by centring on its start block), as planTerrainWalk's do.
 */
export function toTerrainMoves(start: Cell, movements: readonly Movement[]): TerrainConversion {
  const moves: TerrainMove[] = [{ kind: 'walk', to: centre(start) }];
  for (let i = 0; i < movements.length; i++) {
    const m = movements[i] as Movement;
    const breaks = m.breaks.map((b) => b.cell);
    const extra = breaks.length > 0 ? { breaks } : {};
    if (m.water) {
      return { ok: false, index: i, reason: `movement ${i + 1} (${m.kind}) is in water` };
    }
    switch (m.kind) {
      case 'traverse':
      case 'diagonal':
        moves.push({ kind: 'walk', to: centre(m.to), ...extra });
        break;
      case 'ascend':
        moves.push({ kind: 'step-up', to: centre(m.to), ...extra });
        break;
      case 'descend':
      case 'fall':
        moves.push({ kind: 'drop', to: centre(m.to), height: m.drop, ...extra });
        break;
      case 'parkour':
      case 'pillar':
      case 'bridge':
      case 'downward':
        return {
          ok: false,
          index: i,
          reason: `movement ${i + 1} (${m.kind}) has no terrain move: it needs an execution plan`,
        };
    }
  }
  return { ok: true, moves };
}
