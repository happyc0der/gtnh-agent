import { readItemStack, VANILLA_DECODING } from '../../../../src/bot/gtnh1710/packets.ts';
import type { Reader } from '../../../../src/bot/gtnh1710/wire.ts';
import { blockChangeFrame } from './chunk-fixtures.ts';
import type { FakeChestSim, FakeStack } from './fake-chests.ts';

const TICK_MS = 50;
/** MinecraftServer.getBuildLimit() with the test server's max-build-height. */
const BUILD_LIMIT = 256;
/** The cell next to each face (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east). */
const FACE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];
/** Blocks whose material is replaceable (air, liquids, fire, Material.vine, thin snow). */
const REPLACEABLE: ReadonlySet<string> = new Set([
  'minecraft:air',
  'minecraft:tallgrass',
  'minecraft:deadbush',
  'minecraft:vine',
  'minecraft:snow_layer',
  'minecraft:water',
  'minecraft:flowing_water',
  'minecraft:lava',
  'minecraft:flowing_lava',
  'minecraft:fire',
]);
/** A clicked block of these is replaced in place (ItemBlock.onItemUse), not offset by the face. */
const REPLACED_IN_PLACE: ReadonlySet<string> = new Set([
  'minecraft:tallgrass',
  'minecraft:deadbush',
  'minecraft:vine',
  'minecraft:snow_layer',
]);
const FALLING: ReadonlySet<string> = new Set(['minecraft:sand', 'minecraft:gravel']);
/** BlockFalling.canFallBelow: air, fire, water or lava under it. */
const FALLS_INTO: ReadonlySet<string> = new Set([
  'minecraft:air',
  'minecraft:fire',
  'minecraft:water',
  'minecraft:flowing_water',
  'minecraft:lava',
  'minecraft:flowing_lava',
]);

/** An entity the server knows: its feet position and box size. */
export interface FakeBody {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

export interface FakePlaceOptions {
  /** Living entities the server knows about but never told the client about. */
  hiddenEntities?: FakeBody[];
  /** A mod cancels Forge's BlockEvent.PlaceEvent: the cell is restored. */
  cancelPlace?: boolean;
  /** The server's reach for clicks (vanilla 5 + 1); lower it to have clicks refused. */
  reach?: number;
}

export interface FakePlaceWorld {
  blockAt(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): void;
  blockName(id: number): string | undefined;
  /** The player's feet, from its last position packet. */
  playerFeet(): { x: number; y: number; z: number } | null;
  /** The living entities the client was told about (the placing player is never one). */
  entities(): FakeBody[];
}

export interface RecordedPlacement {
  /** The clicked block and face, as the C08 named them. */
  x: number;
  y: number;
  z: number;
  face: number;
  /** The stack the client claimed to hold, and the one the server's held slot really had. */
  claimed: FakeStack | null;
  held: FakeStack | null;
  cursor: [number, number, number];
  /** Whether a block was placed (and kept). */
  placed: boolean;
}

/**
 * Vanilla 1.7.10 + Forge 10.13.4.1614 block placement, server side, as disassembled from the
 * test server's jars (NetHandlerPlayServer.processPlayerBlockPlacement, ItemInWorldManager.
 * activateBlockOrUseItem, ForgeHooks.onPlaceItemIntoWorld, ItemBlock.onItemUse,
 * World.canPlaceEntityOnSide, BlockFalling):
 *  - a clicked y at the build limit - 1 with face 1 (or above) is "too high";
 *  - otherwise, when the clicked block's centre is closer than the reach (5 + 1) to the
 *    player, the clicked block is activated FIRST: a chest or crafting table opens and
 *    nothing is placed. With a held block item (1.7.10 block items share their block's id)
 *    the block goes into the cell next to the clicked face (a clicked tall grass or dead
 *    bush is replaced in place), if that cell is replaceable and no entity overlaps it; the
 *    PLACING PLAYER IS LEFT OUT of that check, as on the real server. Then Forge's PlaceEvent
 *    (cancelPlace restores the cell); success uses one item;
 *  - every C08 is answered with S23 for the clicked block, then for the cell next to its face
 *    (whatever they hold now), and with S2F for the held slot when its stack differs from the
 *    claimed one or the placement failed; the world's own change follows a tick later;
 *  - sand and gravel with air (or a fluid, or fire) under them fall 2 ticks later.
 */
export class FakePlaceSim {
  readonly placements: RecordedPlacement[] = [];
  /** Blocks the server placed and kept, in order. */
  readonly placed: Array<{ x: number; y: number; z: number; name: string }> = [];
  /** Blocks that fell out of the cell they were placed in. */
  readonly fell: Array<{ x: number; y: number; z: number; name: string }> = [];
  /** Called right after a block is placed (tests use it to change the world around it). */
  onPlaced: ((x: number, y: number, z: number) => void) | null = null;
  readonly #world: FakePlaceWorld;
  readonly #chests: FakeChestSim;
  readonly #opts: FakePlaceOptions;
  readonly #timers = new Set<NodeJS.Timeout>();
  #send: (frame: Buffer) => void = () => undefined;
  #broadcast: (frame: Buffer) => void = () => undefined;

