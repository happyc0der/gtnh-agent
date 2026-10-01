import { fallsWhenPlaced, type PlaceableItem } from '../domain/blocks.ts';
import type { BlockPosition } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { blockCentre, bodyColumns, formatPosition, headBlockY } from '../domain/geometry.ts';
import type { SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { checkHazardClearance } from './coordinate-boundaries.ts';

/**
 * PLACE_BLOCK rules that the observation can answer. The live client re-checks all of them
 * (and more: the fence, everything touching the cell, entities, the block it clicks) on the
 * blocks the server sent, just before it places.
 *  - The cell must be one the observation lists as placeable: empty (air, tall grass or a
 *    dead bush), within reach, clear of the player's body and of every entity, against a
 *    plain full block, with no hazard next to it.
 *  - Never a cell the player's body is in: the server does not stop that (it leaves the
 *    placing player out of its entity check).
 *  - Sand and gravel only where they cannot fall: on a plain full block, and never in a
 *    column the player's body stands in (above its head they would fall on it).
 *  - Clear of known hazards, like a dug block.
 */
export function placeChecks(
  target: BlockPosition,
  item: PlaceableItem,
  state: GameState,
  config: SafetyConfig,
): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const where = formatPosition(target);
  const details = { x: target.x, y: target.y, z: target.z, item };
  if (!state.nearbyBlocks.known) {
    v.push({
      code: 'UNKNOWN_TARGET',
      severity: 'pause',
      message: `Nearby blocks are not observed (${state.nearbyBlocks.reason}); nothing can be placed`,
      details,
    });
    return v;
  }
  const cell = state.nearbyBlocks.value.placeable.find(
    (c) => c.position.x === target.x && c.position.y === target.y && c.position.z === target.z,
  );
  if (cell === undefined) {
    v.push({
      code: 'NOT_PLACEABLE',
      severity: 'pause',
      message: `${where} is not an observed placeable cell (only empty cells the observation lists, within reach and against a plain block, may be filled)`,
      details,
    });
    return v;
  }
  const position = state.player.position.known ? state.player.position.value : null;
  const falls = fallsWhenPlaced(item);
  if (position !== null) {
    const own = bodyColumns(position).some((c) => c.x === target.x && c.z === target.z);
    if (own && target.y >= Math.floor(position.y + 1e-6) && target.y <= headBlockY(position)) {
      v.push({
        code: 'UNSAFE_PLACE',
        severity: 'pause',
        message: `${where} is a cell the player's body is in`,
        details,
      });
    } else if (own && falls) {
      v.push({
        code: 'UNSAFE_PLACE',
        severity: 'pause',
        message: `${item} at ${where} would be in a column the player stands in: it could fall on its head`,
        details,
      });
    }
  }
  if (falls && !cell.takesFalling && v.length === 0) {
    v.push({
      code: 'UNSAFE_PLACE',
      severity: 'pause',
      message: `${item} at ${where} would fall: the observation does not show a plain full block holding it up`,
      details,
    });
  }
  const hazards = state.environmentHazards.known ? state.environmentHazards.value.hazards : [];
  v.push(
    ...checkHazardClearance(
      blockCentre(target),
      hazards,
      config.hazardAvoidanceRadius,
      'PLACE_BLOCK target',
    ),
  );
  return v;
}
