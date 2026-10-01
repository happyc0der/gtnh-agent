import {
  FARM_ANIMALS,
  WEAPON_DAMAGE,
  type EntityCategory,
  type Weapon,
} from '../../domain/combat.ts';
import type { Classification } from './entity-types.ts';
import { PLAYER_EYE_HEIGHT } from './packets.ts';
import { standProblem } from './terrain.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';

/**
 * Fighting for the live GTNH client: what an entity's metadata says, where to look, whether
 * the server would see the target, and which weapon to hold. Pure functions; no I/O. The
 * rules about WHAT may be attacked and WHEN live in src/domain/combat.ts.
 *
 * Server facts this relies on (verified in the test server's jars, docs/gtnh-compatibility.md
 * "Combat"): C02 attacks are accepted within 6 blocks (feet to feet) when the server's ray
 * from the player's eyes to the target's eyes hits no block, within 3 when it does;
 * Battlegear2 cancels a bare-hand attack beyond 2.3; a mob takes full damage again 10 ticks
 * after a full hit; the held item's damage counts only after the server's next player tick.
 */

/** DataWatcher indices the agent reads (Entity, EntityLivingBase, EntityLiving, EntityAgeable, EntityPig). */
export const METADATA_INDEX = {
  /** EntityLivingBase: health (float). */
  health: 6,
  /** EntityLiving: custom name (string; empty without a name tag). */
  customName: 10,
  /** EntityAgeable: growing age (int; below 0 for a baby). */
  age: 12,
  /** EntityPig: saddled (byte 1). */
  pigSaddle: 16,
} as const;

export type MetadataValues = ReadonlyMap<number, number | string | null>;

/** What combat needs from an entity's metadata. Null fields are not known. */
export interface EntityVitals {
  health: number | null;
  /** A name tag or a saddle: someone's animal (farm animals only; null for others). */
  owned: boolean | null;
  /** A baby (farm animals only; null for others). */
  baby: boolean | null;
}

/**
 * Health, owner and age from the DataWatcher values received so far (the full list at spawn,
 * then changes). A farm animal is "not owned" only when its name entry was received and is
 * empty (and, for a pig, it has no saddle); "grown" only when its age entry was received.
 */
export function vitalsOf(type: string, metadata: MetadataValues | null): EntityVitals {
  const num = (index: number): number | null => {
    const v = metadata?.get(index);
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const health = num(METADATA_INDEX.health);
  if (!FARM_ANIMALS.has(type)) {
    return { health: health === null ? null : Math.max(0, health), owned: null, baby: null };
  }
  const name = metadata?.get(METADATA_INDEX.customName);
  const named = typeof name === 'string' ? name.length > 0 : null;
  let saddled: boolean | null = false;
  if (type === 'minecraft:Pig') {
    const saddle = num(METADATA_INDEX.pigSaddle);
    saddled = saddle === null ? null : saddle === 1;
  }
  let owned: boolean | null;
  if (named === true || saddled === true) owned = true;
  else if (named === null || saddled === null) owned = null;
  else owned = false;
  const age = num(METADATA_INDEX.age);
  return {
    health: health === null ? null : Math.max(0, health),
    owned,
    baby: age === null ? null : age < 0,
  };
}

/**
 * How the GameState lists a tracked entity: players as `player`, the classification's own
 * category otherwise; null for things not listed at all (dropped items, arrows, XP orbs).
 */
export function listedCategory(
  kind: 'player' | 'mob' | 'object' | 'modded',
  classification: Classification,
): EntityCategory | null {
  if (kind === 'player') return 'player';
  switch (classification.category) {
    case 'hostile':
    case 'passive':
    case 'unclassified':
      return classification.category;
    case 'ignored':
      return null;
  }
}

/**
 * Eye height above the feet (EntityLivingBase.getEyeHeight: height x 0.85) for the vanilla
 * mobs the agent may fight or hunt, from their setSize calls; 1.5 for anything else. Only
 * used to aim and to predict the server's line of sight, never for a safety decision.
 */
const EYE_HEIGHT: ReadonlyMap<string, number> = new Map([
  ['minecraft:Zombie', 1.53],
  ['minecraft:Skeleton', 1.53],
  ['minecraft:Witch', 1.53],
  ['minecraft:Spider', 0.765],
  ['minecraft:CaveSpider', 0.425],
  ['minecraft:Creeper', 1.445],
  ['minecraft:Cow', 1.105],
  ['minecraft:Sheep', 1.105],
  ['minecraft:Pig', 0.765],
  ['minecraft:Chicken', 0.595],
]);

export function eyeHeightOf(type: string): number {
  return EYE_HEIGHT.get(type) ?? 1.5;
}

/** The player's eyes, from its feet (1.7.10's eye height). */
export function playerEyes(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y + PLAYER_EYE_HEIGHT, z: feet.z };
}

/** Yaw and pitch (degrees, Minecraft's convention) to look from the eyes at a point. */
export function lookAtPoint(eyes: Vec3, p: Vec3): { yaw: number; pitch: number } {
  const dx = p.x - eyes.x;
  const dy = p.y - eyes.y;
  const dz = p.z - eyes.z;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: Math.max(-90, Math.min(90, (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI)),
  };
}

