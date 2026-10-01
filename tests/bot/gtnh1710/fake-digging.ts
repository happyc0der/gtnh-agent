import type { Reader } from '../../../src/bot/gtnh1710/wire.ts';
import { blockChangeFrame } from './chunk-fixtures.ts';
import type { FakeChestSim } from './fake-chests.ts';

/** Vanilla 1.7.10 hardness of the blocks the tests dig (the server's own table). */
const VANILLA_HARDNESS: Readonly<Record<string, number>> = {
  'minecraft:log': 2,
  'minecraft:log2': 2,
  'minecraft:leaves': 0.2,
  'minecraft:leaves2': 0.2,
  'minecraft:dirt': 0.5,
  'minecraft:grass': 0.6,
  'minecraft:sand': 0.5,
  'minecraft:gravel': 0.6,
  'minecraft:clay': 0.6,
  'minecraft:stone': 1.5,
};

/** What a block drops (the fake's fixed version of the vanilla drop table). */
const DROPS: Readonly<Record<string, { item: string; count: number } | null>> = {
  'minecraft:log': { item: 'minecraft:log', count: 1 },
  'minecraft:log2': { item: 'minecraft:log2', count: 1 },
  'minecraft:leaves': null,
  'minecraft:leaves2': null,
  'minecraft:dirt': { item: 'minecraft:dirt', count: 1 },
  'minecraft:grass': { item: 'minecraft:dirt', count: 1 },
  'minecraft:sand': { item: 'minecraft:sand', count: 1 },
  'minecraft:gravel': { item: 'minecraft:gravel', count: 1 },
  'minecraft:clay': { item: 'minecraft:clay_ball', count: 4 },
  'minecraft:stone': { item: 'minecraft:cobblestone', count: 1 },
};

const TICK_MS = 50;
/** EntityItem pickup delay for block drops (Block.dropBlockAsItem_do). */
const PICKUP_DELAY_MS = 10 * TICK_MS;

export interface FakeDigOptions {
  /** Hardness the SERVER uses, by block name (default vanilla); raise one to make digs too early. */
  hardness?: Record<string, number>;
  /** Re-send the block at the start instead of digging (spawn protection, a cancelled event). */
  refuseStart?: boolean;
  /** On an accepted finish send air, then the block again: a mod cancelled Forge's BreakEvent. */
  cancelBreak?: boolean;
  /** Break a too-early dig on its own once its progress reaches 1, as vanilla does (default true). */
  completeLateFinishes?: boolean;
}

export interface FakeDigWorld {
  blockAt(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): void;
  blockName(id: number): string | undefined;
  itemId(name: string): number | undefined;
  /** The player's feet, from its last position packet. */
  playerFeet(): { x: number; y: number; z: number } | null;
}

export interface RecordedDig {
  status: number;
  x: number;
  y: number;
  z: number;
  face: number;
  /** Whether the selected hotbar slot was empty (the agent must dig with an empty hand). */
  emptyHand: boolean;
  at: number;
}

/**
 * Vanilla 1.7.10 + Forge 10.13.4.1614 digging, server side (ItemInWorldManager and
 * NetHandlerPlayServer.processPlayerDigging, as disassembled from the test server's jars):
 *  - C07 status 0 remembers the block and the time; status 1 cancels;
 *  - status 2 for that block breaks it if progress x (ticks since the start + 1) >= 0.7, with
 *    progress per tick = 1 / hardness / 30 (a bare hand on a block that needs no tool). Forge
 *    first sends the digging player "air" (S23), then the world's change goes to every
 *    watcher (a second S23 air). Too early: the block is re-sent at once, and broken on the
 *    server's own schedule once progress reaches 1 (vanilla's receivedFinishDiggingPacket);
 *  - the drop can be picked up 10 ticks later, only if it lies within the player's box grown
 *    by 1 sideways and 0.5 up/down: it goes into the inventory like InventoryPlayer, S2F.
 */
/** A drop lying on the ground: its block cell and the item. */
interface GroundDrop {
  x: number;
  y: number;
  z: number;
  item: string;
  count: number;
}

export class FakeDigSim {
  readonly digs: RecordedDig[] = [];
  /** Blocks the server broke, in order. */
  readonly broken: Array<{ x: number; y: number; z: number; name: string; late: boolean }> = [];
  /** Items picked up by the player. */
  readonly pickedUp: Array<{ item: string; count: number }> = [];
  readonly #world: FakeDigWorld;
  readonly #chests: FakeChestSim;
  readonly #opts: FakeDigOptions;
  readonly #timers = new Set<NodeJS.Timeout>();
  #send: (frame: Buffer) => void = () => undefined;
  #broadcast: (frame: Buffer) => void = () => undefined;
  #current: { x: number; y: number; z: number; startedAt: number } | null = null;
  /** Drops lying on the ground, out of the player's reach when they could first be picked up. */
  readonly #ground: GroundDrop[] = [];

  constructor(world: FakeDigWorld, chests: FakeChestSim, options: FakeDigOptions = {}) {
    this.#world = world;
    this.#chests = chests;
    this.#opts = options;
  }

