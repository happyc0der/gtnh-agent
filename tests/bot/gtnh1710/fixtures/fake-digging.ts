import {
  readNbt,
  writeNbt,
  nbtTag,
  type NbtTagCompound,
} from '../../../../src/bot/gtnh1710/nbt.ts';
import type { Reader } from '../../../../src/bot/gtnh1710/wire.ts';
import { blockChangeFrame } from './chunk-fixtures.ts';
import type { FakeChestSim, FakeStack } from './fake-chests.ts';

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
  'minecraft:cobblestone': 2,
  'minecraft:mossy_cobblestone': 2,
  'minecraft:sandstone': 0.8,
  'minecraft:netherrack': 0.4,
  'minecraft:hardened_clay': 1.25,
  'minecraft:emerald_ore': 3,
  // GregTech's BlockStonesAbstract: 3 x stone's.
  'gregtech:gt.blockgranites': 4.5,
  'gregtech:gt.blockstones': 4.5,
};

/**
 * Material rock: only a pickaxe whose harvest level is at least the block's harvests it
 * (ForgeHooks.canHarvestBlock); anything else digs it at speed / hardness / 100 and the
 * block breaks with nothing dropped. Levels: IguanaTweaks' BlockDefaults.cfg and GregTech's
 * own methods (gt.blockores: by its metadata, gtOreLevel).
 */
const ROCK_LEVEL: Readonly<Record<string, number>> = {
  'minecraft:stone': 0,
  'minecraft:cobblestone': 0,
  'minecraft:mossy_cobblestone': 0,
  'minecraft:sandstone': 0,
  'minecraft:netherrack': 0,
  'minecraft:hardened_clay': 0,
  'minecraft:emerald_ore': 4,
  'gregtech:gt.blockgranites': 3,
  'gregtech:gt.blockstones': 2,
  'gregtech:gt.blockores': 0,
};
const GT_ORES = 'gregtech:gt.blockores';
/** BlockOresAbstract.getHarvestLevel: metadata % 8, but 5 and 6 give 2. */
const gtOreLevel = (meta: number): number => (meta === 5 || meta === 6 ? 2 : meta % 8);
const rockLevel = (name: string, meta: number): number | undefined =>
  name === GT_ORES ? gtOreLevel(meta) : ROCK_LEVEL[name];

/**
 * HarvestCraft's gardens set no hardness (BlockRegistry, javap): 0, broken on the start. A
 * GT ore's is 1 + its level (BlockOresAbstract).
 */
const hardnessOf = (name: string, meta: number): number | undefined =>
  /^harvestcraft:[a-z]+garden$/.test(name)
    ? 0
    : name === GT_ORES
      ? 1 + gtOreLevel(meta)
      : VANILLA_HARDNESS[name];

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
  'minecraft:cobblestone': { item: 'minecraft:cobblestone', count: 1 },
  // A GT ore's material is its tile entity's (FakeDigOptions.dropsAt); raw lignite by default.
  'gregtech:gt.blockores': { item: 'gregtech:gt.metaitem.03@5538', count: 1 },
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
const ROCK = Object.keys(ROCK_LEVEL).concat('minecraft:stained_hardened_clay');

/** What a held item does on the server. */
export interface FakeTool {
  /** Dig speed on `blocks`; elsewhere the item digs at 1, like a hand. */
  speed: number;
  blocks: readonly string[];
  /** The tool breaks when a use takes its damage above this. */
  maxDamage: number;
  /** IguanaTweaks: this tool digs nothing at all (speed 0 on every block). */
  useless?: boolean;
  /** Its tool class and harvest level (IguanaTweaks' ToolDefaults.cfg): what rock it harvests. */
  kind?: 'pickaxe' | 'shovel' | 'axe';
  level?: number;
}

/**
 * Held items as the GTNH 2.8.4 test server treats them (docs/gtnh-compatibility.md, "Tools"):
 * vanilla efficiencies, GregTech's wooden-tool durability of 64, and IguanaTweaks' disabled
 * shovels and pickaxes. Every other item digs at speed 1 and does not wear; a Tinkers'
 * Construct tool by its NBT data (#tinkers).
 */
