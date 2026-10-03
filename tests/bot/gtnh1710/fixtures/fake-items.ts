import { encodeFrame, encodeVarInt, i32 } from '../../../../src/bot/gtnh1710/wire.ts';
import { encodeStack, type FakeChestSim } from './fake-chests.ts';
import { PLAYER_ENTITY_ID } from './fake-combat.ts';

/**
 * Dropped items on the fake server, as vanilla 1.7.10 + Forge 10.13.4.1614 handles them
 * (EntityItem, EntityTracker / EntityTrackerEntry, EntityPlayer.onLivingUpdate):
 *  - an item appears with S0E Spawn Object (type 2, object data 1, its velocity), then S1C with
 *    its whole DataWatcher (0 its flags, 1 its air, 10 its ItemStack), then S12 its velocity;
 *  - it flies up a little and falls onto the first block under it; the fake takes it straight
 *    down from where it appeared (or to `restAt`, for a test), landing LAND_TICKS after it
 *    appeared (2 ticks more for each block it falls beyond its own cell);
 *  - the tracker sends its position every 20 ticks (EntityItem's update frequency), and only
 *    when it moved 1/8 block since the last position it sent: a relative move (S15), or a
 *    teleport (S18) beyond 4 blocks. Lying still, it sends nothing more (the real tracker's
 *    move of nothing every 60 ticks is left out);
 *  - after its pickup delay (10 ticks), a player tick (C03, C06) with its box (0.25 wide and
 *    high, its position the centre) inside the player's box grown by 1 sideways and 0.5 up and
 *    down picks it up: into the inventory like InventoryPlayer (S2F), S0D collect, S13 destroy.
 *    What does not fit stays, with a smaller stack (S1C).
 */

const TICK_MS = 50;
/** EntityItem's pickup delay for a block's or a mob's drops (10 ticks). */
const PICKUP_DELAY_TICKS = 10;
/** How long a drop flies before it lies on the block under its cell. */
const LAND_TICKS = 10;
/** EntityTracker: an EntityItem's position goes out every 20 ticks. */
const UPDATE_TICKS = 20;
const HALF = 0.125;

export interface FakeItemWorld {
  blockAt(x: number, y: number, z: number): number;
  /** Registry id of an item by name (`name` or `name@damage`'s base). */
  itemId(name: string): number | undefined;
  /** The player's feet, from its last position packet. */
  playerFeet(): { x: number; y: number; z: number } | null;
}

interface Vec {
  x: number;
  y: number;
  z: number;
}

/** A dropped item the fake server keeps. */
export interface FakeDroppedItem {
  entityId: number;
  item: string;
  count: number;
  /** Where it appeared, and where it comes to rest. */
  spawn: Vec;
  rest: Vec;
  spawnedAt: number;
  landTicks: number;
  /** The position the tracker last sent, in 1/32 blocks. */
  sent: { x: number; y: number; z: number };
  /** The tracker's ticks since it appeared. */
  ticks: number;
  onPickup: (item: string, count: number) => void;
}

const fixed = (v: number): number => Math.floor(v * 32);

export class FakeItemSim {
  /** Every item that appeared, in order (tests). */
  readonly spawned: FakeDroppedItem[] = [];
  readonly #items = new Map<number, FakeDroppedItem>();
  readonly #world: FakeItemWorld;
  readonly #chests: FakeChestSim;
  readonly #modularUi: boolean;
  #broadcast: (frame: Buffer) => void = () => undefined;
  #timer: NodeJS.Timeout | null = null;
  #nextId = 70_000;

  constructor(world: FakeItemWorld, chests: FakeChestSim, modularUi: boolean) {
    this.#world = world;
    this.#chests = chests;
    this.#modularUi = modularUi;
  }

