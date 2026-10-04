import { z } from 'zod';
import { ActionIdSchema, ActionSpecSchema, ActionTypeSchema } from './actions.ts';
import { DiggableBlockSchema, PlaceableBlockSchema } from './blocks.ts';
import { ENTITY_CATEGORIES, WeaponSchema } from './combat.ts';
import {
  BlockPositionSchema,
  DimensionSchema,
  EntityIdSchema,
  EntityNumberSchema,
  ItemCountsSchema,
  ItemNameSchema,
  PositionSchema,
  TimestampSchema,
} from './common.ts';
import { ProfileIdSchema, SLOT_ROLES } from './interactions.ts';
import { knownSchema } from './known.ts';
import { QuestBookSchema } from './quest-book.ts';
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
  /**
   * What ATTACK_ENTITY would strike with now: the best allowlisted weapon in the hotbar, or
   * an empty hand (src/domain/combat.ts). Snapshots stored before combat read back as unknown.
   */
  weapon: knownSchema(WeaponSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  /**
   * When the player last lost health on this connection (a hit, an arrow, a fall, hunger), or
   * null. Snapshots stored before it read back as null.
   */
  lastHurtAt: TimestampSchema.nullable().default(null),
  /**
   * Sealed in: the cells beside the player's feet and head, above its head and below its feet
   * are all known full blocks, so no mob can reach it (its night pit, roofed). Null when not
   * known (or not reported). Snapshots stored before it read back as null.
   */
  sealed: z.boolean().nullable().default(null),
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

/** Largest `nearbyThreats.entities` list (the nearest ones). */
export const MAX_REPORTED_ENTITIES = 32;
/** Largest `nearbyThreats.recentDeaths` list. */
export const MAX_REPORTED_DEATHS = 16;

/**
 * A creature, player or dangerous object near the player, with what combat needs. Names
 * come from the agent's classification tables (never from name tags or chat).
 */
export const NearbyEntitySchema = z.strictObject({
  id: EntityNumberSchema,
  /** What it is: minecraft:Zombie, SpecialMobs.FireCreeper, mob#120, ... or `player`. */
  type: z.string().min(1).max(100),
  category: z.enum(ENTITY_CATEGORIES),
  /** `object`: not a creature (primed TNT, fireballs, projectiles). */
  kind: z.enum(['mob', 'player', 'object']),
  position: PositionSchema,
  /** Blocks from the player's feet to its feet: how the server measures attack reach. */
  distance: z.number().min(0),
  /** Health (half-hearts) from the server's entity metadata; null until it was sent. */
  health: z.number().min(0).max(1_000_000).nullable(),
  /** Someone's animal (a name tag or a saddle); null when not known or not applicable. */
  owned: z.boolean().nullable(),
  /** A baby animal; null when not known or not applicable. */
  baby: z.boolean().nullable(),
  /** When this connection last saw it take a hit (the server's hurt status), or null. */
  lastHurtAt: TimestampSchema.nullable(),
  /**
   * A vanilla spider that leaves the player alone now (src/domain/combat.ts,
   * LIGHT_SHY_SPIDERS): the light at it is at least SPIDER_CALM_LIGHT, it is farther than
   * CALM_SPIDER_MIN_DISTANCE, and the player was not hurt in the last HURT_DANGER_MS. It is
   * listed, but not counted in `nearbyThreats`, and never attacked (that would provoke it).
   * False in snapshots stored before it existed (they counted every spider).
   */
  calm: z.boolean().default(false),
});
export type NearbyEntity = z.infer<typeof NearbyEntitySchema>;

/** An entity this connection saw die (the server's death status), most recent first. */
export const RecentDeathSchema = z.strictObject({
  id: EntityNumberSchema,
  type: z.string().min(1).max(100),
  at: TimestampSchema,
});

/**
 * The details behind `nearbyThreats`, for combat and planning: what is near, how far, how
 * healthy. Observed with the threats (same scan), so the two must agree.
 */
export const NearbyEntitiesSchema = z.strictObject({
  /** The same scan radius as `nearbyThreats`. */
  scanRadius: z.number().min(0).max(256),
  /**
   * The nearest entities within `scanRadius` (hostile, passive and unclassified creatures,
   * dangerous objects and players; dropped items and the like are left out), nearest first.
   * With fewer than MAX_REPORTED_ENTITIES listed the list is complete: its hostile entries
   * that are not calm, and its unclassified ones, then match the `nearbyThreats` counts.
   */
  entities: z.array(NearbyEntitySchema).max(MAX_REPORTED_ENTITIES),
  /** Entities seen dying recently (ATTACK_ENTITY's kills are verified against this). */
  recentDeaths: z.array(RecentDeathSchema).max(MAX_REPORTED_DEATHS),
});
export type NearbyEntities = z.infer<typeof NearbyEntitiesSchema>;

/**
 * Entities near the player (within the adapter's scan radius).
 * `hostile` counts hostile creatures and dangerous objects, but not calm spiders
 * (NearbyEntitySchema.calm: a spider in the light leaves the player alone).
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

/** Largest `nearbyBlocks.resources` list, shared fairly between kinds of block. */
export const MAX_REPORTED_RESOURCES = 64;
/** Largest `nearbyBlocks.removed` list. */
export const MAX_REPORTED_REMOVED = 16;
/** Largest `nearbyBlocks.placeable` list (the nearest cells within reach). */
export const MAX_REPORTED_PLACEABLE = 32;
/** Largest `nearbyBlocks.placed` list. */
export const MAX_REPORTED_PLACED = 16;
/** Largest `nearbyBlocks.playerBuilt` list. */
export const MAX_REPORTED_PLAYER_BUILT = 64;

/** A block DIG_BLOCK may break, where the observation saw it. */
export const ResourceBlockSchema = z.strictObject({
  block: DiggableBlockSchema,
  position: BlockPositionSchema,
  /**
   * Where the player can stand to dig it (feet position): beside it, standable, inside the
   * fence, the dig allowed from there; null when there is no such spot. Absent when the
   * adapter does not compute it.
   */
  standAt: PositionSchema.nullable().optional(),
  /**
   * A GregTech ore's material (gregtech:gt.blockores keeps it in a tile entity): its
   * TileEntityOres.mMetaData, the material id plus 1000 x the stone it is in plus 16000 for
   * a small ore, as the server sends it for an ore with an open face (a player sees its
   * texture). Absent when not sent, and for every other block.
   */
  ore: z.int().min(0).max(32767).optional(),
});
export type ResourceBlock = z.infer<typeof ResourceBlockSchema>;

/**
 * An empty cell PLACE_BLOCK may fill, where the observation saw it: air (or tall grass or a
 * dead bush, which a placed block replaces), within reach, clear of the player's body and of
 * every entity, touching a plain full block to place it against, with nothing but air, plain
 * blocks and plants around it and no hazard within one block.
 */
export const PlaceableCellSchema = z.strictObject({
  position: BlockPositionSchema,
  /**
   * Sand and gravel may go here: a plain full block is directly below it (they fall
   * otherwise) and it is not in a column the player's body stands in.
   */
  takesFalling: z.boolean(),
  /**
   * A crafting table or furnace may go here: the client's own check (placing.ts checkStation:
   * on a solid floor beside the player, never in its way: not a 1-wide passage, nor the only
   * way on). Looked at only while the player carries a station, for the nearest cells on a
   * solid floor; absent where not looked at.
   */
  station: z.boolean().optional(),
});
export type PlaceableCell = z.infer<typeof PlaceableCellSchema>;

/** A block the observer saw appear in an empty cell (a placed block), still there. */
export const PlacedBlockSchema = z.strictObject({
  block: PlaceableBlockSchema,
  position: BlockPositionSchema,
});
export type PlacedBlock = z.infer<typeof PlacedBlockSchema>;

/**
 * The ground in the player's own column (for DIG_DOWN, the night pit only): the block the
 * player stands on and the one under it, by registry name. Reported only while the player's
 * body stands in that one column, on top of the block.
 */
export const UnderFeetSchema = z.strictObject({
  /** The block the player stands on: the one DIG_DOWN digs. */
  position: BlockPositionSchema,
  block: z.string().min(1).max(128),
  /** The block under it: where the player lands after DIG_DOWN. */
  landing: z.string().min(1).max(128),
  /**
   * The landing holds the player: a plain full block, and when it is sand or gravel, a
   * plain full block holds it up in turn (else it would fall into a hole under it).
   */
  landingHolds: z.boolean(),
});
export type UnderFeet = z.infer<typeof UnderFeetSchema>;

/**
 * Blocks near the player that matter for digging and placing, from the blocks the server
 * sent. Only allowlisted blocks a player could see (a face touching air) are listed as
 * resources: at or above the player's feet level, plus sand, gravel and clay one level below
 * it (the ground layer a player digs). The blocks the player stands on are never listed.
 */
export const NearbyBlocksSchema = z.strictObject({
  /**
   * How far (blocks, from the player's feet to block centres) the scan looked. Of each kind
   * `resources` lists the nearest within it, not every one (a fair share of the list), so a
   * kind that is not listed has no visible block within it.
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
  /**
   * Cells PLACE_BLOCK may fill (see PlaceableCellSchema), nearest to the eyes first. Only
   * cells within reach are looked at, and only the nearest MAX_REPORTED_PLACEABLE are listed:
   * a cell not listed may not be placed into. Empty in snapshots stored before placing.
   */
  placeable: z.array(PlaceableCellSchema).max(MAX_REPORTED_PLACEABLE).default([]),
  /**
   * Positions near the player where the observer saw an empty cell (air, tall grass or a dead
   * bush) become a placeable block, while it still is, most recent first. BLOCK_PLACED is
   * verified against this.
   */
  placed: z.array(PlacedBlockSchema).max(MAX_REPORTED_PLACED).default([]),
  /**
   * Blocks near the player (within the scan's full radius) that a player built
   * (src/domain/player-builds.ts): never dug, and never listed among `resources`; nearest
   * first. Empty in snapshots stored before they were kept.
   */
  playerBuilt: z.array(BlockPositionSchema).max(MAX_REPORTED_PLAYER_BUILT).default([]),
  /**
   * The ground under the player (DIG_DOWN), or null when the player's body is not in one
   * column on a block top, or a block is not loaded or named. Absent when the adapter does
   * not report it (digging disabled), and in snapshots stored before it existed.
   */
  underFeet: UnderFeetSchema.nullable().optional(),
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

/**
 * A crafting table the agent may use for 3x3 crafting: one the operator configured, or a
 * vanilla crafting table the observation found nearby (id `crafting_table:<x>.<y>.<z>`).
 */
export const CraftingTableSchema = z.strictObject({
  id: EntityIdSchema,
  name: z.string().min(1).max(100),
  position: knownSchema(PositionSchema),
});
export type CraftingTable = z.infer<typeof CraftingTableSchema>;

/** Largest `interactables.blocks` list; beyond it the declared scan radius shrinks. */
export const MAX_REPORTED_INTERACTABLES = 32;

/** An item stack in a block's window: what it is and how many. */
export const SlotStackSchema = z.strictObject({
  item: ItemNameSchema,
  count: z.int().min(1).max(1_000_000),
});
export type SlotStack = z.infer<typeof SlotStackSchema>;

/**
 * What the agent knows about a furnace. `burning` comes from the block itself
 * (minecraft:lit_furnace), so it is always current; the contents and progress only from
 * the last time the agent had its window open (`seen`, with its time).
 */
export const FurnaceStateSchema = z.strictObject({
  burning: z.boolean(),
  seen: z
    .strictObject({
      observedAt: TimestampSchema,
      input: SlotStackSchema.nullable(),
      fuel: SlotStackSchema.nullable(),
      output: SlotStackSchema.nullable(),
      /** Ticks the current item has cooked (it is done at 200), or null if not sent. */
      cookTicks: z.int().min(-32768).max(32767).nullable(),
      /** Ticks the burning fuel item still burns, or null if not sent. */
      burnTicksLeft: z.int().min(-32768).max(32767).nullable(),
      /** Total burn ticks of the fuel item burning now, or null if not sent. */
      fuelItemTicks: z.int().min(-32768).max(32767).nullable(),
    })
    .nullable(),
});
export type FurnaceState = z.infer<typeof FurnaceStateSchema>;

/**
 * A block near the player the agent may right-click (src/domain/interactions.ts): one with
 * an interaction profile, or one the operator allowlisted to look at (`profile` null).
 */
export const InteractableBlockSchema = z.strictObject({
  profile: ProfileIdSchema.nullable(),
  /** The block's registry name. */
  block: ItemNameSchema,
  position: BlockPositionSchema,
  /**
   * Where the player can stand to use it (feet position, inside the fence, within reach);
   * null when there is no such spot. Absent when the adapter does not compute it.
   */
  standAt: PositionSchema.nullable().optional(),
  /** Furnaces only. */
  furnace: FurnaceStateSchema.optional(),
});
export type InteractableBlock = z.infer<typeof InteractableBlockSchema>;

export const NearbyInteractablesSchema = z.strictObject({
  /** How far (blocks, feet to block centres) the scan looked; `blocks` is complete within it. */
  scanRadius: z.number().min(0).max(64),
  /** Nearest first. Only blocks with a face open to air are listed. */
  blocks: z.array(InteractableBlockSchema).max(MAX_REPORTED_INTERACTABLES),
});
export type NearbyInteractables = z.infer<typeof NearbyInteractablesSchema>;

/** One non-empty slot of a block's window. */
export const WindowSlotSchema = z.strictObject({
  slot: z.int().min(0).max(511),
  /** Registry name, or `unknown:<id>@<damage>` for an id the registry does not name. */
  item: z.string().min(1).max(128),
  count: z.int().min(-128).max(1_000_000),
  /** The slot's role from the profile (input, fuel, output, grid, ...), or null. */
  role: z.enum(SLOT_ROLES).nullable(),
  /** The stack carries NBT data (never moved by the agent). */
  nbt: z.boolean(),
});

/**
 * The window of the block the agent opened last (INTERACT_BLOCK, SMELT, TAKE_OUTPUT), as
 * the server sent it. Observe-only windows are closed right after they are seen.
 */
export const BlockWindowSchema = z.strictObject({
  position: BlockPositionSchema,
  block: ItemNameSchema,
  profile: ProfileIdSchema.nullable(),
  /** How the server opened it: `vanilla:<S2D type>` or `fml:<modId>:<guiId>`. */
  opener: z.string().min(1).max(100),
  title: z.string().max(200).nullable(),
  /** Every slot the window has, the player's 36 included. */
  slotCount: z.int().min(0).max(512),
  /** The window's own slots before the player's 36, when its layout is known. */
  containerSlots: z.int().min(0).max(512).nullable(),
  /**
   * Where the player's 36 slots start: the layout's, or, for a window without a known
   * layout, where 36 slots exactly matched the (non-empty) inventory; null if neither.
   */
  inventoryAt: z.int().min(0).max(512).nullable(),
  /** Non-empty slots outside the player's inventory part (all slots if that is unknown). */
  slots: z.array(WindowSlotSchema).max(512),
  /** Window properties (S31) as last sent: property id -> value. */
  properties: z.record(z.string().regex(/^\d{1,5}$/), z.int().min(-32768).max(32767)),
  /** Whether the window is still open. */
  open: z.boolean(),
  observedAt: TimestampSchema,
});
export type BlockWindow = z.infer<typeof BlockWindowSchema>;

export const CurrentTaskSchema = z.strictObject({
  taskId: EntityIdSchema,
  goal: z.string().min(1).max(300),
  subgoal: z.string().min(1).max(300).nullable(),
  status: TaskStatusSchema,
  /**
   * The items the goal needs in the inventory (item -> count), when it is a resource goal.
   * The planner gets an exact route for them (src/goals/route.ts).
   */
  requirements: ItemCountsSchema.optional(),
  /**
   * Requirement items of which every kind and wear counts (all their damage values): an
   * owner's "logs" are any wood. Others count exactly.
   */
  anyKind: z.array(ItemNameSchema).max(16).optional(),
  /** A building task's blueprint: the blocks to place, in order (the planner's route). */
  blueprint: z.array(z.string().max(300)).max(32).optional(),
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

/** Minecraft ticks per real second, and per day (20 real minutes). */
export const TICKS_PER_SECOND = 20;
export const TICKS_PER_DAY = 24_000;

export const DAY_PHASES = ['day', 'evening', 'night', 'dawn'] as const;

/**
 * The world's clock as a player sees it (the sun). 0 = sunrise, 6000 noon, 12000 sunset,
 * 18000 midnight. Phases: day 0-11999; evening 12000-12999 (sunset: get to shelter);
 * night 13000-22999 (hostile mobs spawn in the dark); dawn 23000-23999 (mobs burn soon).
 */
export const WorldTimeSchema = z.strictObject({
  timeOfDay: z
    .int()
    .min(0)
    .max(TICKS_PER_DAY - 1),
  phase: z.enum(DAY_PHASES),
  /** Real minutes until night starts (tick 13000); 0 during the night. */
  minutesUntilNight: z.number().min(0),
  /** Real minutes until sunrise (tick 0); 0 during the day. */
  minutesUntilDay: z.number().min(0),
  /** False when the server's daylight cycle is stopped (the time does not advance). */
  daylightCycle: z.boolean(),
});
export type WorldTime = z.infer<typeof WorldTimeSchema>;

/** The clock for `dayTicks` (any number of ticks; only the time of day matters). */
export function worldTime(dayTicks: number, daylightCycle: boolean): WorldTime {
  const t = ((Math.floor(dayTicks) % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const phase = t < 12_000 ? 'day' : t < 13_000 ? 'evening' : t < 23_000 ? 'night' : 'dawn';
  const minutes = (ticks: number): number => Number((ticks / TICKS_PER_SECOND / 60).toFixed(1));
  return {
    timeOfDay: t,
    phase,
    minutesUntilNight:
      phase === 'night' ? 0 : minutes((13_000 - t + TICKS_PER_DAY) % TICKS_PER_DAY),
    minutesUntilDay: phase === 'day' ? 0 : minutes(TICKS_PER_DAY - t),
    daylightCycle,
  };
}

export const GameStateSchema = z.strictObject({
  schemaVersion: z.literal(GAME_STATE_SCHEMA_VERSION),
  /** When this state was observed. Used for staleness checks. */
  timestamp: TimestampSchema,
  source: z.enum(['mock', 'mineflayer', 'gtnh1710', 'fixture']),
  player: PlayerSchema,
  inventory: knownSchema(InventorySchema),
  nearbyThreats: knownSchema(ThreatsSchema),
  /**
   * The entities behind `nearbyThreats` (ATTACK_ENTITY targets one of them). Snapshots
   * stored before combat existed read back as unknown, and nothing can be attacked then.
   */
  nearbyEntities: knownSchema(NearbyEntitiesSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  environmentHazards: knownSchema(EnvironmentHazardsSchema),
  /**
   * Diggable blocks and placeable cells nearby (for DIG_BLOCK and PLACE_BLOCK). Snapshots
   * stored before this field existed read back as unknown.
   */
  nearbyBlocks: knownSchema(NearbyBlocksSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  /** The world's clock. Snapshots stored before this field existed read back as unknown. */
  time: knownSchema(WorldTimeSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  /**
   * The server's own quest book records for this player (Better Questing), for the quests the
   * agent tracks. Snapshots stored before this field existed read back as unknown.
   */
  questBook: knownSchema(QuestBookSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  power: PowerSchema,
  machines: z.array(MachineSchema).max(512),
  storage: z.array(StorageContainerSchema).max(512),
  /** Crafting tables the agent may use. Defaults to [] for states recorded before crafting. */
  craftingTables: z.array(CraftingTableSchema).max(64).default([]),
  /**
   * Blocks the agent may right-click (furnaces, crafting tables, allowlisted blocks...).
   * Snapshots stored before this field existed read back as unknown.
   */
  interactables: knownSchema(NearbyInteractablesSchema).default({
    known: false,
    reason: 'not reported by this observation',
  }),
  /** The block window the agent opened last in this connection, or null. */
  blockWindow: BlockWindowSchema.nullable().default(null),
  /** Container whose GUI is currently open, if any. */
  openContainerId: EntityIdSchema.nullable(),
  currentTask: CurrentTaskSchema.nullable(),
  knownRecipeState: KnownRecipeStateSchema.nullable(),
  lastAction: LastActionSchema.nullable(),
});
export type GameState = z.infer<typeof GameStateSchema>;
