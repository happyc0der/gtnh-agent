import { z } from 'zod';
import { ActionSpecSchema, ActionTypeSchema } from '../domain/actions.ts';
import {
  DimensionSchema,
  EntityIdSchema,
  ItemCountsSchema,
  PositionSchema,
} from '../domain/common.ts';
import {
  MachineStatusSchema,
  CurrentTaskSchema,
  GENERATOR_STATUSES,
} from '../domain/game-state.ts';

/** Hard ceiling on plan length. Config may lower it (planner.maxPlanSteps), never raise it. */
export const MAX_PLAN_STEPS = 16;

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
  machines: z
    .array(
      z.strictObject({
        id: EntityIdSchema,
        name: z.string(),
        status: MachineStatusSchema,
        position: PositionSchema.nullable(),
      }),
    )
    .max(32),
  storage: z
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
        acceptedFuels: z.array(z.string()),
      }),
    )
    .max(32),
  knownRecipe: z
    .strictObject({ target: z.string(), missingComponents: ItemCountsSchema })
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
    forbidden: z.array(z.string()),
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
