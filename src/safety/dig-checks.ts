import { toSpec, type Action } from '../domain/actions.ts';
import { FALLING_DIGGABLE_BLOCKS, isGardenBlock } from '../domain/blocks.ts';
import type { BlockPosition } from '../domain/common.ts';
import { diggableInfo } from '../domain/dig-time.ts';
import { carriedHarvester } from '../domain/tools.ts';
import type { GameState } from '../domain/game-state.ts';
import { blockCentre, bodyColumns, formatPosition, headBlockY } from '../domain/geometry.ts';
import {
  isDigDownBlock,
  NIGHT_PIT_WINDOW_MINUTES,
  NIGHT_SHELTER_TASK_ID,
  nightPitTime,
} from '../domain/night-shelter.ts';
import type { SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { stableStringify } from '../util/json.ts';
import { checkHazardClearance } from './coordinate-boundaries.ts';

/** DIG_BLOCK and DIG_DOWN rules the observation can answer (see safety-policy.ts). */

/**
 * DIG_BLOCK rules that the observation can answer. The live client re-checks all of them
 * (and more: fluids, tile entities and anything else touching the block) on the blocks the
 * server sent, just before and during the dig.
 *  - The block must be an allowlisted diggable block the observation lists.
 *  - Stone and ores only when the player carries a tool that harvests them (NOT_DIGGABLE
 *    otherwise: a hand, or a tool of another kind or too low a level, digs them at a third of
 *    the speed and the block is gone with nothing dropped; tools.ts carriedHarvester). A
 *    vanilla tool counts by its name (kind, level, wear); a Tinkers' tool's level is in its
 *    NBT data, and a GT ore's in its metadata, neither of which the observation carries, so
 *    for those any tool of the kind passes here and the client checks the levels before it
 *    digs (client/dig-actions.ts). Like any NOT_DIGGABLE, a plan's step refused for it is
 *    stale, not unsafe: the planner is asked again (and can make the tool).
 *  - Never the player's own support: nothing in a column the body overlaps, at or below
 *    the head (the body's own cells are air anyway).
 *  - Never a falling block (sand/gravel) above the player's head, and never a block with a
 *    listed falling block directly on top of it (it would fall into the hole).
 *  - Clear of known hazards, like a MOVE_TO target.
 */
export function digChecks(
  target: BlockPosition,
  state: GameState,
  config: SafetyConfig,
): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const where = formatPosition(target);
  const details = { x: target.x, y: target.y, z: target.z };
  if (!state.nearbyBlocks.known) {
    v.push({
      code: 'UNKNOWN_TARGET',
      severity: 'pause',
      message: `Nearby blocks are not observed (${state.nearbyBlocks.reason}); nothing can be dug`,
      details,
    });
    return v;
  }
  const blocks = state.nearbyBlocks.value;
  const same = (p: BlockPosition, q: BlockPosition): boolean =>
    p.x === q.x && p.y === q.y && p.z === q.z;
  // A player's build (src/domain/player-builds.ts): never dug, whatever the block.
  if ((blocks.playerBuilt ?? []).some((p) => same(p, target))) {
    v.push({
      code: 'NOT_DIGGABLE',
      severity: 'pause',
      message: `The block at ${where} was built by a player (seen placed while one stood near): the agent never breaks a player's build`,
      details,
    });
    return v;
  }
  const listed = blocks.resources.find((r) => same(r.position, target));
  if (listed === undefined) {
    v.push({
      code: 'NOT_DIGGABLE',
      severity: 'pause',
      message: `The block at ${where} is not an observed diggable block (only allowlisted blocks the observation lists may be dug)`,
      details: { ...details, scanRadius: blocks.scanRadius },
    });
    return v;
  }
  // A GT ore's table rule is the least any GT ore needs (a pickaxe of level 0).
  const rule = diggableInfo(listed.block).harvest;
  if (rule !== null) {
    const tool = state.inventory.known
      ? carriedHarvester(state.inventory.value.items, rule)
      : { ok: false as const, reason: `the inventory is not observed (${state.inventory.reason})` };
    if (!tool.ok) {
      v.push({
        code: 'NOT_DIGGABLE',
        severity: 'pause',
        message:
          `${where} is ${listed.block}, which only a tool that harvests it may dig: ${tool.reason}`.slice(
            0,
            500,
          ),
        details: { ...details, block: listed.block, tool: rule.tool, level: rule.level },
      });
      return v;
    }
  }
  const position = state.player.position.known ? state.player.position.value : null;
  if (position !== null) {
    const own = bodyColumns(position).some((c) => c.x === target.x && c.z === target.z);
    // Below the feet: what holds the player up; at the feet and the head, in its own columns,
    // anything but a plant the body passes, which breaking moves nothing (seen live: a
    // starving agent stood in the HarvestCraft garden it had walked to, and its dig was
    // refused as "under the player").
    const below = target.y < Math.floor(position.y + 1e-6);
    if (own && (below || (target.y <= headBlockY(position) && !isGardenBlock(listed.block)))) {
      v.push({
        code: 'UNSAFE_DIG',
        severity: 'pause',
        message: `${where} is under the player (the block it stands on, or its own column below the feet)`,
        details,
      });
    }
    if (own && target.y > headBlockY(position) && FALLING_DIGGABLE_BLOCKS.has(listed.block)) {
      v.push({
        code: 'UNSAFE_DIG',
        severity: 'pause',
        message: `${where} is ${listed.block} directly above the player's head`,
        details: { ...details, block: listed.block },
      });
    }
  }
  const above = blocks.resources.find((r) =>
    same(r.position, { x: target.x, y: target.y + 1, z: target.z }),
  );
  if (above !== undefined && FALLING_DIGGABLE_BLOCKS.has(above.block)) {
    v.push({
      code: 'UNSAFE_DIG',
      severity: 'pause',
      message: `${above.block} sits on ${where} and would fall into the hole`,
      details: { ...details, above: above.block },
    });
  }
  const hazards = state.environmentHazards.known ? state.environmentHazards.value.hazards : [];
  v.push(
    ...checkHazardClearance(
      blockCentre(target),
      hazards,
      config.hazardAvoidanceRadius,
      'DIG_BLOCK target',
    ),
  );
  return v;
}

