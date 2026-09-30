import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  type GameState,
} from '../../domain/game-state.ts';
import { known, unknown, type Known } from '../../domain/known.ts';
import { PLAYER_EYE_HEIGHT, type ItemStackData, type PlayPacket } from './packets.ts';
import { nameItemStack, type Registry } from './registry.ts';

/**
 * 1.7.10 player inventory window (id 0): 0 crafting output, 1-4 crafting grid, 5-8 armor,
 * 9-35 main inventory, 36-44 hotbar. GTNH's Backhand mod appends an off-hand slot (45).
 */
const ARMOR_SLOTS = [5, 6, 7, 8] as const;
const STORAGE_FIRST = 9;
const STORAGE_LAST = 44;
const HOTBAR_FIRST = 36;
const MIN_PLAYER_WINDOW_SLOTS = 45;

const THREATS_UNKNOWN =
  'entity tracking not implemented yet (GTNH modded mobs arrive via FML spawn messages)';

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

  setRegistry(registry: Registry): void {
    this.#registry = registry;
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
        return; // not used for observation
    }
  }

  apply(packet: PlayPacket, at: Date): void {
    this.touch(at);
    switch (packet.type) {
      case 'join-game':
        this.#joined = true;
        this.#dimension = packet.dimension;
        return;
      case 'respawn':
        // New dimension or death respawn: position is unknown until the server sends it.
        this.#dimension = packet.dimension;
        this.#position = null;
        return;
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
      nearbyThreats: unknown(THREATS_UNKNOWN),
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
