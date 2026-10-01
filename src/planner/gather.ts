import { z } from 'zod';
import type { ActionSpec } from '../domain/actions.ts';
import { DiggableBlockSchema, type DiggableBlock } from '../domain/blocks.ts';
import {
  BlockPositionSchema,
  TimestampSchema,
  type BlockPosition,
  type Position,
} from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock, formatPosition } from '../domain/geometry.ts';
import { DIG_YIELDS } from '../goals/route-book.ts';

/**
 * GATHER: ONE plan step ("get 54 sand") that code expands, cycle by cycle, into ordinary
 * actions: DIG_BLOCK on the nearest listed block of its kind, or MOVE_TO the spot to dig it
 * from. Each of those is proposed, validated (schema, safety policy, preconditions),
 * executed, verified and logged like any other action, one per cycle, and no model is
 * called between them. GATHER is a plan step only: it is not an action type, and it is
 * never sent to a client.
 *
 * The idea is Baritone's mine process: pick the nearest known target, walk to it, mine it,
 * and repeat until the goal count is held. No code was taken from Baritone (LGPL-3.0).
 *
 * This file is pure: the step's schema, its bounds, and the choice of the next action from
 * an observation. The agent loop keeps the step's progress between cycles
 * (src/app/gather-step.ts).
 */
export const GATHER = 'GATHER';

/** Largest count one GATHER step may ask for. */
export const MAX_GATHER_COUNT = 256;
/** Actions (walks and digs) after which a GATHER step ends, so the planner gets a checkpoint. */
export const GATHER_MAX_ACTIONS = 64;
/** Time after which a GATHER step ends, for the same reason. */
export const GATHER_MAX_MS = 5 * 60_000;
/** Blocks dug between the GATHER lines in the task journal. */
export const GATHER_REPORT_EVERY = 16;
/** MOVE_TO tolerance for a stand spot (the planner's own rule for DIG_BLOCK). */
export const GATHER_STAND_TOLERANCE = 0.5;
/** Blocks a step remembers not to try again (the most recent ones). */
const MAX_SKIPPED = 64;

/**
 * Gather `count` of what `block` drops (sand: sand; dirt and grass: dirt; clay: clay balls;
 * gravel: gravel or flint; logs: logs), digging listed blocks of that kind. The block is
 * one of DIG_BLOCK's allowlisted blocks, so GATHER can never ask for anything DIG_BLOCK
 * could not break.
 */
export const GatherStepSchema = z.strictObject({
  type: z.literal(GATHER),
  args: z.strictObject({
    block: DiggableBlockSchema,
    count: z.int().min(1).max(MAX_GATHER_COUNT),
  }),
});
export type GatherStep = z.infer<typeof GatherStepSchema>;

/** What a GATHER step has done so far; kept in agent memory between cycles and sessions. */
export const GatherProgressSchema = z.strictObject({
  planId: z.int().min(1),
  /** The plan step (0-based). */
  step: z.int().min(0),
  block: DiggableBlockSchema,
  count: z.int().min(1).max(MAX_GATHER_COUNT),
  /** How many of the block's drops the inventory held when the step started. */
  startHeld: z.int().min(0),
  startedAt: TimestampSchema,
  /** Actions the step ran (walks and digs), whatever their outcome. */
  actions: z.int().min(0),
  /** Digs that were verified. */
  dug: z.int().min(0),
  /** `dug` at the last progress line in the journal. */
  reported: z.int().min(0),
  /**
   * Blocks the step does not try again: an action for one of them did not succeed, or the
   * walk to its stand spot did not bring it within reach.
   */
  skipped: z.array(BlockPositionSchema).max(MAX_SKIPPED),
  /** The block the last action was for, and whether that action was the walk to it. */
  last: z.strictObject({ position: BlockPositionSchema, walk: z.boolean() }).nullable(),
});
export type GatherProgress = z.infer<typeof GatherProgressSchema>;

/** Why a GATHER step ended: the count is held, a bound was reached, or nothing is left to dig. */
export type GatherEnd = 'done' | 'bound' | 'no-target';

/** The items a dig of `block` can put into the inventory (the route book's dig yields). */
export function gatherDrops(block: DiggableBlock): string[] {
  return DIG_YIELDS[block].map((y) => y.item);
}

