import { z } from 'zod';
import { ActionSpecSchema, ActionTypeSchema } from '../domain/actions.ts';
import { DiggableBlockSchema } from '../domain/blocks.ts';
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

/** Hard ceiling on plan length. Config may lower it (planner.maxPlanSteps), never raise it. */
export const MAX_PLAN_STEPS = 16;

/** Diggable blocks passed to the planner (the nearest ones). */
export const MAX_COMPACT_RESOURCES = 32;
/** Creatures passed to the planner (the nearest ones). */
export const MAX_COMPACT_ENTITIES = 16;

export const PlanStepSchema = z.strictObject({
  /** 1-based, sequential. */
  step: z.int().min(1).max(MAX_PLAN_STEPS),
  /** Must be one of the allowlisted action specs; unknown types fail validation. */
  action: ActionSpecSchema,
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
      }),
    )
    .max(32),
  craftingTables: z
    .array(
      z.strictObject({ id: EntityIdSchema, name: z.string(), position: PositionSchema.nullable() }),
    )
    .max(32),
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
   * from feet to feet; `health` is null when not known.
   */
  entities: z
    .array(
      z.strictObject({
        id: EntityNumberSchema,
        type: z.string(),
        category: z.enum(ENTITY_CATEGORIES),
        distance: z.number().min(0),
        health: z.number().nullable(),
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
    /** ...except exactly these types, which the operator allows (DIG_BLOCK). */
    forbiddenExceptions: z.array(ActionTypeSchema),
    /** The only blocks DIG_BLOCK may break. */
    diggableBlocks: z.array(DiggableBlockSchema),
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
