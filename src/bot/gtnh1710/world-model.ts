import { BARE_HAND } from '../../domain/combat.ts';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  MAX_REPORTED_DEATHS,
  MAX_REPORTED_ENTITIES,
  MAX_REPORTED_REMOVED,
  worldTime,
  type GameState,
  type NearbyEntity as StateEntity,
} from '../../domain/game-state.ts';
import { chooseWeapon, listedCategory, vitalsOf, type HotbarSlot } from './combat.ts';
import { known, unknown, type Known } from '../../domain/known.ts';
import {
  buildDiggableTable,
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
import {
  GT_EVENT_CHANGE_COMMON_DATA,
  machineFlags,
  machineNamesFor,
  machineStatus,
  type GregTechMessage,
  type MachineFlags,
} from './gregtech.ts';
import { ChunkStore, decodeChunkBulk, decodeChunkColumn, type ChunkFormat } from './chunk-data.ts';
import { scanHazards, type HazardScan } from './hazard-scan.ts';
import type { WindowSnapshot } from './container.ts';
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

/** Window 0 as a click target: slots 0-8 (result, 2x2 grid, armor) before the player's 36. */
const INVENTORY_WINDOW_CONTAINER_SLOTS = 9;

/** A chest or crafting table the agent may use (from config). */
export interface ContainerDefinition {
  id: string;
  name: string;
  position: { x: number; y: number; z: number };
}

/** The container window the server has open for the player (window 0, the inventory, excluded). */
export interface OpenWindow extends WindowSnapshot {
  windowId: number;
  inventoryType: number;
  /** The configured container it belongs to, when the agent opened it; null otherwise. */
  containerId: string | null;
  /** Slots are known once the server has sent them (S30); until then `slots` is empty. */
  slotsKnown: boolean;
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
}

/** Positions of removed diggable blocks remembered per connection (most recent first). */
const MAX_REMEMBERED_REMOVALS = 64;

/**
 * Folds decoded server packets into what the agent knows. Pure: no sockets, no timers.
 * Anything not (yet) observed, or not reliably interpretable, is reported as unknown.
 */
export class WorldModel {
  #registry: Registry | null = null;
  #dimension: number | null = null;
  #position: PlayerPosition | null = null;
  #health: { health: number; food: number } | null = null;
  /** The last S03: the day time then, whether it advances, and when it arrived. */
  #time: { dayTicks: number; daylightCycle: boolean; at: Date } | null = null;
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
  /** Deaths the server announced on this connection, most recent first. */
  #deaths: DeathRecord[] = [];
  #selfEntityId: number | null = null;

  /** The player's own entity id (from Join Game), or null before it arrived. */
  get selfEntityId(): number | null {
    return this.#selfEntityId;
  }
  /** Set when an entity packet could not be decoded: the entity picture may be incomplete. */
  #entityProblem: string | null = null;
  /** Loaded chunk columns: arrival times (for entity readiness) and block ids (for hazards). */
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
  /** Where the server turned a diggable block into air, most recent first. */
  #removed: Array<{ x: number; y: number; z: number }> = [];
  readonly #watches = new Set<BlockWatch>();

  setRegistry(registry: Registry): void {
    this.#registry = registry;
    this.#blockCodes = buildBlockCodeTable(registry);
    this.#diggable = buildDiggableTable(registry);
  }

  /** Records every update the server sends for this block until unwatch(). */
  watchBlock(x: number, y: number, z: number): BlockWatch {
    const w: BlockWatch = { x, y, z, updates: [] };
    this.#watches.add(w);
    return w;
  }

  unwatch(w: BlockWatch): void {
    this.#watches.delete(w);
  }

  /** A single block changed: remember removed diggable blocks, and tell the watchers. */
  #onBlockChanged(x: number, y: number, z: number, id: number): void {
    const before = this.#store.blockAt(x, y, z);
    this.#store.setBlock(x, y, z, id);
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
    for (const w of this.#watches) {
      if (w.x === x && w.y === y && w.z === z) w.updates.push(this.#store.blockAt(x, y, z) ?? -1);
    }
  }

  /** A whole column (or some of its sections) arrived or went: tell the watchers in it. */
  #onColumnChanged(chunkX: number, chunkZ: number): void {
    for (const w of this.#watches) {
      if (Math.floor(w.x / 16) === chunkX && Math.floor(w.z / 16) === chunkZ) {
        w.updates.push(this.#store.blockAt(w.x, w.y, w.z) ?? -1);
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
  }

  /** The client closed the window (C0D). */
  closeWindowLocally(): void {
    this.#closeWindow();
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
      this.#window !== null &&
      this.#window.length >= MIN_PLAYER_WINDOW_SLOTS
    ) {
      for (let i = 0; i < 36; i++)
        this.#window[STORAGE_FIRST + i] = w.slots[w.containerSlots + i] ?? null;
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
      case 0x07:
      case 0x08:
        this.#position = null;
        return;
      case 0x1c:
        // An entity's metadata update was lost, and which entity is not known: every
        // entity's health, name tag and age become unknown until they are sent again.
        for (const e of this.#entities.values()) e.metadata = new Map();
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
      case 'fml-other':
        return;
    }
  }

  /**
   * Every tracked entity within `radius` of the player, nearest first. An entity the server
   * said died (it lies in its death animation until it is removed) is no longer counted.
   */
  nearbyEntities(radius = ENTITY_SCAN_RADIUS): NearbyEntity[] {
    const pos = this.#position;
    if (pos === null) return [];
    const out: NearbyEntity[] = [];
    for (const [entityId, e] of this.#entities) {
      if (e.diedAt != null) continue;
      const distance = Math.hypot(e.x - pos.x, e.y - pos.feetY, e.z - pos.z);
      if (distance <= radius) {
        out.push({
          entityId,
          kind: e.kind,
          name: e.classification.name,
          category: e.classification.category,
          distance: Number(distance.toFixed(2)),
        });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
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
  }

  apply(packet: PlayPacket, at: Date): void {
    this.touch(at);
    switch (packet.type) {
      case 'join-game':
        this.#joined = true;
        this.#dimension = packet.dimension;
        this.#selfEntityId = packet.entityId;
        this.#entities.clear();
        this.#deaths = [];
        this.#machines.clear();
        return;
      case 'respawn':
        // New dimension or death respawn: position is unknown until the server sends it,
        // and the server re-sends every entity (and machine) in range.
        this.#dimension = packet.dimension;
        this.#position = null;
        this.#entities.clear();
        this.#deaths = [];
        this.#machines.clear();
        this.#store.clear();
        this.#removed = [];
        for (const w of this.#watches) w.updates.push(-1);
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
          const sections = decodeChunkColumn(
            packet.header,
            packet.groundUp,
            packet.compressed,
            this.#chunkFormat,
          );
          if (packet.groundUp) this.#store.setColumn(chunkX, chunkZ, sections, at.getTime());
          else
            this.#store.updateSections(
              chunkX,
              chunkZ,
              sections,
              packet.header.primaryBitMask,
              at.getTime(),
            );
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
            this.#store.setColumn(c.header.chunkX, c.header.chunkZ, c.sections, at.getTime());
          }
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          for (const c of packet.columns)
            this.#store.markBad(c.chunkX, c.chunkZ, error.message, at.getTime());
        }
        for (const c of packet.columns) this.#onColumnChanged(c.chunkX, c.chunkZ);
        return;
      case 'block-change':
        this.#onBlockChanged(packet.x, packet.y, packet.z, packet.blockId);
        this.#forgetReplacedMachine(packet.x, packet.y, packet.z, packet.blockId);
        return;
      case 'multi-block-change':
        for (const r of packet.records) {
          this.#onBlockChanged(r.x, r.y, r.z, r.blockId);
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
        if (packet.metadata === null) e.metadata = new Map();
        else {
          const merged = new Map(e.metadata ?? []);
          for (const entry of packet.metadata) merged.set(entry.index, entry.value);
          e.metadata = merged;
        }
        return;
      }
      case 'spawn-object':
        this.#track(packet.entityId, {
          kind: 'object',
          modType: null,
          classification: classifyVanillaObject(packet.objectType),
          x: packet.x,
          y: packet.y,
          z: packet.z,
        });
        return;
      case 'destroy-entities':
        for (const id of packet.entityIds) this.#entities.delete(id);
        return;
      case 'entity-move': {
        const e = this.#entities.get(packet.entityId);
        if (e !== undefined) {
          e.x += packet.dx;
          e.y += packet.dy;
          e.z += packet.dz;
        }
        return;
      }
      case 'entity-teleport': {
        const e = this.#entities.get(packet.entityId);
        if (e !== undefined) Object.assign(e, { x: packet.x, y: packet.y, z: packet.z });
        return;
      }
      case 'server-position':
        this.#position = { x: packet.x, feetY: packet.eyeY - PLAYER_EYE_HEIGHT, z: packet.z };
        return;
      case 'update-health':
        this.#health = { health: packet.health, food: packet.food };
        return;
      case 'time-update':
        this.#time = { dayTicks: packet.dayTicks, daylightCycle: packet.daylightCycle, at };
        return;
      case 'held-item':
        if (packet.slot >= 0 && packet.slot <= 8) this.#heldSlot = packet.slot;
        return;
      case 'window-items':
        if (packet.windowId === 0) {
          this.#window = [...packet.items];
          this.#inventoryProblem = null;
          this.#inventorySyncs += 1;
        } else if (packet.windowId === this.#openWindow?.windowId) {
          const w = this.#openWindow;
          if (packet.items.length === w.containerSlots + 36) {
            w.slots = [...packet.items];
            w.slotsKnown = true;
          } else {
            w.slots = [];
            w.slotsKnown = false;
            this.#inventoryProblem ??= `container window has ${packet.items.length} slots, expected ${w.containerSlots + 36}`;
          }
          this.#windowSyncs += 1;
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
        }
        return;
      case 'open-window':
        this.#closeWindow();
        this.#openWindow = {
          windowId: packet.windowId,
          inventoryType: packet.inventoryType,
          containerSlots: containerSlotsOf(packet.inventoryType, packet.slotCount),
          slots: [],
          slotsKnown: false,
          cursor: null,
          containerId: this.#expectedContainer,
        };
        this.#expectedContainer = null;
        return;
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
    const pos = this.#position;
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
      },
      inventory: this.#inventory(),
      nearbyThreats: this.#threats(now),
      nearbyEntities: this.#nearbyEntitiesState(now),
      environmentHazards: this.#hazards(),
      nearbyBlocks: this.#nearbyBlocks(),
      time: this.#worldTime(now),
      power: {
        availableEUt: unknown('GTNH EU is not observable through the protocol'),
        generators: [],
      },
      machines: this.#machinesState(),
      storage: this.#storageState(),
      craftingTables: this.#craftingTables.map((t) => ({
        id: t.id,
        name: t.name,
        position: known({ ...t.position }),
      })),
      openContainerId: this.#openWindow?.containerId ?? null,
      currentTask: null,
      knownRecipeState: null,
      lastAction: null,
    };
    return GameStateSchema.parse(state);
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
    const nearby = this.nearbyEntities(ENTITY_SCAN_RADIUS);
    const hostile = nearby.filter((e) => e.category === 'hostile');
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
    for (const n of this.nearbyEntities(ENTITY_SCAN_RADIUS)) {
      const e = this.combatEntity(n.entityId);
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
   * A tracked entity as the GameState lists it (and as the combat code checks it), or null
   * when it is not tracked, not listed (a dropped item, an arrow) or the position is unknown.
   */
  combatEntity(entityId: number): (StateEntity & { hurtCount: number; dead: boolean }) | null {
    const e = this.#entities.get(entityId);
    const pos = this.#position;
    if (e === undefined || pos === null) return null;
    const category = listedCategory(e.kind, e.classification);
    if (category === null) return null;
    const type = e.kind === 'player' ? 'player' : e.classification.name;
    const vitals = vitalsOf(type, e.metadata ?? null);
    return {
      id: entityId,
      type,
      category,
      kind: e.kind === 'modded' ? 'mob' : e.kind,
      position: { x: e.x, y: e.y, z: e.z },
      distance: Number(Math.hypot(e.x - pos.x, e.y - pos.feetY, e.z - pos.z).toFixed(2)),
      health: vitals.health,
      owned: vitals.owned,
      baby: vitals.baby,
      lastHurtAt: e.lastHurtAt == null ? null : e.lastHurtAt.toISOString(),
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

  /** Diggable blocks within RESOURCE_SCAN_RADIUS, and recently removed ones (still air). */
  #nearbyBlocks(): GameState['nearbyBlocks'] {
    if (this.#hazardProblem !== null) return unknown(this.#hazardProblem);
    if (!this.#joined) return unknown('not joined yet');
    const pos = this.#position;
    if (pos === null) return unknown('player position unknown');
    const table = this.#diggable;
    if (table === null) return unknown('block registry not received yet');
    const feet = { x: pos.x, y: pos.feetY, z: pos.z };
    const scan = scanResources(this.#store, table, feet);
    if (!scan.ok) return unknown(scan.reason);
    const removed = this.#removed
      .filter(
        (p) =>
          this.#store.blockAt(p.x, p.y, p.z) === 0 &&
          Math.hypot(p.x + 0.5 - feet.x, p.y + 0.5 - feet.y, p.z + 0.5 - feet.z) <=
            RESOURCE_SCAN_RADIUS,
      )
      .slice(0, MAX_REPORTED_REMOVED);
    return known({
      scanRadius: scan.scanRadius,
      resources: scan.resources.map(({ block, position }) => ({ block, position })),
      removed: removed.map((p) => ({ ...p })),
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
  }

  get health(): number | null {
    return this.#health?.health ?? null;
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
      blockName: (id) => registry.blocks.get(id),
      hazardCode: (id) => codes[id] ?? BLOCK_CODE.unknown,
    };
  }

  /** Block id at a position (diagnostics/tests); undefined if its chunk is not loaded. */
  blockAt(x: number, y: number, z: number): number | undefined {
    return this.#store.blockAt(x, y, z);
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
    return stack === null || stack === undefined
      ? known(null)
      : unknown('held item durability is not known yet');
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
