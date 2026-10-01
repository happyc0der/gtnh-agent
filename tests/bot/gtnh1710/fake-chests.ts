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

const EMPTY_NBT = gzipSync(Buffer.from([0x0a, 0x00, 0x00, 0x00])); // TAG_Compound "" { }

function encodeStack(s: FakeStack | null, modularUi: boolean): Buffer {
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

const i16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};

/**
 * Vanilla 1.7.10 chests, server side, for one connection:
 *  - C08 on a chest block opens it: S2D, then S30 (chest slots + the player's 36);
 *  - C0E (mode 0) is applied exactly like Container.slotClick, THEN the client's claimed
 *    stack is compared with the slot's stack before the click. A match is confirmed (S32
 *    true, and no slot updates: the client predicts them). A mismatch is rejected (S32
 *    false) with an immediate re-sync (S30 + cursor S2F), and further clicks are ignored
 *    until the client acknowledges with C0F;
 *  - C0D closes the window: a stack left on the cursor is DROPPED (recorded), and the
 *    changed player slots are sent for window 0;
 *  - a disconnect with a stack on the cursor drops it too.
 */
export class FakeChestSim {
  readonly dropped: FakeStack[] = [];
  readonly clicks: Array<{ slot: number; button: number; action: number; accepted: boolean }> = [];
  readonly activations: Array<{ x: number; y: number; z: number; heldSlot: number }> = [];
  heldSlot = 0;
  readonly #chests = new Map<string, Array<FakeStack | null>>();
  /** The player's window-0 layout (45 slots). */
  readonly #player: Array<FakeStack | null>;
  #lastSentPlayer: Array<FakeStack | null>;
  #open: { windowId: number; key: string; size: number } | null = null;
  #cursor: FakeStack | null = null;
  #nextWindowId = 1;
  #clickCount = 0;
  #ignoringUntilAck: number | null = null;
  #send: (frame: Buffer) => void;
  readonly #modularUi: boolean;
  readonly #rejectClicks: ReadonlySet<number>;

  constructor(opts: {
    chests: readonly FakeChest[];
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
    this.#player = Array.from({ length: 45 }, () => null);
    for (const it of opts.playerInventory) {
      this.#player[it.slot] = { id: it.id, count: it.count, damage: it.damage, nbt: it.nbt };
    }
    this.#lastSentPlayer = this.#player.map((s) => (s === null ? null : { ...s }));
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

  playerSlots(): Array<FakeStack | null> {
    return [...this.#player];
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

  /** Handles a play-state packet if it is a container packet; returns whether it was. */
  handle(packetId: number, r: Reader): boolean {
    switch (packetId) {
      case 0x08: {
        const x = r.i32();
        const y = r.u8();
        const z = r.i32();
        r.u8(); // face
        readItemStack(r, { ...VANILLA_DECODING, itemStackSizeVarInt: this.#modularUi });
        this.activations.push({ x, y, z, heldSlot: this.heldSlot });
        const key = `${x},${y},${z}`;
        const chest = this.#chests.get(key);
        if (chest !== undefined) this.#openChest(key, chest.length);
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
        if (this.#open === null || windowId !== this.#open.windowId) return true;
        if (this.#ignoringUntilAck !== null) return true; // vanilla ignores clicks until C0F
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
        this.clicks.push({ slot, button, action, accepted });
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
        return true;
      }
      case 0x0f: {
        r.i8();
        const action = r.i16();
        if (action === this.#ignoringUntilAck) this.#ignoringUntilAck = null;
        return true;
      }
      case 0x0d:
        r.i8();
        this.#close();
        return true;
      default:
        return false;
    }
  }

  onDisconnect(): void {
    if (this.#cursor !== null) this.dropped.push(this.#cursor);
    this.#cursor = null;
    this.#open = null;
    this.#ignoringUntilAck = null;
  }

  /** A new connection: the client is sent the whole player inventory at join. */
  onJoin(): void {
    this.#open = null;
    this.#cursor = null;
    this.#ignoringUntilAck = null;
    this.#lastSentPlayer = this.#player.map((s) => (s === null ? null : { ...s }));
  }

  #openChest(key: string, size: number): void {
    this.#close();
    this.#open = { windowId: this.#nextWindowId++, key, size };
    this.#send(
      encodeFrame(
        0x2d,
        Buffer.concat([
          Buffer.from([this.#open.windowId, 0]),
          encodeString('container.chest'),
          Buffer.from([size, 0]),
        ]),
      ),
    );
    this.#sendWindow();
  }

  /** S30 for the open window, then the cursor (S2F window -1, slot -1). */
  #sendWindow(): void {
    const open = this.#open;
    if (open === null) return;
    const slots = Array.from({ length: open.size + 36 }, (_, i) => this.#get(i));
    this.#send(
      encodeFrame(
        0x30,
        Buffer.concat([
          Buffer.from([open.windowId]),
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

  #close(): void {
    if (this.#open === null) return;
    if (this.#cursor !== null) this.dropped.push(this.#cursor);
    this.#cursor = null;
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
    this.#lastSentPlayer = this.#player.map((s) => (s === null ? null : { ...s }));
  }

  /** Window slot -> backing store: chest slots, then player main (9-35) and hotbar (36-44). */
  #get(i: number): FakeStack | null {
    const open = this.#open;
    if (open === null) return null;
    if (i < open.size) return this.#chests.get(open.key)?.[i] ?? null;
    return this.#player[9 + (i - open.size)] ?? null;
  }

  #set(i: number, s: FakeStack | null): void {
    const open = this.#open;
    if (open === null) return;
    const v = s === null || s.count <= 0 ? null : s;
    if (i < open.size) {
      const chest = this.#chests.get(open.key);
      if (chest !== undefined) chest[i] = v;
    } else this.#player[9 + (i - open.size)] = v;
  }

  /** Container.slotClick, mode 0. Returns a copy of the slot's stack before the click. */
  #applyClick(i: number, button: number): FakeStack | null {
    const slot = this.#get(i);
    const before = slot === null ? null : { ...slot };
    const cursor = this.#cursor;
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
    } else if (
      slot.id === cursor.id &&
      slot.damage === cursor.damage &&
      (slot.nbt ?? false) === (cursor.nbt ?? false)
    ) {
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
