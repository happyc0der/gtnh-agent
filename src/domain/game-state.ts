import { z } from 'zod';
import { ActionIdSchema, ActionSpecSchema, ActionTypeSchema } from './actions.ts';
import { DiggableBlockSchema } from './blocks.ts';
import {
  BlockPositionSchema,
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

/**
 * A block or column to keep away from. `lava` covers lava and other burning liquids/blocks
 * (molten metals, magma); `fire` open flames; `harmful_fluid` poisonous or corrosive fluids;
 * `damaging_block` blocks that hurt on contact (cactus, thorns, spikes); `void` a column
 * with nothing below the player's level.
 */
export const HAZARD_KINDS = ['lava', 'fire', 'harmful_fluid', 'damaging_block', 'void'] as const;
export const HazardSchema = z.strictObject({
  kind: z.enum(HAZARD_KINDS),
  position: PositionSchema,
});
export type Hazard = z.infer<typeof HazardSchema>;

/**
 * Entities near the player (within the adapter's scan radius).
 * `unclassified` counts entities whose type the agent cannot identify (e.g. a modded mob
 * type not in the classification table). The safety policy treats them like hostiles.
 */
export const ThreatsSchema = z.strictObject({
  /** How far (blocks) the adapter looked. The safety policy fails closed if this is too small. */
  scanRadius: z.number().min(0).max(256),
  hostileCount: z.int().min(0).max(1000),
  nearestHostileDistance: z.number().min(0).nullable(),
  unclassifiedCount: z.int().min(0).max(1000),
  nearestUnclassifiedDistance: z.number().min(0).nullable(),
});
export type Threats = z.infer<typeof ThreatsSchema>;

/** Lava/void near the player. Observed separately from entities (it needs chunk data). */
export const EnvironmentHazardsSchema = z.strictObject({
  /** How far (blocks) the adapter looked for lava/void around the player. */
  scanRadius: z.number().min(0).max(256),
  lavaNearby: z.boolean(),
  voidNearby: z.boolean(),
  /** Known hazard positions within the adapter scan radius. */
  hazards: z.array(HazardSchema).max(256),
});
export type EnvironmentHazards = z.infer<typeof EnvironmentHazardsSchema>;

/** Largest `nearbyBlocks.resources` list; beyond it the declared scan radius shrinks. */
export const MAX_REPORTED_RESOURCES = 64;
/** Largest `nearbyBlocks.removed` list. */
export const MAX_REPORTED_REMOVED = 16;

/** A block DIG_BLOCK may break, where the observation saw it. */
export const ResourceBlockSchema = z.strictObject({
  block: DiggableBlockSchema,
  position: BlockPositionSchema,
});
export type ResourceBlock = z.infer<typeof ResourceBlockSchema>;

/**
 * Blocks near the player that matter for digging, from the blocks the server sent. Only
 * allowlisted blocks a player could see (a face touching air) are listed: at or above the
 * player's feet level, plus sand, gravel and clay one level below it (the ground layer a
 * player digs). The blocks the player stands on are never listed.
 */
export const NearbyBlocksSchema = z.strictObject({
  /**
   * How far (blocks, from the player's feet to block centres) the scan looked. `resources`
   * is complete within it: a visible block that qualifies but is not listed there is not a
   * diggable block.
   */
  scanRadius: z.number().min(0).max(64),
  /** Diggable blocks within `scanRadius` (see above), nearest first. */
  resources: z.array(ResourceBlockSchema).max(MAX_REPORTED_RESOURCES),
  /**
   * Positions near the player (within the scan's full radius, even when `scanRadius` shrank)
   * where the observer saw a diggable block turn into air and that are still air, most
   * recent first. BLOCK_REMOVED is verified against this.
   */
  removed: z.array(BlockPositionSchema).max(MAX_REPORTED_REMOVED),
});
export type NearbyBlocks = z.infer<typeof NearbyBlocksSchema>;

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

/** A crafting table the agent may use for 3x3 crafting (the operator configures them). */
export const CraftingTableSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(100),
  position: knownSchema(PositionSchema),
});
export type CraftingTable = z.infer<typeof CraftingTableSchema>;

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
  source: z.enum(['mock', 'mineflayer', 'gtnh1710', 'fixture']),
  player: PlayerSchema,
  inventory: knownSchema(InventorySchema),
  nearbyThreats: knownSchema(ThreatsSchema),
  environmentHazards: knownSchema(EnvironmentHazardsSchema),
  /**
   * Diggable blocks nearby (for DIG_BLOCK). Snapshots stored before this field existed
   * read back as unknown.
   */
  nearbyBlocks: knownSchema(NearbyBlocksSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  power: PowerSchema,
  machines: z.array(MachineSchema).max(512),
  storage: z.array(StorageContainerSchema).max(512),
  /** Crafting tables the agent may use. Defaults to [] for states recorded before crafting. */
  craftingTables: z.array(CraftingTableSchema).max(64).default([]),
  /** Container whose GUI is currently open, if any. */
  openContainerId: EntityIdSchema.nullable(),
  currentTask: CurrentTaskSchema.nullable(),
  knownRecipeState: KnownRecipeStateSchema.nullable(),
  lastAction: LastActionSchema.nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;
