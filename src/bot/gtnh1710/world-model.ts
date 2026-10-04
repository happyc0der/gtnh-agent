import { isPlaceableBlock, type PlaceableBlock } from '../../domain/blocks.ts';
import {
  BARE_HAND,
  calmSpiderBlocker,
  LIGHT_SHY_SPIDERS,
  recentHurtMs,
  SPIDER_CALM_LIGHT,
  SPIDER_TARGET_RANGE,
} from '../../domain/combat.ts';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  MAX_REPORTED_DEATHS,
  MAX_REPORTED_ENTITIES,
  MAX_REPORTED_PLACEABLE,
  MAX_REPORTED_PLACED,
  MAX_REPORTED_REMOVED,
  MAX_REPORTED_RESOURCES,
  worldTime,
  type GameState,
  type NearbyEntity as StateEntity,
  type WorldTime,
} from '../../domain/game-state.ts';
import { chooseWeapon, listedCategory, vitalsOf, type HotbarSlot } from './combat.ts';
import { known, unknown, type Known } from '../../domain/known.ts';
import { toolInfo, usesLeft } from '../../domain/tools.ts';
import { PLACE_TARGETS, scanPlaceable } from './placing.ts';
import {
  buildDiggableTable,
  buildSeeThroughTable,
  diggableOf,
  RESOURCE_SCAN_RADIUS,
  scanResources,
} from './resource-scan.ts';
import {
  classifyModded,
  classifyVanillaMob,
  classifyVanillaObject,
  type Classification,
} from './entity-types.ts';
import {
  PLAYER_EYE_HEIGHT,
  type EntityMetadata,
  type FmlRuntimeMessage,
  type ItemStackData,
  type PlayPacket,
} from './packets.ts';
import { BLOCK_CODE, buildBlockCodeTable } from './block-hazards.ts';
import { QuestBookModel, type BqMessage } from './better-questing.ts';
import {
  GT_EVENT_CHANGE_COMMON_DATA,
  machineFlags,
  machineNamesFor,
  machineStatus,
  type GregTechMessage,
  type MachineFlags,
} from './gregtech.ts';
import {
  ChunkStore,
  decodeChunkBulk,
  decodeChunkColumnWithBiomes,
  type ChunkFormat,
  type ColumnView,
} from './chunk-data.ts';
import { scanHazards, type HazardScan } from './hazard-scan.ts';
import { lightPointY, skylightSubtracted } from './light.ts';
import type { WindowSnapshot } from './container.ts';
import {
  FURNACE_PROPERTY,
  FURNACE_SLOT,
  INTERACTION_PROFILES,
  matchWindowVariant,
  observedStorageId,
  type OpenedWindow,
  type ProfileId,
  type WindowLayout,
} from '../../domain/interactions.ts';
import { ItemNameSchema } from '../../domain/common.ts';
import {
  MAX_REPORTED_INTERACTABLES,
  type BlockWindow,
  type FurnaceState,
  type InteractableBlock,
  type SlotStack,
} from '../../domain/game-state.ts';
import { buildInteractableTable, roleOf, scanInteractables } from './interact.ts';
import { nameItemStack, type Registry } from './registry.ts';
import type { Vec3, WalkWorld } from './walking.ts';
import { ProtocolError } from './wire.ts';

/**
 * 1.7.10 player inventory window (id 0): 0 crafting output, 1-4 crafting grid, 5-8 armor,
 * 9-35 main inventory, 36-44 hotbar. GTNH's Backhand mod appends an off-hand slot (45).
 */
const ARMOR_SLOTS = [5, 6, 7, 8] as const;
const STORAGE_FIRST = 9;
const STORAGE_LAST = 44;
const HOTBAR_FIRST = 36;
const MIN_PLAYER_WINDOW_SLOTS = 45;

/** Entities within this many blocks count as "nearby" (the danger radius is config, <= this). */
export const ENTITY_SCAN_RADIUS = 16;

/**
 * The server sends a chunk's entities in the same tick as the chunk itself. After the last
 * chunk covering the scan radius arrives, wait this long (5 ticks) before trusting the
 * entity list. Verified live: before this rule the client reported "0 threats" 85 ms
 * before the first chunk had even arrived.
 */
export const ENTITY_SETTLE_MS = 250;

/** Packet ids whose loss would leave the block picture (and so the hazard scan) incomplete. */
const BLOCK_PACKETS: ReadonlySet<number> = new Set([0x21, 0x22, 0x23, 0x26]);

/** Packet ids whose loss would leave the entity picture incomplete. */
const ENTITY_PACKETS: ReadonlySet<number> = new Set([0x0c, 0x0e, 0x0f, 0x13, 0x15, 0x17, 0x18]);

/**
 * The client sees a mob where the server last sent it: every 3 ticks, and only once it moved
 * 1/8 block (EntityTrackerEntry, 1/32-block positions), so a walking spider may be half a
 * block or more from there. A spider's light is the darkest of the blocks within this
 * distance of its light point that it could be in (air).
 */
