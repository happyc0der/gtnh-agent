import { explosionDamage, KILL_EXPLOSION_POWER } from '../../../src/domain/combat.ts';
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
  encodeVarShort,
  f32,
  i32,
  type Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import type { FakeChestSim } from './fake-chests.ts';

/**
 * Vanilla 1.7.10 + Forge combat, server side, as disassembled from the test server's jars
 * (docs/gtnh-compatibility.md, "Combat"), plus the GTNH mods that change it:
 *  - C02 (i32 entity id, byte action) with action 1 attacks: ignored unless the target's feet
 *    are within 6 blocks of the player's (3 when the server cannot see it, `blind`); an item,
 *    XP orb, arrow or the player itself gets the player KICKED;
 *  - Battlegear2 cancels a bare-hand attack farther than 2.3 blocks;
 *  - damage: 1 for a bare hand, the held item's from `weaponDamage`; IguanaTweaks cancels the
 *    damage of a vanilla sword (`swordIds`), but the hurt status and knockback still happen;
 *  - hurt resistance: after a full hit, another full hit counts only 10 ticks (500 ms) later
 *    (the same damage again earlier does nothing);
 *  - a full hit sends S19 status 2 and the new health (S1C, index 6), and knocks the mob back
 *    0.4 blocks; at 0 health S19 status 3, then the entity is removed 20 ticks later (S13);
 *  - `kamikaze`: AngerMod's kill explosion (power 1.5) on every kill, hurting the player as
 *    1.7.10's Explosion does on Hard (deterministic here; the real chance is 10%);
 *  - mobs with `chase` walk at the player and hit it within 1.4 blocks once a second; a
 *    creeper that gets within 3 blocks explodes 1.5 s later (power 3);
 *  - a mob with `drops` drops them where it died (dropFewItems: EntityItems at its position);
 *    after their 10-tick pickup delay, a player tick (C03, C06) with them inside the player's
 *    box grown by 1 sideways and 0.5 up and down picks them up into the inventory.
 */

export interface FakeMob {
  entityId: number;
  /** Vanilla mob type (S0F), or a Forge modded type announced on the FML channel. */
  mobType?: number;
  modded?: { modId: string; typeId: number };
  x: number;
  y: number;
  z: number;
  health: number;
  /** Sent at spawn in the DataWatcher (index 10): a name tag. */
  customName?: string;
  /** Sent at spawn (index 12): below 0 for a baby. */
  age?: number;
  /** Sent at spawn (index 16, pigs): saddled. */
  saddled?: boolean;
  /** Walks at the player (blocks per tick) and hits it for `damage` within 1.4 blocks. */
  chase?: { speed: number; damage: number };
  /** Sent with no DataWatcher at all (as if its metadata did not decode). */
  noMetadata?: boolean;
  /** What it drops when killed (a farm animal's meat, leather...). */
  drops?: Array<{ item: string; count: number }>;
}

export interface FakeCombatOptions {
  mobs?: FakeMob[];
  /** The server cannot see any target (a block in between): attacks reach 3 blocks only. */
  blind?: boolean;
  /** Held item id -> damage of a full hit (a bare hand deals 1). */
  weaponDamage?: Record<number, number>;
  /** Held item ids that are vanilla swords: IguanaTweaks cancels their damage. */
  swordIds?: number[];
  /** Every kill explodes (AngerMod, power 1.5). */
  kamikaze?: boolean;
  /** Entity ids of items, XP orbs or arrows (attacking one kicks the player). */
  invalidTargets?: number[];
}

export interface RecordedAttack {
  entityId: number;
  /** The selected hotbar slot and the item id in it (null: empty hand). */
  heldItem: number | null;
  /** What the server did with it. */
  outcome:
    | 'hit'
    | 'resisted'
    | 'out of reach'
    | 'cancelled (bare hand beyond 2.3)'
    | 'no damage (sword)'
    | 'unknown entity'
    | 'kicked';
  at: number;
}

interface MobState extends FakeMob {
  lastFullHitAt: number;
  lastDamage: number;
  diedAt: number | null;
  lastAttackAt: number;
  creeperFuseAt: number | null;
}

const TICK_MS = 50;
/** hurtResistantTime 20 ticks, full damage again below 10. */
const RESISTANCE_MS = 10 * TICK_MS;
const DESPAWN_MS = 20 * TICK_MS;
const MOB_REACH = 1.4;
/** EntityItem's pickup delay for a mob's drops (Entity.entityDropItem: 10 ticks). */
const PICKUP_DELAY_MS = 10 * TICK_MS;

