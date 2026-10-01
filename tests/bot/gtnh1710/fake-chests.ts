import { gzipSync } from 'node:zlib';
import { readItemStack, VANILLA_DECODING } from '../../../src/bot/gtnh1710/packets.ts';
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
  encodeVarShort,
  type Reader,
} from '../../../src/bot/gtnh1710/wire.ts';

export interface FakeStack {
  id: number;
  count: number;
  damage: number;
  /** A stack with (trivial) NBT data, which the agent must never move. */
  nbt?: boolean | undefined;
}

export interface FakeChest {
  x: number;
  y: number;
  z: number;
  size: 27 | 54;
  items: Array<FakeStack & { slot: number }>;
}

/** A recipe ingredient: an item id, and a damage value or any damage (vanilla's wildcard). */
export interface FakeIngredient {
  id: number;
  damage: number | 'any';
}

/**
 * A crafting recipe of the fake server. Shaped recipes match anywhere in the grid (and
 * mirrored), like vanilla's ShapedRecipes; shapeless ones need exactly their ingredients.
 */
export type FakeRecipe =
  | { shaped: Array<Array<FakeIngredient | null>>; result: FakeStack }
  | { shapeless: FakeIngredient[]; result: FakeStack };

const EMPTY_NBT = gzipSync(Buffer.from([0x0a, 0x00, 0x00, 0x00])); // TAG_Compound "" { }

/** A 1.7.10 item stack on the wire (with GTNH ModularUI's VarInt stack size when enabled). */
export function encodeStack(s: FakeStack | null, modularUi: boolean): Buffer {
  if (s === null) return Buffer.from([0xff, 0xff]);
  const head = Buffer.alloc(5);
  head.writeInt16BE(s.id, 0);
  head.writeInt8(Math.min(s.count, 127), 2);
  head.writeInt16BE(s.damage, 3);
  const nbtLength = Buffer.alloc(2);
  nbtLength.writeInt16BE(s.nbt === true ? EMPTY_NBT.length : -1);
  return Buffer.concat([
    head,
    nbtLength,
    s.nbt === true ? EMPTY_NBT : Buffer.alloc(0),
    modularUi ? encodeVarInt(s.count) : Buffer.alloc(0),
  ]);
}

const same = (a: FakeStack | null, b: FakeStack | null): boolean =>
  a === null || b === null
    ? a === b
    : a.id === b.id &&
      a.count === b.count &&
      a.damage === b.damage &&
      (a.nbt ?? false) === (b.nbt ?? false);

const sameItem = (a: FakeStack, b: FakeStack): boolean =>
  a.id === b.id && a.damage === b.damage && (a.nbt ?? false) === (b.nbt ?? false);

const fits = (ing: FakeIngredient, s: FakeStack): boolean =>
  ing.id === s.id && (ing.damage === 'any' || ing.damage === s.damage);

const copy = (s: FakeStack | null): FakeStack | null => (s === null ? null : { ...s });

const i16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};

/** What CraftingManager.findMatchingRecipe gives for a grid (row-major, `width` wide). */
export function matchRecipe(
  recipes: readonly FakeRecipe[],
  grid: ReadonlyArray<FakeStack | null>,
  width: number,
): FakeStack | null {
  const height = grid.length / width;
  const at = (x: number, y: number): FakeStack | null => grid[y * width + x] ?? null;
  for (const recipe of recipes) {
    if ('shapeless' in recipe) {
      const items = grid.filter((s): s is FakeStack => s !== null);
      const left = [...recipe.shapeless];
      const ok =
        items.length === left.length &&
        items.every((s) => {
          const i = left.findIndex((ing) => fits(ing, s));
          if (i === -1) return false;
          left.splice(i, 1);
          return true;
        });
      if (ok) return { ...recipe.result };
      continue;
    }
    const rh = recipe.shaped.length;
    const rw = Math.max(...recipe.shaped.map((r) => r.length));
    for (let dx = 0; dx + rw <= width; dx++) {
      for (let dy = 0; dy + rh <= height; dy++) {
        for (const mirrored of [false, true]) {
          let ok = true;
          for (let x = 0; x < width && ok; x++) {
            for (let y = 0; y < height && ok; y++) {
              const rx = x - dx;
              const ry = y - dy;
              const inside = rx >= 0 && ry >= 0 && rx < rw && ry < rh;
              const ing = inside
                ? (recipe.shaped[ry]?.[mirrored ? rw - 1 - rx : rx] ?? null)
                : null;
              const s = at(x, y);
              ok = ing === null ? s === null : s !== null && fits(ing, s);
            }
          }
          if (ok) return { ...recipe.result };
        }
      }
    }
  }
  return null;
}

/** A crafting grid with its result slot (InventoryCrafting + InventoryCraftResult). */
interface Grid {
  slots: Array<FakeStack | null>;
  width: number;
  result: FakeStack | null;
}

