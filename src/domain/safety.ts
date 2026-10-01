import { z } from 'zod';
import { DimensionSchema, ItemNameSchema, PositionSchema, TimestampSchema } from './common.ts';

export const DEFAULT_BOUNDARY = {
  min: { x: -256, y: 0, z: -256 },
  max: { x: 256, y: 255, z: 256 },
  allowedDimensions: ['overworld'],
};

/** Each field defaults independently, so overriding only `min` keeps the default `max`. */
export const BoundarySchema = z
  .strictObject({
    min: PositionSchema.default(DEFAULT_BOUNDARY.min),
    max: PositionSchema.default(DEFAULT_BOUNDARY.max),
    allowedDimensions: z
      .array(DimensionSchema)
      .min(1)
      .max(16)
      .default(DEFAULT_BOUNDARY.allowedDimensions),
  })
  .refine((b) => b.min.x <= b.max.x && b.min.y <= b.max.y && b.min.z <= b.max.z, {
    message: 'boundary.min must be <= boundary.max on every axis',
  });
export type Boundary = z.infer<typeof BoundarySchema>;

/**
 * Hard safety limits. Enforced by ordinary code in src/safety; never delegated to a model.
 * Defaults are deliberately conservative.
 */
export const SafetyConfigSchema = z.strictObject({
  boundary: BoundarySchema.prefault({}),
  /** Stay at least this many blocks away from known lava/void. */
  hazardAvoidanceRadius: z.number().min(1).max(64).default(6),
  /** Hostile mobs within this radius count as a threat. */
  hostileThreatRadius: z.number().min(1).max(64).default(10),
  /** Retreat when health (half-hearts) is below this. */
  minHealth: z.number().min(1).max(1024).default(10),
  /** Eat when food level is below this (and approved food is available). */
  hungerEatThreshold: z.number().min(1).max(20).default(14),
  /** Below this food level with no approved food, retreat or pause. */
  minHunger: z.number().min(0).max(20).default(6),
  /** Items that must never be consumed, deposited, withdrawn or used as fuel. */
  protectedItems: z.array(ItemNameSchema).max(1000).default([]),
  /** Foods the agent may eat. Anything else is never eaten. */
  approvedFoods: z
    .array(ItemNameSchema)
    .max(100)
    .default(['minecraft:bread', 'minecraft:cooked_beef']),
  /** Fuels the agent may put into known generators. */
  approvedFuels: z
    .array(ItemNameSchema)
    .max(100)
    .default(['minecraft:coal', 'minecraft:coal@1', 'minecraft:planks']),
  /** A failing action may be attempted at most this many times per task before escalation. */
  maxFailuresPerActionPerTask: z.int().min(1).max(5).default(2),
  /** Observations older than this are stale; the agent fails closed. */
  maxStateAgeMs: z.int().min(100).max(600_000).default(5_000),
  /** Allowed clock skew for observations timestamped in the future. */
  maxClockSkewMs: z.int().min(0).max(60_000).default(1_000),
  /** Longest single MOVE_TO, in blocks. */
  maxMoveDistance: z.number().min(1).max(1024).default(64),
  /** Longest single RETURN_TO_SAFE_LOCATION, in blocks. */
  maxRetreatDistance: z.number().min(1).max(4096).default(512),
  /** Used/capacity slot fraction at which the inventory counts as nearly full. */
  inventoryNearlyFullFraction: z.number().min(0.5).max(1).default(0.9),
  /** Maximum distance for interacting with a container, machine or generator. */
  interactionReach: z.number().min(1).max(6).default(4.5),
});
export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const VIOLATION_CODES = [
  'UNSUPPORTED_ACTION',
  'FORBIDDEN_MODIFICATION',
  'INVALID_POSTCONDITION',
  'STATE_UNKNOWN',
  'STATE_STALE',
  'STATE_INCONSISTENT',
  'OUT_OF_BOUNDS',
  'DIMENSION_NOT_ALLOWED',
  'HAZARD_PROXIMITY',
  'HOSTILES_NEARBY',
  'UNCLASSIFIED_ENTITY_NEARBY',
  'LOW_HEALTH',
  'LOW_HUNGER',
  'PROTECTED_ITEM',
  'NOT_APPROVED_FOOD',
  'NOT_APPROVED_FUEL',
  'UNKNOWN_TARGET',
  'MOVE_TOO_FAR',
  'ACTION_NOT_ALLOWED_IN_DANGER',
  'REPEATED_FAILURE',
  'PLAN_INVALID',
  /** DIG_BLOCK on a block that is not an observed, allowlisted diggable block. */
  'NOT_DIGGABLE',
  /** DIG_BLOCK on a block whose removal could hurt the player (support, falling blocks). */
  'UNSAFE_DIG',
  /** PLACE_BLOCK into a cell that is not an observed placeable cell. */
  'NOT_PLACEABLE',
  /** PLACE_BLOCK that could hurt the player (its own body, sand or gravel that would fall). */
  'UNSAFE_PLACE',
  /** EXPLORE in the evening or at night (hostile mobs; the agent has no shelter yet). */
  'NOT_DAYTIME',
  /**
   * INTERACT_BLOCK / SMELT / TAKE_OUTPUT on a block the observation does not list as one the
   * action may use (no profile for it, not allowlisted, not observed, or the wrong kind).
   */
  'NOT_INTERACTABLE',
] as const;
export const ViolationCodeSchema = z.enum(VIOLATION_CODES);
export type ViolationCode = z.infer<typeof ViolationCodeSchema>;

export const ViolationDetailsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const SafetyViolationSchema = z.strictObject({
  code: ViolationCodeSchema,
  /** `block`: the action is refused. `pause`: refused and the user must be asked. */
  severity: z.enum(['block', 'pause']),
  message: z.string().min(1).max(500),
  details: ViolationDetailsSchema,
});
export type SafetyViolation = z.infer<typeof SafetyViolationSchema>;

export const NamedLocationSchema = z.strictObject({
  dimension: DimensionSchema,
  position: PositionSchema,
  kind: z.enum(['safe', 'storage', 'work', 'other']),
  note: z.string().max(200).nullable().default(null),
});
export type NamedLocation = z.infer<typeof NamedLocationSchema>;

export const StoredSafetyViolationSchema = z.strictObject({
  ...SafetyViolationSchema.shape,
  id: z.int().positive(),
  cycleId: z.string().nullable(),
  actionId: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type StoredSafetyViolation = z.infer<typeof StoredSafetyViolationSchema>;
