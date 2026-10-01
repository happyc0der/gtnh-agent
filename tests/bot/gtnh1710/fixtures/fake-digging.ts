import type { Reader } from '../../../../src/bot/gtnh1710/wire.ts';
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

/** HarvestCraft's gardens set no hardness (BlockRegistry, javap): 0, broken on the start. */
const hardnessOf = (name: string): number | undefined =>
  /^harvestcraft:[a-z]+garden$/.test(name) ? 0 : VANILLA_HARDNESS[name];

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
  // gardendropAmount=3 of the garden's produce (one kind here; the server picks at random).
  'harvestcraft:berrygarden': { item: 'harvestcraft:strawberryItem', count: 3 },
  'harvestcraft:grassgarden': { item: 'harvestcraft:cornItem', count: 3 },
};

const TICK_MS = 50;
/** EntityItem pickup delay for block drops (Block.dropBlockAsItem_do). */
const PICKUP_DELAY_MS = 10 * TICK_MS;

const SHOVEL_BLOCKS = [
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
];
const LOGS = ['minecraft:log', 'minecraft:log2'];

/** What a held item does on the server. */
export interface FakeTool {
  /** Dig speed on `blocks`; elsewhere the item digs at 1, like a hand. */
  speed: number;
  blocks: readonly string[];
  /** The tool breaks when a use takes its damage above this. */
  maxDamage: number;
  /** IguanaTweaks: this tool digs nothing at all (speed 0 on every block). */
  useless?: boolean;
}

/**
 * Held items as the GTNH 2.8.4 test server treats them (docs/gtnh-compatibility.md, "Tools"):
 * vanilla efficiencies, GregTech's wooden-tool durability of 64, and IguanaTweaks' disabled
 * shovels. Every other item digs at speed 1 and does not wear.
 */
export const SERVER_TOOLS: Readonly<Record<string, FakeTool>> = {
  'minecraft:wooden_shovel': { speed: 2, blocks: SHOVEL_BLOCKS, maxDamage: 64 },
  'minecraft:stone_shovel': { speed: 4, blocks: SHOVEL_BLOCKS, maxDamage: 131, useless: true },
  'minecraft:iron_shovel': { speed: 6, blocks: SHOVEL_BLOCKS, maxDamage: 250, useless: true },
  'minecraft:wooden_axe': { speed: 2, blocks: LOGS, maxDamage: 64 },
  'minecraft:stone_axe': { speed: 4, blocks: LOGS, maxDamage: 131 },
  'minecraft:iron_axe': { speed: 6, blocks: LOGS, maxDamage: 250 },
  'minecraft:golden_axe': { speed: 12, blocks: LOGS, maxDamage: 32 },
  'minecraft:diamond_axe': { speed: 8, blocks: LOGS, maxDamage: 1561 },
};

export interface FakeDigOptions {
  /** Hardness the SERVER uses, by block name (default vanilla); raise one to make digs too early. */
  hardness?: Record<string, number>;
  /** Re-send the block at the start instead of digging (spawn protection, a cancelled event). */
  refuseStart?: boolean;
  /** On an accepted finish send air, then the block again: a mod cancelled Forge's BreakEvent. */
  cancelBreak?: boolean;
  /** Break a too-early dig on its own once its progress reaches 1, as vanilla does (default true). */
  completeLateFinishes?: boolean;
  /**
   * What blocks drop, over the fake's fixed table (vanilla leaves drop a sapling 1 time in
   * 20, an oak's an apple 1 in 200: e.g. `{ 'minecraft:leaves': { item: 'minecraft:sapling',
   * count: 1 } }` makes every leaf drop one).
   */
  drops?: Record<string, { item: string; count: number } | null>;
}

export interface FakeDigWorld {
  blockAt(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): void;
  blockName(id: number): string | undefined;
  itemId(name: string): number | undefined;
  itemName(id: number): string | undefined;
  /** The player's feet, from its last position packet. */
  playerFeet(): { x: number; y: number; z: number } | null;
}

export interface RecordedDig {
  status: number;
  x: number;
  y: number;
  z: number;
  face: number;
  /** Whether the selected hotbar slot was empty. */
  emptyHand: boolean;
  /** The item in the selected hotbar slot ("name@damage"), or null. */
  held: string | null;
  at: number;
}