const SPIDER_POSITION_MARGIN = 0.5;
/** ...and a spider this much beyond SPIDER_TARGET_RANGE still counts as within it. */
const SPIDER_RANGE_MARGIN = 2;
/** The clock may be a second or two off the server's: darkness is the darkest within this. */
const LIGHT_TIME_MARGIN_TICKS = 40;
/** World.getBlockLightValue's neighbours for a block that takes their brightness. */
const NEIGHBOUR_LIGHT: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * Packets after which a spider may have found the player in the dark (#watchSpiders): the
 * spider moved, the player moved, the clock or the weather changed, or the blocks did.
 */
const SPIDER_WATCH_PACKETS: ReadonlySet<PlayPacket['type']> = new Set<PlayPacket['type']>([
  'spawn-mob',
  'entity-move',
  'entity-teleport',
  'entity-status',
  'server-position',
  'time-update',
  'change-game-state',
  'chunk-data',
  'chunk-bulk',
  'block-change',
  'multi-block-change',
]);

export interface TrackedEntity {
  kind: 'player' | 'mob' | 'object' | 'modded';
  classification: Classification;
  /** Forge mod entity type (modded entities only), as announced by the FML spawn message. */
  modType: { modId: string; typeId: number } | null;
  x: number;
  y: number;
  z: number;
  /**
   * DataWatcher values received so far (the full list at spawn, then S1C changes), by index.
   * An index not in the map is not known (never sent, or an update for it was lost).
   */
  metadata?: Map<number, number | string | null>;
  /** Hurt statuses (S19 status 2, a full hit) seen for it, and when the last one arrived. */
  hurtCount?: number;
  lastHurtAt?: Date | null;
  /** When the server said it died (S19 status 3); it is removed about 20 ticks later. */
  diedAt?: Date | null;
  /**
   * A vanilla spider (LIGHT_SHY_SPIDERS) that may have picked this player as its target on
   * this connection, and why (#watchSpiders): it never counts as calm again.
   */
  mayTarget?: string | null;
  /** A dropped item (Spawn Object type 2, an EntityItem): what it is, and how it moved. */
  item?: DroppedItem;
}

/**
 * What the client knows of a dropped item besides where it is: its stack, from the server's
 * DataWatcher (index 10; null until that arrives, or after an update for it was lost), where
 * and when it appeared, and when its position last changed.
 */
interface DroppedItem {
  stack: ItemStackData | null;
  spawn: Vec3;
  spawnedAt: Date;
  movedAt: Date;
}

/** Spawn Object type of a dropped item (EntityTrackerEntry: S0EPacketSpawnObject(entity, 2, 1)). */
export const DROPPED_ITEM_OBJECT_TYPE = 2;
/** The DataWatcher index of a dropped item's stack (EntityItem.entityInit: type 5 at 10). */
const DROPPED_ITEM_STACK_INDEX = 10;
/**
 * A dropped item lies still once its position has not changed for this long (25 ticks) and it
 * lies on a block. The server sends an item's position only every 20 ticks (EntityTracker:
 * EntityItem's update frequency is 20), and then only when it moved 1/8 block since the last
 * one it sent (EntityTrackerEntry.sendLocationToAllClients): a few quiet ticks prove nothing,
 * one update period and a margin do.
 */
export const ITEM_SETTLE_MS = 1_250;
/**
 * ...or this long (70 ticks) whatever it seems to lie on (a slab, a snow layer; or its first
 * update is late): past the forced update the tracker sends every 60 ticks.
 */
export const ITEM_STILL_MS = 3_500;
/** A dropped item's box is 0.25 high; its position is the box's centre (yOffset = height/2). */
const ITEM_HALF_SIZE = 0.125;

/** A dropped item near a point, as WorldModel.itemEntitiesNear reports it. */
export interface ItemEntity {
  entityId: number;
  /** The item as the inventory names it (`name` or `name@damage`); null while not known. */
  item: string | null;
  /** How many it holds (it grows when items merge); null while not known. */
  count: number | null;
  /** Where it is: the centre of its 0.25-block box, as the server last sent it. */
  position: Vec3;
  /** Where and when it appeared (its spawn packet). */
  spawn: Vec3;
  spawnedAt: Date;
  /** It lies still (WorldModel#itemSettled). */
  settled: boolean;
  /** From the point asked about to where it is. */
  distance: number;
}

/** A recent death the server announced (S19 status 3). */
interface DeathRecord {
  entityId: number;
  type: string;
  at: Date;
}

/** DataWatcher entries as a map (the last value per index wins). */
function metadataMap(entries: EntityMetadata | undefined): Map<number, number | string | null> {
  return new Map((entries ?? []).map((e) => [e.index, e.value]));
}

export interface NearbyEntity {
  entityId: number;
  kind: TrackedEntity['kind'];
  name: string;
  category: Classification['category'];
  distance: number;
  /** Where it is (its feet), as last sent. */
  position: { x: number; y: number; z: number };
  /** A calm spider (WorldModel#isCalm): listed, but no threat. */
  calm: boolean;
}

export function dimensionName(id: number): string {
  switch (id) {
    case 0:
      return 'overworld';
    case -1:
      return 'the_nether';
    case 1:
      return 'the_end';
    default:
      return `dim_${id}`;
  }
}

/** GregTech machines farther than this are left out of the state (their packets still arrive). */
export const MACHINE_SCAN_RADIUS = 32;
const MAX_REPORTED_MACHINES = 64;
/** The block every GregTech machine (and pipe) is. */
const GT_MACHINE_BLOCK = 'gregtech:gt.blockmachines';

/**
 * 1.7.10 window type 1, the crafting table. Its S2D announces the 9 grid slots, but the
 * window also has the result slot (slot 0): 10 container slots, then the player's 36.
 */
export const WORKBENCH_WINDOW_TYPE = 1;

/** Container slots (before the player's 36) of a window as S2D announces it. */
export function containerSlotsOf(inventoryType: number, announced: number): number {
  return inventoryType === WORKBENCH_WINDOW_TYPE ? announced + 1 : announced;
}

/** The id a crafting table the scan found gets: `crafting_table:<x>.<y>.<z>`. */
export function observedTableId(p: { x: number; y: number; z: number }): string {
  return `crafting_table:${p.x}.${p.y}.${p.z}`;
}

/** The position in an observed crafting table id, or null for any other id. */
export function parseObservedTableId(id: string): { x: number; y: number; z: number } | null {
  const m = /^crafting_table:(-?\d+)\.(-?\d+)\.(-?\d+)$/.exec(id);
  if (m === null) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** Window 0 as a click target: slots 0-8 (result, 2x2 grid, armor) before the player's 36. */
const INVENTORY_WINDOW_CONTAINER_SLOTS = 9;

/** A chest or crafting table the agent may use (from config). */
export interface ContainerDefinition {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
}

/** The block a window belongs to, when the agent opened it with a right-click (interact.ts). */
export interface WindowBlock {
  position: { x: number; y: number; z: number };
  /** The block's registry name when it was clicked. */
  block: string;
  /** Its interaction profile, or null for an observe-only block. */
  profile: ProfileId | null;
}

/** The container window the server has open for the player (window 0, the inventory, excluded). */
export interface OpenWindow extends WindowSnapshot {
  windowId: number;
  /** S2D inventory type; FML_WINDOW_TYPE for a mod GUI opened with Forge's OpenGui. */
  inventoryType: number;
  /** The configured container it belongs to, when the agent opened it; null otherwise. */
  containerId: string | null;
  /** Slots are known once the server has sent them (S30); until then `slots` is empty. */
  slotsKnown: boolean;
  /** S2D title (vanilla windows), or null. */
  title?: string | null;
  /** The slot count S2D announced (vanilla windows), or null. */
  announcedSlots?: number | null;
  /**
   * The profile layout of the window, when it belongs to a block with a profile and is
   * exactly a window that profile knows (matchWindowVariant); null otherwise.
   */
  layout?: WindowLayout | null;
  /** Forge OpenGui details for a mod GUI, or null. */
  fml?: { modId: string; guiId: number; x: number; y: number; z: number } | null;
  /** The block the agent right-clicked to open it (INTERACT_BLOCK and friends), or null. */
  block?: WindowBlock | null;
  /**
   * The player's 36 slots follow the container slots (every vanilla window; a mod window
   * only when its profile says so). When false the inventory is unknown while it is open.
   */
  layoutKnown?: boolean;
  /** The client may click in it: false for observe-only blocks and unknown layouts. */
  clickable?: boolean;
  /** Window properties (S31) as last sent: property id -> value. */
  properties?: Map<number, number>;
  /** Unknown layouts: where 36 slots matched the player's inventory (a hint), or null. */
  inventoryMatchAt?: number | null;
}

/** OpenWindow.inventoryType of a mod GUI (Forge OpenGui carries no vanilla type). */
export const FML_WINDOW_TYPE = -1;

/** A block window as last seen: live while open, frozen when it closed. */
interface BlockWindowRecord {
  window: OpenWindow;
  open: boolean;
  observedAt: Date;
}

const positionKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

/** Whether a profile's window may be clicked by some action (not only looked at). */
function profileClickable(profile: ProfileId | null): boolean {
  if (profile === null) return false;
  const uses = INTERACTION_PROFILES[profile].usedBy;
  return uses.some((u) => u !== 'INTERACT_BLOCK');
}

export interface TrackedMachine {
  x: number;
  y: number;
  z: number;
  metaTileId: number;
  /** Name from GregTech's MetaTileEntityIDs (e.g. MACERATOR_LV). */
  name: string;
  /** BaseMetaTileEntity texture data (see gregtech.ts). */
  common: number;
}

interface PlayerPosition {
  x: number;
  feetY: number;
  z: number;
}

/**
 * Every block update the server sends for one position, in order: the block id after the
 * update, or -1 when its chunk was unloaded. The digging client watches its target so it
 * can tell "broken" (air) from "re-sent" (the same block again, the server's refusal).
 */
export interface BlockWatch {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly updates: number[];
  /**
   * For each update, its place among the updates of every watch (one counter for all), so
   * the updates of two watched blocks can be put in the order they arrived.
   */
  readonly order: number[];
}

/** Positions of removed diggable blocks remembered per connection (most recent first). */
const MAX_REMEMBERED_REMOVALS = 64;
/** Placed blocks remembered per connection (most recent first). */
const MAX_REMEMBERED_PLACEMENTS = 64;
/** Entities this close to the player are passed to the placeable-cell scan. */
const PLACE_SCAN_ENTITY_RADIUS = 12;

/** A placeable block the observer saw appear in an empty cell, and its registry id. */
interface PlacedRecord {
  x: number;
  y: number;
  z: number;
  block: PlaceableBlock;
  id: number;
}

/**
 * Folds decoded server packets into what the agent knows. Pure: no sockets, no timers.
 * Anything not (yet) observed, or not reliably interpretable, is reported as unknown.
 */
export class WorldModel {
  #registry: Registry | null = null;
  #dimension: number | null = null;
  #position: PlayerPosition | null = null;
  #health: { health: number; food: number } | null = null;
  /** The last S39's flags (1: invulnerable), or null before the server sent one. */
  #abilityFlags: number | null = null;
  /** When an update last showed the player's health going down. */
  #lastHurtAt: Date | null = null;
  /** The last S03: the day time then, whether it advances, and when it arrived. */
  #time: { dayTicks: number; daylightCycle: boolean; at: Date } | null = null;
  /**
   * The weather as the server keeps it (#applyWeather): the rain and thunder strengths, 0-1;
   * the thunder null while not known. Null while not known at all.
   */
  #weather: { rain: number; thunder: number | null } | null = null;
  /**
   * Where the (re)join's weather stands: its time update is awaited, or its weather (sent
   * right after that) is arriving; null once past both.
   */
  #loginWeather: 'awaiting-time' | 'burst' | null = 'awaiting-time';
  #heldSlot = 0;
  #window: Array<ItemStackData | null> | null = null;
  #containers: readonly ContainerDefinition[] = [];
  #craftingTables: readonly ContainerDefinition[] = [];
  #openWindow: OpenWindow | null = null;
  /**
   * The stack on the cursor (S2F window -1 slot -1). The server sends it after every full
   * window sync; accepted clicks change it by prediction; closing a window empties it.
   */
  #cursor: ItemStackData | null = null;
  /** The container the agent is about to open: claimed by the next open-window packet. */
  #expectedContainer: string | null = null;
  /** Counts S30s for the open window (the client waits for a re-sync after a rejected click). */
  #windowSyncs = 0;
  /** Counts S30s for window 0 (the player's own inventory container). */
  #inventorySyncs = 0;
  /** Counts cursor updates (S2F -1/-1), which follow every full window sync. */
  #cursorSyncs = 0;
  #lastPacketAt: Date | null = null;
  #joined = false;
  /** Set when an inventory packet could not be decoded; cleared by the next full window refresh. */
  #inventoryProblem: string | null = null;
  readonly #chat: string[] = [];
  readonly #entities = new Map<number, TrackedEntity>();
  /** The tracked vanilla spiders (LIGHT_SHY_SPIDERS), by entity id. */
  readonly #spiders = new Set<number>();
  /** Deaths the server announced on this connection, most recent first. */
  #deaths: DeathRecord[] = [];
  #selfEntityId: number | null = null;

  /** The player's own entity id (from Join Game), or null before it arrived. */
  get selfEntityId(): number | null {
    return this.#selfEntityId;
  }
  /** Set when an entity packet could not be decoded: the entity picture may be incomplete. */
  #entityProblem: string | null = null;
  /**
   * Loaded chunk columns: arrival times (for entity readiness), block ids (for hazards) and
   * their metadata (for walking: plant variants).
   */
  readonly #store = new ChunkStore();
  #chunkFormat: ChunkFormat = { neid: false };
  #modVersions: ReadonlyMap<string, string> = new Map();
  /** GregTech machine names for the server's version; null = GregTech blocks are not tracked. */
  #gtNames: ReadonlyMap<number, string> | null = null;
  /** GregTech machines by "x,y,z", from the GregTech channel. */
  readonly #machines = new Map<string, TrackedMachine>();
  /** Set when a GregTech message could not be decoded: machine states may be wrong. */
  #machineProblem: string | null = null;
  /** Registry id -> hazard code; rebuilt when the registry arrives (ids are per world). */
  #blockCodes: Uint8Array | null = null;
  /** Set when block data was lost: the hazard scan cannot be trusted for this session. */
  #hazardProblem: string | null = null;
  /** Registry id -> diggable block (resource-scan.ts); rebuilt when the registry arrives. */
  #diggable: Uint8Array | null = null;
  /** Blocks a face may touch and still be in view (resource-scan.ts buildSeeThroughTable). */
  #seeThrough: Uint8Array | null = null;
  /** Where the server turned a diggable block into air, most recent first. */
  #removed: Array<{ x: number; y: number; z: number }> = [];
  /**
   * Blocks the agent dug itself, most recent first. They come first in the reported
   * `removed`: seen live, a tree's leaves decaying after its log was chopped pushed the log's
   * own dig out of the list, and DIG_BLOCK's verification failed with the log in hand.
   */
  #dug: Array<{ x: number; y: number; z: number }> = [];
  /** Where the server turned an empty cell into a placeable block, most recent first. */
  #placed: PlacedRecord[] = [];
  readonly #watches = new Set<BlockWatch>();
  /** Counts the updates recorded by every watch (BlockWatch.order). */
  #watchedUpdates = 0;
  /** The block the agent is about to right-click: claimed by the next window that opens. */
  #expectedBlock: WindowBlock | null = null;
  /** Block windows seen in this connection, by position (live while open, then frozen). */
  readonly #blockWindows = new Map<string, BlockWindowRecord>();
  #lastBlockWindowKey: string | null = null;
  /** Registry id -> interactable code (interact.ts); rebuilt with the registry or the patterns. */
  #interactTable: Uint8Array | null = null;
  #observePatterns: readonly string[] = [];
  /** The server's quest book for this player (Better Questing), from its own sync messages. */
  readonly #questBook = new QuestBookModel();
  /** The quests GameState reports (the agent's Age 0 closure); none until it is set. */
  #questScope: readonly string[] = [];

  /** Read access for the client (it waits on the server's quest syncs). */
  get questBook(): QuestBookModel {
    return this.#questBook;
  }

  /** Which quests GameState.questBook lists, in this order. */
  setQuestScope(ids: readonly string[]): void {
    this.#questScope = [...ids];
  }

  /** A decoded Better Questing message from the server. */
  applyQuestBook(message: BqMessage, at: Date): void {
    this.touch(at);
    this.#questBook.apply(message);
  }

  /** A Better Questing message could not be decoded: the quest book is unknown from now on. */
  markQuestBookProblem(reason: string): void {
    this.#questBook.markProblem(reason);
  }

  /** The client dug the block at `p` (the server confirmed it): see #dug. */
  noteDug(p: { x: number; y: number; z: number }): void {
    this.#dug = [
      { x: p.x, y: p.y, z: p.z },
      ...this.#dug.filter((d) => d.x !== p.x || d.y !== p.y || d.z !== p.z),
    ].slice(0, MAX_REPORTED_REMOVED);
  }

  setRegistry(registry: Registry): void {
    this.#registry = registry;
    this.#blockCodes = buildBlockCodeTable(registry);
    this.#diggable = buildDiggableTable(registry);
    this.#seeThrough = buildSeeThroughTable(registry);
    this.#interactTable = buildInteractableTable(registry, this.#observePatterns);
  }

  /** Blocks without a profile the operator allowlisted to look at (config interact.observeOnly). */
  setObservePatterns(patterns: readonly string[]): void {
    this.#observePatterns = [...patterns];
    if (this.#registry !== null) {
      this.#interactTable = buildInteractableTable(this.#registry, this.#observePatterns);
    }
  }

  /** The agent is about to right-click this block: the next window that opens is its window. */
  expectBlockWindow(block: WindowBlock | null): void {
    this.#expectedBlock = block;
  }

  /** Records every update the server sends for this block until unwatch(). */
  watchBlock(x: number, y: number, z: number): BlockWatch {
    const w: BlockWatch = { x, y, z, updates: [], order: [] };
    this.#watches.add(w);
    return w;
  }

  unwatch(w: BlockWatch): void {
    this.#watches.delete(w);
  }

  #record(w: BlockWatch, id: number): void {
    w.updates.push(id);
    w.order.push(++this.#watchedUpdates);
  }

  /**
   * A single block changed (to `id` with metadata `meta`): remember removed diggable blocks
   * and placed blocks, and tell the watchers.
   */
  #onBlockChanged(x: number, y: number, z: number, id: number, meta: number): void {
    const before = this.#store.blockAt(x, y, z);
    this.#store.setBlock(x, y, z, id, meta);
    const table = this.#diggable;
    if (
      id === 0 &&
      before !== undefined &&
      table !== null &&
      diggableOf(table, before) !== undefined
    ) {
      this.#removed = [
        { x, y, z },
        ...this.#removed.filter((p) => p.x !== x || p.y !== y || p.z !== z),
      ].slice(0, MAX_REMEMBERED_REMOVALS);
    }
    const block = id === 0 ? undefined : this.#registry?.blocks.get(id);
    const wasEmpty =
      before === 0 ||
      (before !== undefined && PLACE_TARGETS.has(this.#registry?.blocks.get(before) ?? ''));
    if (wasEmpty && block !== undefined && isPlaceableBlock(block)) {
      this.#placed = [
        { x, y, z, block, id },
        ...this.#placed.filter((p) => p.x !== x || p.y !== y || p.z !== z),
      ].slice(0, MAX_REMEMBERED_PLACEMENTS);
    }
    for (const w of this.#watches) {
      if (w.x === x && w.y === y && w.z === z) this.#record(w, this.#store.blockAt(x, y, z) ?? -1);
    }
  }

  /** A whole column (or some of its sections) arrived or went: tell the watchers in it. */
  #onColumnChanged(chunkX: number, chunkZ: number): void {
    for (const w of this.#watches) {
      if (Math.floor(w.x / 16) === chunkX && Math.floor(w.z / 16) === chunkZ) {
        this.#record(w, this.#store.blockAt(w.x, w.y, w.z) ?? -1);
      }
    }
  }

  /** Mod versions the server reports (modid -> version); entity identifications are version-bound. */
  setServerMods(mods: ReadonlyArray<{ modid: string; version: string }>): void {
    this.#modVersions = new Map(mods.map((m) => [m.modid, m.version]));
    this.#gtNames = machineNamesFor(this.#modVersions.get('gregtech_nh'));
  }

  /** GregTech channel messages: machine placements (tile entities) and state changes. */
  applyGregTech(message: GregTechMessage): void {
    const names = this.#gtNames;
    if (names === null || this.#machineProblem !== null) return;
    switch (message.type) {
      case 'gt-tile-entity': {
        const key = `${message.x},${message.y},${message.z}`;
        const name = names.get(message.metaTileId);
        // Pipes, cables and unknown ids send the same packet with another meaning.
        if (name === undefined) this.#machines.delete(key);
        else {
          this.#machines.set(key, {
            x: message.x,
            y: message.y,
            z: message.z,
            metaTileId: message.metaTileId,
            name,
            common: message.common,
          });
        }
        return;
      }
      case 'gt-block-events':
        if (message.dimension !== this.#dimension) return;
        for (const e of message.events) {
          if (e.eventId !== GT_EVENT_CHANGE_COMMON_DATA) continue;
          const m = this.#machines.get(`${e.x},${e.y},${e.z}`);
          if (m !== undefined) m.common = e.value;
        }
        return;
      case 'gt-other':
        return;
    }
  }

  /** Chests the agent may use (config); reported in GameState.storage. */
  setContainers(defs: readonly ContainerDefinition[]): void {
    this.#containers = defs;
  }

  /** Crafting tables the agent may use (config); reported in GameState.craftingTables. */
  setCraftingTables(defs: readonly ContainerDefinition[]): void {
    this.#craftingTables = defs;
  }

  /** The agent is about to open this container: the next window the server opens is it. */
  expectContainer(containerId: string | null): void {
    this.#expectedContainer = containerId;
  }

  /** Window 0 (the player's own inventory container), as last sent by the server. */
  get inventoryWindow(): ReadonlyArray<ItemStackData | null> | null {
    return this.#window;
  }

  /**
   * Window 0 as a click target (the player's own 2x2 crafting grid), or null while another
   * window is open (the server only takes clicks for its open window) or it is not known.
   */
  get inventoryClickWindow(): WindowSnapshot | null {
    const w = this.#window;
    if (this.#openWindow !== null || w === null || w.length < MIN_PLAYER_WINDOW_SLOTS) return null;
    if (this.#inventoryProblem !== null) return null;
    return {
      containerSlots: INVENTORY_WINDOW_CONTAINER_SLOTS,
      slots: [...w],
      cursor: this.#cursor,
    };
  }

  get openWindow(): OpenWindow | null {
    const w = this.#openWindow;
    return w === null ? null : { ...w, slots: [...w.slots], cursor: this.#cursor };
  }

  get windowSyncs(): number {
    return this.#windowSyncs;
  }

  get inventorySyncs(): number {
    return this.#inventorySyncs;
  }

  get cursorSyncs(): number {
    return this.#cursorSyncs;
  }

  get heldSlot(): number {
    return this.#heldSlot;
  }

  /** C09 was sent: the server does not echo a hotbar change the client made itself. */
  setHeldSlot(slot: number): void {
    if (slot >= 0 && slot <= 8) this.#heldSlot = slot;
  }

  /**
   * The server accepted a click in `windowId` (0 = the player's own inventory container): it
   * sends no slot updates for it, so apply the client's prediction. Only the slots the click
   * changes (`before` -> `after`) and the cursor are written, so an unrelated slot update
   * that arrived while the click was on its way is kept.
   */
  applyAcceptedClick(windowId: number, before: WindowSnapshot, after: WindowSnapshot): void {
    const open = this.#openWindow;
    let slots: Array<ItemStackData | null>;
    if (windowId === 0) {
      if (open !== null || this.#window === null) return;
      slots = [...this.#window];
      this.#window = slots;
    } else {
      if (open === null || open.windowId !== windowId || !open.slotsKnown) return;
      slots = [...open.slots];
      open.slots = slots;
    }
    const n = Math.max(before.slots.length, after.slots.length);
    for (let i = 0; i < n && i < slots.length; i++) {
      const was = before.slots[i] ?? null;
      const now = after.slots[i] ?? null;
      if (was !== now) slots[i] = now;
    }
    this.#cursor = after.cursor;
    if (windowId !== 0) this.#touchBlockWindow(this.#lastPacketAt);
  }

  /** The open window belongs to a block the agent right-clicked: remember what it shows now. */
  #touchBlockWindow(at: Date | null): void {
    const w = this.#openWindow;
    if (w === null || !w.slotsKnown || w.block == null) return;
    const key = positionKey(w.block.position);
    this.#blockWindows.set(key, { window: w, open: true, observedAt: at ?? new Date(0) });
    this.#lastBlockWindowKey = key;
  }

  /** The client closed the window (C0D). */
  closeWindowLocally(): void {
    this.#closeWindow();
  }

  /**
   * S30 for a mod GUI, or for a block the agent only looks at: any slot count is accepted.
   * The player's 36 slots are placed only by a profile whose window this is (or, for a
   * vanilla window, by the vanilla rule: they come last); otherwise the layout is unknown.
   * Such windows are never clicked unless a profile's actions need clicks.
   */
  #acceptLooseWindow(w: OpenWindow, items: ReadonlyArray<ItemStackData | null>): void {
    w.slots = [...items];
    w.slotsKnown = true;
    const layout = this.#profileLayoutOf(w);
    w.layout = layout;
    if (layout !== null) {
      w.containerSlots = layout.containerSlots;
      w.layoutKnown = true;
      w.clickable = profileClickable(w.block?.profile ?? null);
      return;
    }
    if (w.fml == null && items.length === w.containerSlots + 36) {
      w.layoutKnown = true;
      w.clickable = false;
      return;
    }
    w.containerSlots = items.length;
    w.layoutKnown = false;
    w.clickable = false;
    w.inventoryMatchAt = this.#matchInventory(items);
  }

  /**
   * Where 36 slots of a window match the player's inventory exactly (window 0's main
   * inventory, then hotbar, as last sent): a hint for a profile, never used to click. Only a
   * non-empty inventory counts (any 36 empty slots would match an empty one); the window's
   * last 36 slots are tried first, as most containers add the player's inventory last.
   */
  #matchInventory(items: ReadonlyArray<ItemStackData | null>): number | null {
    const inv = this.#window;
    if (inv === null || inv.length < MIN_PLAYER_WINDOW_SLOTS) return null;
    const mine = inv.slice(STORAGE_FIRST, STORAGE_LAST + 1);
    if (mine.every((s) => s == null)) return null;
    const same = (a: ItemStackData | null | undefined, b: ItemStackData | null | undefined) =>
      a == null || b == null
        ? a == b
        : a.id === b.id && a.damage === b.damage && a.count === b.count && a.hasNbt === b.hasNbt;
    const at = (o: number): boolean => mine.every((s, i) => same(s, items[o + i]));
    for (let o = items.length - 36; o >= 0; o--) if (at(o)) return o;
    return null;
  }

  /**
   * The layout of a window that belongs to a block with a profile, when the window is exactly
   * one the profile knows (its opener and slot count; matchWindowVariant), else null.
   */
  #profileLayoutOf(w: OpenWindow): WindowLayout | null {
    const profileId = w.block?.profile ?? null;
    if (profileId === null) return null;
    let opened: OpenedWindow;
    if (w.fml != null) opened = { kind: 'fml', modId: w.fml.modId, guiId: w.fml.guiId };
    else if (w.announcedSlots != null) {
      opened = {
        kind: 'vanilla',
        inventoryType: w.inventoryType,
        announcedSlots: w.announcedSlots,
      };
    } else return null;
    const variant = matchWindowVariant(INTERACTION_PROFILES[profileId], opened, w.slots.length);
    return variant?.layout ?? null;
  }

  /** The block window the agent opened last in this connection (live or as it closed). */
  #blockWindowState(): BlockWindow | null {
    const key = this.#lastBlockWindowKey;
    const record = key === null ? undefined : this.#blockWindows.get(key);
    return record === undefined ? null : this.#describeBlockWindow(record);
  }

  /** A block window record as the GameState reports it. */
  #describeBlockWindow(record: BlockWindowRecord): BlockWindow | null {
    const w = record.window;
    const block = w.block;
    if (block == null) return null;
    const blockName = ItemNameSchema.safeParse(block.block);
    if (!blockName.success) return null;
    const layout: WindowLayout | null = w.layoutKnown === false ? null : (w.layout ?? null);
    const playerFirst = w.layoutKnown === false ? Infinity : w.containerSlots;
    const slots: BlockWindow['slots'] = [];
    w.slots.forEach((s, i) => {
      if (s == null || (i >= playerFirst && i < playerFirst + 36)) return;
      const naming = nameItemStack(this.#registry, s.id, s.damage);
      slots.push({
        slot: i,
        item: naming.ok ? naming.name : `unknown:${s.id}@${s.damage}`,
        count: s.count,
        role: roleOf(layout, i),
        nbt: s.hasNbt,
      });
    });
    const properties: Record<string, number> = {};
    for (const [id, value] of w.properties ?? new Map<number, number>()) {
      properties[String(id)] = value;
    }
    return {
      position: { ...block.position },
      block: blockName.data,
      profile: block.profile,
      opener:
        w.fml != null
          ? `fml:${w.fml.modId}:${w.fml.guiId}`.slice(0, 100)
          : `vanilla:${w.inventoryType}`,
      title: w.title == null ? null : w.title.slice(0, 200),
      slotCount: w.slots.length,
      containerSlots: w.layoutKnown === false ? null : w.containerSlots,
      inventoryAt: w.layoutKnown === false ? (w.inventoryMatchAt ?? null) : w.containerSlots,
      slots: slots.slice(0, 512),
      properties,
      open: record.open,
      observedAt: record.observedAt.toISOString(),
    };
  }

  /** What the agent last saw in the furnace at this position (null if never seen). */
  #furnaceSeen(position: { x: number; y: number; z: number }): FurnaceState['seen'] {
    const record = this.#blockWindows.get(positionKey(position));
    const w = record?.window;
    if (record === undefined || w === undefined || w.block?.profile !== 'furnace') return null;
    let ok = true;
    const stack = (slot: number): SlotStack | null => {
      const s = w.slots[slot];
      if (s == null) return null;
      const naming = nameItemStack(this.#registry, s.id, s.damage);
      if (!naming.ok || s.count < 1) {
        ok = false;
        return null;
      }
      return { item: naming.name, count: s.count };
    };
    const input = stack(FURNACE_SLOT.input);
    const fuel = stack(FURNACE_SLOT.fuel);
    const output = stack(FURNACE_SLOT.output);
    if (!ok) return null;
    const property = (id: number): number | null => w.properties?.get(id) ?? null;
    return {
      observedAt: record.observedAt.toISOString(),
      input,
      fuel,
      output,
      cookTicks: property(FURNACE_PROPERTY.cookTicks),
      burnTicksLeft: property(FURNACE_PROPERTY.burnTicksLeft),
      fuelItemTicks: property(FURNACE_PROPERTY.fuelItemTicks),
    };
  }

  /** Blocks the agent may right-click near the player (interact.ts scan), nearest first. */
  #interactables(): GameState['interactables'] {
    if (this.#hazardProblem !== null) return unknown(this.#hazardProblem);
    if (!this.#joined) return unknown('not joined yet');
    const pos = this.#position;
    if (pos === null) return unknown('player position unknown');
    const table = this.#interactTable;
    const registry = this.#registry;
    if (table === null || registry === null) return unknown('block registry not received yet');
    const scan = scanInteractables(
      this.#store,
      table,
      { x: pos.x, y: pos.feetY, z: pos.z },
      undefined,
      MAX_REPORTED_INTERACTABLES,
    );
    if (!scan.ok) return unknown(scan.reason);
    const blocks: InteractableBlock[] = [];
    for (const f of scan.blocks) {
      const name = ItemNameSchema.safeParse(registry.blocks.get(f.blockId));
      if (!name.success) continue;
      const entry: InteractableBlock = {
        profile: f.profile,
        block: name.data,
        position: { ...f.position },
      };
      if (f.profile === 'furnace') {
        entry.furnace = {
          burning: name.data === 'minecraft:lit_furnace',
          seen: this.#furnaceSeen(f.position),
        };
      }
      blocks.push(entry);
    }
    return known({ scanRadius: scan.scanRadius, blocks });
  }

  /**
   * Ends the open window. The player's part of it is the latest view of the inventory (the
   * server does not update window 0 while another window is open), so it is copied back.
   */
  #closeWindow(): void {
    const w = this.#openWindow;
    if (
      w !== null &&
      w.slotsKnown &&
      w.layoutKnown !== false &&
      this.#window !== null &&
      this.#window.length >= MIN_PLAYER_WINDOW_SLOTS
    ) {
      for (let i = 0; i < 36; i++)
        this.#window[STORAGE_FIRST + i] = w.slots[w.containerSlots + i] ?? null;
    }
    // A block's window is remembered as it was last seen (a furnace keeps cooking unseen).
    if (w !== null && w.slotsKnown && w.block != null) {
      const key = positionKey(w.block.position);
      const seen = this.#blockWindows.get(key);
      this.#blockWindows.set(key, {
        window: { ...w, slots: [...w.slots], cursor: null, properties: new Map(w.properties) },
        open: false,
        // Every change was sent while it was open: what it showed held until it closed.
        observedAt: this.#lastPacketAt ?? seen?.observedAt ?? new Date(0),
      });
    }
    this.#openWindow = null;
    this.#cursor = null;
  }

  /** A GregTech message could not be decoded: stop reporting machines for this session. */
  markMachineProblem(reason: string): void {
    this.#machineProblem ??= reason;
    this.#machines.clear();
  }

  /** Every tracked GregTech machine with its flags (diagnostics). */
  trackedMachines(): Array<TrackedMachine & MachineFlags> {
    return [...this.#machines.values()].map((m) => ({ ...m, ...machineFlags(m.common) }));
  }

  /** Chunk data layout, chosen from the server's mod list (NotEnoughIDs or vanilla). */
  setChunkFormat(format: ChunkFormat): void {
    this.#chunkFormat = format;
  }

  get registry(): Registry | null {
    return this.#registry;
  }

  get joined(): boolean {
    return this.#joined;
  }

  get hasPosition(): boolean {
    return this.#position !== null;
  }

  get hasHealth(): boolean {
    return this.#health !== null;
  }

  get hasInventory(): boolean {
    return this.#window !== null;
  }

  /** Whether the hazard scan around the player can run: the chunks it needs have arrived. */
  get surroundingsKnown(): boolean {
    return this.#hazards().known;
  }

  get lastPacketAt(): Date | null {
    return this.#lastPacketAt;
  }

  /** Last few chat lines (raw JSON), for diagnostics only. Never fed to a planner. */
  get recentChat(): readonly string[] {
    return this.#chat;
  }

  /** Record that the server was heard from (any packet, including ones we don't decode). */
  touch(at: Date): void {
    this.#lastPacketAt = at;
  }

  /**
   * A packet could not be decoded. Whatever it would have updated is no longer
   * trustworthy, so it becomes unknown instead of silently going stale.
   */
  markUndecodable(packetId: number, reason: string, at: Date): void {
    this.touch(at);
    switch (packetId) {
      case 0x2f:
      case 0x30:
        this.#inventoryProblem = `undecodable inventory packet 0x${packetId.toString(16)}: ${reason}`;
        return;
      case 0x06:
        this.#health = null;
        return;
      case 0x39:
        this.#abilityFlags = null;
        return;
      case 0x07:
      case 0x08:
        this.#position = null;
        return;
      case 0x1c:
        // An entity's metadata update was lost, and which entity is not known: every
        // entity's health, name tag and age (and what each dropped item is) become unknown
        // until they are sent again.
        for (const e of this.#entities.values()) {
          e.metadata = new Map();
          if (e.item !== undefined) e.item.stack = null;
        }
        return;
      case 0x2b:
        // A weather update was lost: the sky's darkness is not known for this connection
        // (no spider counts as calm from now on).
        this.#weather = null;
        this.#loginWeather = null;
        return;
      default:
        if (BLOCK_PACKETS.has(packetId)) {
          this.#hazardProblem ??= `undecodable block packet 0x${packetId.toString(16)}: ${reason}`;
        }
        if (ENTITY_PACKETS.has(packetId)) {
          this.markEntityProblem(`undecodable entity packet 0x${packetId.toString(16)}: ${reason}`);
        }
        return; // otherwise not used for observation
    }
  }

  /**
   * An entity update was lost, so some entity may be missing or misplaced. Threats stay
   * unknown for the rest of the connection (reconnecting rebuilds the picture).
   */
  markEntityProblem(reason: string): void {
    this.#entityProblem ??= reason;
  }

  /** Forge "FML" channel messages: spawning and repositioning of mod entities. */
  applyFml(message: FmlRuntimeMessage, at: Date): void {
    this.touch(at);
    switch (message.type) {
      case 'fml-entity-spawn':
        this.#track(message.entityId, {
          kind: 'modded',
          classification: classifyModded(
            message.modId,
            message.typeId,
            this.#modVersions.get(message.modId),
          ),
          modType: { modId: message.modId, typeId: message.typeId },
          x: message.x,
          y: message.y,
          z: message.z,
          metadata: metadataMap(message.metadata),
        });
        return;
      case 'fml-entity-adjust': {
        const e = this.#entities.get(message.entityId);
        if (e !== undefined) Object.assign(e, { x: message.x, y: message.y, z: message.z });
        return;
      }
      case 'fml-open-gui': {
        // A mod GUI: the window's slots follow as S30 with this id. It belongs to the block
        // the agent clicked only if the message names that block's position.
        this.#closeWindow();
        const expected = this.#expectedBlock;
        const block =
          expected !== null &&
          expected.position.x === message.x &&
          expected.position.y === message.y &&
          expected.position.z === message.z
            ? expected
            : null;
        this.#openWindow = {
          windowId: message.windowId,
          inventoryType: FML_WINDOW_TYPE,
          containerSlots: 0,
          slots: [],
          slotsKnown: false,
          cursor: null,
          // A storage block the agent opened is that container (only at the right position).
          containerId: block === null ? null : this.#expectedContainer,
          title: null,
          announcedSlots: null,
          layout: null,
          fml: {
            modId: message.modId,
            guiId: message.guiId,
            x: message.x,
            y: message.y,
            z: message.z,
          },
          block,
          layoutKnown: false,
          clickable: false,
          properties: new Map(),
        };
        this.#expectedBlock = null;
        this.#expectedContainer = null;
        return;
      }
      case 'fml-other':
        return;
    }
  }

  /**
   * Every tracked entity within `radius` of the player, nearest first, with whether it is a
   * calm spider as of `now` (#isCalm; by default the last packet's time). An entity the
   * server said died (it lies in its death animation until it is removed) is no longer
   * counted.
   */
  nearbyEntities(
    radius = ENTITY_SCAN_RADIUS,
    now: Date = this.#lastPacketAt ?? new Date(0),
  ): NearbyEntity[] {
    const pos = this.#position;
    if (pos === null) return [];
    const out: NearbyEntity[] = [];
    for (const [entityId, e] of this.#entities) {
      if (e.diedAt != null) continue;
      const distance = Math.hypot(e.x - pos.x, e.y - pos.feetY, e.z - pos.z);
      if (distance <= radius) {
        const reported = Number(distance.toFixed(2));
        out.push({
          entityId,
          kind: e.kind,
          name: e.classification.name,
          category: e.classification.category,
          distance: reported,
          position: { x: e.x, y: e.y, z: e.z },
          calm: this.#isCalm(e, reported, now),
        });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // -------------------------------------------------------------------------
  // Dropped items (EntityItems: what a dig or a kill drops)

  /**
   * The dropped items within `radius` of `point`, nearest first: what each is, where it is,
   * where and when it appeared, and whether it lies still as of `now` (#itemSettled). Unknown
   * while an entity update was lost: an item may be missing or misplaced.
   */
  itemEntitiesNear(point: Vec3, radius: number, now: Date): Known<ItemEntity[]> {
    if (this.#entityProblem !== null) return unknown(this.#entityProblem);
    const out: ItemEntity[] = [];
    for (const [entityId, e] of this.#entities) {
      const item = this.#itemEntity(entityId, e, point, now);
      if (item !== null && item.distance <= radius) out.push(item);
    }
    return known(out.sort((a, b) => a.distance - b.distance || a.entityId - b.entityId));
  }

  /**
   * One dropped item as itemEntitiesNear reports it (its distance from `point`), or null once
   * it is gone: picked up, merged into another, burnt or despawned (the server destroys it).
   */
  itemEntity(entityId: number, point: Vec3, now: Date): ItemEntity | null {
    const e = this.#entities.get(entityId);
    return e === undefined ? null : this.#itemEntity(entityId, e, point, now);
  }

  #itemEntity(entityId: number, e: TrackedEntity, point: Vec3, now: Date): ItemEntity | null {
    const track = e.item;
    if (track === undefined) return null;
    const stack = track.stack;
    const naming = stack === null ? null : nameItemStack(this.#registry, stack.id, stack.damage);
    return {
      entityId,
      item: naming !== null && naming.ok ? naming.name : null,
      count: stack === null ? null : stack.count,
      position: { x: e.x, y: e.y, z: e.z },
      spawn: { ...track.spawn },
      spawnedAt: track.spawnedAt,
      settled: this.#itemSettled(e, track, now),
      distance: Math.hypot(e.x - point.x, e.y - point.y, e.z - point.z),
    };
  }

  /**
   * Whether a dropped item lies still: its position has not changed for ITEM_SETTLE_MS (since
   * it appeared, or last moved) and it lies on a block (#itemOnBlock), or for ITEM_STILL_MS
   * whatever it seems to lie on. A block's drop flies up and comes down within a dozen ticks
   * (EntityItem: 0.2 up, up to 0.1 sideways a tick, falling 0.04 faster a tick); the server
   * shows where it came to rest at its next update, 20 ticks after it appeared.
   */
  #itemSettled(e: TrackedEntity, track: DroppedItem, now: Date): boolean {
    const still = now.getTime() - track.movedAt.getTime();
    if (still >= ITEM_STILL_MS) return true;
    return still >= ITEM_SETTLE_MS && this.#itemOnBlock(e.x, e.y, e.z);
  }

  /**
   * Whether an item at (x, y, z) lies on a block: the bottom of its box is on a block top
   * (within the protocol's 1/32), over a block that is not air under its 0.25-wide footprint.
   * Falling, or in mid-air where it appeared, it does not. Fail closed: block data that is not
   * known, or not trusted, holds nothing up.
   */
  #itemOnBlock(x: number, y: number, z: number): boolean {
    if (this.#hazardProblem !== null) return false;
    const bottom = y - ITEM_HALF_SIZE;
    const top = Math.round(bottom);
    if (Math.abs(bottom - top) > 1 / 32 + 1e-9) return false;
    const under = (v: number): number[] => [
      ...new Set([Math.floor(v - ITEM_HALF_SIZE), Math.floor(v + ITEM_HALF_SIZE)]),
    ];
    for (const bx of under(x)) {
      for (const bz of under(z)) {
        const id = this.#store.blockAt(bx, top - 1, bz);
        if (id !== undefined && id !== 0) return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Spiders in the light (src/domain/combat.ts, LIGHT_SHY_SPIDERS; docs/gtnh-compatibility.md)

  /** Its height, when the entity is a vanilla spider. */
  #lightShy(e: TrackedEntity): { height: number } | undefined {
    if (e.kind !== 'mob' || e.classification.category !== 'hostile') return undefined;
    return LIGHT_SHY_SPIDERS.get(e.classification.name);
  }

  /**
   * Whether a tracked entity is a calm spider now: a vanilla spider that has not shown on
   * this connection that it may have the player as its target (#watchSpiders), that
   * calmSpiderBlocker allows (beyond its leap, the player not hurt lately, both as the
   * GameState reports them: `distance` rounded, the hurt measured from the last packet, the
   * observation's timestamp), and in light of at least SPIDER_CALM_LIGHT now.
   */
  #isCalm(e: TrackedEntity, distance: number, now: Date): boolean {
    const shy = this.#lightShy(e);
    if (shy === undefined || e.mayTarget != null || (e.hurtCount ?? 0) > 0) return false;
    const hurt = recentHurtMs(
      this.#lastHurtAt === null ? null : this.#lastHurtAt.toISOString(),
      this.#lastPacketAt ?? now,
    );
    const seen = {
      type: e.classification.name,
      category: 'hostile' as const,
      kind: 'mob' as const,
    };
    if (calmSpiderBlocker({ ...seen, distance }, hurt) !== null) return false;
    const light = this.#spiderLight(e, shy.height, now, 'darkest');
    return light !== undefined && light >= SPIDER_CALM_LIGHT;
  }

  /**
   * EntitySpider.findPlayerToAttack takes the closest player within 16 blocks whenever the
   * spider has no target and is in the dark, and it keeps that target in the light: it drops
   * it with a 1% chance a tick, and only while it can see the player, until the player leaves
   * the server (EntityCreature.updateEntityActionState, EntitySpider.attackEntity). A blow
   * makes the attacker its target, in any light. So a vanilla spider this connection saw in
   * the dark within that reach (plus SPIDER_RANGE_MARGIN), or saw hurt, may be after the
   * player from then on: it never counts as calm again on this connection. Checked whenever
   * a spider, the player, the clock, the weather or the blocks change (SPIDER_WATCH_PACKETS),
   * and at every observation. Only what is known marks it: light not known yet (a column
   * still arriving) marks nothing, and the brightest reading of what is uncertain counts
   * (the clock as it is, a thunder not known as none: between the rain and thunder updates
   * of one weather change the thunder is briefly not known). The spider is not calm while
   * any of that is uncertain all the same (#isCalm takes the darkest reading).
   */
  #watchSpiders(at: Date): void {
    const pos = this.#position;
    for (const id of this.#spiders) {
      const e = this.#entities.get(id);
      if (e === undefined || e.mayTarget != null) continue;
      const shy = this.#lightShy(e);
      if (shy === undefined) continue;
      if ((e.hurtCount ?? 0) > 0) {
        e.mayTarget = 'it was seen hurt';
        continue;
      }
      if (pos === null) continue;
      const d = Math.hypot(e.x - pos.x, e.y - pos.feetY, e.z - pos.z);
      if (d > SPIDER_TARGET_RANGE + SPIDER_RANGE_MARGIN) continue;
      const light = this.#spiderLight(e, shy.height, at, 'brightest');
      if (light !== undefined && light < SPIDER_CALM_LIGHT) {
        e.mayTarget = `it was seen in light ${light}, ${d.toFixed(1)} blocks from the player`;
      }
    }
  }

  /**
   * The light at a spider as Entity.getBrightness reads it (the block of its light point:
   * light.ts), the darkest of the blocks within SPIDER_POSITION_MARGIN of that point that it
   * could be in (air), since the client sees it where it was a moment ago; with the sky's
   * darkness read `reading` (#skylightSubtracted). Undefined when any of those is not
   * known, or outside the overworld (the threshold is the overworld's brightness table's).
   */
  #spiderLight(
    e: TrackedEntity,
    height: number,
    at: Date,
    reading: 'darkest' | 'brightest',
  ): number | undefined {
    if (this.#dimension !== 0 || this.#hazardProblem !== null) return undefined;
    const subtracted = this.#skylightSubtracted(at, reading);
    if (subtracted === undefined) return undefined;
    const y = lightPointY(e.y, height);
    const home = { x: Math.floor(e.x), y: Math.floor(y), z: Math.floor(e.z) };
    let darkest = this.#blockLight(home.x, home.y, home.z, subtracted);
    if (darkest === undefined) return undefined;
    const m = SPIDER_POSITION_MARGIN;
    const near = (v: number): number[] => [...new Set([Math.floor(v - m), Math.floor(v + m)])];
    for (const bx of near(e.x)) {
      for (const by of near(y)) {
        for (const bz of near(e.z)) {
          if (bx === home.x && by === home.y && bz === home.z) continue;
          const id = this.#store.blockAt(bx, by, bz);
          if (id === undefined) return undefined;
          if (id !== 0) continue; // a block the spider cannot be in
          const light = this.#blockLight(bx, by, bz, subtracted);
          if (light === undefined) return undefined;
          darkest = Math.min(darkest, light);
        }
      }
    }
    return darkest;
  }

  /**
   * World.getBlockLightValue at a block: its own light, or for a block that takes its
   * neighbours' brightness (Block.getUseNeighborBrightness: slabs, stairs, farmland, and
   * blocks light passes through, such as glass and plants) the brightest of the five above
   * and beside it. Which blocks those are the client does not know, so for any block but air
   * it is the darker of the two (fail closed). Undefined when a light it needs is not known.
   */
  #blockLight(x: number, y: number, z: number, subtracted: number): number | undefined {
    const own = this.#ownLight(x, y, z, subtracted);
    if (own === undefined) return undefined;
    const id = this.#store.blockAt(x, y, z);
    if (id === undefined) return undefined;
    if (id === 0) return own;
    let brightest = 0;
    for (const [dx, dy, dz] of NEIGHBOUR_LIGHT) {
      const light = this.#ownLight(x + dx, y + dy, z + dz, subtracted);
      if (light === undefined) return undefined;
      brightest = Math.max(brightest, light);
    }
    return Math.min(own, brightest);
  }

  /** Chunk.getBlockLightValue as World calls it: 0 below the world, the top block above it. */
  #ownLight(x: number, y: number, z: number, subtracted: number): number | undefined {
    if (y < 0) return 0;
    return this.#store.lightValue(x, Math.min(y, 255), z, subtracted);
  }

  /**
   * World.skylightSubtracted (light.ts) for the clock at `at`. Undefined while the time or
   * the weather is not known. Read `darkest`: the most within LIGHT_TIME_MARGIN_TICKS of the
   * clock while the daylight cycle runs (the clock may be a little off the server's), and a
   * storm while it rains and the thunder is not known. Read `brightest`: the clock as it is,
   * and no thunder that is not known.
   */
  #skylightSubtracted(at: Date, reading: 'darkest' | 'brightest' = 'darkest'): number | undefined {
    const t = this.#time;
    const w = this.#weather;
    if (t === null || w === null) return undefined;
    const elapsed = t.daylightCycle
      ? Math.max(0, Math.floor((at.getTime() - t.at.getTime()) / 50))
      : 0;
    const ticks = t.dayTicks + elapsed;
    const darkest = reading === 'darkest';
    const thunder = w.thunder ?? (darkest && w.rain > 0 ? 1 : 0);
    const margins =
      darkest && t.daylightCycle ? [-LIGHT_TIME_MARGIN_TICKS, 0, LIGHT_TIME_MARGIN_TICKS] : [0];
    let most = 0;
    for (const d of margins) {
      const time = (((ticks + d) % 24_000) + 24_000) % 24_000;
      most = Math.max(most, skylightSubtracted(time, w.rain, thunder));
    }
    return most;
  }

  /**
   * S2B's weather, as WorldServer.updateWeather sends it (Forge: to the dimension's players):
   * 7 the rain strength and 8 the thunder strength, each every tick it changes (they fade by
   * 0.01 a tick), and 1 or 2, then both, when it starts or stops raining. At a (re)join,
   * ServerConfigurationManager.updateTimeAndWeatherForPlayer sends the time (S03) and then,
   * only while the rain is above 0.2, 1, 7 and 8, with the thunder WEIGHTED by the rain
   * (getWeightedThunderStrength): the raw thunder is that over the rain. Without them it is
   * not raining, and the thunder is not known until it is next sent (it only matters while
   * it rains: #skylightSubtracted then assumes a storm).
   */
  #applyWeather(reason: number, value: number): void {
    const w = this.#weather;
    if (w === null) return; // before the (re)join's time update, or lost: not known
    const strength = Math.min(1, Math.max(0, value));
    if (reason === 7) w.rain = strength;
    else if (reason === 8) {
      if (this.#loginWeather !== 'burst') w.thunder = strength;
      else w.thunder = w.rain > 0 ? Math.min(1, strength / w.rain) : null;
    }
    // 1 and 2 (it starts or stops raining) are followed at once by both strengths.
  }

  /** Snapshot of every tracked entity (diagnostics and research tools). */
  trackedEntities(): Array<TrackedEntity & { entityId: number }> {
    return [...this.#entities].map(([entityId, e]) => ({ ...e, entityId }));
  }

  get trackedEntityCount(): number {
    return this.#entities.size;
  }

  get loadedChunkCount(): number {
    return this.#store.size;
  }

  /**
   * True once every chunk column overlapping the scan radius has arrived and settled, so
   * the entity list around the player is complete. Returns false while the server is still
   * streaming chunks after a join, respawn or teleport.
   */
  entitiesReady(now: Date): boolean {
    return this.#entitiesNotReadyReason(now) === null;
  }

  #entitiesNotReadyReason(now: Date): string | null {
    const pos = this.#position;
    if (pos === null) return 'player position unknown';
    const minX = Math.floor((pos.x - ENTITY_SCAN_RADIUS) / 16);
    const maxX = Math.floor((pos.x + ENTITY_SCAN_RADIUS) / 16);
    const minZ = Math.floor((pos.z - ENTITY_SCAN_RADIUS) / 16);
    const maxZ = Math.floor((pos.z + ENTITY_SCAN_RADIUS) / 16);
    let latest = 0;
    let missing = 0;
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const at = this.#store.receivedAt(cx, cz);
        if (at === undefined) missing += 1;
        else latest = Math.max(latest, at);
      }
    }
    if (missing > 0)
      return `waiting for ${missing} nearby chunk(s) (and their entities) from the server`;
    if (now.getTime() - latest < ENTITY_SETTLE_MS)
      return 'nearby chunks just arrived; entities still settling';
    return null;
  }

  /** A machine's block became something else (broken or replaced): it is no longer a machine. */
  #forgetReplacedMachine(x: number, y: number, z: number, blockId: number): void {
    const key = `${x},${y},${z}`;
    if (!this.#machines.has(key)) return;
    if (this.#registry?.blocks.get(blockId) !== GT_MACHINE_BLOCK) this.#machines.delete(key);
  }

  #track(entityId: number, entity: TrackedEntity): void {
    if (entityId === this.#selfEntityId) return;
    this.#entities.set(entityId, entity);
    if (this.#lightShy(entity) === undefined) this.#spiders.delete(entityId);
    else this.#spiders.add(entityId);
  }

  apply(packet: PlayPacket, at: Date): void {
    this.touch(at);
    // The (re)join's weather comes right after its time update, before anything else.
    if (this.#loginWeather === 'burst' && packet.type !== 'change-game-state') {
      this.#loginWeather = null;
    }
    this.#applyPacket(packet, at);
    if (SPIDER_WATCH_PACKETS.has(packet.type)) this.#watchSpiders(at);
  }

  #applyPacket(packet: PlayPacket, at: Date): void {
    switch (packet.type) {
      case 'join-game':
        this.#joined = true;
        this.#dimension = packet.dimension;
        this.#selfEntityId = packet.entityId;
        this.#entities.clear();
        this.#spiders.clear();
        this.#deaths = [];
        this.#machines.clear();
        this.#weather = null;
        this.#loginWeather = 'awaiting-time';
        return;
      case 'respawn':
        // New dimension or death respawn: position is unknown until the server sends it,
        // and the server re-sends every entity (and machine) in range, and the time and
        // weather. (After a death the player is a new entity, which no spider has as its
        // target yet; the agent never travels between dimensions: the policy pauses.)
        this.#dimension = packet.dimension;
        this.#position = null;
        this.#entities.clear();
        this.#spiders.clear();
        this.#weather = null;
        this.#loginWeather = 'awaiting-time';
        this.#deaths = [];
        this.#machines.clear();
        this.#store.clear();
        this.#removed = [];
        this.#dug = [];
        this.#placed = [];
        this.#blockWindows.clear();
        this.#lastBlockWindowKey = null;
        for (const w of this.#watches) this.#record(w, -1);
        return;
      case 'chunk-data': {
        const { chunkX, chunkZ } = packet.header;
        if (packet.unload) {
          this.#store.unload(chunkX, chunkZ);
          for (const [key, m] of this.#machines) {
            if (Math.floor(m.x / 16) === chunkX && Math.floor(m.z / 16) === chunkZ) {
              this.#machines.delete(key);
            }
          }
          this.#onColumnChanged(chunkX, chunkZ);
          return;
        }
        try {
          const { sections, meta, light, biomes } = decodeChunkColumnWithBiomes(
            packet.header,
            packet.groundUp,
            packet.compressed,
            this.#chunkFormat,
          );
          if (packet.groundUp) {
            this.#store.setColumn(chunkX, chunkZ, sections, at.getTime(), biomes, meta, light);
          } else {
            this.#store.updateSections(
              chunkX,
              chunkZ,
              sections,
              packet.header.primaryBitMask,
              at.getTime(),
              meta,
              light,
            );
          }
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          if (packet.groundUp) this.#store.markBad(chunkX, chunkZ, error.message, at.getTime());
          else
            this.#hazardProblem ??= `undecodable chunk update ${chunkX},${chunkZ}: ${error.message}`;
        }
        this.#onColumnChanged(chunkX, chunkZ);
        return;
      }
      case 'chunk-bulk':
        try {
          for (const c of decodeChunkBulk(
            packet.columns,
            packet.skyLight,
            packet.compressed,
            this.#chunkFormat,
          )) {
            this.#store.setColumn(
              c.header.chunkX,
              c.header.chunkZ,
              c.sections,
              at.getTime(),
              c.biomes,
              c.meta,
              c.light,
            );
          }
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          for (const c of packet.columns)
            this.#store.markBad(c.chunkX, c.chunkZ, error.message, at.getTime());
        }
        for (const c of packet.columns) this.#onColumnChanged(c.chunkX, c.chunkZ);
        return;
      case 'block-change':
        this.#onBlockChanged(packet.x, packet.y, packet.z, packet.blockId, packet.blockMeta);
        this.#forgetReplacedMachine(packet.x, packet.y, packet.z, packet.blockId);
        return;
      case 'multi-block-change':
        for (const r of packet.records) {
          this.#onBlockChanged(r.x, r.y, r.z, r.blockId, r.blockMeta);
          this.#forgetReplacedMachine(r.x, r.y, r.z, r.blockId);
        }
        return;
      case 'spawn-player':
        this.#track(packet.entityId, {
          kind: 'player',
          modType: null,
          classification: { name: `player:${packet.name}`, category: 'ignored' },
          x: packet.x,
          y: packet.y,
          z: packet.z,
        });
        return;
      case 'spawn-mob':
        this.#track(packet.entityId, {
          kind: 'mob',
          modType: null,
          classification: classifyVanillaMob(packet.mobType),
          x: packet.x,
          y: packet.y,
          z: packet.z,
          metadata: metadataMap(packet.metadata),
        });
        return;
      case 'entity-status': {
        const e = this.#entities.get(packet.entityId);
        if (e === undefined) return;
        if (packet.status === 2) {
          e.hurtCount = (e.hurtCount ?? 0) + 1;
          e.lastHurtAt = at;
        } else if (packet.status === 3 && e.diedAt == null) {
          e.diedAt = at;
          const type = e.kind === 'player' ? 'player' : e.classification.name;
          this.#deaths = [{ entityId: packet.entityId, type, at }, ...this.#deaths].slice(
            0,
            MAX_REPORTED_DEATHS,
          );
        }
        return;
      }
      case 'entity-metadata': {
        const e = this.#entities.get(packet.entityId);
        if (e === undefined) return;
        // A lost update: which values changed is not known, so none of the old ones count.
        if (packet.metadata === null) {
          e.metadata = new Map();
          if (e.item !== undefined) e.item.stack = null;
        } else {
          const merged = new Map(e.metadata ?? []);
          for (const entry of packet.metadata) {
            merged.set(entry.index, entry.value);
            // A dropped item's stack follows its spawn (EntityTrackerEntry sends the whole
            // DataWatcher at once), and again when items merge into it.
            if (
              e.item !== undefined &&
              entry.index === DROPPED_ITEM_STACK_INDEX &&
              entry.stack !== undefined
            ) {
              e.item.stack = entry.stack;
            }
          }
          e.metadata = merged;
        }
        return;
      }
      case 'spawn-object': {
        const position = { x: packet.x, y: packet.y, z: packet.z };
        this.#track(packet.entityId, {
          kind: 'object',
          modType: null,
          classification: classifyVanillaObject(packet.objectType),
          ...position,
          ...(packet.objectType === DROPPED_ITEM_OBJECT_TYPE
            ? { item: { stack: null, spawn: { ...position }, spawnedAt: at, movedAt: at } }
            : {}),
        });
        return;
      }
      case 'destroy-entities':
        for (const id of packet.entityIds) {
          this.#entities.delete(id);
          this.#spiders.delete(id);
        }
        return;
      case 'entity-move': {
        const e = this.#entities.get(packet.entityId);
        if (e !== undefined) {
          e.x += packet.dx;
          e.y += packet.dy;
          e.z += packet.dz;
          // The tracker also sends a dropped item's position every 60 ticks when it has not
          // moved (a move of nothing): only a real move counts.
          if (e.item !== undefined && (packet.dx !== 0 || packet.dy !== 0 || packet.dz !== 0)) {
            e.item.movedAt = at;
          }
        }
        return;
      }
      case 'entity-teleport': {
        const e = this.#entities.get(packet.entityId);
        if (e !== undefined) {
          if (e.item !== undefined && (e.x !== packet.x || e.y !== packet.y || e.z !== packet.z)) {
            e.item.movedAt = at;
          }
          Object.assign(e, { x: packet.x, y: packet.y, z: packet.z });
        }
        return;
      }
      case 'server-position':
        this.#position = { x: packet.x, feetY: packet.eyeY - PLAYER_EYE_HEIGHT, z: packet.z };
        return;
      case 'update-health':
        if (this.#health !== null && packet.health < this.#health.health) this.#lastHurtAt = at;
        this.#health = { health: packet.health, food: packet.food };
        return;
      case 'time-update':
        this.#time = { dayTicks: packet.dayTicks, daylightCycle: packet.daylightCycle, at };
        if (this.#loginWeather === 'awaiting-time') {
          // The (re)join's time update: its weather follows at once, only while it rains.
          this.#weather = { rain: 0, thunder: null };
          this.#loginWeather = 'burst';
        }
        return;
      case 'change-game-state':
        this.#applyWeather(packet.reason, packet.value);
        return;
      case 'held-item':
        if (packet.slot >= 0 && packet.slot <= 8) this.#heldSlot = packet.slot;
        return;
      case 'player-abilities':
        this.#abilityFlags = packet.flags;
        return;
      case 'window-items':
        if (packet.windowId === 0) {
          this.#window = [...packet.items];
          this.#inventoryProblem = null;
          this.#inventorySyncs += 1;
        } else if (packet.windowId === this.#openWindow?.windowId) {
          const w = this.#openWindow;
          if (w.fml != null || (w.block != null && w.block.profile === null)) {
            // A mod GUI, or a block the agent only looks at: any slot count is accepted and
            // the window is never clicked; where the player's slots are is known only from
            // a matching profile (or the vanilla rule).
            this.#acceptLooseWindow(w, packet.items);
          } else if (packet.items.length === w.containerSlots + 36) {
            w.slots = [...packet.items];
            w.slotsKnown = true;
            w.layout = this.#profileLayoutOf(w);
          } else {
            w.slots = [];
            w.slotsKnown = false;
            this.#inventoryProblem ??= `container window has ${packet.items.length} slots, expected ${w.containerSlots + 36}`;
          }
          this.#windowSyncs += 1;
          this.#touchBlockWindow(at);
        }
        return;
      case 'set-slot':
        if (packet.windowId === -1 && packet.slot === -1) {
          this.#cursor = packet.item;
          this.#cursorSyncs += 1;
        } else if (packet.windowId === 0 && this.#window !== null && packet.slot >= 0) {
          while (this.#window.length <= packet.slot) this.#window.push(null);
          this.#window[packet.slot] = packet.item;
        } else if (
          packet.windowId === this.#openWindow?.windowId &&
          this.#openWindow.slotsKnown &&
          packet.slot >= 0 &&
          packet.slot < this.#openWindow.slots.length
        ) {
          const slots = [...this.#openWindow.slots];
          slots[packet.slot] = packet.item;
          this.#openWindow.slots = slots;
          this.#touchBlockWindow(at);
        }
        return;
      case 'open-window': {
        this.#closeWindow();
        const block = this.#expectedBlock;
        this.#openWindow = {
          windowId: packet.windowId,
          inventoryType: packet.inventoryType,
          containerSlots: containerSlotsOf(packet.inventoryType, packet.slotCount),
          slots: [],
          slotsKnown: false,
          cursor: null,
          containerId: this.#expectedContainer,
          title: packet.title,
          announcedSlots: packet.slotCount,
          layout: null,
          fml: null,
          block,
          layoutKnown: true,
          clickable: block === null || profileClickable(block.profile),
          properties: new Map(),
        };
        this.#expectedContainer = null;
        this.#expectedBlock = null;
        return;
      }
      case 'window-property': {
        const w = this.#openWindow;
        if (w !== null && packet.windowId === w.windowId && packet.property >= 0) {
          w.properties ??= new Map();
          w.properties.set(packet.property, packet.value);
          this.#touchBlockWindow(at);
        }
        return;
      }
      case 'close-window':
        if (packet.windowId === this.#openWindow?.windowId) this.#closeWindow();
        return;
      case 'confirm-transaction':
        return; // the client matches confirmations to its clicks
      case 'chat':
        this.#chat.push(packet.json.slice(0, 500));
        if (this.#chat.length > 20) this.#chat.shift();
        return;
      case 'keep-alive':
      case 'spawn-position':
      case 'plugin-message':
      case 'disconnect':
      case 'unhandled':
        return;
    }
  }

  toGameState(now: Date): GameState {
    this.#watchSpiders(now);
    const pos = this.#position;
    const interactables = this.#interactables();
    const state: GameState = {
      schemaVersion: GAME_STATE_SCHEMA_VERSION,
      timestamp: (this.#lastPacketAt ?? now).toISOString(),
      source: 'gtnh1710',
      player: {
        position:
          pos === null
            ? unknown('no position from the server yet')
            : known({ x: pos.x, y: pos.feetY, z: pos.z }),
        dimension:
          this.#dimension === null
            ? unknown('not joined yet')
            : known(dimensionName(this.#dimension)),
        health:
          this.#health === null
            ? unknown('no health update yet (the server only sends it once the player is ticked)')
            : known(this.#health.health),
        hunger: this.#health === null ? unknown('no food update yet') : known(this.#health.food),
        armor: this.#armor(),
        heldTool: this.#heldTool(),
        weapon: this.#weapon(),
        lastHurtAt: this.#lastHurtAt === null ? null : this.#lastHurtAt.toISOString(),
      },
      inventory: this.#inventory(),
      nearbyThreats: this.#threats(now),
      nearbyEntities: this.#nearbyEntitiesState(now),
      environmentHazards: this.#hazards(),
      nearbyBlocks: this.#nearbyBlocks(),
      time: this.#worldTime(now),
      questBook: this.#modVersions.has('betterquesting')
        ? this.#questBook.toState(this.#questScope)
        : unknown('the server does not run Better Questing'),
      power: {
        availableEUt: unknown('GTNH EU is not observable through the protocol'),
        generators: [],
      },
      machines: this.#machinesState(),
      storage: [...this.#storageState(), ...this.#observedStorage(interactables)].slice(0, 512),
      craftingTables: [
        ...this.#craftingTables.map((t) => ({
          id: t.id,
          name: t.name,
          position: known({ ...t.position }),
        })),
        ...this.#observedCraftingTables(interactables),
      ].slice(0, 64),
      interactables,
      blockWindow: this.#blockWindowState(),
      openContainerId: this.#openWindow?.containerId ?? null,
      currentTask: null,
      knownRecipeState: null,
      lastAction: null,
    };
    return GameStateSchema.parse(state);
  }

  /**
   * Storage blocks the scan found (a profile whose slots are all storage: chests, Iron
   * Chests) that are not configured containers: `<profile>:<x>.<y>.<z>`. Their contents are
   * known while the agent has the block open; the agent's container memory keeps them after.
   */
  #observedStorage(interactables: GameState['interactables']): GameState['storage'] {
    if (!interactables.known) return [];
    const configured = new Set(this.#containers.map((c) => positionKey(c.position)));
    const open = this.#openWindow;
    const out: GameState['storage'] = [];
    for (const b of interactables.value.blocks) {
      if (b.profile === null || !INTERACTION_PROFILES[b.profile].storage) continue;
      if (configured.has(positionKey(b.position))) continue;
      const { x, y, z } = b.position;
      const isOpen =
        open !== null &&
        open.slotsKnown &&
        open.layout != null &&
        open.block?.profile === b.profile &&
        positionKey(open.block.position) === positionKey(b.position);
      out.push({
        id: observedStorageId(b.profile, b.position),
        name: `${INTERACTION_PROFILES[b.profile].label} at (${x}, ${y}, ${z})`,
        position: known({ x, y, z }),
        items: isOpen
          ? this.#containerCounts(open)
          : unknown('contents are known only while the agent has it open'),
      });
    }
    return out;
  }

  /** Item counts of an open window's container slots (unknown if a stack cannot be named). */
  #containerCounts(w: OpenWindow): GameState['storage'][number]['items'] {
    const counts: Record<string, number> = {};
    for (let i = 0; i < w.containerSlots; i++) {
      const s = w.slots[i];
      if (s == null) continue;
      const naming = nameItemStack(this.#registry, s.id, s.damage);
      if (!naming.ok) return unknown(naming.reason);
      counts[naming.name] = (counts[naming.name] ?? 0) + s.count;
    }
    return known(counts);
  }

  /**
   * Vanilla crafting tables the scan found that are not configured ones (same position):
   * CRAFT_ITEM may use them too, as `crafting_table:<x>.<y>.<z>`.
   */
  #observedCraftingTables(interactables: GameState['interactables']): GameState['craftingTables'] {
    if (!interactables.known) return [];
    const configured = new Set(this.#craftingTables.map((t) => positionKey(t.position)));
    return interactables.value.blocks
      .filter((b) => b.profile === 'crafting_table' && !configured.has(positionKey(b.position)))
      .map((b) => {
        const { x, y, z } = b.position;
        return {
          id: observedTableId(b.position),
          name: `Crafting table at (${x}, ${y}, ${z})`,
          position: known({ x, y, z }),
        };
      });
  }

  /**
   * The world's clock: the last S03 (the server sends one every second), advanced by the
   * time since it arrived while the daylight cycle runs.
   */
  #worldTime(now: Date): GameState['time'] {
    const t = this.#time;
    if (t === null) return unknown('no time update from the server yet');
    const elapsed = t.daylightCycle
      ? Math.max(0, Math.floor((now.getTime() - t.at.getTime()) / 50))
      : 0;
    return known(worldTime(t.dayTicks + elapsed, t.daylightCycle));
  }

  /** Configured chests; contents are known only while the agent has that chest open. */
  #storageState(): GameState['storage'] {
    return this.#containers.map((c) => {
      const w = this.#openWindow;
      let items: GameState['storage'][number]['items'] = unknown(
        'chest contents are known only while the agent has it open',
      );
      if (w !== null && w.containerId === c.id && w.slotsKnown) {
        const counts: Record<string, number> = {};
        let problem: string | null = null;
        for (let i = 0; i < w.containerSlots; i++) {
          const s = w.slots[i];
          if (s == null) continue;
          const naming = nameItemStack(this.#registry, s.id, s.damage);
          if (!naming.ok) {
            problem = naming.reason;
            break;
          }
          counts[naming.name] = (counts[naming.name] ?? 0) + s.count;
        }
        items = problem === null ? known(counts) : unknown(problem);
      }
      return { id: c.id, name: c.name, position: known({ ...c.position }), items };
    });
  }

  /** GregTech machines within MACHINE_SCAN_RADIUS, nearest first. Stored energy is never sent. */
  #machinesState(): GameState['machines'] {
    const pos = this.#position;
    if (pos === null || this.#machineProblem !== null) return [];
    return [...this.#machines.values()]
      .map((m) => ({
        m,
        d: Math.hypot(m.x + 0.5 - pos.x, m.y + 0.5 - pos.feetY, m.z + 0.5 - pos.z),
      }))
      .filter(({ d }) => d <= MACHINE_SCAN_RADIUS)
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_REPORTED_MACHINES)
      .map(({ m }) => ({
        id: `gt:${m.x}.${m.y}.${m.z}`,
        name: m.name,
        position: known({ x: m.x, y: m.y, z: m.z }),
        status: machineStatus(m.common),
        powered: unknown('GregTech does not send stored energy to clients'),
        lastInspectedAt: null,
      }));
  }

  #threats(now: Date): GameState['nearbyThreats'] {
    if (this.#entityProblem !== null) return unknown(this.#entityProblem);
    if (!this.#joined) return unknown('not joined yet');
    const notReady = this.#entitiesNotReadyReason(now);
    if (notReady !== null) return unknown(notReady);
    const nearby = this.nearbyEntities(ENTITY_SCAN_RADIUS, now);
    // A calm spider threatens nobody (it is still listed in nearbyEntities).
    const hostile = nearby.filter((e) => e.category === 'hostile' && !e.calm);
    const unclassified = nearby.filter((e) => e.category === 'unclassified');
    return known({
      scanRadius: ENTITY_SCAN_RADIUS,
      hostileCount: hostile.length,
      nearestHostileDistance: hostile[0]?.distance ?? null,
      unclassifiedCount: unclassified.length,
      nearestUnclassifiedDistance: unclassified[0]?.distance ?? null,
    });
  }

  /**
   * The entities behind #threats: everything it counts (and players), nearest first, with
   * health and the like from their metadata. Known exactly when the threats are.
   */
  #nearbyEntitiesState(now: Date): GameState['nearbyEntities'] {
    const threats = this.#threats(now);
    if (!threats.known) return unknown(threats.reason);
    const entities: StateEntity[] = [];
    for (const n of this.nearbyEntities(ENTITY_SCAN_RADIUS, now)) {
      const e = this.combatEntity(n.entityId, now);
      if (e !== null) {
        entities.push({
          id: e.id,
          type: e.type,
          category: e.category,
          kind: e.kind,
          position: e.position,
          distance: e.distance,
          health: e.health,
          owned: e.owned,
          baby: e.baby,
          lastHurtAt: e.lastHurtAt,
          // As #threats counted it.
          calm: n.calm,
        });
      }
      if (entities.length >= MAX_REPORTED_ENTITIES) break;
    }
    return known({
      scanRadius: ENTITY_SCAN_RADIUS,
      entities,
      recentDeaths: this.#deaths.map((d) => ({
        id: d.entityId,
        type: d.type,
        at: d.at.toISOString(),
      })),
    });
  }

  /**
   * A tracked entity as the GameState lists it (and as the combat code checks it), calm as
   * of `now` (by default the last packet's time), or null when it is not tracked, not listed
   * (a dropped item, an arrow) or the position is unknown.
   */
  combatEntity(
    entityId: number,
    now: Date = this.#lastPacketAt ?? new Date(0),
  ): (StateEntity & { hurtCount: number; dead: boolean }) | null {
    const e = this.#entities.get(entityId);
    const pos = this.#position;
    if (e === undefined || pos === null) return null;
    const category = listedCategory(e.kind, e.classification);
    if (category === null) return null;
    const type = e.kind === 'player' ? 'player' : e.classification.name;
    const vitals = vitalsOf(type, e.metadata ?? null);
    const distance = Number(Math.hypot(e.x - pos.x, e.y - pos.feetY, e.z - pos.z).toFixed(2));
    return {
      id: entityId,
      type,
      category,
      kind: e.kind === 'modded' ? 'mob' : e.kind,
      position: { x: e.x, y: e.y, z: e.z },
      distance,
      health: vitals.health,
      owned: vitals.owned,
      baby: vitals.baby,
      lastHurtAt: e.lastHurtAt == null ? null : e.lastHurtAt.toISOString(),
      calm: this.#isCalm(e, distance, now),
      hurtCount: e.hurtCount ?? 0,
      dead: e.diedAt != null,
    };
  }

  /** Whether the server announced this entity's death on this connection. */
  hasDied(entityId: number): boolean {
    return this.#deaths.some((d) => d.entityId === entityId);
  }

  /**
   * The hotbar as the client would click it (registry names without @damage), or null while
   * the inventory is not known.
   */
  hotbar(): HotbarSlot[] | null {
    const storage = this.playerStorage();
    if (storage === null) return null;
    return storage.slice(27, 36).map((s, slot) => {
      if (s === null) return { slot, name: null, hasNbt: false };
      const naming = nameItemStack(this.#registry, s.id, s.damage);
      return {
        slot,
        name: naming.ok ? naming.name.replace(/@\d+$/, '') : `item#${s.id}`,
        hasNbt: s.hasNbt,
      };
    });
  }

  /**
   * What ATTACK_ENTITY would strike with: the best allowlisted weapon in the hotbar, else a
   * bare hand when a hotbar slot is empty; unknown when it could strike with neither.
   */
  #weapon(): GameState['player']['weapon'] {
    const hotbar = this.hotbar();
    if (hotbar === null) return unknown('inventory not known');
    const best = chooseWeapon(hotbar, this.#heldSlot);
    if (best !== null) return known(best.weapon);
    if (hotbar.some((s) => s.name === null)) return known({ ...BARE_HAND });
    return unknown('no allowlisted weapon and no empty hotbar slot: the agent cannot strike');
  }

  #hazards(): GameState['environmentHazards'] {
    if (this.#hazardProblem !== null) return unknown(this.#hazardProblem);
    if (!this.#joined) return unknown('not joined yet');
    const pos = this.#position;
    if (pos === null) return unknown('player position unknown');
    if (this.#blockCodes === null) return unknown('block registry not received yet');
    const scan = scanHazards(this.#store, this.#blockCodes, { x: pos.x, y: pos.feetY, z: pos.z });
    if (!scan.ok) return unknown(scan.reason);
    return known({
      scanRadius: scan.scanRadius,
      lavaNearby: scan.hazards.some((h) => h.kind === 'lava'),
      voidNearby: scan.hazards.some((h) => h.kind === 'void'),
      hazards: scan.hazards.map(({ kind, position }) => ({ kind, position })),
    });
  }

  /**
   * Diggable blocks within RESOURCE_SCAN_RADIUS, recently removed ones (still air), the cells
   * a block could be placed into (placing.ts), and recently placed blocks (still there).
   */
  #nearbyBlocks(): GameState['nearbyBlocks'] {
    if (this.#hazardProblem !== null) return unknown(this.#hazardProblem);
    if (!this.#joined) return unknown('not joined yet');
    const pos = this.#position;
    if (pos === null) return unknown('player position unknown');
    const table = this.#diggable;
    if (table === null) return unknown('block registry not received yet');
    const feet = { x: pos.x, y: pos.feetY, z: pos.z };
    const scan = scanResources(
      this.#store,
      table,
      feet,
      RESOURCE_SCAN_RADIUS,
      MAX_REPORTED_RESOURCES,
      this.#seeThrough ?? undefined,
    );
    if (!scan.ok) return unknown(scan.reason);
    const near = (p: { x: number; y: number; z: number }): boolean =>
      Math.hypot(p.x + 0.5 - feet.x, p.y + 0.5 - feet.y, p.z + 0.5 - feet.z) <=
      RESOURCE_SCAN_RADIUS;
    const others = this.#removed.filter(
      (p) => !this.#dug.some((d) => d.x === p.x && d.y === p.y && d.z === p.z),
    );
    const removed = [...this.#dug, ...others]
      .filter((p) => this.#store.blockAt(p.x, p.y, p.z) === 0 && near(p))
      .slice(0, MAX_REPORTED_REMOVED);
    const placed = this.#placed
      .filter((p) => this.#store.blockAt(p.x, p.y, p.z) === p.id && near(p))
      .slice(0, MAX_REPORTED_PLACED);
    const world = this.walkWorld();
    const entities = this.trackedEntities().filter(
      (e) => Math.hypot(e.x - feet.x, e.y - feet.y, e.z - feet.z) <= PLACE_SCAN_ENTITY_RADIUS,
    );
    const placeable =
      world === null ? [] : scanPlaceable(world, feet, entities, MAX_REPORTED_PLACEABLE);
    return known({
      scanRadius: scan.scanRadius,
      resources: scan.resources.map(({ block, position }) => ({ block, position })),
      removed: removed.map((p) => ({ ...p })),
      placeable: placeable.map(({ position, takesFalling }) => ({
        position: { ...position },
        takesFalling,
      })),
      placed: placed.map(({ block, x, y, z }) => ({ block, position: { x, y, z } })),
    });
  }

  /** Hazard scan with a custom radius, for diagnostics only (the agent always uses the default). */
  diagnosticHazardScan(radius: number): HazardScan | null {
    const pos = this.#position;
    if (pos === null || this.#blockCodes === null) return null;
    return scanHazards(this.#store, this.#blockCodes, { x: pos.x, y: pos.feetY, z: pos.z }, radius);
  }

  /** The player's feet position: where the client walked it, or where the server placed it. */
  get ownPosition(): Vec3 | null {
    const p = this.#position;
    return p === null ? null : { x: p.x, y: p.feetY, z: p.z };
  }

  /** Walking: the client moved the player (the server only reports corrections, as S08). */
  setOwnPosition(p: Vec3): void {
    this.#position = { x: p.x, feetY: p.y, z: p.z };
    // Walking toward a spider in the dark brings it within its reach.
    this.#watchSpiders(this.#lastPacketAt ?? new Date(0));
  }

  get health(): number | null {
    return this.#health?.health ?? null;
  }

  /**
   * Whether the server keeps the player from taking damage (S39 flag 1), or null before it
   * said. GTNH's AngerMod does so for up to 90 s after each join (spawn protection), and a
   * player that cannot be hurt cannot eat either (EntityPlayer.canEat).
   */
  get damageDisabled(): boolean | null {
    return this.#abilityFlags === null ? null : (this.#abilityFlags & 1) !== 0;
  }

  /** The food level (0-20), or null before the server sent it. */
  get food(): number | null {
    return this.#health?.food ?? null;
  }

  /** The player's item counts (as the GameState reports them), or null while unknown. */
  inventoryItems(): Record<string, number> | null {
    const inv = this.#inventory();
    return inv.known ? { ...inv.value.items } : null;
  }

  /**
   * Live block access for walking; null while the registry or block data is missing or
   * unreliable. Lookups stay live: if the block data becomes unreliable mid-walk, every
   * block reads as not loaded and the walk stops.
   */
  walkWorld(): WalkWorld | null {
    const registry = this.#registry;
    const codes = this.#blockCodes;
    if (registry === null || codes === null || this.#hazardProblem !== null) return null;
    return {
      blockAt: (x, y, z) =>
        this.#hazardProblem === null ? this.#store.blockAt(x, y, z) : undefined,
      metaAt: (x, y, z) => (this.#hazardProblem === null ? this.#store.metaAt(x, y, z) : undefined),
      blockName: (id) => registry.blocks.get(id),
      hazardCode: (id) => codes[id] ?? BLOCK_CODE.unknown,
    };
  }

  /** Block id at a position (diagnostics/tests); undefined if its chunk is not loaded. */
  blockAt(x: number, y: number, z: number): number | undefined {
    return this.#store.blockAt(x, y, z);
  }

  /** Block metadata at a position (diagnostics/tests); undefined while not known. */
  metaAt(x: number, y: number, z: number): number | undefined {
    return this.#store.metaAt(x, y, z);
  }

  /**
   * The light level World.getBlockLightValue gives a block at `now` (diagnostics/tests;
   * #blockLight), the time of day's darkness included; undefined while not known.
   */
  lightLevelAt(x: number, y: number, z: number, now: Date): number | undefined {
    const subtracted = this.#skylightSubtracted(now);
    return subtracted === undefined ? undefined : this.#blockLight(x, y, z, subtracted);
  }

  /** One loaded column with its biomes, for world surveys; undefined while unknown. */
  chunkColumn(cx: number, cz: number): ColumnView | undefined {
    return this.#hazardProblem === null ? this.#store.column(cx, cz) : undefined;
  }

  /** The dimension's name, or null before joining. */
  get dimension(): string | null {
    return this.#dimension === null ? null : dimensionName(this.#dimension);
  }

  /** The world's clock now (as in the GameState), or null before the first time update. */
  worldTimeAt(now: Date): WorldTime | null {
    const t = this.#worldTime(now);
    return t.known ? t.value : null;
  }

  #armor(): GameState['player']['armor'] {
    if (this.#inventoryProblem !== null) return unknown(this.#inventoryProblem);
    const w = this.#window;
    if (w === null || w.length < MIN_PLAYER_WINDOW_SLOTS)
      return unknown('inventory not received yet');
    const pieces = ARMOR_SLOTS.filter((s) => w[s] !== null && w[s] !== undefined).length;
    return pieces === 0
      ? known({ equippedPieces: 0, lowestDurabilityFraction: null })
      : unknown('armor durability of modded items is not known yet');
  }

  #heldTool(): GameState['player']['heldTool'] {
    if (this.#inventoryProblem !== null) return unknown(this.#inventoryProblem);
    const slots = this.#playerSlots();
    if (typeof slots === 'string') return unknown(slots);
    const stack = slots[HOTBAR_FIRST - STORAGE_FIRST + this.#heldSlot];
    if (stack === null || stack === undefined) return known(null);
    // An allowlisted tool (src/domain/tools.ts) without NBT data: its damage value is its wear.
    const base = this.#registry?.items.get(stack.id);
    const tool = base === undefined ? null : toolInfo(base);
    if (tool === null || stack.hasNbt || stack.count !== 1) {
      return unknown('held item durability is not known (only allowlisted tools without NBT data)');
    }
    return known({
      item: tool.item,
      durabilityFraction: usesLeft(tool, stack.damage) / tool.maxDamage,
    });
  }

  /** The player's 36 storage slots (main, then hotbar), or null while they are not known. */
  playerStorage(): Array<ItemStackData | null> | null {
    if (this.#inventoryProblem !== null) return null;
    const slots = this.#playerSlots();
    return typeof slots === 'string' ? null : slots.map((s) => s ?? null);
  }

  /**
   * The player's 36 storage slots (27 main, then 9 hotbar): from the open container window
   * while there is one (window 0 is not updated then), otherwise from window 0.
   */
  #playerSlots(): Array<ItemStackData | null> | string {
    const open = this.#openWindow;
    if (open !== null) {
      if (!open.slotsKnown) return 'container window contents not received yet';
      if (open.layoutKnown === false) {
        return 'a window whose slot layout is unknown is open (the inventory part cannot be placed)';
      }
      return open.slots.slice(open.containerSlots, open.containerSlots + 36);
    }
    const w = this.#window;
    if (w === null) return 'inventory not received yet';
    if (w.length < MIN_PLAYER_WINDOW_SLOTS) return `unexpected player window size ${w.length}`;
    return w.slice(STORAGE_FIRST, STORAGE_LAST + 1);
  }

  #inventory(): Known<{ items: Record<string, number>; usedSlots: number; capacitySlots: number }> {
    if (this.#inventoryProblem !== null) return unknown(this.#inventoryProblem);
    const slots = this.#playerSlots();
    if (typeof slots === 'string') return unknown(slots);
    const items: Record<string, number> = {};
    let usedSlots = 0;
    for (let i = 0; i < slots.length; i++) {
      const slot = STORAGE_FIRST + i;
      const stack = slots[i];
      if (stack === null || stack === undefined) continue;
      if (stack.count <= 0) return unknown(`slot ${slot} has a non-positive stack size`);
      const naming = nameItemStack(this.#registry, stack.id, stack.damage);
      if (!naming.ok) return unknown(naming.reason);
      items[naming.name] = (items[naming.name] ?? 0) + stack.count;
      usedSlots += 1;
    }
    return known({ items, usedSlots, capacitySlots: STORAGE_LAST - STORAGE_FIRST + 1 });
  }
}
