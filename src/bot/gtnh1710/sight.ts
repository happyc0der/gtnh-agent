import { TERRAIN_SURFACES } from './terrain.ts';
import type { Vec3, WalkWorld } from './walking.ts';

/**
 * Lines of sight over the blocks the client knows: whether a mob could see the player.
 *
 * A 1.7.10 mob picks a player to attack only while it sees it (EntityAITarget.isSuitableTarget
 * asks EntitySenses.canSee: one ray from the mob's eyes to the player's, stopped by blocks),
 * and a skeleton, a witch or a blaze shoots only while it sees the player (EntityAIArrowAttack,
 * EntityBlaze), an arrow not passing a block. So a skeleton in a cave below, with rock all
 * round, neither aims at the player nor hits it (seen live 2026-10-04: one in a cave under the
 * night pit kept the agent in its shelter a whole day).
 */

/**
 * Heights above a mob's feet its lines start from: a small mob's eyes to a giant's, with the
 * real eye heights of the shooters among them (skeleton, witch and blaze 1.53; a Special Mobs
 * giant 2.295, its wither kind 2.754; a wither skeleton 1.989).
 */
const MOB_EYES = [0.4, 0.8, 1.2, 1.53, 1.6, 1.99, 2.3, 2.75] as const;
/** A player's eyes above its feet. */
const PLAYER_EYES = 1.62;
/** Heights above the player's feet the lines end at: its feet, its middle, its eyes. */
const PLAYER_POINTS = [0.2, 0.9, PLAYER_EYES] as const;
/**
 * A block stops a line only where the line passes through it at least this far inside its
 * faces: a line grazing an edge or a corner may be the mob's real one, which the client knows
 * only to 1/32 of a block (and only after it moved 4/32 on an axis).
 */
const BLOCK_MARGIN = 0.2;
/**
 * How far above the feet the player's way out or up is looked at (eyesAbove): as far as the
 * entity scan reaches, so the mouth of a shaft the player is down is never missed (an
 * independent review, 2026-10-04: at the bottom of one 12 deep, skeletons by its mouth counted
 * as hidden).
 */
const MAX_EXIT_RISE = 16;
/** The most block cells a segment may cross to be walked (longer ones: null). */
const MAX_LINE_CELLS = 256;

/**
 * The block cells the segment from `from` to `to` passes through, in order, both ends' cells
 * included (a voxel walk: Amanatides and Woo); null past MAX_LINE_CELLS.
 */
export function cellsAlong(from: Vec3, to: Vec3): Array<[number, number, number]> | null {
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
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < MAX_LINE_CELLS; i++) {
    out.push([cell.x, cell.y, cell.z]);
    if (cell.x === end.x && cell.y === end.y && cell.z === end.z) return out;
    const axis = t.x < t.y && t.x < t.z ? 'x' : t.y < t.z ? 'y' : 'z';
    if (t[axis] > 1) return out; // the segment ends inside this cell
    cell[axis] += s[axis];
    t[axis] += dt[axis];
  }
  return null;
}

/** A known full cube at the cell (loaded, not air, named in TERRAIN_SURFACES). */
function fullBlock(world: WalkWorld, x: number, y: number, z: number): boolean {
  const id = world.blockAt(x, y, z);
  if (id === undefined || id === 0) return false;
  const name = world.blockName(id);
  return name !== undefined && TERRAIN_SURFACES.has(name);
}

/**
 * Whether the segment from `a` to `b` passes through the full block at (x, y, z) at least
 * BLOCK_MARGIN inside each face open to a cell that is not a full block (the slab test on that
 * shrunk box). A face against another full block keeps no margin: the seam between two blocks
 * of a wall is no gap.
 */
function passesThrough(
  world: WalkWorld,
  a: Vec3,
  b: Vec3,
  x: number,
  y: number,
  z: number,
): boolean {
  const margin = (dx: number, dy: number, dz: number): number =>
    fullBlock(world, x + dx, y + dy, z + dz) ? 0 : BLOCK_MARGIN;
  let lo = 0;
  let hi = 1;
  for (const [p, q, min, max] of [
    [a.x, b.x, x + margin(-1, 0, 0), x + 1 - margin(1, 0, 0)],
    [a.y, b.y, y + margin(0, -1, 0), y + 1 - margin(0, 1, 0)],
    [a.z, b.z, z + margin(0, 0, -1), z + 1 - margin(0, 0, 1)],
  ] as const) {
    const dp = q - p;
    if (Math.abs(dp) < 1e-12) {
      if (p < min || p > max) return false;
      continue;
    }
    let t0 = (min - p) / dp;
    let t1 = (max - p) / dp;
    if (t0 > t1) [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  return true;
}

/**
 * Whether the segment from `a` to `b` passes clearly through a known full cube (cellsAlong,
 * then passesThrough). A segment too long to walk is not blocked.
 */
export function lineBlocked(world: WalkWorld, a: Vec3, b: Vec3): boolean {
  const cells = cellsAlong(a, b);
  return (
    cells !== null &&
    cells.some(([x, y, z]) => fullBlock(world, x, y, z) && passesThrough(world, a, b, x, y, z))
  );
}

/**
 * The player's eyes at every level above its feet, up its column, where its body would fit (no
 * full block in its two cells): the way it comes out of a pit or a shaft (dug up, or onto a
 * sealed pit's roof). Up to the first level where the head is out of any hole (no full block
 * in the 8 cells around it), MAX_EXIT_RISE higher at most: on open ground, just the next level.
 */
export function eyesAbove(world: WalkWorld, feet: Vec3): Vec3[] {
  const x = Math.floor(feet.x);
  const z = Math.floor(feet.z);
  const y0 = Math.floor(feet.y + 1e-9);
  const out: Vec3[] = [];
  for (let y = y0 + 1; y <= y0 + MAX_EXIT_RISE; y++) {
    if (fullBlock(world, x, y, z) || fullBlock(world, x, y + 1, z)) continue;
    out.push({ x: x + 0.5, y: y + PLAYER_EYES, z: z + 0.5 });
    let clear = true;
    for (let dx = -1; dx <= 1 && clear; dx++) {
      for (let dz = -1; dz <= 1 && clear; dz++) {
        if ((dx !== 0 || dz !== 0) && fullBlock(world, x + dx, y + 1, z + dz)) clear = false;
      }
    }
    if (clear) break;
  }
  return out;
}

/**
 * Whether known full blocks hide a player with its feet at `feet` from a mob with its feet at
 * `mob`: every line from the mob's head region (MOB_EYES) to the player's body
 * (PLAYER_POINTS), and to its eyes higher up its column (eyesAbove: where it comes out of a
 * pit), passes clearly through one (TERRAIN_SURFACES: full cubes the walker knows). Without
 * those higher eyes, every mob outside a sealed pit would count as hidden, however open the
 * ground the player is about to dig out onto (an independent review, 2026-10-04). It fails
 * toward seen: a block not loaded, or not known to be a full cube (leaves, a slab, a modded
 * block), lets a line through, and so does a line too long to walk or one that only grazes a
 * block (BLOCK_MARGIN).
 */
export function hiddenFrom(world: WalkWorld, mob: Vec3, feet: Vec3): boolean {
  const targets: Vec3[] = [
    ...PLAYER_POINTS.map((k) => ({ x: feet.x, y: feet.y + k, z: feet.z })),
    ...eyesAbove(world, feet),
  ];
  for (const h of MOB_EYES) {
    const from = { x: mob.x, y: mob.y + h, z: mob.z };
    for (const to of targets) if (!lineBlocked(world, from, to)) return false;
  }
  return true;
}