type MetaValue =
  | { index: number; type: 'byte' | 'short' | 'int' | 'float'; value: number }
  | { index: number; type: 'string'; value: string };

/** A 1.7.10 DataWatcher list. */
export function encodeMetadata(entries: readonly MetaValue[]): Buffer {
  const parts: Buffer[] = [];
  const typeId = { byte: 0, short: 1, int: 2, float: 3, string: 4 } as const;
  for (const e of entries) {
    parts.push(Buffer.from([((typeId[e.type] << 5) | (e.index & 0x1f)) & 0xff]));
    switch (e.type) {
      case 'byte':
        parts.push(Buffer.from([e.value & 0xff]));
        break;
      case 'short': {
        const b = Buffer.alloc(2);
        b.writeInt16BE(e.value);
        parts.push(b);
        break;
      }
      case 'int':
        parts.push(i32(e.value));
        break;
      case 'float':
        parts.push(f32(e.value));
        break;
      case 'string':
        parts.push(encodeString(e.value));
        break;
    }
  }
  parts.push(Buffer.from([0x7f]));
  return Buffer.concat(parts);
}

const fixed = (x: number, y: number, z: number): Buffer =>
  Buffer.concat([i32(Math.floor(x * 32)), i32(Math.floor(y * 32)), i32(Math.floor(z * 32))]);