  /**
   * A C08 on a block in reach, before the block or the item does anything: where Forge fires
   * PlayerInteractEvent RIGHT_CLICK_BLOCK (AngerMod ends its spawn protection there).
   */
  onBlockClick: ((x: number, y: number, z: number, face: number) => void) | null = null;
  /** C08 with face 255 (use the held item in the air), with the held stack. */
  onUseInAir: ((held: FakeStack | null) => void) | null = null;

  constructor(world: FakePlaceWorld, chests: FakeChestSim, options: FakePlaceOptions = {}) {
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

  /** C08 Player Block Placement. */
  handle(r: Reader, modularUi: boolean): void {
    const x = r.i32();
    const y = r.u8();
    const z = r.i32();
    const face = r.u8();
    const item = readItemStack(r, { ...VANILLA_DECODING, itemStackSizeVarInt: modularUi });
    const cursor: [number, number, number] = [r.u8(), r.u8(), r.u8()];
    const claimed: FakeStack | null =
      item === null
        ? null
        : { id: item.id, count: item.count, damage: item.damage, nbt: item.hasNbt || undefined };
    const held = this.#chests.heldStack;
    const record: RecordedPlacement = { x, y, z, face, claimed, held, cursor, placed: false };
    this.placements.push(record);
    if (face === 255) {
      // Using the held item in the air: eating (the server decides what it does).
      this.onUseInAir?.(held);
      return;
    }

    let placeResult = true;
    // Too high: the server says "build.tooHigh" in chat instead (not simulated).
    const tooHigh = y >= BUILD_LIMIT - 1 && (face === 1 || y >= BUILD_LIMIT);
    if (!tooHigh) {
      const feet = this.#world.playerFeet();
      const reach = this.#opts.reach ?? 6;
      const inReach =
        feet !== null &&
        (feet.x - (x + 0.5)) ** 2 + (feet.y - (y + 0.5)) ** 2 + (feet.z - (z + 0.5)) ** 2 <
          reach * reach;
      if (inReach) this.onBlockClick?.(x, y, z, face);
      if (inReach && !this.#activateOrPlace(x, y, z, face, record)) placeResult = false;
    }
    // Either way (face 255 aside), both blocks are sent as they are now.
    const [dx, dy, dz] = FACE_OFFSETS[face] ?? [0, 0, 0];
    this.#send(blockChangeFrame(x, y, z, this.#world.blockAt(x, y, z)));
    this.#send(
      blockChangeFrame(x + dx, y + dy, z + dz, this.#world.blockAt(x + dx, y + dy, z + dz)),
    );
    const now = this.#chests.heldStack;
    if (!sameStack(now, claimed) || !placeResult) this.#chests.sendHeldSlot();
  }

  /** ItemInWorldManager.activateBlockOrUseItem: the clicked block first, then the item. */
  #activateOrPlace(
    x: number,
    y: number,
    z: number,
    face: number,
    record: RecordedPlacement,
  ): boolean {
    if (this.#chests.activate(x, y, z)) return true;
    const held = record.held;
    if (held === null) return false;
    return this.#tryPlace(x, y, z, face, held, record);
  }

  /** ForgeHooks.onPlaceItemIntoWorld around ItemBlock.onItemUse. */
  #tryPlace(
    x: number,
    y: number,
    z: number,
    face: number,
    held: FakeStack,
    record: RecordedPlacement,
  ): boolean {
    const name = (id: number): string =>
      id === 0 ? 'minecraft:air' : (this.#world.blockName(id) ?? `block id ${id}`);
    const blockName = this.#world.blockName(held.id); // an ItemBlock's id is its block's id
    if (blockName === undefined || held.count <= 0) return false;
    let [tx, ty, tz] = [x, y, z];
    if (!REPLACED_IN_PLACE.has(name(this.#world.blockAt(x, y, z)))) {
      const [dx, dy, dz] = FACE_OFFSETS[face] ?? [0, 0, 0];
      [tx, ty, tz] = [x + dx, y + dy, z + dz];
    }
    if (ty === 255) return false; // a solid block at the top of the world
    // World.canPlaceEntityOnSide: the new block's box against every entity but the placer.
    const cell = { x: tx, y: ty, z: tz };
    const bodies = [...this.#world.entities(), ...(this.#opts.hiddenEntities ?? [])];
    if (bodies.some((b) => overlaps(b, cell))) return false;
    const before = this.#world.blockAt(tx, ty, tz);
    if (!REPLACEABLE.has(name(before))) return false;

    this.#world.setBlock(tx, ty, tz, held.id);
    if (this.#opts.cancelPlace === true) {
      // A mod cancelled the PlaceEvent: the block snapshot is restored.
      this.#world.setBlock(tx, ty, tz, before);
      return false;
    }
    this.#chests.useHeldItem();
    record.placed = true;
    this.placed.push({ x: tx, y: ty, z: tz, name: blockName });
    this.onPlaced?.(tx, ty, tz);
    // The world's own change reaches every watcher on the next tick.
    this.#later(TICK_MS, () =>
      this.#broadcast(blockChangeFrame(tx, ty, tz, this.#world.blockAt(tx, ty, tz))),
    );
    if (FALLING.has(blockName)) {
      this.#later(2 * TICK_MS, () => {
        if (this.#world.blockAt(tx, ty, tz) !== held.id) return;
        if (!FALLS_INTO.has(name(this.#world.blockAt(tx, ty - 1, tz)))) return;
        // It becomes a falling block entity (not simulated further) and leaves air.
        this.#world.setBlock(tx, ty, tz, 0);
        this.fell.push({ x: tx, y: ty, z: tz, name: blockName });
        this.#broadcast(blockChangeFrame(tx, ty, tz, 0));
      });
    }
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

/** Whether an entity's box overlaps a block cell (touching a face is not overlapping). */
function overlaps(b: FakeBody, c: { x: number; y: number; z: number }): boolean {
  const h = b.width / 2;
  return (
    b.x - h < c.x + 1 &&
    b.x + h > c.x &&
    b.y < c.y + 1 &&
    b.y + b.height > c.y &&
    b.z - h < c.z + 1 &&
    b.z + h > c.z
  );
}

/** ItemStack.areItemStacksEqual: item, count and damage (and NBT) all equal. */
function sameStack(a: FakeStack | null, b: FakeStack | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.count === b.count &&
    a.damage === b.damage &&
    (a.nbt ?? false) === (b.nbt ?? false)
  );
}