/**
 * A vanilla furnace (TileEntityFurnace): input, fuel and output slots and its timers, in
 * ticks. The server advances it with tickFurnaces() (tests drive time explicitly).
 */
export interface FakeFurnace {
  x: number;
  y: number;
  z: number;
  input?: FakeStack | null;
  fuel?: FakeStack | null;
  output?: FakeStack | null;
  cookTicks?: number;
  burnTicks?: number;
  itemBurnTicks?: number;
}

/** A smelting recipe of the fake server (FurnaceRecipes): input -> result. */
export interface FakeSmelting {
  input: FakeIngredient;
  result: FakeStack;
}

/**
 * A modded block whose GUI opens with Forge's OpenGui (FMLNetworkHandler.openGui): the
 * server sends the FML message, then S30 with the window's slots.
 */
export interface FakeModBlock {
  x: number;
  y: number;
  z: number;
  modId: string;
  guiId: number;
  /** The block's own slots. */
  slots: Array<FakeStack | null>;
  /** Slots after the player's 36 (an adjacent chest in a crafting station). */
  trailing?: Array<FakeStack | null>;
  /** The player's 36 slots come FIRST, before the block's (an unusual mod layout). */
  playerFirst?: boolean;
  /** Right-clicking it opens nothing (e.g. an Iron Chests chest under a solid block). */
  opensNothing?: boolean;
}

interface FurnaceState {
  slots: [FakeStack | null, FakeStack | null, FakeStack | null];
  cookTicks: number;
  burnTicks: number;
  itemBurnTicks: number;
}

type OpenWindow =
  | { kind: 'chest'; windowId: number; key: string; size: number }
  | { kind: 'table'; windowId: number; key: string; grid: Grid }
  | { kind: 'furnace'; windowId: number; key: string; sent: [number, number, number] }
  | { kind: 'mod'; windowId: number; key: string; block: FakeModBlock };

/**
 * Vanilla 1.7.10 containers, server side, for one player, as verified in the server jar
 * (with Forge's patches): the player's own inventory container (window 0, with its 2x2
 * crafting grid), chests and crafting tables.
 *  - C08 on a chest opens it: S2D type 0, then S30 (chest slots + the player's 36). On a
 *    crafting table: S2D type 1 announcing 9 slots, then S30 with 46 (result, 9 grid, 36);
 *  - C0E (mode 0) is applied exactly like Container.slotClick, THEN the client's claimed
 *    stack is compared with the slot's stack before the click. A match is confirmed (S32
 *    true, and NO slot updates: the client predicts them). A mismatch is rejected (S32
 *    false) with an immediate re-sync (S30 + cursor S2F), and further clicks are ignored
 *    until the client acknowledges with C0F;
 *  - window-0 clicks count only while no other window is open;
 *  - the crafting result slot is recomputed whenever the grid changes, but never sent on its
 *    own (EntityPlayerMP skips SlotCrafting): only S30 carries it. Clicking it with an empty
 *    cursor puts the WHOLE result on the cursor and takes one item from every grid slot;
 *  - C0D closes the open window, or, with none open, the inventory container itself: the
 *    cursor and that window's crafting grid are DROPPED (recorded), and changed player slots
 *    are sent for window 0;
 *  - a disconnect drops the cursor, the 2x2 grid and an open table's grid;
 *  - furnaces (ContainerFurnace: input 0, fuel 1, SlotFurnace output 2 that takes nothing,
 *    player 3-38): S2D type 2, S30, the cursor, then S31 for its three timers; the furnace
 *    keeps its items when closed, and tickFurnaces() runs TileEntityFurnace.updateEntity;
 *  - modded blocks whose GUI opens with Forge's OpenGui message (Iron Chests, Tinkers'
 *    crafting station, any mod GUI), then S30 with their own slots.
 */