export const SERVER_TOOLS: Readonly<Record<string, FakeTool>> = {
  'minecraft:wooden_shovel': { speed: 2, blocks: SHOVEL_BLOCKS, maxDamage: 64, kind: 'shovel' },
  'minecraft:stone_shovel': { speed: 4, blocks: SHOVEL_BLOCKS, maxDamage: 131, useless: true },
  'minecraft:iron_shovel': { speed: 6, blocks: SHOVEL_BLOCKS, maxDamage: 250, useless: true },
  'minecraft:wooden_pickaxe': {
    speed: 2,
    blocks: ROCK,
    maxDamage: 64,
    kind: 'pickaxe',
    level: 0,
  },
  'minecraft:stone_pickaxe': {
    speed: 4,
    blocks: ROCK,
    maxDamage: 131,
    useless: true,
    kind: 'pickaxe',
  },
  'minecraft:iron_pickaxe': {
    speed: 6,
    blocks: ROCK,
    maxDamage: 250,
    useless: true,
    kind: 'pickaxe',
    level: 3,
  },
  'minecraft:wooden_axe': { speed: 2, blocks: LOGS, maxDamage: 64, kind: 'axe' },
  'minecraft:stone_axe': { speed: 4, blocks: LOGS, maxDamage: 131, kind: 'axe' },
  'minecraft:iron_axe': { speed: 6, blocks: LOGS, maxDamage: 250, kind: 'axe', level: 3 },
  'minecraft:golden_axe': { speed: 12, blocks: LOGS, maxDamage: 32, kind: 'axe' },
  'minecraft:diamond_axe': { speed: 8, blocks: LOGS, maxDamage: 1561, kind: 'axe', level: 5 },
};

/**
 * A Tinkers' Construct pickaxe's InfiTool data, as TConstruct's ToolBuilder writes it, for a
 * stack's `nbtData` (the fake encodes it gzipped in the slot, as the server does).
 */
export function tinkersPickaxeNbt(t: {
  harvestLevel: number;
  miningSpeed: number;
  damage?: number;
  totalDurability: number;
  broken?: boolean;
}): Buffer {
  return writeNbt({
    InfiTool: nbtTag.compound({
      HarvestLevel: nbtTag.int(t.harvestLevel),
      MiningSpeed: nbtTag.int(t.miningSpeed),
      Damage: nbtTag.int(t.damage ?? 0),
      TotalDurability: nbtTag.int(t.totalDurability),
      Broken: nbtTag.bool(t.broken ?? false),
      Shoddy: nbtTag.float(0),
    }),
  });
}

/** A held Tinkers' pickaxe, as the server reads its NBT data (TConstruct's HarvestTool). */
interface FakeTinkers {
  harvestLevel: number;
  miningSpeed: number;
  damage: number;
  totalDurability: number;
  broken: boolean;
}

function readTinkers(nbt: Buffer): FakeTinkers | null {
  const tags = readNbt(nbt).value['InfiTool'];
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags) || Buffer.isBuffer(tags)) {
    return null;
  }
  const t = tags as Record<string, unknown>;
  const n = (k: string): number => (typeof t[k] === 'number' ? t[k] : 0);
  return {
    harvestLevel: n('HarvestLevel'),
    miningSpeed: n('MiningSpeed'),
    damage: n('Damage'),
    totalDurability: n('TotalDurability'),
    broken: n('Broken') !== 0,
  };
}

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
  /** What the block at "x,y,z" drops, over the rest (a GT ore's material). */
  dropsAt?: Record<string, { item: string; count: number } | null>;
}

