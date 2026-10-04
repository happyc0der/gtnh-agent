import { z } from 'zod';
import { MAX_EXPLORE_DISTANCE, MIN_EXPLORE_DISTANCE, type ActionSpec } from '../domain/actions.ts';
import {
  DiggableBlockSchema,
  GT_ORE_BLOCK,
  isGardenBlock,
  type DiggableBlock,
} from '../domain/blocks.ts';
import {
  attackRefusal,
  BARE_HAND,
  BLIND_STRIKE_REACH,
  calmRefusal,
  HAND_STRIKE_REACH,
} from '../domain/combat.ts';
import {
  BlockPositionSchema,
  EntityNumberSchema,
  ItemNameSchema,
  TimestampSchema,
  type BlockPosition,
  type Position,
} from '../domain/common.ts';
import { animalDrops, FOOD_GARDENS, GARDEN_DROPS } from '../domain/food.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock, formatPosition } from '../domain/geometry.ts';
import { gtOreOfMeta } from '../goals/ore-names.ts';
import { DIG_YIELDS } from '../goals/route-book.ts';

/**
 * GATHER: ONE plan step ("get 54 sand", "get 3 of what cows drop") that code expands, cycle by
 * cycle, into ordinary actions: DIG_BLOCK on the nearest listed block of its kind, or MOVE_TO
 * the spot to dig it from; for a farm animal, MOVE_TO next to the nearest one of its kind and
 * ATTACK_ENTITY once it is within reach (the live client then picks up what the kill drops).
 * Each of those is proposed, validated (schema, safety policy, preconditions), executed,
 * verified and logged like any other action, one per cycle, and no model is called between
 * them. GATHER is a plan step only: it is not an action type, and it is never sent to a client.
 *
 * The idea is Baritone's mine process: pick the nearest known target, walk to it, mine it,
 * and repeat until the goal count is held. No code was taken from Baritone (LGPL-3.0).
 *
 * This file is pure: the step's schema, its bounds, and the choice of the next action from
 * an observation. The agent loop keeps the step's progress between cycles
 * (src/app/loop/gather-step.ts).
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
 * The creatures a GATHER may hunt: the farm animals ATTACK_ENTITY may strike for a task
 * (src/domain/combat.ts FARM_ANIMALS), whose drops the route book knows (food.ts).
 */
export const GatherAnimalSchema = z.enum([
  'minecraft:Cow',
  'minecraft:Pig',
  'minecraft:Sheep',
  'minecraft:Chicken',
]);
export type GatherAnimal = z.infer<typeof GatherAnimalSchema>;

/**
 * MOVE_TO tolerance for a walk to an animal: the walk ends at the centre of the block the
 * animal stood in, and the animal is somewhere in that block or has moved a little.
 */
export const HUNT_TOLERANCE = 1;
/**
 * Walks in a row to one animal before the step passes it over: a struck animal runs off for a
 * few seconds (EntityAIPanic), so a walk may end out of reach once or twice; one that keeps
 * getting away is left for another.
 */
export const HUNT_WALKS_PER_TARGET = 3;
/** Kept out of the strike reach's last bit: the animal moves while the burst starts. */
const REACH_MARGIN = 0.3;

/**
 * Gather `count` of what `block` drops (sand: sand; dirt and grass: dirt; clay: clay balls;
 * gravel: gravel or flint; logs: logs; a garden: its produce; stone: cobblestone; a GT ore:
 * its raw ore), digging listed blocks of that kind; or of what `animal` drops (a cow: raw beef
 * or leather; a pig: raw porkchops; a sheep: raw mutton or wool; a chicken: raw chicken or
 * feathers), hunting it. The block is one of DIG_BLOCK's allowlisted blocks and the animal a
 * farm animal, so GATHER can never ask for anything DIG_BLOCK or ATTACK_ENTITY could not do.
 *
 * `item` (a block only): count that one of the block's drops, and dig only blocks that can
 * drop it. It is how a GT ore is mined: every GT ore is the one block gregtech:gt.blockores,
 * and which ore one is (its material) lives in its tile entity, which the observation does
 * not read, so "16 raw iron ore" is GATHER {"block": "gregtech:gt.blockores", "item":
 * "gregtech:gt.metaitem.03@5032", "count": 16}: code digs the GT ores in view, whatever their
 * material, until 16 raw iron ore are held (the route's GATHER hints name the item).
 */
