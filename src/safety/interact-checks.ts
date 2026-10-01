import type { ActionType } from '../domain/actions.ts';
import type { BlockPosition } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { formatPosition } from '../domain/geometry.ts';
import { parseObservedStorageId, profileForBlock } from '../domain/interactions.ts';
import type { SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { blockOutsideBoundary } from './coordinate-boundaries.ts';

/** Rules for found storage blocks and window actions on blocks (see safety-policy.ts). */

/** Ids of crafting tables the observation found (not configured): `crafting_table:x.y.z`. */
export const OBSERVED_TABLE_PREFIX = 'crafting_table:';

/** A storage block the observation found (not configured) must lie inside the work area. */
export function observedStorageOutside(
  type: ActionType,
  containerId: string,
  state: GameState,
  config: SafetyConfig,
): SafetyViolation[] {
  if (parseObservedStorageId(containerId) === null) return [];
  const listed = state.storage.find((s) => s.id === containerId);
  if (listed === undefined || !listed.position.known) return [];
  const p = listed.position.value;
  return blockOutsideBoundary(type, { x: p.x, y: p.y, z: p.z }, config);
}

/**
 * Window-action rules the observation can answer. The block must be listed in
 * `interactables` (observed: a profile, or the operator's observe-only allowlist), and its
 * profile must be one the action may use: SMELT and TAKE_OUTPUT need a furnace;
 * INTERACT_BLOCK any profile that may be opened (never a trapped chest), or an
 * observe-only block. The live client re-checks the block, reach, the fence and the window
 * that opens.
 */
export function interactChecks(
  type: 'INTERACT_BLOCK' | 'SMELT' | 'TAKE_OUTPUT',
  target: BlockPosition,
  state: GameState,
): SafetyViolation[] {
  const where = formatPosition(target);
  const details = { x: target.x, y: target.y, z: target.z };
  if (!state.interactables.known) {
    return [
      {
        code: 'UNKNOWN_TARGET',
        severity: 'pause',
        message: `Nearby blocks to interact with are not observed (${state.interactables.reason}); nothing can be opened`,
        details,
      },
    ];
  }
  const listed = state.interactables.value.blocks.find(
    (b) => b.position.x === target.x && b.position.y === target.y && b.position.z === target.z,
  );
  const refuse = (message: string): SafetyViolation[] => [
    { code: 'NOT_INTERACTABLE', severity: 'pause', message, details },
  ];
  if (listed === undefined) {
    return refuse(
      `The block at ${where} is not an observed block the agent may interact with (it needs an interaction profile or the observe-only allowlist)`,
    );
  }
  const profile = listed.profile === null ? null : profileForBlock(listed.block);
  if (listed.profile !== null && (profile === null || profile.id !== listed.profile)) {
    return refuse(`${listed.block} at ${where} does not match its profile ${listed.profile}`);
  }
  if (profile !== null && profile.open.how === 'never') {
    return refuse(`${listed.block} at ${where} is never opened: ${profile.open.reason}`);
  }
  if (type === 'INTERACT_BLOCK') {
    if (profile !== null && !profile.usedBy.includes('INTERACT_BLOCK')) {
      return refuse(`${listed.block} at ${where} may not be opened with INTERACT_BLOCK`);
    }
    return [];
  }
  if (profile === null || !profile.usedBy.includes(type)) {
    return refuse(`${type} needs a furnace; the block at ${where} is ${listed.block}`);
  }
  return [];
}