export class FakeChestSim {
  readonly dropped: FakeStack[] = [];
  readonly clicks: Array<{
    windowId: number;
    slot: number;
    button: number;
    action: number;
    accepted: boolean;
  }> = [];
  readonly activations: Array<{ x: number; y: number; z: number; heldSlot: number }> = [];
  /** Window types opened (S2D), in order. */
  readonly openedTypes: number[] = [];
  /** Crafts taken from a result slot. */
  crafts = 0;
  /** Connections that ended (each drops the cursor and the crafting grids). */
  disconnects = 0;
  heldSlot = 0;
  /** Called after each processed click with its 1-based number (tests use it to interfere). */
  onClick: ((n: number) => void) | null = null;
  /** While true, clicks are ignored: no verdict, no change (a server that stopped answering). */
  ignoreClicks = false;
  /**
   * Called after the player's inventory changed (a pickup, an accepted click, a removal), like
   * Better Questing's PlayerContainerListener, which hears every slot change of the player's
   * container.
   */
  onInventoryChange: (() => void) | null = null;
  readonly #chests = new Map<string, Array<FakeStack | null>>();
  readonly #tables: ReadonlySet<string>;
  readonly #recipes: readonly FakeRecipe[];
  readonly #furnaces = new Map<string, FurnaceState>();
  readonly #mods = new Map<string, FakeModBlock>();
  readonly #smelting: readonly FakeSmelting[];
  /** Burn ticks by item id (TileEntityFurnace.getItemBurnTime). */
  readonly #fuels: ReadonlyMap<number, number>;
  /** Told when a furnace lights up or goes out (BlockFurnace swaps furnace / lit_furnace). */
  onFurnaceLit: ((x: number, y: number, z: number, lit: boolean) => void) | null = null;
  /** Window properties (S31) sent, in order. */
  readonly properties: Array<{ windowId: number; property: number; value: number }> = [];
  /** The player's window-0 layout (45 slots); 1-4 stay null (the 2x2 grid lives in #grid2). */
  readonly #player: Array<FakeStack | null>;
  readonly #grid2: Grid = { slots: [null, null, null, null], width: 2, result: null };
  #lastSentPlayer: Array<FakeStack | null>;
  #open: OpenWindow | null = null;
  #cursor: FakeStack | null = null;
  #nextWindowId = 1;
  #clickCount = 0;
  #ignoringUntilAck: number | null = null;
  #send: (frame: Buffer) => void;
  readonly #modularUi: boolean;
  readonly #rejectClicks: ReadonlySet<number>;