export const GatherStepSchema = z.strictObject({
  type: z.literal(GATHER),
  args: z.union([
    z.strictObject({
      block: DiggableBlockSchema,
      count: z.int().min(1).max(MAX_GATHER_COUNT),
      item: ItemNameSchema.optional(),
    }),
    z.strictObject({
      animal: GatherAnimalSchema,
      count: z.int().min(1).max(MAX_GATHER_COUNT),
    }),
  ]),
});
export type GatherStep = z.infer<typeof GatherStepSchema>;

/**
 * What a GATHER gathers from: a kind of block (with `item`: for that one of its drops), or a
 * kind of farm animal.
 */
export type GatherSource = { block: DiggableBlock; item?: string } | { animal: GatherAnimal };

/** The step's source: its block (and item), or its animal. */
export function gatherSourceOf(gather: GatherStep): GatherSource {
  if (!('block' in gather.args)) return { animal: gather.args.animal };
  const { block, item } = gather.args;
  return item === undefined ? { block } : { block, item };
}

/**
 * "minecraft:sand", "gregtech:gt.blockores for gregtech:gt.metaitem.03@5032" or
 * "minecraft:Cow": the source's name, for the journal and messages (which also count the
 * blocks of the kind in view, so the block comes first).
 */
export function sourceName(source: GatherSource): string {
  if ('animal' in source) return source.animal;
  return source.item === undefined ? source.block : `${source.block} for ${source.item}`;
}

/** What a GATHER step has done so far; kept in agent memory between cycles and sessions. */
export const GatherProgressSchema = z.strictObject({
  planId: z.int().min(1),
  /** The plan step (0-based). */
  step: z.int().min(0),
  /** The block it digs, or (absent) the animal it hunts. */
  block: DiggableBlockSchema.optional(),
  /** With a block: the one drop that counts (GatherStep's `item`). */
  item: ItemNameSchema.optional(),
  animal: GatherAnimalSchema.optional(),
  count: z.int().min(1).max(MAX_GATHER_COUNT),
  /** How many of the source's drops the inventory held when the step started. */
  startHeld: z.int().min(0),
  startedAt: TimestampSchema,
  /** Actions the step ran (walks and digs or attacks), whatever their outcome. */
  actions: z.int().min(0),
  /** Digs (or attacks) that were verified. */
  dug: z.int().min(0),
  /** `dug` at the last progress line in the journal. */
  reported: z.int().min(0),
  /**
   * Blocks the step does not try again: an action for one of them did not succeed, or the
   * walk to its stand spot did not bring it within reach.
   */
  skipped: z.array(BlockPositionSchema).max(MAX_SKIPPED),
  /** Animals (entity ids) the step does not try again, for the same reasons. */
  skippedEntities: z.array(EntityNumberSchema).max(MAX_SKIPPED).default([]),
  /**
   * The block (or the animal, `entity`, and where it stood) the last action was for, whether
   * that action was the walk to it, and how many walks in a row went to that animal; `travel`
   * when it was an EXPLORE toward a remembered place (its position is that place).
   */
  last: z
    .strictObject({
      position: BlockPositionSchema,
      walk: z.boolean(),
      entity: EntityNumberSchema.nullable().default(null),
      walks: z.int().min(0).default(0),
      travel: z.boolean().optional(),
    })
    .nullable(),
});
export type GatherProgress = z.infer<typeof GatherProgressSchema>;

/** The progress's source (old records hold only a block). */
export function progressSource(p: GatherProgress): GatherSource {
  if (p.animal !== undefined) return { animal: p.animal };
  const block = p.block ?? 'minecraft:dirt';
  return p.item === undefined ? { block } : { block, item: p.item };
}

/** Why a GATHER step ended: the count is held, a bound was reached, or nothing is left to dig. */
export type GatherEnd = 'done' | 'bound' | 'no-target';

/**
 * The items that count for a GATHER: what a dig of `block` (the route book's dig yields), or
 * a kill of an animal (food.ts ANIMAL_DROPS), can put into the inventory; with `item`, that
 * one drop (none when the block never drops it).
 */