/**
 * Whether digging `candidate` gives what digging `block` gives: grass gives dirt, so a
 * GATHER of dirt digs grass too (seen live: the floor around the player was all grass).
 */
export function givesSame(candidate: DiggableBlock, block: DiggableBlock): boolean {
  if (candidate === block) return true;
  const wanted = new Set(gatherDrops(block));
  return gatherDrops(candidate).some((item) => wanted.has(item));
}

/** How many of `block`'s drops `items` holds. */
export function heldDrops(block: DiggableBlock, items: Readonly<Record<string, number>>): number {
  return gatherDrops(block).reduce((n, item) => n + (items[item] ?? 0), 0);
}

/** A new step's progress: nothing done yet, and the drops already held as the baseline. */
export function startGather(
  planId: number,
  step: number,
  gather: GatherStep,
  state: GameState,
  now: Date,
): GatherProgress {
  const items = state.inventory.known ? state.inventory.value.items : {};
  return {
    planId,
    step,
    block: gather.args.block,
    count: gather.args.count,
    startHeld: heldDrops(gather.args.block, items),
    startedAt: now.toISOString(),
    actions: 0,
    dug: 0,
    reported: 0,
    skipped: [],
    last: null,
  };
}

/** Drops gathered since the step started, by the inventory (0 when it is unknown). */
export function gatheredSoFar(progress: GatherProgress, state: GameState): number {
  if (!state.inventory.known) return 0;
  return Math.max(0, heldDrops(progress.block, state.inventory.value.items) - progress.startHeld);
}

/** Minutes since the step started. */
export function gatherMinutes(progress: GatherProgress, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(progress.startedAt)) / 60_000);
}

/** The bound the step has reached (64 actions or 5 minutes), or null. */
export function gatherBound(progress: GatherProgress, now: Date): string | null {
  if (progress.actions >= GATHER_MAX_ACTIONS) return `its bound of ${GATHER_MAX_ACTIONS} actions`;
  if (now.getTime() - Date.parse(progress.startedAt) >= GATHER_MAX_MS) {
    return `its bound of ${GATHER_MAX_MS / 60_000} minutes`;
  }
  return null;
}

/** The step's progress after one of its actions ran. A block whose action did not succeed is skipped. */
export function recordGatherAction(
  progress: GatherProgress,
  act: { target: BlockPosition; walk: boolean },
  succeeded: boolean,
): GatherProgress {
  return {
    ...progress,
    actions: progress.actions + 1,
    dug: progress.dug + (succeeded && !act.walk ? 1 : 0),
    skipped: succeeded ? progress.skipped : withSkipped(progress.skipped, [act.target]),
    last: { position: { ...act.target }, walk: act.walk },
  };
}

/** `skipped` plus `more`, each block once, keeping the most recent MAX_SKIPPED. */
export function withSkipped(
  skipped: readonly BlockPosition[],
  more: readonly BlockPosition[],
): BlockPosition[] {
  const out = skipped.map((p) => ({ ...p }));
  const seen = new Set(skipped.map(key));
  for (const p of more) {
    if (seen.has(key(p))) continue;
    seen.add(key(p));
    out.push({ ...p });
  }
  return out.slice(-MAX_SKIPPED);
}

export interface GatherOptions {
  /** DIG_BLOCK's reach from the eyes (the safety config's interactionReach). */
  reach: number;
  now: Date;
  /**
   * Would the executor accept `spec` with the player standing at `from`? null if so,
   * otherwise why not. The agent loop answers with a dry run of the real validation
   * (schema, safety policy, preconditions, the repeated-failure rule), so GATHER never
   * proposes what the policy would refuse for that block.
   */
  check: (spec: ActionSpec, from: Position) => string | null;
}

/** The next action, or how the step ends; `skip`: blocks to remember not to try again. */
export type GatherChoice =
  | { kind: 'act'; spec: ActionSpec; target: BlockPosition; walk: boolean; skip: BlockPosition[] }
  | { kind: 'end'; end: GatherEnd; why: string; skip: BlockPosition[] };