  setBroadcast(broadcast: (frame: Buffer) => void): void {
    this.#broadcast = broadcast;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** The items lying in the world now (tests). */
  lying(): FakeDroppedItem[] {
    return [...this.#items.values()];
  }

  /** A client joined: the tracker announces every item lying in the world, where it is now. */
  onJoin(send: (frame: Buffer) => void): void {
    const now = Date.now();
    for (const d of this.#items.values()) {
      const p = this.#positionAt(d, now);
      d.sent = { x: fixed(p.x), y: fixed(p.y), z: fixed(p.z) };
      send(this.#spawnFrame(d));
      send(this.#metadataFrame(d));
    }
  }

  /**
   * An item appears at `at` (EntityItem's position: the centre of its box) and falls to the
   * block under it, or to `restAt`. Returns its entity id.
   */
  spawn(
    item: string,
    count: number,
    at: Vec,
    onPickup: (item: string, count: number) => void,
    restAt?: Vec,
  ): number {
    const rest = restAt ?? this.#restUnder(at);
    const fell = Math.max(0, Math.floor(at.y) - Math.floor(rest.y));
    const d: FakeDroppedItem = {
      entityId: this.#nextId++,
      item,
      count,
      spawn: { ...at },
      rest: { ...rest },
      spawnedAt: Date.now(),
      landTicks: LAND_TICKS + 2 * fell,
      sent: { x: fixed(at.x), y: fixed(at.y), z: fixed(at.z) },
      ticks: 0,
      onPickup,
    };
    this.#items.set(d.entityId, d);
    this.spawned.push(d);
    this.#broadcast(this.#spawnFrame(d));
    this.#broadcast(this.#metadataFrame(d));
    // Its velocity (up 0.2 a tick), which the agent does not read.
    const v = Buffer.alloc(6);
    v.writeInt16BE(1600, 2);
    this.#broadcast(encodeFrame(0x12, Buffer.concat([i32(d.entityId), v])));
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
    return d.entityId;
  }

  /** A player packet (idle or move): items in reach whose pickup delay is over are picked up. */
  onPlayerTick(): void {
    const feet = this.#world.playerFeet();
    if (feet === null) return;
    const now = Date.now();
    for (const d of [...this.#items.values()]) {
      if (now - d.spawnedAt < PICKUP_DELAY_TICKS * TICK_MS) continue;
      const p = this.#positionAt(d, now);
      const inReach =
        Math.abs(p.x - feet.x) < 0.3 + 1 + HALF &&
        Math.abs(p.z - feet.z) < 0.3 + 1 + HALF &&
        p.y + HALF > feet.y - 0.5 &&
        p.y - HALF < feet.y + 1.8 + 0.5;
      const id = this.#world.itemId(d.item.replace(/@\d+$/, ''));
      if (!inReach || id === undefined) continue;
      const damage = Number(/@(\d+)$/.exec(d.item)?.[1] ?? 0);
      const left = this.#chests.pickUp({ id, count: d.count, damage });
      const taken = d.count - left;
      if (taken > 0) d.onPickup(d.item, taken);
      if (left > 0) {
        d.count = left;
        this.#broadcast(this.#metadataFrame(d));
        continue;
      }
      this.#items.delete(d.entityId);
      this.#broadcast(encodeFrame(0x0d, Buffer.concat([i32(d.entityId), i32(PLAYER_ENTITY_ID)])));
      this.#broadcast(encodeFrame(0x13, Buffer.concat([Buffer.from([1]), i32(d.entityId)])));
    }
  }

  /** Straight down from `at` to the first block under it: lying on its top. */
  #restUnder(at: Vec): Vec {
    const x = Math.floor(at.x);
    const z = Math.floor(at.z);
    let y = Math.floor(at.y);
    while (y > 0 && this.#world.blockAt(x, y - 1, z) === 0) y -= 1;
    // Inside a block (a mob's feet in the ground), it is pushed out on top of it.
    while (y < 255 && this.#world.blockAt(x, y, z) !== 0) y += 1;
    return { x: at.x, y: y + HALF, z: at.z };
  }

  /** Where it is: on the way down until it lands (roughly), then where it rests. */
  #positionAt(d: FakeDroppedItem, now: number): Vec {
    const f = Math.min(1, (now - d.spawnedAt) / (d.landTicks * TICK_MS));
    return {
      x: d.spawn.x + (d.rest.x - d.spawn.x) * f,
      y: d.spawn.y + (d.rest.y - d.spawn.y) * f,
      z: d.spawn.z + (d.rest.z - d.spawn.z) * f,
    };
  }

  /** EntityTrackerEntry.sendLocationToAllClients, every UPDATE_TICKS for each item. */
  #tick(): void {
    const now = Date.now();
    for (const d of this.#items.values()) {
      d.ticks += 1;
      if (d.ticks % UPDATE_TICKS !== 0) continue;
      const p = this.#positionAt(d, now);
      const at = { x: fixed(p.x), y: fixed(p.y), z: fixed(p.z) };
      const delta = { x: at.x - d.sent.x, y: at.y - d.sent.y, z: at.z - d.sent.z };
      if (Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)) < 4) continue;
      if (Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)) >= 128) {
        this.#broadcast(
          encodeFrame(
            0x18,
            Buffer.concat([i32(d.entityId), i32(at.x), i32(at.y), i32(at.z), Buffer.from([0, 0])]),
          ),
        );
      } else {
        const b = Buffer.alloc(3);
        b.writeInt8(delta.x, 0);
        b.writeInt8(delta.y, 1);
        b.writeInt8(delta.z, 2);
        this.#broadcast(encodeFrame(0x15, Buffer.concat([i32(d.entityId), b])));
      }
      d.sent = at;
    }
  }

  /** S0E as EntityTrackerEntry sends it for an EntityItem: S0EPacketSpawnObject(entity, 2, 1). */
  #spawnFrame(d: FakeDroppedItem): Buffer {
    const velocity = Buffer.alloc(6);
    velocity.writeInt16BE(1600, 2); // 0.2 blocks a tick up, x 8000
    return encodeFrame(
      0x0e,
      Buffer.concat([
        encodeVarInt(d.entityId),
        Buffer.from([2]),
        i32(d.sent.x),
        i32(d.sent.y),
        i32(d.sent.z),
        Buffer.from([0, 0]), // pitch, yaw
        i32(1), // object data: velocity follows
        velocity,
      ]),
    );
  }

  /** S1C with an EntityItem's whole DataWatcher: flags, air, and its ItemStack at 10. */
  #metadataFrame(d: FakeDroppedItem): Buffer {
    const id = this.#world.itemId(d.item.replace(/@\d+$/, '')) ?? 1;
    const damage = Number(/@(\d+)$/.exec(d.item)?.[1] ?? 0);
    const air = Buffer.alloc(2);
    air.writeInt16BE(300);
    return encodeFrame(
      0x1c,
      Buffer.concat([
        i32(d.entityId),
        Buffer.from([(0 << 5) | 0, 0]),
        Buffer.from([(1 << 5) | 1]),
        air,
        Buffer.from([(5 << 5) | 10]),
        encodeStack({ id, count: d.count, damage }, this.#modularUi),
        Buffer.from([0x7f]),
      ]),
    );
  }
}