export function gatherDrops(source: DiggableBlock | GatherSource): string[] {
  if (typeof source !== 'string' && 'animal' in source) return animalDrops(source.animal);
  const block = typeof source === 'string' ? source : source.block;
  const item = typeof source === 'string' ? undefined : source.item;
  if (item !== undefined) return ownDrops(block).includes(item) ? [item] : [];
  // A food garden's step is about food, not one kind of garden: any food garden it finds is
  // dug and any produce counts (seen live: a GATHER of a stalk garden walked to the gardens
  // world memory remembered, which were gourd gardens, and ended "none left in view").
  if (isGardenBlock(block) && FOOD_GARDENS.includes(block)) return ALL_GARDEN_PRODUCE;
  return ownDrops(block);
}

/** What a dig of `block` itself can drop (the route book's dig yields). */
function ownDrops(block: DiggableBlock): string[] {
  return DIG_YIELDS[block].map((y) => y.item);
}

/** What any food garden drops (food.ts GARDEN_DROPS), each item once. */
const ALL_GARDEN_PRODUCE: string[] = [...new Set(FOOD_GARDENS.flatMap((g) => GARDEN_DROPS[g]))];

/**
 * What a dig of `block` drops: a GT ore whose material the server sent (`ore`, its tile
 * entity's metadata: ResourceBlock.ore) only that ore's drops, else the block's own.
 */
function dropsOf(block: DiggableBlock, ore: number | undefined): string[] {
  if (block !== GT_ORE_BLOCK || ore === undefined) return ownDrops(block);
  return gtOreOfMeta(ore)?.drops ?? ownDrops(block);
}

/**
 * Whether digging `candidate` gives what a GATHER of `source` counts: grass gives dirt, so a
 * GATHER of dirt digs grass too (seen live: the floor around the player was all grass). With
 * an `item`, only blocks that can drop that item: a GT ore whose material is known (`ore`)
 * only when it is that item's ore, so "16 raw iron ore" digs iron ore and passes tin ore by.
 */
export function givesSame(
  candidate: DiggableBlock,
  source: DiggableBlock | { block: DiggableBlock; item?: string | undefined },
  ore?: number,
): boolean {
  if (typeof source !== 'string' && source.item !== undefined) {
    return dropsOf(candidate, ore).includes(source.item);
  }
  const block = typeof source === 'string' ? source : source.block;
  if (candidate === block) return true;
  const wanted = new Set(gatherDrops(block));
  return gatherDrops(candidate).some((item) => wanted.has(item));
}

/**
 * Why a GATHER of `block` for `item` can never count anything: the block never drops it
 * (a GT ore's drops are the knowledge base's, so none without it). Null when it can.
 */
export function itemProblem(block: DiggableBlock, item: string | undefined): string | null {
  if (item === undefined) return null;
  const drops = ownDrops(block);
  if (drops.includes(item)) return null;
  const shown = drops.slice(0, 4).join(', ');
  return (
    `${block} never drops ${item}` +
    (drops.length === 0
      ? ' (no drops are known for it)'
      : ` (it drops ${shown}${drops.length > 4 ? `, ... ${drops.length} kinds` : ''})`)
  );
}

/** How many of the source's drops `items` holds. */
export function heldDrops(
  source: DiggableBlock | GatherSource,
  items: Readonly<Record<string, number>>,
): number {
  return gatherDrops(source).reduce((n, item) => n + (items[item] ?? 0), 0);
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
  const source = gatherSourceOf(gather);
  return {
    planId,
    step,
    ...source,
    count: gather.args.count,
    startHeld: heldDrops(source, items),
    startedAt: now.toISOString(),
    actions: 0,
    dug: 0,
    reported: 0,
    skipped: [],
    skippedEntities: [],
    last: null,
  };
}