/**
 * Chooses a GATHER step's next action from a fresh observation:
 *  - done once the inventory holds `count` more of the block's drops than at the start;
 *  - a checkpoint at 64 actions or 5 minutes;
 *  - otherwise the nearest listed block of its kind that has a stand spot (standAt; when it
 *    is absent the adapter computes none, and only a block within reach is used) and that
 *    the step has not skipped: DIG_BLOCK it if it is within reach, else MOVE_TO its stand
 *    spot. Blocks within reach come first (no walk at all), then the nearest stand spot. A
 *    block is passed over when `check` says the dig (from where the player would stand) or
 *    the walk would be refused;
 *  - nothing left: the step ends, and the planner is asked again (it can EXPLORE).
 */
export function chooseGatherAction(
  gather: GatherStep,
  progress: GatherProgress,
  state: GameState,
  opts: GatherOptions,
): GatherChoice {
  const { block, count } = gather.args;
  if (gatheredSoFar(progress, state) >= count) {
    return { kind: 'end', end: 'done', why: `${count} gathered`, skip: [] };
  }
  const bound = gatherBound(progress, opts.now);
  if (bound !== null) return { kind: 'end', end: 'bound', why: bound, skip: [] };
  const feet = state.player.position.known ? state.player.position.value : null;
  if (feet === null || !state.nearbyBlocks.known) {
    return {
      kind: 'end',
      end: 'no-target',
      why: 'the player position or the nearby blocks are not observed',
      skip: [],
    };
  }

  const skipped = new Set(progress.skipped.map(key));
  const skip: BlockPosition[] = [];
  const candidates: Array<{ position: BlockPosition; walkTo: Position | null; cost: number }> = [];
  // In view, but with no spot a walk reaches to dig it from (standAt null).
  let unreachable = 0;
  for (const r of state.nearbyBlocks.value.resources) {
    if (!givesSame(r.block, block) || skipped.has(key(r.position))) continue;
    if (r.standAt === null) {
      unreachable += 1;
      continue;
    }
    const reach = eyeDistanceToBlock(feet, r.position);
    if (reach <= opts.reach) {
      candidates.push({ position: r.position, walkTo: null, cost: reach });
      continue;
    }
    // Out of reach: walk to its stand spot, unless the adapter computes none, or the last
    // walk (or the player) is already there and it is still out of reach.
    if (r.standAt === undefined) continue;
    const walked = progress.last?.walk === true && same(progress.last.position, r.position);
    if (walked || distance(feet, r.standAt) <= GATHER_STAND_TOLERANCE) {
      skip.push(r.position);
      continue;
    }
    candidates.push({
      position: r.position,
      walkTo: r.standAt,
      cost: opts.reach + distance(feet, r.standAt),
    });
  }
  candidates.sort((a, b) => a.cost - b.cost);

  let nearestRefusal: string | null = null;
  for (const c of candidates) {
    const dig: ActionSpec = { type: 'DIG_BLOCK', args: { position: { ...c.position } } };
    if (c.walkTo === null) {
      const why = opts.check(dig, feet);
      if (why === null) return { kind: 'act', spec: dig, target: c.position, walk: false, skip };
      nearestRefusal ??= `${formatPosition(c.position)}: ${why}`;
      continue;
    }
    const walk: ActionSpec = {
      type: 'MOVE_TO',
      args: { target: { ...c.walkTo }, tolerance: GATHER_STAND_TOLERANCE },
    };
    const why = opts.check(dig, c.walkTo) ?? opts.check(walk, feet);
    if (why === null) return { kind: 'act', spec: walk, target: c.position, walk: true, skip };
    nearestRefusal ??= `${formatPosition(c.position)}: ${why}`;
  }
  return {
    kind: 'end',
    end: 'no-target',
    why:
      nearestRefusal !== null
        ? `none of the ${candidates.length} ${block} in view can be dug now (nearest ${nearestRefusal})`
        : unreachable > 0
          ? // Seen live: logs 7 blocks away behind leaf bushes; "none left" sent the planner
            // looking for logs elsewhere when a way around was what it needed.
            `${unreachable} ${block} in view, but no walk from here reaches a spot to dig one ` +
            'from (walled in by leaves, plants or water, too high, or something would fall)'
          : `no ${block} left in view to dig`,
    skip,
  };
}

const key = (p: BlockPosition): string => `${p.x},${p.y},${p.z}`;
const same = (a: BlockPosition, b: BlockPosition): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;
