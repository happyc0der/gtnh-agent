import { z } from 'zod';
import { ActionSpecSchema, ActionTypeSchema } from '../domain/actions.ts';
import { DiggableBlockSchema, PlaceableItemSchema } from '../domain/blocks.ts';
import { ProfileIdSchema } from '../domain/interactions.ts';
import { ENTITY_CATEGORIES, WeaponSchema } from '../domain/combat.ts';
import {
  BlockPositionSchema,
  DimensionSchema,
  EntityIdSchema,
  EntityNumberSchema,
  ItemCountsSchema,
  PositionSchema,
} from '../domain/common.ts';
import {
  MachineStatusSchema,
  CurrentTaskSchema,
  DAY_PHASES,
  GENERATOR_STATUSES,
} from '../domain/game-state.ts';
import { ExplorationSummarySchema } from '../domain/world-memory.ts';
import { GatherStepSchema } from './gather.ts';

/** Longest journal line a planner request may carry (a longer one fails the request). */
export const MAX_JOURNAL_LINE = 300;

/** Hard ceiling on plan length. Config may lower it (planner.maxPlanSteps), never raise it. */
export const MAX_PLAN_STEPS = 16;

/** Diggable blocks passed to the planner (the nearest of each kind: nearestOfEachKind). */
export const MAX_COMPACT_RESOURCES = 32;
/** Creatures passed to the planner (the nearest ones). */
export const MAX_COMPACT_ENTITIES = 16;

/** Tools passed to the planner (the best ones). */
export const MAX_COMPACT_TOOLS = 8;
/** Placeable cells passed to the planner (the nearest ones). */
export const MAX_COMPACT_PLACEABLE = 16;
/** Interactable blocks passed to the planner (the nearest ones). */
export const MAX_COMPACT_INTERACTABLES = 16;

/**
 * What a plan step does: one of the allowlisted action specs, or a GATHER step, which code
 * expands into DIG_BLOCK and MOVE_TO actions one cycle at a time (src/planner/gather.ts).
 * GATHER exists only in plans: it is not an action type and never reaches a client.
 */
export const PlanActionSchema = z.discriminatedUnion('type', [
  ...ActionSpecSchema.options,
  GatherStepSchema,
]);
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const PlanStepSchema = z.strictObject({
  /** 1-based, sequential. */
  step: z.int().min(1).max(MAX_PLAN_STEPS),
  /** An allowlisted action spec or a GATHER step; unknown types fail validation. */
  action: PlanActionSchema,
  rationale: z.string().min(1).max(300),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const FailureHandlingSchema = z.strictObject({
  onStepFailure: z.enum(['PAUSE_AND_ASK_USER', 'REPLAN', 'RETREAT_HOME']),
  /** Never more than the safety policy's repeated-failure limit allows. */
  maxRetriesPerStep: z.int().min(0).max(2),
  escalationMessage: z.string().min(1).max(300),
});

export const PlanSchema = z
  .strictObject({
    goal: z.string().min(1).max(300),
    steps: z.array(PlanStepSchema).min(1).max(MAX_PLAN_STEPS),
    requiresUserApproval: z.boolean(),
    explanation: z.string().min(1).max(1000),
    failureHandling: FailureHandlingSchema,
  })
  .superRefine((plan, ctx) => {
    plan.steps.forEach((s, i) => {
      if (s.step !== i + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', i, 'step'],
          message: `expected step ${i + 1}`,
        });
      }
    });
  });
export type Plan = z.infer<typeof PlanSchema>;

export const EscalationSchema = z.strictObject({
  reason: z.enum([
    'UNKNOWN_RECIPE',
    'INSUFFICIENT_STATE',
    'UNSAFE',
    'OUT_OF_SCOPE',
    'INVALID_OUTPUT',
    'OTHER',
  ]),
  message: z.string().min(1).max(500),
  questionForUser: z.string().min(1).max(500),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const PlannerResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), plan: PlanSchema }),
  z.strictObject({ kind: z.literal('escalation'), escalation: EscalationSchema }),
]);
export type PlannerResponse = z.infer<typeof PlannerResponseSchema>;

// ---------------------------------------------------------------------------
// Planner input: a compact, sanitized view. No raw logs, no free-form history.
// ---------------------------------------------------------------------------