/** Drops gathered since the step started, by the inventory (0 when it is unknown). */
export function gatheredSoFar(progress: GatherProgress, state: GameState): number {
  if (!state.inventory.known) return 0;
  return Math.max(
    0,
    heldDrops(progressSource(progress), state.inventory.value.items) - progress.startHeld,
  );
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

/**
 * What one of the step's actions was for: a block, or an animal (`entity`) where it stood;
 * `travel`: an EXPLORE toward a place the block is remembered at.
 */
export interface GatherAct {
  target: BlockPosition;
  walk: boolean;
  entity: number | null;
  travel?: boolean;
}

/**
 * The step's progress after one of its actions ran. A block (or animal) whose action did not
 * succeed is skipped.
 */
export function recordGatherAction(
  progress: GatherProgress,
  act: GatherAct,
  succeeded: boolean,
): GatherProgress {
  const same = act.entity !== null && progress.last?.entity === act.entity;
  return {
    ...progress,
    actions: progress.actions + 1,
    dug: progress.dug + (succeeded && !act.walk ? 1 : 0),
    skipped:
      succeeded || act.entity !== null
        ? progress.skipped
        : withSkipped(progress.skipped, [act.target]),
    skippedEntities:
      succeeded || act.entity === null
        ? progress.skippedEntities
        : withSkippedEntities(progress.skippedEntities, [act.entity]),
    last: {
      position: { ...act.target },
      walk: act.walk,
      entity: act.entity,
      walks: act.walk ? (same && progress.last?.walk === true ? progress.last.walks : 0) + 1 : 0,
      ...(act.travel === true ? { travel: true } : {}),
    },
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

/** `skipped` plus `more`, each entity once, keeping the most recent MAX_SKIPPED. */
export function withSkippedEntities(skipped: readonly number[], more: readonly number[]): number[] {
  return [...new Set([...skipped, ...more])].slice(-MAX_SKIPPED);
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
  /**
   * Where world memory remembers the block beyond what the current scan covers, nearest first
   * (planner-provider.ts rememberedPlacesOf). With none of it in view, the step heads for the
   * nearest with an EXPLORE toward its x and z, as a person walks back to the gravel they saw
   * on a hillside. Seen live: GATHER gravel ended "no gravel left in view" with gravel
   * remembered 92 blocks south, and the planner, asked again, planned the same.
   */
  remembered?: ReadonlyArray<{ x: number; y: number; z: number; distance: number }>;
  /**
   * Where to look on with none of it in view and none remembered (world-memory.ts
   * wanderTarget: toward the direction seen least): the step explores there by itself, as
   * Baritone's mine process wanders on for blocks it knows of none of. Seen live: "GATHER 5
   * logs" ended "none left in view" plan after plan, the planner never exploring, and play
   * went idle. Absent: the step ends.
   */
  wander?: { x: number; z: number; distance: number } | null;
}

/** Within this far (blocks, level) of a remembered place, none of it in view: it is gone. */
const REMEMBERED_NEAR = 12;

/**
 * Trunks: a GATHER of logs fells each one from its base, as a person chops a tree. Seen live
 * 2026-10-01: gathering logs for a crafting table, the agent dug three logs and got one; it
 * dug the logs at (-20, 116, 123) and (-18, 117, 123) from (-20.5, 114, 122.5), high in the
 * trees and off its own column, and their drops stopped on the logs and leaves under them, out
 * of its pickup reach. Dug from the bottom, beside the trunk, every drop falls down the emptied
 * column to the base, next to the player.
 */
const TRUNK_BLOCKS: ReadonlySet<DiggableBlock> = new Set<DiggableBlock>([
  'minecraft:log',
  'minecraft:log2',
]);

/** Whether a dug log's drop would stop on `block` under it (a log, or leaves of any kind). */
const holdsADrop = (block: DiggableBlock): boolean =>
  TRUNK_BLOCKS.has(block) || /leaves/i.test(block);

/** Whether feet at `feet` stand in one of the 3 x 3 columns around the block `p`. */
const besideColumn = (feet: Position, p: BlockPosition): boolean =>
  Math.abs(Math.floor(feet.x) - p.x) <= 1 && Math.abs(Math.floor(feet.z) - p.z) <= 1;

/**
 * The next action, or how the step ends; `skip`: blocks (and `skipEntities`: animals) to
 * remember not to try again. `entity` is the animal the action is for (null for a block);
 * `travel`: an EXPLORE toward a remembered place (`target`).
 */
export type GatherChoice =
  | {
      kind: 'act';
      spec: ActionSpec;
      target: BlockPosition;
      walk: boolean;
      entity: number | null;
      travel?: boolean;
      skip: BlockPosition[];
      skipEntities: number[];
    }
  | { kind: 'end'; end: GatherEnd; why: string; skip: BlockPosition[]; skipEntities: number[] };

/**
 * Chooses a GATHER step's next action from a fresh observation:
 *  - done once the inventory holds `count` more of the source's drops than at the start;
 *  - a checkpoint at 64 actions or 5 minutes;
 *  - a block: the nearest listed block of its kind that has a stand spot (standAt; when it
 *    is absent the adapter computes none, and only a block within reach is used) and that
 *    the step has not skipped: DIG_BLOCK it if it is within reach, else MOVE_TO its stand
 *    spot. Blocks within reach come first (no walk at all), then the nearest stand spot. A
 *    block is passed over when `check` says the dig (from where the player would stand) or
 *    the walk would be refused (stone or an ore with no carried tool that harvests it: the
 *    policy's NOT_DIGGABLE). With an `item`, the blocks of any kind that can drop it; a block
 *    that never drops it ends the step at once;
 *  - logs are felled trunk by trunk from the base (TRUNK_BLOCKS): a log with a listed log or
 *    leaves under it (its drop would stop there) comes after every log with neither; one is
 *    dug only from beside its trunk (feet in the 3 x 3 columns around it; with a stand spot,
 *    a log in reach from farther away is walked to first); and the log in reach in the
 *    column of the log dug last comes first, so the trunk goes on up while it is in reach;
 *  - an animal: see chooseHuntAction;
 *  - nothing left: the step ends, and the planner is asked again (it can EXPLORE).
 */
export function chooseGatherAction(
  gather: GatherStep,
  progress: GatherProgress,
  state: GameState,
  opts: GatherOptions,
): GatherChoice {
  const { count } = gather.args;
  if (gatheredSoFar(progress, state) >= count) {
    return { kind: 'end', end: 'done', why: `${count} gathered`, skip: [], skipEntities: [] };
  }
  const bound = gatherBound(progress, opts.now);
  if (bound !== null) {
    return { kind: 'end', end: 'bound', why: bound, skip: [], skipEntities: [] };
  }
  if ('animal' in gather.args) {
    return chooseHuntAction(gather.args.animal, progress, state, opts);
  }
  const { block } = gather.args;
  const wrongItem = itemProblem(block, gather.args.item);
  if (wrongItem !== null) {
    return { kind: 'end', end: 'no-target', why: wrongItem, skip: [], skipEntities: [] };
  }
  const feet = state.player.position.known ? state.player.position.value : null;
  if (feet === null || !state.nearbyBlocks.known) {
    return {
      kind: 'end',
      end: 'no-target',
      why: 'the player position or the nearby blocks are not observed',
      skip: [],
      skipEntities: [],
    };
  }

  const skipped = new Set(progress.skipped.map(key));
  const skip: BlockPosition[] = [];
  const candidates: Array<{
    position: BlockPosition;
    walkTo: Position | null;
    cost: number;
    /** Felling: a log on another log or on leaves, whose drop would stop there: later. */
    later: boolean;
    /** Felling: a log in reach in the column of the log dug last: the trunk goes on. */
    goesOn: boolean;
    /** A GT ore whose material is not known, for one ore's item: perhaps that ore, after the known ones. */
    maybe: boolean;
  }> = [];
  // Felling trunks (logs): the listed blocks a log's drop would stop on, and the log dug last.
  const resources = state.nearbyBlocks.value.resources;
  const felling = TRUNK_BLOCKS.has(block);
  const dropHolders = new Set(
    felling
      ? resources
          .filter((r) => holdsADrop(r.block) && !skipped.has(key(r.position)))
          .map((r) => key(r.position))
      : [],
  );
  const lastDug =
    felling && progress.last !== null && !progress.last.walk && progress.last.entity === null
      ? progress.last.position
      : null;
  // In view, but with no spot a walk reaches to dig it from (standAt null).
  let unreachable = 0;
  for (const r of resources) {
    if (!givesSame(r.block, gather.args, r.ore) || skipped.has(key(r.position))) continue;
    const maybe = r.block === GT_ORE_BLOCK && r.ore === undefined && gather.args.item !== undefined;
    if (r.standAt === null) {
      unreachable += 1;
      continue;
    }
    const later = dropHolders.has(key({ ...r.position, y: r.position.y - 1 }));
    const reach = eyeDistanceToBlock(feet, r.position);
    const walked =
      progress.last?.walk === true &&
      progress.last.travel !== true &&
      same(progress.last.position, r.position);
    // A log is dug standing beside its trunk, so that its drop falls next to the player; in
    // reach from farther away, the walk to its stand spot comes first (unless that walk was
    // just made). Other blocks are dug from wherever they are in reach.
    const fromHere =
      !felling || r.standAt === undefined || walked || besideColumn(feet, r.position);
    if (reach <= opts.reach && fromHere) {
      const goesOn = lastDug !== null && lastDug.x === r.position.x && lastDug.z === r.position.z;
      candidates.push({ position: r.position, walkTo: null, cost: reach, later, goesOn, maybe });
      continue;
    }
    // Out of reach: walk to its stand spot, unless the adapter computes none, or the last
    // walk (or the player) is already there and it is still out of reach.
    if (r.standAt === undefined) continue;
    if (walked || distance(feet, r.standAt) <= GATHER_STAND_TOLERANCE) {
      skip.push(r.position);
      continue;
    }
    candidates.push({
      position: r.position,
      walkTo: r.standAt,
      cost: opts.reach + distance(feet, r.standAt),
      later,
      goesOn: false,
      maybe,
    });
  }
  // Ores known to be the one wanted before those not known; felling: a trunk from its base
  // (no log or leaves under it) up, its next log first.
  candidates.sort(
    (a, b) =>
      Number(a.maybe) - Number(b.maybe) ||
      Number(a.later) - Number(b.later) ||
      Number(b.goesOn) - Number(a.goesOn) ||
      a.cost - b.cost,
  );

  let nearestRefusal: string | null = null;
  for (const c of candidates) {
    const dig: ActionSpec = { type: 'DIG_BLOCK', args: { position: { ...c.position } } };
    if (c.walkTo === null) {
      const why = opts.check(dig, feet);
      if (why === null) {
        return {
          kind: 'act',
          spec: dig,
          target: c.position,
          walk: false,
          entity: null,
          skip,
          skipEntities: [],
        };
      }
      nearestRefusal ??= `${formatPosition(c.position)}: ${why}`;
      continue;
    }
    const walk: ActionSpec = {
      type: 'MOVE_TO',
      args: { target: { ...c.walkTo }, tolerance: GATHER_STAND_TOLERANCE },
    };
    const why = opts.check(dig, c.walkTo) ?? opts.check(walk, feet);
    if (why === null) {
      return {
        kind: 'act',
        spec: walk,
        target: c.position,
        walk: true,
        entity: null,
        skip,
        skipEntities: [],
      };
    }
    nearestRefusal ??= `${formatPosition(c.position)}: ${why}`;
  }
  // None of it in view, or only blocks no walk from here reaches (logs high in the trees,
  // behind water: seen live 2026-10-04, "!get 1 wooden pickaxe" got one log and stopped):
  // head for the nearest place it is remembered at, else on into ground not seen yet, as
  // Baritone's mine process goes on to blocks it can get to. A block refused for another
  // reason (no tool that harvests it, a hazard) ends the step: the next plan sees why.
  let travelRefusal: string | null = null;
  if (nearestRefusal === null) {
    for (const place of opts.remembered ?? []) {
      const target = { x: place.x, y: place.y, z: place.z };
      if (skipped.has(key(target))) continue;
      if (Math.hypot(place.x + 0.5 - feet.x, place.z + 0.5 - feet.z) <= REMEMBERED_NEAR) {
        skip.push(target); // there already, and none of it in view: gone (dug, or fell)
        continue;
      }
      const explore: ActionSpec = {
        type: 'EXPLORE',
        args: {
          toward: { x: place.x + 0.5, z: place.z + 0.5 },
          maxDistance: Math.min(
            MAX_EXPLORE_DISTANCE,
            Math.max(MIN_EXPLORE_DISTANCE, Math.ceil(place.distance) + 8),
          ),
        },
      };
      const why = opts.check(explore, feet);
      if (why === null) {
        return {
          kind: 'act',
          spec: explore,
          target,
          walk: true,
          entity: null,
          travel: true,
          skip,
          skipEntities: [],
        };
      }
      travelRefusal ??= `the one remembered at ${formatPosition(target)}: ${why}`;
    }
    // Nothing remembered either (or only places it stands by, gone): on into ground not seen yet.
    const w = opts.wander;
    if (w != null && travelRefusal === null) {
      const explore: ActionSpec = {
        type: 'EXPLORE',
        args: {
          toward: { x: w.x + 0.5, z: w.z + 0.5 },
          maxDistance: Math.min(
            MAX_EXPLORE_DISTANCE,
            Math.max(MIN_EXPLORE_DISTANCE, Math.ceil(w.distance) + 8),
          ),
        },
      };
      const why = opts.check(explore, feet);
      if (why === null) {
        return {
          kind: 'act',
          spec: explore,
          target: { x: w.x, y: Math.floor(feet.y), z: w.z },
          walk: true,
          entity: null,
          travel: true,
          skip,
          skipEntities: [],
        };
      }
      travelRefusal = `exploring on toward (${w.x}, ${w.z}): ${why}`;
    }
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
          : `no ${block} left in view to dig` +
            (travelRefusal === null ? '' : ` (${travelRefusal})`),
    skip,
    skipEntities: [],
  };
}

/**
 * A GATHER of a farm animal's drops: the nearest listed animal of that kind that may be
 * attacked (grown, unowned: attackRefusal) and that the step has not skipped.
 *  - Within strike reach (a bare hand 2.2 blocks, a weapon 2.9: ATTACK_ENTITY strikes
 *    without moving, and a passive animal never comes to the player), less a margin:
 *    ATTACK_ENTITY it. The live client picks up what a kill drops.
 *  - Otherwise MOVE_TO where it stands (HUNT_TOLERANCE); after HUNT_WALKS_PER_TARGET walks in
 *    a row to it, it keeps getting away and is passed over.
 *  - `check` dry-runs the attack (from where the walk would end, for a walk) and the walk: an
 *    animal the policy would not let it attack now (food or health below the fighting
 *    thresholds, hostiles near) is passed over, and the step ends saying why.
 */
export function chooseHuntAction(
  animal: GatherAnimal,
  progress: GatherProgress,
  state: GameState,
  opts: GatherOptions,
): GatherChoice {
  const end = (why: string, skipEntities: number[] = []): GatherChoice => ({
    kind: 'end',
    end: 'no-target',
    why,
    skip: [],
    skipEntities,
  });
  const feet = state.player.position.known ? state.player.position.value : null;
  if (feet === null || !state.nearbyEntities.known) {
    return end('the player position or the nearby creatures are not observed');
  }
  const weapon = state.player.weapon.known ? state.player.weapon.value : BARE_HAND;
  const reach = (weapon.item === null ? HAND_STRIKE_REACH : BLIND_STRIKE_REACH) - REACH_MARGIN;
  const skipped = new Set(progress.skippedEntities);
  const skipEntities: number[] = [];
  const candidates = state.nearbyEntities.value.entities
    .filter(
      (e) =>
        e.type === animal &&
        e.kind === 'mob' &&
        !skipped.has(e.id) &&
        attackRefusal({
          type: e.type,
          category: e.category,
          kind: e.kind,
          owned: e.owned,
          baby: e.baby,
        }) === null &&
        calmRefusal(e) === null,
    )
    .sort((a, b) => a.distance - b.distance || a.id - b.id);
  let nearestRefusal: string | null = null;
  for (const e of candidates) {
    const at = blockOf(e.position);
    const attack: ActionSpec = { type: 'ATTACK_ENTITY', args: { entityId: e.id } };
    if (e.distance <= reach) {
      const why = opts.check(attack, feet);
      if (why === null) {
        return {
          kind: 'act',
          spec: attack,
          target: at,
          walk: false,
          entity: e.id,
          skip: [],
          skipEntities,
        };
      }
      nearestRefusal ??= `${animal} ${e.id}: ${why}`;
      continue;
    }
    const last = progress.last;
    if (last?.entity === e.id && last.walk && last.walks >= HUNT_WALKS_PER_TARGET) {
      skipEntities.push(e.id);
      continue;
    }
    const walk: ActionSpec = {
      type: 'MOVE_TO',
      args: { target: { ...e.position }, tolerance: HUNT_TOLERANCE },
    };
    const why = opts.check(attack, e.position) ?? opts.check(walk, feet);
    if (why === null) {
      return {
        kind: 'act',
        spec: walk,
        target: at,
        walk: true,
        entity: e.id,
        skip: [],
        skipEntities,
      };
    }
    nearestRefusal ??= `${animal} ${e.id}: ${why}`;
  }
  return end(
    nearestRefusal !== null
      ? `none of the ${candidates.length} ${animal} in view can be hunted now (nearest ${nearestRefusal})`
      : skipEntities.length > 0
        ? `the ${animal} in view keep getting away (${skipEntities.length} passed over)`
        : `no ${animal} in view that may be hunted (grown and nobody's)`,
    skipEntities,
  );
}

const blockOf = (p: Position): BlockPosition => ({
  x: Math.floor(p.x),
  y: Math.floor(p.y + 1e-6),
  z: Math.floor(p.z),
});

const key = (p: BlockPosition): string => `${p.x},${p.y},${p.z}`;
const same = (a: BlockPosition, b: BlockPosition): boolean =>
  a.x === b.x && a.y === b.y && a.z === b.z;