  constructor(opts: {
    chests: readonly FakeChest[];
    tables?: ReadonlyArray<{ x: number; y: number; z: number }>;
    recipes?: readonly FakeRecipe[];
    furnaces?: readonly FakeFurnace[];
    modBlocks?: readonly FakeModBlock[];
    smelting?: readonly FakeSmelting[];
    fuels?: ReadonlyMap<number, number>;
    playerInventory: ReadonlyArray<FakeStack & { slot: number }>;
    modularUi: boolean;
    rejectClicks: ReadonlySet<number>;
    send: (frame: Buffer) => void;
  }) {
    for (const c of opts.chests) {
      const slots: Array<FakeStack | null> = Array.from({ length: c.size }, () => null);
      for (const it of c.items)
        slots[it.slot] = { id: it.id, count: it.count, damage: it.damage, nbt: it.nbt };
      this.#chests.set(`${c.x},${c.y},${c.z}`, slots);
    }
    for (const f of opts.furnaces ?? []) {
      this.#furnaces.set(`${f.x},${f.y},${f.z}`, {
        slots: [copy(f.input ?? null), copy(f.fuel ?? null), copy(f.output ?? null)],
        cookTicks: f.cookTicks ?? 0,
        burnTicks: f.burnTicks ?? 0,
        itemBurnTicks: f.itemBurnTicks ?? 0,
      });
    }
    for (const m of opts.modBlocks ?? []) {
      this.#mods.set(`${m.x},${m.y},${m.z}`, {
        ...m,
        slots: m.slots.map(copy),
        trailing: (m.trailing ?? []).map(copy),
      });
    }
    this.#smelting = opts.smelting ?? [];
    this.#fuels = opts.fuels ?? new Map();
    this.#tables = new Set((opts.tables ?? []).map((t) => `${t.x},${t.y},${t.z}`));
    this.#recipes = opts.recipes ?? [];
    this.#player = Array.from({ length: 45 }, () => null);
    for (const it of opts.playerInventory) {
      this.#player[it.slot] = { id: it.id, count: it.count, damage: it.damage, nbt: it.nbt };
    }
    this.#lastSentPlayer = this.#player.map(copy);
    this.#send = opts.send;
    this.#modularUi = opts.modularUi;
    this.#rejectClicks = opts.rejectClicks;
  }

  /** Frames go to the current connection. */
  setSender(send: (frame: Buffer) => void): void {
    this.#send = send;
  }

  chestContents(x: number, y: number, z: number): Array<FakeStack | null> {
    return [...(this.#chests.get(`${x},${y},${z}`) ?? [])];
  }

  /** A furnace's slots (input, fuel, output) and timers, as the server holds them. */
  furnace(
    x: number,
    y: number,
    z: number,
  ): {
    input: FakeStack | null;
    fuel: FakeStack | null;
    output: FakeStack | null;
    cookTicks: number;
    burnTicks: number;
    itemBurnTicks: number;
  } | null {
    const f = this.#furnaces.get(`${x},${y},${z}`);
    if (f === undefined) return null;
    return {
      input: copy(f.slots[0]),
      fuel: copy(f.slots[1]),
      output: copy(f.slots[2]),
      cookTicks: f.cookTicks,
      burnTicks: f.burnTicks,
      itemBurnTicks: f.itemBurnTicks,
    };
  }

  /** A modded block's own slots, as the server holds them. */
  modBlockSlots(x: number, y: number, z: number): Array<FakeStack | null> {
    return (this.#mods.get(`${x},${y},${z}`)?.slots ?? []).map(copy);
  }

  /**
   * Advances every furnace `ticks` server ticks, exactly like TileEntityFurnace.updateEntity
   * (1.7.10, Forge-patched): burn down, light the next fuel item when something can smelt,
   * cook 200 ticks per item (reset when the fire is out). While its window is open, changed
   * slots go to the client as S2F and changed timers as S31 (ContainerFurnace).
   */
  tickFurnaces(ticks = 1): void {
    for (const [key, f] of this.#furnaces) {
      const before = f.slots.map(copy);
      const wasLit = f.burnTicks > 0;
      for (let t = 0; t < ticks; t++) this.#tickFurnace(f);
      const open = this.#open;
      if (open?.kind === 'furnace' && open.key === key) {
        for (let i = 0; i < 3; i++) {
          if (!same(before[i] ?? null, f.slots[i] ?? null)) {
            this.#send(
              encodeFrame(
                0x2f,
                Buffer.concat([
                  Buffer.from([open.windowId]),
                  i16(i),
                  encodeStack(f.slots[i] ?? null, this.#modularUi),
                ]),
              ),
            );
          }
        }
        this.#sendFurnaceProperties(open, f, false);
      }
      if (wasLit !== f.burnTicks > 0) {
        const [x, y, z] = key.split(',').map(Number) as [number, number, number];
        this.onFurnaceLit?.(x, y, z, f.burnTicks > 0);
      }
    }
  }

  #smeltResult(s: FakeStack | null): FakeStack | null {
    if (s === null) return null;
    return this.#smelting.find((r) => fits(r.input, s))?.result ?? null;
  }

  #tickFurnace(f: FurnaceState): void {
    const canSmelt = (): boolean => {
      const result = this.#smeltResult(f.slots[0]);
      if (result === null) return false;
      const out = f.slots[2];
      return out === null || (sameItem(out, result) && out.count + result.count <= 64);
    };
    if (f.burnTicks > 0) f.burnTicks -= 1;
    if (f.burnTicks === 0 && (f.slots[1] === null || f.slots[0] === null)) return;
    if (f.burnTicks === 0 && canSmelt()) {
      const fuel = f.slots[1];
      const burn = fuel === null ? 0 : (this.#fuels.get(fuel.id) ?? 0);
      f.burnTicks = burn;
      f.itemBurnTicks = burn;
      if (burn > 0 && fuel !== null) {
        f.slots[1] = fuel.count > 1 ? { ...fuel, count: fuel.count - 1 } : null;
      }
    }
    if (f.burnTicks > 0 && canSmelt()) {
      f.cookTicks += 1;
      if (f.cookTicks === 200) {
        f.cookTicks = 0;
        const result = this.#smeltResult(f.slots[0]);
        const input = f.slots[0];
        if (result !== null && input !== null) {
          const out = f.slots[2];
          f.slots[2] = out === null ? { ...result } : { ...out, count: out.count + result.count };
          f.slots[0] = input.count > 1 ? { ...input, count: input.count - 1 } : null;
        }
      }
    } else {
      f.cookTicks = 0;
    }
  }

  /** S31 for the furnace timers that changed since last sent (all of them when `all`). */
  #sendFurnaceProperties(
    open: { windowId: number; sent: [number, number, number] },
    f: FurnaceState,
    all: boolean,
  ): void {
    const values: [number, number, number] = [f.cookTicks, f.burnTicks, f.itemBurnTicks];
    values.forEach((value, property) => {
      if (!all && open.sent[property] === value) return;
      open.sent[property] = value;
      this.properties.push({ windowId: open.windowId, property, value });
      // S31: u8 window, i16 property, i16 value (the value wraps like a Java short).
      const b = Buffer.alloc(5);
      b.writeUInt8(open.windowId, 0);
      b.writeInt16BE(property, 1);
      b.writeInt16BE(((value & 0xffff) << 16) >> 16, 3);
      this.#send(encodeFrame(0x31, b));
    });
  }

  /** Window-0 slots 0-44 as the player inventory holds them (the 2x2 grid is separate). */
  playerSlots(): Array<FakeStack | null> {
    return [...this.#player];
  }

  /** The 2x2 grid in window 0, and an open crafting table's grid (empty when none is open). */
  craftingGrids(): { inventory: Array<FakeStack | null>; table: Array<FakeStack | null> } {
    return {
      inventory: [...this.#grid2.slots],
      table: this.#open?.kind === 'table' ? [...this.#open.grid.slots] : [],
    };
  }

  get cursor(): FakeStack | null {
    return this.#cursor;
  }

  get openWindowId(): number | null {
    return this.#open?.windowId ?? null;
  }

  /**
   * An item picked up from the ground, stored like 1.7.10's InventoryPlayer: onto a matching
   * stack with room first, then into the first empty slot, hotbar FIRST (inventory index 0-8
   * is window slots 36-44), then the main inventory (9-35). The changed slots are sent as S2F
   * for window 0. Returns how many items did not fit.
   */
  pickUp(stack: FakeStack): number {
    let left = stack.count;
    const order = [
      ...Array.from({ length: 9 }, (_, i) => 36 + i),
      ...Array.from({ length: 27 }, (_, i) => 9 + i),
    ];
    const changed = new Set<number>();
    for (const slot of order) {
      const s = this.#player[slot];
      if (
        left > 0 &&
        s != null &&
        s.id === stack.id &&
        s.damage === stack.damage &&
        s.nbt !== true &&
        s.count < 64
      ) {
        const n = Math.min(left, 64 - s.count);
        this.#player[slot] = { ...s, count: s.count + n };
        left -= n;
        changed.add(slot);
      }
    }
    for (const slot of order) {
      if (left > 0 && this.#player[slot] == null) {
        const n = Math.min(left, 64);
        this.#player[slot] = { id: stack.id, count: n, damage: stack.damage };
        left -= n;
        changed.add(slot);
      }
    }
    for (const slot of changed) {
      this.#send(
        encodeFrame(
          0x2f,
          Buffer.concat([
            Buffer.from([0]),
            i16(slot),
            encodeStack(this.#player[slot] ?? null, this.#modularUi),
          ]),
        ),
      );
    }
    this.#lastSentPlayer = this.#player.map((s) => (s === null ? null : { ...s }));
    if (changed.size > 0) this.onInventoryChange?.();
    return left;
  }

  /** The server changed a player slot (e.g. a tool wore): set it and send it (S2F, window 0). */
  setPlayerSlot(slot: number, stack: FakeStack | null): void {
    this.#player[slot] = stack;
    this.#send(
      encodeFrame(
        0x2f,
        Buffer.concat([Buffer.from([0]), i16(slot), encodeStack(stack, this.#modularUi)]),
      ),
    );
    this.#lastSentPlayer[slot] = copy(stack);
  }

  /**
   * Block.onBlockActivated for the block a C08 clicks: a chest, crafting table, furnace or
   * modded block opens its window (true; a modded block that opens nothing still takes the
   * click); any other block does nothing (false). Recorded either way.
   */
  activate(x: number, y: number, z: number): boolean {
    this.activations.push({ x, y, z, heldSlot: this.heldSlot });
    const key = `${x},${y},${z}`;
    const chest = this.#chests.get(key);
    if (chest !== undefined) {
      this.#openChest(key, chest.length);
      return true;
    }
    if (this.#tables.has(key)) {
      this.#openTable(key);
      return true;
    }
    if (this.#furnaces.has(key)) {
      this.#openFurnace(key);
      return true;
    }
    if (this.#mods.has(key)) {
      this.#openMod(key);
      return true;
    }
    return false;
  }

  /** The stack in the selected hotbar slot (window-0 slot 36 + heldSlot). */
  get heldStack(): FakeStack | null {
    return copy(this.#player[36 + this.heldSlot] ?? null);
  }

  /** A placement used one item of the held stack (server side; nothing is sent). */
  useHeldItem(): void {
    const slot = 36 + this.heldSlot;
    const s = this.#player[slot];
    if (s != null) this.#player[slot] = s.count > 1 ? { ...s, count: s.count - 1 } : null;
  }

  /**
   * S2F for the held slot in the open container (window 0 when none is open), as
   * processPlayerBlockPlacement sends it when the stack differs from the client's claim.
   */
  sendHeldSlot(): void {
    const open = this.#open;
    const windowSlot =
      open === null ? 36 + this.heldSlot : this.#containerSlots(open) + 27 + this.heldSlot;
    this.#send(
      encodeFrame(
        0x2f,
        Buffer.concat([
          Buffer.from([open?.windowId ?? 0]),
          i16(windowSlot),
          encodeStack(this.heldStack, this.#modularUi),
        ]),
      ),
    );
    this.#lastSentPlayer[36 + this.heldSlot] = this.heldStack;
  }

  /**
   * InventoryPlayer.decrStackSize on a player slot (window-0 numbering): removes up to `n`
   * items and sends the slot (S2F). Returns how many were removed.
   */
  take(slot: number, n: number): number {
    const s = this.#player[slot];
    if (s == null || n <= 0) return 0;
    const removed = Math.min(n, s.count);
    this.setPlayerSlot(slot, s.count - removed > 0 ? { ...s, count: s.count - removed } : null);
    this.onInventoryChange?.();
    return removed;
  }

  /** Handles a play-state packet if it is a container packet; returns whether it was. */
  handle(packetId: number, r: Reader): boolean {
    switch (packetId) {
      case 0x08: {
        const x = r.i32();
        const y = r.u8();
        const z = r.i32();
        r.u8(); // face
        readItemStack(r, { ...VANILLA_DECODING, itemStackSizeVarInt: this.#modularUi });
        this.activate(x, y, z);
        return true;
      }
      case 0x09:
        this.heldSlot = r.i16();
        return true;
      case 0x0e: {
        const windowId = r.i8();
        const slot = r.i16();
        const button = r.i8();
        const action = r.i16();
        r.i8(); // mode (0)
        const claimed = readItemStack(r, {
          ...VANILLA_DECODING,
          itemStackSizeVarInt: this.#modularUi,
        });
        if (windowId !== (this.#open?.windowId ?? 0)) return true;
        if (this.#ignoringUntilAck !== null) return true; // vanilla ignores clicks until C0F
        if (this.ignoreClicks) return true;
        this.#clickCount += 1;
        const before = this.#applyClick(slot, button);
        const claim: FakeStack | null =
          claimed === null
            ? null
            : {
                id: claimed.id,
                count: claimed.count,
                damage: claimed.damage,
                nbt: claimed.hasNbt ? true : undefined,
              };
        const accepted = same(claim, before) && !this.#rejectClicks.has(this.#clickCount);
        this.clicks.push({ windowId, slot, button, action, accepted });
        this.#send(
          encodeFrame(
            0x32,
            Buffer.concat([Buffer.from([windowId]), i16(action), Buffer.from([accepted ? 1 : 0])]),
          ),
        );
        if (!accepted) {
          this.#ignoringUntilAck = action;
          this.#sendWindow();
        }
        this.onClick?.(this.#clickCount);
        this.onInventoryChange?.();
        return true;
      }
      case 0x0f: {
        r.i8();
        const action = r.i16();
        if (action === this.#ignoringUntilAck) this.#ignoringUntilAck = null;
        return true;
      }
      case 0x0d:
        r.i8(); // 1.7.10 ignores the id: it closes whatever is open, or the inventory itself
        if (this.#open === null) this.#closeInventory();
        else this.#close();
        return true;
      default:
        return false;
    }
  }

  onDisconnect(): void {
    this.disconnects += 1;
    // EntityPlayer.setDead closes both the inventory container and the open window.
    if (this.#cursor !== null) this.dropped.push(this.#cursor);
    this.#cursor = null;
    this.#dropGrid(this.#grid2);
    if (this.#open?.kind === 'table') this.#dropGrid(this.#open.grid);
    this.#open = null;
    this.#ignoringUntilAck = null;
  }

  /** A new connection: the client is sent the whole player inventory at join. */
  onJoin(): void {
    this.#open = null;
    this.#cursor = null;
    this.#ignoringUntilAck = null;
    this.#lastSentPlayer = this.#player.map(copy);
  }

  #openChest(key: string, size: number): void {
    this.#close();
    this.#open = { kind: 'chest', windowId: this.#nextWindowId++, key, size };
    this.#sendOpenWindow(0, 'container.chest', size);
  }

  #openTable(key: string): void {
    this.#close();
    const grid: Grid = { slots: Array.from({ length: 9 }, () => null), width: 3, result: null };
    this.#open = { kind: 'table', windowId: this.#nextWindowId++, key, grid };
    // displayGUIWorkbench announces the 9 grid slots; the window also has the result slot.
    this.#sendOpenWindow(1, 'Crafting', 9);
  }

  /** displayGUIFurnace: S2D(type 2, "container.furnace", 3), S30, cursor, then the 3 S31. */
  #openFurnace(key: string): void {
    this.#close();
    const f = this.#furnaces.get(key);
    if (f === undefined) return;
    const open = {
      kind: 'furnace' as const,
      windowId: this.#nextWindowId++,
      key,
      sent: [0, 0, 0] as [number, number, number],
    };
    this.#open = open;
    this.#sendOpenWindow(2, 'container.furnace', 3);
    this.#sendFurnaceProperties(open, f, true);
  }

  /**
   * FMLNetworkHandler.openGui: the previous container is closed (silently), then the FML
   * OpenGui message (channel "FML", discriminator 1) and S30 with the window's slots.
   */
  #openMod(key: string): void {
    const block = this.#mods.get(key);
    if (block === undefined || block.opensNothing === true) return;
    this.#close();
    const windowId = this.#nextWindowId++;
    this.#open = { kind: 'mod', windowId, key, block };
    this.openedTypes.push(-1);
    const id = Buffer.alloc(4);
    id.writeInt32BE(windowId);
    const ints = Buffer.alloc(16);
    ints.writeInt32BE(block.guiId, 0);
    ints.writeInt32BE(block.x, 4);
    ints.writeInt32BE(block.y, 8);
    ints.writeInt32BE(block.z, 12);
    const data = Buffer.concat([Buffer.from([1]), id, encodeString(block.modId), ints]);
    this.#send(
      encodeFrame(0x3f, Buffer.concat([encodeString('FML'), encodeVarShort(data.length), data])),
    );
    this.#sendWindow();
  }

  #sendOpenWindow(type: number, title: string, slots: number): void {
    const open = this.#open;
    if (open === null) return;
    this.openedTypes.push(type);
    this.#send(
      encodeFrame(
        0x2d,
        Buffer.concat([
          Buffer.from([open.windowId, type]),
          encodeString(title),
          Buffer.from([slots, 1]),
        ]),
      ),
    );
    this.#sendWindow();
  }

  /** S30 for the open window (window 0 when none is), then the cursor (S2F window -1, slot -1). */
  #sendWindow(): void {
    const size = this.#windowSize();
    const slots = Array.from({ length: size }, (_, i) => this.#get(i));
    this.#send(
      encodeFrame(
        0x30,
        Buffer.concat([
          Buffer.from([this.#open?.windowId ?? 0]),
          i16(slots.length),
          ...slots.map((s) => encodeStack(s, this.#modularUi)),
        ]),
      ),
    );
    this.#send(
      encodeFrame(
        0x2f,
        Buffer.concat([Buffer.from([0xff]), i16(-1), encodeStack(this.#cursor, this.#modularUi)]),
      ),
    );
  }

  /** ContainerPlayer.onContainerClosed: the cursor and the 2x2 grid are dropped. */
  #closeInventory(): void {
    if (this.#cursor !== null) this.dropped.push(this.#cursor);
    this.#cursor = null;
    this.#dropGrid(this.#grid2);
    this.#ignoringUntilAck = null;
  }

  #close(): void {
    const open = this.#open;
    if (open === null) return;
    if (this.#cursor !== null) this.dropped.push(this.#cursor);
    this.#cursor = null;
    if (open.kind === 'table') this.#dropGrid(open.grid);
    this.#open = null;
    this.#ignoringUntilAck = null;
    // The inventory container syncs its changed slots on the next tick.
    for (let i = 0; i < 45; i++) {
      const now = this.#player[i] ?? null;
      if (!same(now, this.#lastSentPlayer[i] ?? null)) {
        this.#send(
          encodeFrame(
            0x2f,
            Buffer.concat([Buffer.from([0]), i16(i), encodeStack(now, this.#modularUi)]),
          ),
        );
      }
    }
    this.#lastSentPlayer = this.#player.map(copy);
  }

  #dropGrid(grid: Grid): void {
    for (let i = 0; i < grid.slots.length; i++) {
      const s = grid.slots[i];
      if (s != null) this.dropped.push(s);
      grid.slots[i] = null;
    }
    grid.result = null;
  }

  /** The block's own slots before the player's 36 in the open window. */
  #containerSlots(open: OpenWindow): number {
    switch (open.kind) {
      case 'chest':
        return open.size;
      case 'table':
        return 10;
      case 'furnace':
        return 3;
      case 'mod':
        return open.block.playerFirst === true ? 0 : open.block.slots.length;
    }
  }

  #windowSize(): number {
    const open = this.#open;
    if (open === null) return 46; // with GTNH Backhand's off-hand slot (45, always empty here)
    if (open.kind === 'furnace') return 39;
    if (open.kind === 'mod') {
      return open.block.slots.length + 36 + (open.block.trailing?.length ?? 0);
    }
    return open.kind === 'chest' ? open.size + 36 : 46;
  }

  /** Window slot -> where it lives, for the furnace and mod windows. */
  #extraSlot(
    i: number,
  ): { store: Array<FakeStack | null>; index: number } | { player: number } | null | undefined {
    const open = this.#open;
    if (open?.kind === 'furnace') {
      const f = this.#furnaces.get(open.key);
      if (f === undefined) return null;
      return i < 3 ? { store: f.slots, index: i } : { player: 9 + (i - 3) };
    }
    if (open?.kind === 'mod') {
      const b = open.block;
      const n = b.slots.length;
      if (b.playerFirst === true) {
        return i < 36 ? { player: 9 + i } : i < 36 + n ? { store: b.slots, index: i - 36 } : null;
      }
      if (i < n) return { store: b.slots, index: i };
      if (i < n + 36) return { player: 9 + (i - n) };
      return { store: b.trailing ?? [], index: i - n - 36 };
    }
    return undefined; // not a furnace or mod window
  }

  /** Slot.isItemValid: a furnace's output slot (SlotFurnace) takes nothing. */
  #accepts(i: number): boolean {
    return !(this.#open?.kind === 'furnace' && i === 2);
  }

  /** The crafting grid of the click window, if it has one. */
  #grid(): Grid | null {
    const open = this.#open;
    if (open === null) return this.#grid2;
    return open.kind === 'table' ? open.grid : null;
  }

  /** Window slot -> backing store, for the open window (window 0 when none is open). */
  #get(i: number): FakeStack | null {
    const extra = this.#extraSlot(i);
    if (extra !== undefined) {
      if (extra === null) return null;
      return 'player' in extra
        ? (this.#player[extra.player] ?? null)
        : (extra.store[extra.index] ?? null);
    }
    const open = this.#open;
    if (open === null) {
      if (i === 0) return this.#grid2.result;
      if (i >= 1 && i <= 4) return this.#grid2.slots[i - 1] ?? null;
      return i < 45 ? (this.#player[i] ?? null) : null;
    }
    if (open.kind === 'chest') {
      if (i < open.size) return this.#chests.get(open.key)?.[i] ?? null;
      return this.#player[9 + (i - open.size)] ?? null;
    }
    if (open.kind !== 'table') return null; // furnace and mod windows: #extraSlot
    if (i === 0) return open.grid.result;
    if (i <= 9) return open.grid.slots[i - 1] ?? null;
    return this.#player[9 + (i - 10)] ?? null;
  }

  #set(i: number, s: FakeStack | null): void {
    const v = s === null || s.count <= 0 ? null : s;
    const extra = this.#extraSlot(i);
    if (extra !== undefined) {
      if (extra === null) return;
      if ('player' in extra) this.#player[extra.player] = v;
      else extra.store[extra.index] = v;
      return;
    }
    const open = this.#open;
    const grid = this.#grid();
    const gridIndex =
      open === null
        ? i >= 1 && i <= 4
          ? i - 1
          : -1
        : open.kind === 'table' && i >= 1 && i <= 9
          ? i - 1
          : -1;
    if (grid !== null && gridIndex >= 0) {
      grid.slots[gridIndex] = v;
      grid.result = matchRecipe(this.#recipes, grid.slots, grid.width); // onCraftMatrixChanged
      return;
    }
    if (open === null) {
      if (i >= 5 && i < 45) this.#player[i] = v;
      return;
    }
    if (open.kind === 'chest') {
      if (i < open.size) {
        const chest = this.#chests.get(open.key);
        if (chest !== undefined) chest[i] = v;
      } else this.#player[9 + (i - open.size)] = v;
      return;
    }
    if (i >= 10) this.#player[9 + (i - 10)] = v;
  }

  #isResultSlot(i: number): boolean {
    return i === 0 && this.#grid() !== null;
  }

  /** SlotCrafting.onPickupFromSlot: one item from every grid slot, then the result is recomputed. */
  #craftTaken(): void {
    const grid = this.#grid();
    if (grid === null) return;
    for (let k = 0; k < grid.slots.length; k++) {
      const s = grid.slots[k];
      if (s != null) grid.slots[k] = s.count > 1 ? { ...s, count: s.count - 1 } : null;
    }
    grid.result = matchRecipe(this.#recipes, grid.slots, grid.width);
    this.crafts += 1;
  }

  /** Container.slotClick, mode 0. Returns a copy of the slot's stack before the click. */
  #applyClick(i: number, button: number): FakeStack | null {
    if (i < 0) return null; // vanilla: a negative slot (other than -999) does nothing
    if (i >= this.#windowSize()) return null;
    const slot = this.#get(i);
    const before = copy(slot);
    const cursor = this.#cursor;
    if (this.#isResultSlot(i)) {
      // SlotCrafting: nothing can be put in; taking gives the whole result (any button).
      const grid = this.#grid();
      if (slot === null || grid === null) return before;
      if (cursor === null) {
        this.#cursor = { ...slot };
        grid.result = null;
        this.#craftTaken();
      } else if (sameItem(slot, cursor) && cursor.count + slot.count <= 64) {
        this.#cursor = { ...cursor, count: cursor.count + slot.count };
        grid.result = null;
        this.#craftTaken();
      }
      return before;
    }
    const accepts = this.#accepts(i);
    if (slot === null) {
      if (cursor !== null && accepts) {
        const n = Math.min(button === 0 ? cursor.count : 1, 64);
        this.#set(i, { ...cursor, count: n });
        this.#cursor = cursor.count - n > 0 ? { ...cursor, count: cursor.count - n } : null;
      }
    } else if (cursor === null) {
      const n = button === 0 ? slot.count : Math.ceil(slot.count / 2);
      this.#cursor = { ...slot, count: n };
      this.#set(i, { ...slot, count: slot.count - n });
    } else if (!accepts) {
      // A slot that takes nothing (SlotFurnace): the same item moves from it onto the cursor.
      if (sameItem(slot, cursor) && slot.count + cursor.count <= 64) {
        this.#cursor = { ...cursor, count: cursor.count + slot.count };
        this.#set(i, null);
      }
    } else if (sameItem(slot, cursor)) {
      const n = Math.min(button === 0 ? cursor.count : 1, 64 - slot.count);
      this.#set(i, { ...slot, count: slot.count + n });
      this.#cursor = cursor.count - n > 0 ? { ...cursor, count: cursor.count - n } : null;
    } else {
      this.#set(i, cursor);
      this.#cursor = slot;
    }
    return before;
  }
}
