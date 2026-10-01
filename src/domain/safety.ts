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
 * When the agent may fight at all (ATTACK_ENTITY, and System 1's DEFEND). The client's own
 * switch is minecraft.combat.enabled (MC_ENABLE_COMBAT); these limits apply on top of it.
 */
export const CombatSafetySchema = z.strictObject({
  /**
   * No fight is started below this health (half-hearts); System 1 retreats instead. GTNH
   * runs on Hard, and a kill may explode (src/domain/combat.ts), so this is high.
   */
  minHealthToFight: z.number().min(1).max(1024).default(14),
  /** No fight below this food level: HungerOverhaul stops natural healing under 8 here. */
  minHungerToFight: z.number().min(0).max(20).default(8),
  /** More hostiles than this within the threat radius: overwhelmed, flee instead. */
  maxHostilesToFight: z.int().min(1).max(8).default(2),
  /**
   * A creeper (or a hostile that might be one) this close forbids every fight. Special Mobs'
   * Death and Gravity creepers explode with power 5, which hurts up to 10 blocks away.
   */
  creeperFleeRadius: z.number().min(1).max(64).default(16),
});
export type CombatSafety = z.infer<typeof CombatSafetySchema>;

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
  /**
   * Below minHealth with nothing else wrong, the agent rests (waits) to heal only at or above
   * this food level: HungerOverhaul stops natural healing under 8 here.
   */
  minHungerToHeal: z.number().min(0).max(20).default(8),
  /** One rest (REST's WAIT), in ms. */
  restMs: z.int().min(1_000).max(60_000).default(30_000),
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
    .default([
      'minecraft:bread',
      'minecraft:cooked_beef',
      // Vanilla foods with no harmful effect, best first: what a first day turns up (an apple
      // from a leaf, a carrot). Not raw chicken or rotten flesh (hunger), spider eyes or
      // pufferfish (poison), nor golden apples (worth keeping).
      'minecraft:cooked_porkchop',
      'minecraft:cooked_chicken',
      'minecraft:cooked_fished',
      'minecraft:baked_potato',
      'minecraft:pumpkin_pie',
      'minecraft:mushroom_stew',
      'minecraft:apple',
      'minecraft:carrot',
      'minecraft:melon',
      'minecraft:cookie',
    ]),
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
  /** Limits for fighting (ATTACK_ENTITY, DEFEND). */
  combat: CombatSafetySchema.prefault({}),
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
  /** ATTACK_ENTITY on something never attacked (a player, villager, owned animal, creeper...). */
  'NOT_ATTACKABLE',
  /** ATTACK_ENTITY when fighting is unsafe now (low health, too many hostiles, a creeper...). */
  'UNSAFE_ATTACK',
  /** ATTACK_ENTITY on an entity the observation no longer lists (it died, left or despawned). */
  'TARGET_GONE',
  /** SUBMIT_QUEST / CHECK_QUEST_BOX on a quest the server does not list as active and unlocked. */
  'QUEST_NOT_ACTIVE',
  /**
   * DIG_DOWN outside the night pit: not code's own next step of the night-shelter task's
   * blueprint, or not in the evening, at night or just before it.
   */
  'NIGHT_PIT_ONLY',
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