export class FakeCombatSim {
  readonly attacks: RecordedAttack[] = [];
  readonly kills: number[] = [];
  readonly explosions: Array<{ at: { x: number; y: number; z: number }; playerDamage: number }> =
    [];
  /** Why the server kicked the player, if it did. */
  kicked: string | null = null;
  /** Drops the player picked up (a killed mob's). */
  readonly pickedUp: Array<{ item: string; count: number }> = [];
  /** Drops lying where a mob died, from when they may be picked up. */
  readonly #ground: Array<{
    x: number;
    y: number;
    z: number;
    item: string;
    count: number;
    from: number;
  }> = [];
  readonly #itemId: (name: string) => number | undefined;
  playerHealth: number;
  readonly #opts: FakeCombatOptions;
  readonly #chests: FakeChestSim;
  readonly #mobs = new Map<number, MobState>();
  readonly #playerFeet: () => { x: number; y: number; z: number } | null;
  #send: (frame: Buffer) => void = () => undefined;
  #broadcast: (frame: Buffer) => void = () => undefined;
  #kick: (reason: string) => void = () => undefined;
  #food: number;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    options: FakeCombatOptions,
    chests: FakeChestSim,
    player: {
      feet: () => { x: number; y: number; z: number } | null;
      health: number;
      food: number;
      /** Item ids by name, for drops. */
      itemId?: (name: string) => number | undefined;
    },
  ) {
    this.#opts = options;
    this.#chests = chests;
    this.#playerFeet = player.feet;
    this.#itemId = player.itemId ?? (() => undefined);
    this.playerHealth = player.health;
    this.#food = player.food;
    for (const m of options.mobs ?? []) {
      this.#mobs.set(m.entityId, {
        ...m,
        lastFullHitAt: -Infinity,
        lastDamage: 0,
        diedAt: null,
        lastAttackAt: -Infinity,
        creeperFuseAt: null,
      });
    }
  }

  setSenders(
    send: (frame: Buffer) => void,
    broadcast: (frame: Buffer) => void,
    kick: (reason: string) => void,
  ): void {
    this.#send = send;
    this.#broadcast = broadcast;
    this.#kick = kick;
  }

  /** Spawns every living mob for a client that just joined, and starts the mobs' ticks. */
  onJoin(): void {
    for (const m of this.#mobs.values()) {
      if (m.diedAt === null) this.#send(this.#spawnFrame(m));
    }
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** A mob's current state (tests). */
  mob(entityId: number): Readonly<MobState> | undefined {
    return this.#mobs.get(entityId);
  }

  /** Puts a mob somewhere else (tests), as the server's movement would. */
  moveMob(entityId: number, x: number, y: number, z: number): void {
    const m = this.#mobs.get(entityId);
    if (m === undefined) return;
    Object.assign(m, { x, y, z });
    this.#broadcast(this.#teleportFrame(m));
  }

  /** A new mob appears (tests). */
  spawn(mob: FakeMob): void {
    const m: MobState = {
      ...mob,
      lastFullHitAt: -Infinity,
      lastDamage: 0,
      diedAt: null,
      lastAttackAt: -Infinity,
      creeperFuseAt: null,
    };
    this.#mobs.set(mob.entityId, m);
    this.#broadcast(this.#spawnFrame(m));
  }

  /** The food level the server keeps for the player. */
  get food(): number {
    return this.#food;
  }

  /** The player ate (the server's FoodStats.addStats): the server sends the new food level. */
  feed(points: number): void {
    this.#food = Math.min(20, this.#food + points);
    this.#sendHealth();
  }

  /** The player is hurt by something else (tests): the server sends the new health. */
  hurtPlayer(damage: number): void {
    this.playerHealth = Math.max(0, this.playerHealth - damage);
    this.#sendHealth();
  }

  /** C02 Use Entity. */
  handle(r: Reader): void {
    const entityId = r.i32();
    const action = r.i8();
    if (action !== 1) return; // INTERACT: never expected from the agent
    const now = Date.now();
    const heldItem = this.#chests.playerSlots()[36 + this.#chests.heldSlot]?.id ?? null;
    const record = (outcome: RecordedAttack['outcome']): void => {
      this.attacks.push({ entityId, heldItem, outcome, at: now });
    };
    if ((this.#opts.invalidTargets ?? []).includes(entityId) || entityId === PLAYER_ENTITY_ID) {
      record('kicked');
      this.kicked = 'Attempting to attack an invalid entity';
      this.#kick(this.kicked);
      return;
    }
    const m = this.#mobs.get(entityId);
    const feet = this.#playerFeet();
    if (m === undefined || m.diedAt !== null || feet === null) {
      record('unknown entity');
      return;
    }
    const d = Math.hypot(m.x - feet.x, m.y - feet.y, m.z - feet.z);
    if (d * d >= (this.#opts.blind === true ? 9 : 36)) {
      record('out of reach');
      return;
    }
    if (heldItem === null && d > 2.3) {
      record('cancelled (bare hand beyond 2.3)');
      return;
    }
    const sword = heldItem !== null && (this.#opts.swordIds ?? []).includes(heldItem);
    const damage = heldItem === null ? 1 : (this.#opts.weaponDamage?.[heldItem] ?? 1);
    // EntityLivingBase.attackEntityFrom: within the resistance window only a bigger hit counts.
    if (now - m.lastFullHitAt < RESISTANCE_MS) {
      record('resisted');
      return;
    }
    m.lastFullHitAt = now;
    m.lastDamage = damage;
    if (!sword) m.health = Math.max(0, m.health - damage);
    record(sword ? 'no damage (sword)' : 'hit');
    this.#broadcast(statusFrame(entityId, 2));
    this.#broadcast(healthFrame(entityId, m.health));
    if (m.health > 0) {
      // Knockback: 0.4 blocks straight away from the player.
      const dx = m.x - feet.x;
      const dz = m.z - feet.z;
      const len = Math.hypot(dx, dz) || 1;
      m.x += (dx / len) * 0.4;
      m.z += (dz / len) * 0.4;
      this.#broadcast(this.#teleportFrame(m));
      return;
    }
    this.#die(m, d);
  }

  #die(m: MobState, distance: number): void {
    // AngerMod's LivingDeathEvent handler runs before the death status is sent.
    if (this.#opts.kamikaze === true) {
      const damage = explosionDamage(KILL_EXPLOSION_POWER, distance);
      this.explosions.push({ at: { x: m.x, y: m.y, z: m.z }, playerDamage: damage });
      if (damage > 0) this.hurtPlayer(damage);
    }
    m.diedAt = Date.now();
    this.kills.push(m.entityId);
    this.#broadcast(statusFrame(m.entityId, 3));
    for (const d of m.drops ?? []) {
      this.#ground.push({ x: m.x, y: m.y, z: m.z, ...d, from: m.diedAt + PICKUP_DELAY_MS });
    }
  }

  /** A player packet (idle or move): drops in reach whose pickup delay is over are picked up. */
  onPlayerTick(): void {
    const feet = this.#playerFeet();
    if (feet === null) return;
    const now = Date.now();
    for (let i = this.#ground.length - 1; i >= 0; i--) {
      const d = this.#ground[i];
      if (d === undefined || now < d.from) continue;
      const half = 0.125;
      const inRange =
        Math.abs(d.x - feet.x) < 0.3 + 1 + half &&
        Math.abs(d.z - feet.z) < 0.3 + 1 + half &&
        d.y + 0.25 > feet.y - 0.5 &&
        d.y < feet.y + 1.8 + 0.5;
      const id = this.#itemId(d.item);
      if (!inRange || id === undefined) continue;
      this.#chests.pickUp({ id, count: d.count, damage: 0 });
      this.pickedUp.push({ item: d.item, count: d.count });
      this.#ground.splice(i, 1);
    }
  }

  #tick(): void {
    const now = Date.now();
    const feet = this.#playerFeet();
    for (const m of this.#mobs.values()) {
      if (m.diedAt !== null) {
        if (now - m.diedAt >= DESPAWN_MS) {
          this.#mobs.delete(m.entityId);
          this.#broadcast(encodeFrame(0x13, Buffer.concat([Buffer.from([1]), i32(m.entityId)])));
        }
        continue;
      }
      if (m.chase === undefined || feet === null) continue;
      const dx = feet.x - m.x;
      const dz = feet.z - m.z;
      const d = Math.hypot(dx, dz);
      if (m.mobType === 50) {
        // A creeper lights its fuse within 3 blocks and explodes 1.5 s later.
        if (d < 3) m.creeperFuseAt ??= now;
        if (m.creeperFuseAt !== null && now - m.creeperFuseAt >= 30 * TICK_MS) {
          const damage = explosionDamage(3, d);
          this.explosions.push({ at: { x: m.x, y: m.y, z: m.z }, playerDamage: damage });
          this.#mobs.delete(m.entityId);
          this.#broadcast(encodeFrame(0x13, Buffer.concat([Buffer.from([1]), i32(m.entityId)])));
          if (damage > 0) this.hurtPlayer(damage);
          continue;
        }
      }
      if (d > MOB_REACH) {
        const step = Math.min(m.chase.speed, d - MOB_REACH + 0.05);
        m.x += (dx / d) * step;
        m.z += (dz / d) * step;
        this.#broadcast(this.#teleportFrame(m));
      } else if (now - m.lastAttackAt >= 20 * TICK_MS && m.mobType !== 50) {
        m.lastAttackAt = now;
        this.hurtPlayer(m.chase.damage);
      }
    }
  }

  #sendHealth(): void {
    this.#send(
      encodeFrame(
        0x06,
        Buffer.concat([f32(this.playerHealth), Buffer.from([0, this.#food]), f32(5)]),
      ),
    );
  }

  #spawnFrame(m: MobState): Buffer {
    const entries: MetaValue[] = [
      { index: 0, type: 'byte', value: 0 },
      { index: 1, type: 'short', value: 300 },
      { index: 6, type: 'float', value: m.health },
      { index: 10, type: 'string', value: m.customName ?? '' },
      { index: 11, type: 'byte', value: 0 },
    ];
    if (m.age !== undefined) entries.push({ index: 12, type: 'int', value: m.age });
    if (m.saddled !== undefined)
      entries.push({ index: 16, type: 'byte', value: m.saddled ? 1 : 0 });
    const meta = m.noMetadata === true ? Buffer.from([0xff]) : encodeMetadata(entries);
    if (m.modded !== undefined) {
      const body = Buffer.concat([
        Buffer.from([2]),
        i32(m.entityId),
        encodeString(m.modded.modId),
        i32(m.modded.typeId),
        fixed(m.x, m.y, m.z),
        Buffer.from([0, 0, 0]), // yaw, pitch, head yaw
        meta,
        i32(0), // no thrower
      ]);
      return encodeFrame(
        0x3f,
        Buffer.concat([encodeString('FML'), encodeVarShort(body.length), body]),
      );
    }
    return encodeFrame(
      0x0f,
      Buffer.concat([
        encodeVarInt(m.entityId),
        Buffer.from([m.mobType ?? 54]),
        fixed(m.x, m.y, m.z),
        Buffer.from([0, 0, 0]),
        Buffer.alloc(6),
        meta,
      ]),
    );
  }

  #teleportFrame(m: MobState): Buffer {
    return encodeFrame(
      0x18,
      Buffer.concat([i32(m.entityId), fixed(m.x, m.y, m.z), Buffer.from([0, 0])]),
    );
  }
}

/** The player's own entity id in the fake server's Join Game. */
export const PLAYER_ENTITY_ID = 1197138;

function statusFrame(entityId: number, status: number): Buffer {
  return encodeFrame(0x1a, Buffer.concat([i32(entityId), Buffer.from([status])]));
}

function healthFrame(entityId: number, health: number): Buffer {
  return encodeFrame(
    0x1c,
    Buffer.concat([i32(entityId), encodeMetadata([{ index: 6, type: 'float', value: health }])]),
  );
}