export const CompactStateSchema = z.strictObject({
  observedAt: z.string(),
  position: PositionSchema.nullable(),
  dimension: DimensionSchema.nullable(),
  health: z.number().nullable(),
  hunger: z.number().nullable(),
  inventoryTop: z.array(z.strictObject({ item: z.string(), quantity: z.int() })).max(20),
  inventoryFill: z.number().nullable(),
  threats: z.strictObject({ hostileCount: z.int(), unclassifiedCount: z.int() }).nullable(),
  hazards: z.strictObject({ lavaNearby: z.boolean(), voidNearby: z.boolean() }).nullable(),
  /**
   * Blocks DIG_BLOCK may target (allowlisted, observed), nearest first, with `reach` (blocks
   * from the eyes to the block centre; DIG_BLOCK needs at most 4.5) and `standAt` (where to
   * stand to dig it, or null).
   */
  diggableBlocks: z
    .array(
      z.strictObject({
        block: DiggableBlockSchema,
        position: BlockPositionSchema,
        reach: z.number().min(0).nullable(),
        standAt: PositionSchema.nullable(),
      }),
    )
    .max(MAX_COMPACT_RESOURCES),
  /**
   * Tools the player carries that DIG_BLOCK may hold (src/domain/tools.ts; never a protected
   * one), best first: how many, how many digs each has left before the agent stops using it
   * (0 = worn out), and the blocks it digs faster than a hand. DIG_BLOCK picks one by itself.
   * Built from inventory names, which do not show NBT data: an enchanted or renamed tool is
   * listed too, though the client never holds one.
   */
  tools: z
    .array(
      z.strictObject({
        item: z.string(),
        count: z.int().min(1),
        durabilityLeft: z.int().min(0),
        digsFaster: z.array(DiggableBlockSchema),
      }),
    )
    .max(MAX_COMPACT_TOOLS),
  /**
   * Empty cells PLACE_BLOCK may fill (observed), nearest first, with `reach` (blocks from the
   * eyes to the cell's centre) and `takesFalling` (sand and gravel may go there).
   */
  placeableCells: z
    .array(
      z.strictObject({
        position: BlockPositionSchema,
        reach: z.number().min(0).nullable(),
        takesFalling: z.boolean(),
      }),
    )
    .max(MAX_COMPACT_PLACEABLE),
  machines: z
    .array(
      z.strictObject({
        id: EntityIdSchema,
        name: z.string(),
        status: MachineStatusSchema,
        position: PositionSchema.nullable(),
        /** Blocks from the player (null if either position is unknown). */
        distance: z.number().min(0).nullable(),
      }),
    )
    .max(32),
  storage: z
    .array(
      z.strictObject({
        id: EntityIdSchema,
        name: z.string(),
        position: PositionSchema.nullable(),
        distance: z.number().min(0).nullable(),
        /** What it holds (seen or remembered), largest stacks first; null if unknown. */
        items: z
          .array(z.strictObject({ item: z.string(), quantity: z.int() }))
          .max(20)
          .nullable(),
      }),
    )
    .max(32),
  craftingTables: z
    .array(
      z.strictObject({ id: EntityIdSchema, name: z.string(), position: PositionSchema.nullable() }),
    )
    .max(32),
  /**
   * Blocks INTERACT_BLOCK / SMELT / TAKE_OUTPUT may target, nearest first: the profile
   * (`furnace`, `crafting_table`, `chest`, ...; null = only to look at), `reach` from the
   * eyes (at most 4.5 to use it), `standAt` (where to stand, or null) and, for furnaces,
   * what is inside as last seen and how long until everything in it is smelted.
   */
  interactables: z
    .array(
      z.strictObject({
        profile: ProfileIdSchema.nullable(),
        block: z.string(),
        position: BlockPositionSchema,
        reach: z.number().min(0).nullable(),
        standAt: PositionSchema.nullable(),
        furnace: z
          .strictObject({
            burning: z.boolean(),
            /** "8 minecraft:cobblestone", or null when empty or never seen. */
            input: z.string().nullable(),
            fuel: z.string().nullable(),
            output: z.string().nullable(),
            /** Seconds from now until the input is all smelted (null: unknown or out of fuel). */
            secondsLeft: z.number().min(0).nullable(),
            /** How old the contents above are (null: never seen; open INTERACT_BLOCK first). */
            seenSecondsAgo: z.number().min(0).nullable(),
          })
          .nullable(),
      }),
    )
    .max(MAX_COMPACT_INTERACTABLES),
  generators: z
    .array(
      z.strictObject({
        id: EntityIdSchema,
        name: z.string(),
        status: z.enum(GENERATOR_STATUSES),
        position: PositionSchema.nullable(),
        distance: z.number().min(0).nullable(),
        acceptedFuels: z.array(z.string()),
      }),
    )
    .max(32),
  knownRecipe: z
    .strictObject({ target: z.string(), missingComponents: ItemCountsSchema })
    .nullable(),
  /**
   * Creatures near the player, nearest first (players and objects are left out).
   * ATTACK_ENTITY may target only one with `attackable` true (a melee or ranged hostile, or an
   * unowned, grown farm animal), and only when `fightProblems` is empty. `distance` is blocks
   * from feet to feet; `health` is null when not known. `calm`: a spider in the light that
   * leaves the player alone (no threat, and never attacked: that would provoke it).
   */
  entities: z
    .array(
      z.strictObject({
        id: EntityNumberSchema,
        type: z.string(),
        category: z.enum(ENTITY_CATEGORIES),
        distance: z.number().min(0),
        health: z.number().nullable(),
        calm: z.boolean(),
        attackable: z.boolean(),
      }),
    )
    .max(MAX_COMPACT_ENTITIES),
  /** What ATTACK_ENTITY would strike with (item null: a bare hand); null when unknown. */
  weapon: WeaponSchema.nullable(),
  /** Why fighting is unsafe right now (e.g. CREEPER_NEARBY, LOW_HEALTH); empty when it is not. */
  fightProblems: z.array(z.string()).max(8),
  /** The world's clock (null when unknown): phase day / evening / night / dawn. */
  time: z
    .strictObject({
      phase: z.enum(DAY_PHASES),
      timeOfDay: z.int(),
      minutesUntilNight: z.number(),
      minutesUntilDay: z.number(),
    })
    .nullable(),
  /** Fields the adapter could not observe; the planner must not assume values for them. */
  unknownFields: z.array(z.string()),
});
export type CompactState = z.infer<typeof CompactStateSchema>;

