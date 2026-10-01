import type { ActionSpec } from './actions.ts';
import { PLACEABLE_ITEMS, type DiggableBlock, type PlaceableItem } from './blocks.ts';
import type { WorldTime } from './game-state.ts';

/**
 * The night shelter, as a first-night player makes one on flat ground (approved 2026-10-01):
 * a pit three blocks deep, dug straight down under its own feet, roofed with a block placed
 * in the ground layer it dug through. That cell's four side neighbours are natural ground,
 * whose inner faces look at the eyes from the pit's floor, so the roof can be placed
 * against them (a raised box cannot be roofed from inside: its walls' tops are above the
 * eyes, seen live on 2026-10-01). In the morning the agent digs the roof and a staircase out.
 *
 * DIG_DOWN, the dig under the player's own feet, exists for this pit only. The safety policy
 * allows it only as the next step of code's own blueprint for the night-shelter task, in the
 * evening, at night or just before it (src/safety/safety-policy.ts); the live client checks
 * the blocks themselves (src/bot/gtnh1710/digging.ts checkDigDown). Plans never contain it.
 */

/** The task the play loop builds the night shelter under; DIG_DOWN is allowed for it only. */
export const NIGHT_SHELTER_TASK_ID = 'night-shelter';
/** The task the play loop leaves last night's shelter under, in the morning. */
export const LEAVE_SHELTER_TASK_ID = 'leave-shelter';

/** How deep the night pit is: the block under the feet is dug this many times. */
export const NIGHT_PIT_DEPTH = 3;

/**
 * DIG_DOWN is allowed in the evening, at night, and in the day's last minutes before night
 * (real minutes). Play starts on the shelter 2 minutes before night (SHELTER_LEAD_MINUTES in
 * src/app/play/night.ts), well inside this window.
 */
export const NIGHT_PIT_WINDOW_MINUTES = 4;

/** Ground DIG_DOWN digs: the dig allowlist's ground blocks, never logs or leaves. */
export const DIG_DOWN_BLOCKS: readonly DiggableBlock[] = [
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
];

export function isDigDownBlock(name: string): boolean {
  return (DIG_DOWN_BLOCKS as readonly string[]).includes(name);
}

/**
 * Roof blocks for the pit, in order of preference: placeable, they do not fall, and the
 * agent can dig them again in the morning (DIG_BLOCK's allowlist): dirt, then logs.
 */
export const PIT_ROOF_ITEMS: readonly PlaceableItem[] = [
  'minecraft:dirt',
  ...PLACEABLE_ITEMS.filter((i) => i.startsWith('minecraft:log')),
];

/** Whether DIG_DOWN's time window is open: evening, night, or day within the window. */
export function nightPitTime(t: WorldTime): boolean {
  if (t.phase === 'evening' || t.phase === 'night') return true;
  return t.phase === 'day' && t.minutesUntilNight <= NIGHT_PIT_WINDOW_MINUTES;
}

/** One step of a code-made shelter blueprint: an action the executor validates, and a line. */
export interface ShelterStep {
  spec: ActionSpec;
  /** What it does, for the journal and the planner's route ("dig down: (0, 63, 0)"). */
  text: string;
}