/**
 * Vanilla 1.7.10 + Forge 10.13.4.1614 digging, server side (ItemInWorldManager and
 * NetHandlerPlayServer.processPlayerDigging, as disassembled from the test server's jars):
 *  - C07 status 0 remembers the block and the time; status 1 cancels; a block whose relative
 *    hardness is at least 1 (hardness 0: HarvestCraft's gardens) is broken on the start
 *    (onBlockClicked calls tryHarvestBlock), and a later finish finds air and does nothing;
 *  - status 2 for that block breaks it if progress x (ticks since the start + 1) >= 0.7, with
 *    progress per tick = speed / hardness / 30 (a block that needs no tool; an empty hand has
 *    speed 1, a tool its own on the blocks it is made for, see SERVER_TOOLS). Forge
 *    first sends the digging player "air" (S23), then the world's change goes to every
 *    watcher (a second S23 air). Too early: the block is re-sent at once, and broken on the
 *    server's own schedule once progress reaches 1 (vanilla's receivedFinishDiggingPacket);
 *  - a held tool wears by 1 per broken block (ItemTool.onBlockDestroyed) and breaks when that
 *    takes its damage above its maximum; its slot is re-sent (S2F);
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
  /** Blocks the server broke, in order, and what the player held ("name@damage" or null). */
  readonly broken: Array<{
    x: number;
    y: number;
    z: number;
    name: string;
    late: boolean;
    held?: string;
  }> = [];
  /** Tools that broke (their last use took the damage above the maximum). */
  readonly toolsBroken: string[] = [];
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
    const held = this.#heldName();
    this.digs.push({ status, x, y, z, face, emptyHand: held === null, held, at: Date.now() });
    const id = this.#world.blockAt(x, y, z);
    if (status === 0) {
      if (this.#opts.refuseStart === true) {
        this.#send(blockChangeFrame(x, y, z, id));
        return;
      }
      if (id !== 0 && this.#hardness(id) === 0) {
        this.#break(x, y, z, false);
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
    // Too early: re-send the block now; vanilla then finishes the dig on its own schedule
    // (never, when the held item digs at speed 0).
    this.#send(blockChangeFrame(x, y, z, id));
    if (this.#opts.completeLateFinishes !== false && perTick > 0) {
      const fullTicks = Math.ceil(1 / perTick - 1 - 1e-9);
      const wait = Math.max(0, cur.startedAt + fullTicks * TICK_MS - Date.now());
      this.#later(wait, () => {
        if (this.#world.blockAt(x, y, z) === id) this.#break(x, y, z, true);
      });
    }
    this.#current = null;
  }

  /** The held stack (hotbar slot 36 + selected) as "name@damage", or null. */
  #heldName(): string | null {
    const s = this.#chests.playerSlots()[36 + this.#chests.heldSlot] ?? null;
    if (s === null) return null;
    return `${this.#world.itemName(s.id) ?? `item ${s.id}`}@${s.damage}`;
  }

  /** The held item's tool facts, or null for an empty hand or any other item. */
  #heldTool(): FakeTool | null {
    const s = this.#chests.playerSlots()[36 + this.#chests.heldSlot] ?? null;
    return s === null ? null : (SERVER_TOOLS[this.#world.itemName(s.id) ?? ''] ?? null);
  }

  #hardness(id: number): number {
    const name = this.#world.blockName(id) ?? '';
    return this.#opts.hardness?.[name] ?? hardnessOf(name) ?? 50;
  }

  #progressPerTick(id: number): number {
    const name = this.#world.blockName(id) ?? '';
    const hardness = this.#hardness(id);
    const tool = this.#heldTool();
    const speed =
      tool === null ? 1 : tool.useless === true ? 0 : tool.blocks.includes(name) ? tool.speed : 1;
    return speed / hardness / 30;
  }

  /** ItemTool.onBlockDestroyed: the held tool wears by one; past its maximum it breaks. */
  #wearHeldTool(): void {
    const tool = this.#heldTool();
    const slot = 36 + this.#chests.heldSlot;
    const s = this.#chests.playerSlots()[slot] ?? null;
    if (tool === null || s === null) return;
    const damage = s.damage + 1;
    if (damage > tool.maxDamage) {
      this.toolsBroken.push(this.#world.itemName(s.id) ?? `item ${s.id}`);
      this.#chests.setPlayerSlot(slot, null);
    } else {
      this.#chests.setPlayerSlot(slot, { ...s, damage });
    }
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
    const held = this.#heldName();
    this.#world.setBlock(x, y, z, 0);
    this.#broadcast(blockChangeFrame(x, y, z, 0)); // the world's own change, to every watcher
    // The tool wore before the block went (onBlockDestroyed); its slot is sent with the
    // player's next container sync, after the block changes.
    this.#wearHeldTool();
    this.broken.push({ x, y, z, name, late, ...(held === null ? {} : { held }) });
    const drops = this.#opts.drops ?? {};
    const drop = name in drops ? drops[name] : DROPS[name];
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