export interface FakeDigWorld {
  blockAt(x: number, y: number, z: number): number;
  /** Block metadata (0 where none was set). */
  blockMeta(x: number, y: number, z: number): number;
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
  /**
   * Blocks the server broke, in order, and what the player held ("name@damage" or null);
   * `harvested: false` when the held item did not harvest it (nothing dropped).
   */
  readonly broken: Array<{
    x: number;
    y: number;
    z: number;
    name: string;
    late: boolean;
    held?: string;
    harvested?: false;
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
      if (id !== 0 && this.#hardness(id, x, y, z) === 0) {
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
    const perTick = this.#progressPerTick(id, x, y, z);
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

  /** The held stack (hotbar slot 36 + selected), or null. */
  #heldStack(): FakeStack | null {
    return this.#chests.playerSlots()[36 + this.#chests.heldSlot] ?? null;
  }

  /** The held item's tool facts, or null for an empty hand or any other item. */
  #heldTool(): FakeTool | null {
    const s = this.#heldStack();
    return s === null ? null : (SERVER_TOOLS[this.#world.itemName(s.id) ?? ''] ?? null);
  }

  /** The held Tinkers' pickaxe, read from its NBT data, or null. */
  #tinkers(): FakeTinkers | null {
    const s = this.#heldStack();
    if (s?.nbtData === undefined || this.#world.itemName(s.id) !== 'TConstruct:pickaxe')
      return null;
    return readTinkers(s.nbtData);
  }

  #hardness(id: number, x: number, y: number, z: number): number {
    const name = this.#world.blockName(id) ?? '';
    return this.#opts.hardness?.[name] ?? hardnessOf(name, this.#world.blockMeta(x, y, z)) ?? 50;
  }

  /**
   * The held item's speed on the block, and whether it harvests it: material rock only for
   * a pickaxe of the block's level (ForgeHooks.canHarvestBlock); a Tinkers' pickaxe by its
   * InfiTool data (HarvestTool: 0.1 when broken or below the block's level, else
   * MiningSpeed / 100).
   */
  #dig(id: number, x: number, y: number, z: number): { speed: number; harvests: boolean } {
    const name = this.#world.blockName(id) ?? '';
    const level = rockLevel(name, this.#world.blockMeta(x, y, z));
    const tinkers = this.#tinkers();
    if (tinkers !== null) {
      if (level === undefined) return { speed: 1, harvests: true };
      const fits = !tinkers.broken && tinkers.harvestLevel >= level;
      return { speed: fits ? tinkers.miningSpeed / 100 : 0.1, harvests: fits };
    }
    const tool = this.#heldTool();
    const speed =
      tool === null ? 1 : tool.useless === true ? 0 : tool.blocks.includes(name) ? tool.speed : 1;
    const harvests =
      level === undefined || (tool?.kind === 'pickaxe' && (tool.level ?? 0) >= level);
    return { speed, harvests };
  }

  #progressPerTick(id: number, x: number, y: number, z: number): number {
    const { speed, harvests } = this.#dig(id, x, y, z);
    return speed / this.#hardness(id, x, y, z) / (harvests ? 30 : 100);
  }

  /**
   * ItemTool.onBlockDestroyed: the held tool wears by one; past its maximum it breaks. A
   * Tinkers' pickaxe wears in its NBT data (AbilityHelper.damageTool: Damage + 1; past
   * TotalDurability it is Broken, not gone), and its damage value is the percentage worn
   * (ToolCore.getDamage).
   */
  #wearHeldTool(): void {
    const slot = 36 + this.#chests.heldSlot;
    const s = this.#chests.playerSlots()[slot] ?? null;
    const tinkers = this.#tinkers();
    if (s !== null && s.nbtData !== undefined && tinkers !== null) {
      const damage = tinkers.damage + 1;
      const broken = damage > tinkers.totalDurability;
      const now = broken ? tinkers.damage : damage;
      const root = readNbt(s.nbtData).value;
      const tags = { ...(root['InfiTool'] as Record<string, unknown>) };
      const nbt: NbtTagCompound = {};
      for (const [k, v] of Object.entries(tags)) {
        if (typeof v !== 'number') continue;
        nbt[k] = k === 'Shoddy' ? nbtTag.float(v) : nbtTag.int(v);
      }
      nbt['Damage'] = nbtTag.int(now);
      nbt['Broken'] = nbtTag.bool(broken || tinkers.broken);
      if (broken) this.toolsBroken.push('TConstruct:pickaxe');
      const percent = Math.max(now > 0 ? 1 : 0, Math.floor((now * 100) / tinkers.totalDurability));
      this.#chests.setPlayerSlot(slot, {
        ...s,
        damage: percent,
        nbtData: writeNbt({ InfiTool: nbtTag.compound(nbt) }),
      });
      return;
    }
    const tool = this.#heldTool();
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
    // tryHarvestBlock: whether the held item harvests it is decided before the block goes.
    const { harvests } = this.#dig(id, x, y, z);
    this.#world.setBlock(x, y, z, 0);
    this.#broadcast(blockChangeFrame(x, y, z, 0)); // the world's own change, to every watcher
    // The tool wore before the block went (onBlockDestroyed); its slot is sent with the
    // player's next container sync, after the block changes.
    this.#wearHeldTool();
    this.broken.push({
      x,
      y,
      z,
      name,
      late,
      ...(held === null ? {} : { held }),
      ...(harvests ? {} : { harvested: false }),
    });
    if (!harvests) return; // removed with nothing dropped (harvestBlock is not called)
    const drops = this.#opts.drops ?? {};
    const here = this.#opts.dropsAt ?? {};
    const at = `${x},${y},${z}`;
    const drop = at in here ? here[at] : name in drops ? drops[name] : DROPS[name];
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
    // "name@damage", as the agent names items (a raw ore is gt.metaitem.03 at its damage).
    const named = /^(.*)@(\d+)$/.exec(drop.item);
    const itemId = this.#world.itemId(named?.[1] ?? drop.item);
    const damage = named === null ? 0 : Number(named[2]);
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
    this.#chests.pickUp({ id: itemId, count: drop.count, damage });
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