/**
 * DIG_DOWN rules that the observation can answer (approved 2026-10-01 for the night pit
 * only). The live client re-checks the blocks themselves just before and during the dig
 * (digging.ts checkDigDown: exactly one block down onto a plain full block, nothing but air,
 * plants and plain blocks around the dug block, the landing and the body, no fluid, no
 * hazard, nothing unloaded).
 *  - The night pit only (NIGHT_PIT_ONLY): proposed by code (origin deterministic-router),
 *    for the night-shelter task, as exactly the next known step of that task's code-made
 *    blueprint (knownRecipeState.nextKnownSafeStep), in the evening, at night or in the
 *    last NIGHT_PIT_WINDOW_MINUTES before it. Plans never contain it (validatePlan), and a
 *    human's command (origin user) is refused too: it is not a general mining ability.
 *  - Exactly the block under the player's feet, the player on top of it (UNSAFE_DIG).
 *  - The observation reports that ground (nearbyBlocks.underFeet): a block DIG_DOWN digs
 *    (dirt, grass, sand, gravel, clay; NOT_DIGGABLE otherwise), over a landing that holds
 *    the player (UNSAFE_DIG: a cave, a fluid or unsupported sand would drop it farther).
 *  - Clear of known hazards, like a dug block.
 */
export function digDownChecks(
  action: Extract<Action, { type: 'DIG_DOWN' }>,
  state: GameState,
  config: SafetyConfig,
): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const target = action.args.position;
  const where = formatPosition(target);
  const details = { x: target.x, y: target.y, z: target.z };
  /** Why this is not the night pit's own step now (one NIGHT_PIT_ONLY violation for all). */
  const notThePit: string[] = [];
  if (action.origin !== 'deterministic-router') {
    notThePit.push(`only code's blueprint proposes it (origin ${action.origin})`);
  }
  const task = state.currentTask;
  if (task === null || task.taskId !== NIGHT_SHELTER_TASK_ID) {
    notThePit.push(
      `only for the night shelter task (${NIGHT_SHELTER_TASK_ID}), not ${task?.taskId ?? 'no task'}`,
    );
  }
  const known = state.knownRecipeState?.nextKnownSafeStep ?? null;
  if (known === null || stableStringify(known) !== stableStringify(toSpec(action))) {
    notThePit.push(`${where} is not the next step of the night shelter's blueprint`);
  }
  if (!state.time.known) {
    v.push({
      code: 'STATE_UNKNOWN',
      severity: 'block',
      message: `DIG_DOWN needs the time of day (night is near), and it is unknown (${state.time.reason})`,
      details: { field: 'time' },
    });
  } else if (!nightPitTime(state.time.value)) {
    const t = state.time.value;
    notThePit.push(
      `only in the evening, at night or within ${NIGHT_PIT_WINDOW_MINUTES} min of it, and it is ${t.phase} (${t.minutesUntilNight} min until night)`,
    );
  }
  if (notThePit.length > 0) {
    v.push({
      code: 'NIGHT_PIT_ONLY',
      severity: 'pause',
      message: `DIG_DOWN is the night pit's own step: ${notThePit.join('; ')}`.slice(0, 500),
      details,
    });
  }

  const unsafe = (message: string, extra: Record<string, string | number | boolean> = {}): void => {
    v.push({ code: 'UNSAFE_DIG', severity: 'pause', message, details: { ...details, ...extra } });
  };
  const position = state.player.position.known ? state.player.position.value : null;
  if (position !== null) {
    const feetLevel = Math.floor(position.y + 1e-6);
    const under =
      target.x === Math.floor(position.x) &&
      target.z === Math.floor(position.z) &&
      target.y === feetLevel - 1;
    if (!under || Math.abs(position.y - Math.round(position.y)) > 1e-3) {
      unsafe(`${where} is not the block the player stands on`);
    }
  }
  if (!state.nearbyBlocks.known) {
    v.push({
      code: 'UNKNOWN_TARGET',
      severity: 'pause',
      message: `Nearby blocks are not observed (${state.nearbyBlocks.reason}); nothing can be dug`,
      details,
    });
  } else {
    const ground = state.nearbyBlocks.value.underFeet ?? null;
    const same =
      ground !== null &&
      ground.position.x === target.x &&
      ground.position.y === target.y &&
      ground.position.z === target.z;
    if (!same) {
      unsafe(
        `the observation does not report the ground under the player at ${where} (the player must stand in one column, on a block top)`,
      );
    } else if (!isDigDownBlock(ground.block)) {
      v.push({
        code: 'NOT_DIGGABLE',
        severity: 'pause',
        message: `${where} is ${ground.block}: digging down takes only dirt, grass, sand, gravel or clay`,
        details: { ...details, block: ground.block },
      });
    } else if (!ground.landingHolds) {
      unsafe(`${ground.landing} under ${where} would not hold the player exactly one block lower`, {
        landing: ground.landing,
      });
    }
  }
  const hazards = state.environmentHazards.known ? state.environmentHazards.value.hazards : [];
  v.push(
    ...checkHazardClearance(
      blockCentre(target),
      hazards,
      config.hazardAvoidanceRadius,
      'DIG_DOWN target',
    ),
  );
  return v;
}
