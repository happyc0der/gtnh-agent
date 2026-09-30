import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  type GameState,
} from '../../domain/game-state.ts';
import { known, unknown, type Known } from '../../domain/known.ts';
import {
  classifyModded,
  classifyVanillaMob,
  classifyVanillaObject,
  type Classification,
} from './entity-types.ts';
import {
  PLAYER_EYE_HEIGHT,
  type FmlRuntimeMessage,
  type ItemStackData,
  type PlayPacket,
} from './packets.ts';
import { buildBlockCodeTable } from './block-hazards.ts';
import { ChunkStore, decodeChunkBulk, decodeChunkColumn, type ChunkFormat } from './chunk-data.ts';
import { scanHazards, type HazardScan } from './hazard-scan.ts';
import { nameItemStack, type Registry } from './registry.ts';
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
  x: number;
  y: number;
  z: number;
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

interface PlayerPosition {
  x: number;
  feetY: number;
  z: number;
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
  #heldSlot = 0;
  #window: Array<ItemStackData | null> | null = null;
  #lastPacketAt: Date | null = null;
  #joined = false;
  /** Set when an inventory packet could not be decoded; cleared by the next full window refresh. */
  #inventoryProblem: string | null = null;
  readonly #chat: string[] = [];
  readonly #entities = new Map<number, TrackedEntity>();
  #selfEntityId: number | null = null;
  /** Set when an entity packet could not be decoded: the entity picture may be incomplete. */
  #entityProblem: string | null = null;
  /** Loaded chunk columns: arrival times (for entity readiness) and block ids (for hazards). */
  readonly #store = new ChunkStore();
  #chunkFormat: ChunkFormat = { neid: false };
  /** Registry id -> hazard code; rebuilt when the registry arrives (ids are per world). */
  #blockCodes: Uint8Array | null = null;
  /** Set when block data was lost: the hazard scan cannot be trusted for this session. */
  #hazardProblem: string | null = null;

  setRegistry(registry: Registry): void {
    this.#registry = registry;
    this.#blockCodes = buildBlockCodeTable(registry);
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
          classification: classifyModded(message.modId, message.typeId),
          x: message.x,
          y: message.y,
          z: message.z,
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

  /** Every tracked entity within `radius` of the player, nearest first (for diagnostics). */
  nearbyEntities(radius = ENTITY_SCAN_RADIUS): NearbyEntity[] {
    const pos = this.#position;
    if (pos === null) return [];
    const out: NearbyEntity[] = [];
    for (const [entityId, e] of this.#entities) {
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
        return;
      case 'respawn':
        // New dimension or death respawn: position is unknown until the server sends it,
        // and the server re-sends every entity in range.
        this.#dimension = packet.dimension;
        this.#position = null;
        this.#entities.clear();
        this.#store.clear();
        return;
      case 'chunk-data': {
        const { chunkX, chunkZ } = packet.header;
        if (packet.unload) {
          this.#store.unload(chunkX, chunkZ);
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
        return;
      case 'block-change':
        this.#store.setBlock(packet.x, packet.y, packet.z, packet.blockId);
        return;
      case 'multi-block-change':
        for (const r of packet.records) this.#store.setBlock(r.x, r.y, r.z, r.blockId);
        return;
      case 'spawn-player':
        this.#track(packet.entityId, {
          kind: 'player',
          classification: { name: `player:${packet.name}`, category: 'ignored' },
          x: packet.x,
          y: packet.y,
          z: packet.z,
        });
        return;
      case 'spawn-mob':
        this.#track(packet.entityId, {
          kind: 'mob',
          classification: classifyVanillaMob(packet.mobType),
          x: packet.x,
          y: packet.y,
          z: packet.z,
        });
        return;
      case 'spawn-object':
        this.#track(packet.entityId, {
          kind: 'object',
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
      case 'held-item':
        if (packet.slot >= 0 && packet.slot <= 8) this.#heldSlot = packet.slot;
        return;
      case 'window-items':
        if (packet.windowId === 0) {
          this.#window = [...packet.items];
          this.#inventoryProblem = null;
        }
        return;
      case 'set-slot':
        if (packet.windowId === 0 && this.#window !== null && packet.slot >= 0) {
          while (this.#window.length <= packet.slot) this.#window.push(null);
          this.#window[packet.slot] = packet.item;
        }
        return;
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
      },
      inventory: this.#inventory(),
      nearbyThreats: this.#threats(now),
      environmentHazards: this.#hazards(),
      power: {
        availableEUt: unknown('GTNH EU is not observable through the protocol'),
        generators: [],
      },
      machines: [],
      storage: [],
      openContainerId: null,
      currentTask: null,
      knownRecipeState: null,
      lastAction: null,
    };
    return GameStateSchema.parse(state);
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

  /** Hazard scan with a custom radius, for diagnostics only (the agent always uses the default). */
  diagnosticHazardScan(radius: number): HazardScan | null {
    const pos = this.#position;
    if (pos === null || this.#blockCodes === null) return null;
    return scanHazards(this.#store, this.#blockCodes, { x: pos.x, y: pos.feetY, z: pos.z }, radius);
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
    const w = this.#window;
    if (w === null || w.length < MIN_PLAYER_WINDOW_SLOTS)
      return unknown('inventory not received yet');
    const stack = w[HOTBAR_FIRST + this.#heldSlot];
    return stack === null || stack === undefined
      ? known(null)
      : unknown('held item durability is not known yet');
  }

  #inventory(): Known<{ items: Record<string, number>; usedSlots: number; capacitySlots: number }> {
    if (this.#inventoryProblem !== null) return unknown(this.#inventoryProblem);
    const w = this.#window;
    if (w === null) return unknown('inventory not received yet');
    if (w.length < MIN_PLAYER_WINDOW_SLOTS)
      return unknown(`unexpected player window size ${w.length}`);
    const items: Record<string, number> = {};
    let usedSlots = 0;
    for (let slot = STORAGE_FIRST; slot <= STORAGE_LAST; slot++) {
      const stack = w[slot];
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