  setSenders(send: (frame: Buffer) => void, broadcast: (frame: Buffer) => void): void {
    this.#send = send;
    this.#broadcast = broadcast;
  }

  stop(): void {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  handle(r: Reader): void {
    const status = r.u8();
    const x = r.i32();
    const y = r.u8();
    const z = r.i32();
    const face = r.u8();
    const held = this.#chests.playerSlots()[36 + this.#chests.heldSlot] ?? null;
    this.digs.push({ status, x, y, z, face, emptyHand: held === null, at: Date.now() });
    const id = this.#world.blockAt(x, y, z);
    if (status === 0) {
      if (this.#opts.refuseStart === true) {
        this.#send(blockChangeFrame(x, y, z, id));
        return;
      }
      this.#current = { x, y, z, startedAt: Date.now() };
      return;
    }
    if (status === 1) {
      this.#current = null;
      return;
    }
    if (status !== 2) return; // 3/4/5 would drop items: never expected from the agent
    const cur = this.#current;
    if (cur === null || cur.x !== x || cur.y !== y || cur.z !== z || id === 0) {
      if (id !== 0) this.#send(blockChangeFrame(x, y, z, id));
      return;
    }
    const perTick = this.#progressPerTick(id);
    const ticks = Math.floor((Date.now() - cur.startedAt) / TICK_MS);
    if (perTick * (ticks + 1) >= 0.7) {
      this.#current = null;
      this.#break(x, y, z, false);
      return;
    }
    // Too early: re-send the block now; vanilla then finishes the dig on its own schedule.
    this.#send(blockChangeFrame(x, y, z, id));
    if (this.#opts.completeLateFinishes !== false) {
      const fullTicks = Math.ceil(1 / perTick - 1 - 1e-9);
      const wait = Math.max(0, cur.startedAt + fullTicks * TICK_MS - Date.now());
      this.#later(wait, () => {
        if (this.#world.blockAt(x, y, z) === id) this.#break(x, y, z, true);
      });
    }
    this.#current = null;
  }

  #progressPerTick(id: number): number {
    const name = this.#world.blockName(id) ?? '';
    const hardness = this.#opts.hardness?.[name] ?? VANILLA_HARDNESS[name] ?? 50;
    return 1 / hardness / 30;
  }

  #break(x: number, y: number, z: number, late: boolean): void {
    const id = this.#world.blockAt(x, y, z);
    const name = this.#world.blockName(id) ?? `id ${id}`;
    // ForgeHooks.onBlockBreakEvent: "air" to the digging player before the event is posted.
    this.#send(blockChangeFrame(x, y, z, 0));
    if (this.#opts.cancelBreak === true) {
      this.#send(blockChangeFrame(x, y, z, id)); // cancelled: the block is re-sent
      return;
    }
    this.#world.setBlock(x, y, z, 0);
    this.#broadcast(blockChangeFrame(x, y, z, 0)); // the world's own change, to every watcher
    this.broken.push({ x, y, z, name, late });
    const drop = DROPS[name];
    if (drop === null || drop === undefined) return;
    this.#later(PICKUP_DELAY_MS, () => this.#pickUp(x, y, z, drop));
  }

  /**
   * The drop falls to the ground under the block and is picked up if it is close enough;
   * otherwise it stays there, and a later player tick in range picks it up (as vanilla's
   * player update does every tick).
   */
  #pickUp(x: number, y: number, z: number, drop: { item: string; count: number }): void {
    let ground = y;
    while (ground > 0 && this.#world.blockAt(x, ground - 1, z) === 0) ground -= 1;
    const item = { x, y: ground, z, ...drop };
    if (!this.#tryPickUp(item)) this.#ground.push(item);
  }

  /** A player packet (idle or move) arrived: pick up any lying drop now in range. */
  onPlayerTick(): void {
    for (let i = this.#ground.length - 1; i >= 0; i--) {
      if (this.#tryPickUp(this.#ground[i] as GroundDrop)) {
        this.#ground.splice(i, 1);
      }
    }
  }

  #tryPickUp(drop: GroundDrop): boolean {
    const feet = this.#world.playerFeet();
    const itemId = this.#world.itemId(drop.item);
    if (feet === null || itemId === undefined) return false;
    const item = { x: drop.x + 0.5, y: drop.y, z: drop.z + 0.5, half: 0.125 };
    const reach = { side: 0.3 + 1, down: 0.5, up: 1.8 + 0.5 };
    const inRange =
      item.x + item.half > feet.x - reach.side &&
      item.x - item.half < feet.x + reach.side &&
      item.z + item.half > feet.z - reach.side &&
      item.z - item.half < feet.z + reach.side &&
      item.y + 0.25 > feet.y - reach.down &&
      item.y < feet.y + reach.up;
    if (!inRange) return false;
    this.#chests.pickUp({ id: itemId, count: drop.count, damage: 0 });
    this.pickedUp.push({ item: drop.item, count: drop.count });
    return true;
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }
}