/**
 * Whether the server will see the target: every block cell the segment from `from` to `to`
 * passes through must be loaded and air. Stricter than the server (which ignores liquids and
 * misses small block shapes), so "clear" here means clear there; "not clear" only shortens
 * the agent's reach to what the server accepts without sight.
 */
export function lineOfSightClear(world: WalkWorld, from: Vec3, to: Vec3): boolean {
  // Voxel traversal (Amanatides & Woo): visit every cell the segment touches, in order.
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const s = { x: Math.sign(d.x), y: Math.sign(d.y), z: Math.sign(d.z) };
  const cell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  const end = { x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) };
  // Fraction of the segment at which it crosses the next boundary on each axis, and per cell.
  const first = (p: number, dp: number, sp: number): number =>
    sp > 0 ? (Math.floor(p) + 1 - p) / dp : sp < 0 ? (p - Math.floor(p)) / -dp : Infinity;
  const per = (dp: number): number => (dp === 0 ? Infinity : 1 / Math.abs(dp));
  const t = { x: first(from.x, d.x, s.x), y: first(from.y, d.y, s.y), z: first(from.z, d.z, s.z) };
  const dt = { x: per(d.x), y: per(d.y), z: per(d.z) };
  for (let i = 0; i < 256; i++) {
    // Not loaded (undefined) or any block at all: the server might not see through it.
    if (world.blockAt(cell.x, cell.y, cell.z) !== 0) return false;
    if (cell.x === end.x && cell.y === end.y && cell.z === end.z) return true;
    const axis = t.x < t.y && t.x < t.z ? 'x' : t.y < t.z ? 'y' : 'z';
    if (t[axis] > 1) return true; // the segment ends inside this cell
    cell[axis] += s[axis];
    t[axis] += dt[axis];
  }
  return false;
}

/**
 * Inside the fence: within its block columns, and from one level below its feet level to two
 * above its top (a mob in the pen stands at the player's level; a spider may climb a wall).
 */
export function insideFence(p: Vec3, fence: Fence): boolean {
  return (
    p.x >= fence.min.x &&
    p.x < fence.max.x + 1 &&
    p.z >= fence.min.z &&
    p.z < fence.max.z + 1 &&
    p.y >= fence.min.y - 1 &&
    p.y < fence.max.y + 3
  );
}

/**
 * Whether an item lying at `at` is within a player's pickup reach from feet at `feet`: the
 * body's box (0.6 wide, 1.8 tall) grown by 1 sideways and 0.5 up and down
 * (EntityPlayer.onLivingUpdate collides it with items), a little short of it to be sure.
 */
export function withinPickup(feet: Vec3, at: Vec3): boolean {
  return (
    Math.abs(at.x - feet.x) <= 1.2 &&
    Math.abs(at.z - feet.z) <= 1.2 &&
    at.y >= feet.y - 0.5 &&
    at.y <= feet.y + 2.2
  );
}

/**
 * Where to stand to pick up what an animal dropped where it died (`at`, its feet): its own
 * block cell when a player may stand there (terrain.ts standProblem: a full block under it,
 * the body's cells passable, no hazard around), else the nearest such cell beside it (the 8
 * around it, at its level, one up or one down) from which the drops are within pickup reach;
 * inside the fence's columns and heights. Feet at the cell's centre; null when none will do.
 */
export function dropSpot(world: WalkWorld, fence: Fence, at: Vec3): Vec3 | null {
  const cx = Math.floor(at.x);
  const cy = Math.floor(at.y + 1e-6);
  const cz = Math.floor(at.z);
  let best: { spot: Vec3; d: number } | null = null;
  for (const dy of [0, 1, -1]) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        const inside =
          x >= fence.min.x &&
          x <= fence.max.x &&
          z >= fence.min.z &&
          z <= fence.max.z &&
          y >= fence.min.y &&
          y <= fence.max.y;
        if (!inside || standProblem(world, x, y, z) !== null) continue;
        const spot = { x: x + 0.5, y, z: z + 0.5 };
        if (!withinPickup(spot, at)) continue;
        const d = Math.hypot(spot.x - at.x, spot.z - at.z) + Math.abs(spot.y - at.y) / 4;
        if (best === null || d < best.d - 1e-9) best = { spot, d };
      }
    }
  }
  return best?.spot ?? null;
}

/** A hotbar slot as the client sees it: the stack's registry name, or null when empty. */
export interface HotbarSlot {
  /** Hotbar index 0-8. */
  slot: number;
  /** Registry name (without @damage), or null for an empty slot. */
  name: string | null;
  hasNbt: boolean;
}

/**
 * The best allowlisted weapon in the hotbar (most damage; ties: the held slot, then the
 * lowest), or null when there is none. A stack with NBT data (enchanted or named) is never
 * used: it may be valued.
 */
export function chooseWeapon(
  hotbar: readonly HotbarSlot[],
  heldSlot: number,
): { slot: number; weapon: Weapon } | null {
  let best: { slot: number; weapon: Weapon } | null = null;
  const order = [...hotbar].sort(
    (a, b) => Number(b.slot === heldSlot) - Number(a.slot === heldSlot) || a.slot - b.slot,
  );
  for (const s of order) {
    if (s.name === null || s.hasNbt) continue;
    const damage = WEAPON_DAMAGE.get(s.name);
    if (damage === undefined) continue;
    if (best === null || damage > best.weapon.damage) {
      best = { slot: s.slot, weapon: { item: s.name, damage } };
    }
  }
  return best;
}