export const PlannerRequestSchema = z.strictObject({
  state: CompactStateSchema,
  task: CurrentTaskSchema.nullable(),
  allowedActions: z.array(ActionTypeSchema).min(1),
  safetyConstraints: z.strictObject({
    boundaryMin: PositionSchema,
    boundaryMax: PositionSchema,
    allowedDimensions: z.array(z.string()),
    protectedItems: z.array(z.string()),
    approvedFoods: z.array(z.string()),
    approvedFuels: z.array(z.string()),
    maxMoveDistance: z.number(),
    safeLocations: z.array(z.string()),
    /** Action types containing any of these keywords are refused... */
    forbidden: z.array(z.string()),
    /** ...except exactly these types, which the operator allows (DIG_BLOCK, PLACE_BLOCK). */
    forbiddenExceptions: z.array(ActionTypeSchema),
    /** The only blocks DIG_BLOCK may break. */
    diggableBlocks: z.array(DiggableBlockSchema),
    /** The only items PLACE_BLOCK may place. */
    placeableItems: z.array(PlaceableItemSchema),
  }),
  recentActions: z
    .array(z.strictObject({ actionType: ActionTypeSchema, status: z.string(), reason: z.string() }))
    .max(50),
  recentFailures: z
    .array(
      z.strictObject({ actionType: ActionTypeSchema, fingerprint: z.string(), failures: z.int() }),
    )
    .max(50),
  maxPlanSteps: z.int().min(1).max(MAX_PLAN_STEPS),
  /**
   * The exact route to the task's required items, calculated in code from the agent's
   * recipes, gathering sources and the places it has seen (null when the task names no
   * items): have vs need, raw materials, the steps in order, where to find each material.
   */
  route: z
    .strictObject({
      stock: z
        .array(
          z.strictObject({
            item: z.string(),
            have: z.int().min(0),
            stored: z.int().min(0),
            need: z.int().min(0),
            missing: z.int().min(0),
          }),
        )
        .max(32),
      steps: z.array(z.string().max(500)).max(40),
    })
    .nullable()
    .default(null),
  /**
   * Where GTNH 2.8.4 differs from vanilla Minecraft 1.7.10 for what the route makes, uses,
   * digs or needs (and what the player holds), one plain line each, most relevant first:
   * from the knowledge base's changes table (docs/gtnh-vs-vanilla.md).
   */
  gtnhChanges: z.array(z.string().max(300)).max(12).default([]),
  /**
   * The task's journal, compacted (oldest first): plans made, done or failed and why,
   * quests completed, interruptions. What the agent already did and must not repeat.
   */
  journal: z.array(z.string().max(MAX_JOURNAL_LINE)).max(32).default([]),
  /**
   * Present only when the agent can explore (EXPLORE is then in allowedActions): what world
   * memory knows (places per resource, biomes) and how far each direction has been seen.
   */
  exploration: ExplorationSummarySchema.optional(),
});
export type PlannerRequest = z.infer<typeof PlannerRequestSchema>;

/**
 * JSON Schema for the planner's output, for a future local-LLM adapter's
 * structured-output / grammar-constrained decoding. Refinements (sequential step
 * numbers) are not expressible in JSON Schema and are still enforced by Zod.
 */
export function plannerResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PlannerResponseSchema, { unrepresentable: 'any' });
}
