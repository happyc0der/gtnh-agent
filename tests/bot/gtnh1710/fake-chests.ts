import { gzipSync } from 'node:zlib';
import { readItemStack, VANILLA_DECODING } from '../../../src/bot/gtnh1710/packets.ts';
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
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

type OpenWindow =
  | { kind: 'chest'; windowId: number; key: string; size: number }
  | { kind: 'table'; windowId: number; key: string; grid: Grid };

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
 *  - a disconnect drops the cursor, the 2x2 grid and an open table's grid.
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
  readonly #chests = new Map<string, Array<FakeStack | null>>();
  readonly #tables: ReadonlySet<string>;
  readonly #recipes: readonly FakeRecipe[];
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
    return left;
  }

  /**
   * Block.onBlockActivated for the block a C08 clicks: a chest or crafting table opens its
   * window (true); any other block does nothing (false). Recorded either way.
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
      open === null
        ? 36 + this.heldSlot
        : (open.kind === 'chest' ? open.size : 10) + 27 + this.heldSlot;
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

  #windowSize(): number {
    const open = this.#open;
    if (open === null) return 46; // with GTNH Backhand's off-hand slot (45, always empty here)
    return open.kind === 'chest' ? open.size + 36 : 46;
  }

  /** The crafting grid of the click window, if it has one. */
  #grid(): Grid | null {
    const open = this.#open;
    if (open === null) return this.#grid2;
    return open.kind === 'table' ? open.grid : null;
  }

  /** Window slot -> backing store, for the open window (window 0 when none is open). */
  #get(i: number): FakeStack | null {
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
    if (i === 0) return open.grid.result;
    if (i <= 9) return open.grid.slots[i - 1] ?? null;
    return this.#player[9 + (i - 10)] ?? null;
  }

  #set(i: number, s: FakeStack | null): void {
    const v = s === null || s.count <= 0 ? null : s;
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
    if (slot === null) {
      if (cursor !== null) {
        const n = Math.min(button === 0 ? cursor.count : 1, 64);
        this.#set(i, { ...cursor, count: n });
        this.#cursor = cursor.count - n > 0 ? { ...cursor, count: cursor.count - n } : null;
      }
    } else if (cursor === null) {
      const n = button === 0 ? slot.count : Math.ceil(slot.count / 2);
      this.#cursor = { ...slot, count: n };
      this.#set(i, { ...slot, count: slot.count - n });
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
