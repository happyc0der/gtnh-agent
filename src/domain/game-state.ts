import { z } from 'zod';
import { ActionIdSchema, ActionSpecSchema, ActionTypeSchema } from './actions.ts';
import {
  DimensionSchema,
  EntityIdSchema,
  ItemCountsSchema,
  ItemNameSchema,
  PositionSchema,
  TimestampSchema,
} from './common.ts';
import { knownSchema } from './known.ts';
import { TaskStatusSchema } from './tasks.ts';

export const GAME_STATE_SCHEMA_VERSION = 1;

const ArmorSchema = z.strictObject({
  equippedPieces: z.int().min(0).max(4),
  /** Lowest remaining durability across equipped pieces, 0..1; null if no pieces. */
  lowestDurabilityFraction: z.number().min(0).max(1).nullable(),
});

const HeldToolSchema = z
  .strictObject({
    item: ItemNameSchema,
    /** 0..1, or null if the item has no durability. */
    durabilityFraction: z.number().min(0).max(1).nullable(),
  })
  .nullable(); // null = empty hand

export const PlayerSchema = z.strictObject({
  position: knownSchema(PositionSchema),
  dimension: knownSchema(DimensionSchema),
  /** Half-hearts. Vanilla max is 20; mods can raise it, so the bound is loose. */
  health: knownSchema(z.number().min(0).max(1024)),
  /** Food level 0..20. */
  hunger: knownSchema(z.number().min(0).max(20)),
  armor: knownSchema(ArmorSchema),
  heldTool: knownSchema(HeldToolSchema),
});

export const InventorySchema = z.strictObject({
  items: ItemCountsSchema,
  usedSlots: z.int().min(0).max(256),
  capacitySlots: z.int().min(1).max(256),
});
export type Inventory = z.infer<typeof InventorySchema>;

export const HazardSchema = z.strictObject({
  kind: z.enum(['lava', 'void']),
  position: PositionSchema,
});
export type Hazard = z.infer<typeof HazardSchema>;

export const ThreatsSchema = z.strictObject({
  hostileCount: z.int().min(0).max(1000),
  nearestHostileDistance: z.number().min(0).nullable(),
  lavaNearby: z.boolean(),
  voidNearby: z.boolean(),
  /** Known hazard positions within the adapter scan radius. */
  hazards: z.array(HazardSchema).max(256),
});
export type Threats = z.infer<typeof ThreatsSchema>;

export const GENERATOR_STATUSES = ['running', 'idle', 'out_of_fuel', 'unknown', 'error'] as const;
export const GeneratorSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(100),
  position: knownSchema(PositionSchema),
  status: z.enum(GENERATOR_STATUSES),
  /** Fuel currently inside the generator, if observable. */
  fuel: knownSchema(ItemCountsSchema),
  /** Fuels this specific generator is known to accept (from the world model, not guessed). */
  acceptedFuels: z.array(ItemNameSchema).max(32),
});
export type Generator = z.infer<typeof GeneratorSchema>;

export const PowerSchema = z.strictObject({
  /** Net EU/t available. GTNH energy is usually NOT observable through the vanilla protocol. */
  availableEUt: knownSchema(z.number().min(0)),
  generators: z.array(GeneratorSchema).max(128),
});

export const MACHINE_STATUSES = ['idle', 'busy', 'unpowered', 'unknown', 'error'] as const;
export const MachineStatusSchema = z.enum(MACHINE_STATUSES);
export type MachineStatus = z.infer<typeof MachineStatusSchema>;

export const MachineSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(100),
  position: knownSchema(PositionSchema),
  status: MachineStatusSchema,
  powered: knownSchema(z.boolean()),
  lastInspectedAt: TimestampSchema.nullable(),
});
export type Machine = z.infer<typeof MachineSchema>;

export const StorageContainerSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(100),
  position: knownSchema(PositionSchema),
  items: knownSchema(ItemCountsSchema),
});
export type StorageContainer = z.infer<typeof StorageContainerSchema>;

export const CurrentTaskSchema = z.strictObject({
  taskId: EntityIdSchema,
  goal: z.string().min(1).max(300),
  subgoal: z.string().min(1).max(300).nullable(),
  status: TaskStatusSchema,
});
export type CurrentTask = z.infer<typeof CurrentTaskSchema>;

export const KnownRecipeStateSchema = z.strictObject({
  target: z.string().min(1).max(200),
  missingComponents: ItemCountsSchema,
  /** Machines this step depends on. If any is busy, System 1 waits. */
  requiredMachineIds: z.array(EntityIdSchema).max(16),
  /** A pre-validated next step, or null when the agent does not know one. */
  nextKnownSafeStep: ActionSpecSchema.nullable(),
});
export type KnownRecipeState = z.infer<typeof KnownRecipeStateSchema>;

export const LastActionSchema = z.strictObject({
  actionId: ActionIdSchema,
  actionType: ActionTypeSchema,
  result: z.enum(['succeeded', 'failed', 'rejected', 'verification_failed']),
  timestamp: TimestampSchema,
});

export const GameStateSchema = z.strictObject({
  schemaVersion: z.literal(GAME_STATE_SCHEMA_VERSION),
  /** When this state was observed. Used for staleness checks. */
  timestamp: TimestampSchema,
  source: z.enum(['mock', 'mineflayer', 'fixture']),
  player: PlayerSchema,
  inventory: knownSchema(InventorySchema),
  nearbyThreats: knownSchema(ThreatsSchema),
  power: PowerSchema,
  machines: z.array(MachineSchema).max(512),
  storage: z.array(StorageContainerSchema).max(512),
  /** Container whose GUI is currently open, if any. */
  openContainerId: EntityIdSchema.nullable(),
  currentTask: CurrentTaskSchema.nullable(),
  knownRecipeState: KnownRecipeStateSchema.nullable(),
  lastAction: LastActionSchema.nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;
