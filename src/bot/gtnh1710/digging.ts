import {
  DIGGABLE_BLOCKS,
  FALLING_DIGGABLE_BLOCKS,
  isDiggableBlock,
  type DiggableBlock,
} from '../../domain/blocks.ts';
import { diggableInfo } from '../../domain/dig-time.ts';
import type { UnderFeet } from '../../domain/game-state.ts';
import { isDigDownBlock } from '../../domain/night-shelter.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import { PLAYER_EYE_HEIGHT } from './packets.ts';
import { passProblem, variantName } from './passable.ts';
import { FLOAT_CHECK_HALF_WIDTH, standProblem, type ReachedFeet } from './terrain.ts';
import {
  sweptColumns,
  WALKABLE_SURFACES,
  type Fence,
  type Vec3,
  type WalkWorld,
} from './walking.ts';

/**
 * Digging ONE block for the live GTNH client: every check a target must pass, and where to
 * stand. Pure functions over the blocks the server sent; no I/O.
 *
 * How a 1.7.10 server (with Forge 10.13.4.1614) handles digging, verified in the test
 * server's jars (docs/gtnh-compatibility.md, "Digging"):
 *  - C07 status 0 starts: the server remembers the tick. Status 2 finishes: the server
 *    breaks the block only if progress-per-tick x (ticks since the start + 1) >= 0.7;
 *    otherwise it re-sends the block (S23) and breaks it on its own once the progress
 *    reaches 1.0. Status 1 cancels.
 *  - Reach: the block centre within 6 blocks of the player's feet + 1.5.
 *  - Progress per tick = dig speed / hardness / 30 when the block can be harvested (1/100
 *    when it cannot, and then nothing drops). An empty hand digs at speed 1, a tool at its
 *    own speed on the blocks it is made for; divided by 5 in water and by 5 when not on the
 *    ground; potions and mods can change it.
 *  - The drop spawns inside the block's cell and can be picked up after 10 ticks, when it
 *    touches the player's box grown by 1 block sideways and 0.5 up and down.
 *
 * The block facts and the dig time are in src/domain/dig-time.ts, the tools the agent may
 * hold in src/domain/tools.ts. The agent digs on the ground, with an allowlisted tool made
 * for the block or an empty hand, and waits well past the vanilla time, so the server's 70%
 * rule leaves a wide margin.
 */

/** The client digs only blocks whose centre is this close to its eyes (the server allows 6). */
export const MAX_DIG_REACH = 4.5;

/**
 * Blocks that may touch a block the agent digs: plain full blocks with no tile entity that
 * do not fall, flow or hang on their neighbours (the walker's known full blocks), plus the
 * allowlist itself and air. Anything else next to the target (water, a torch, a flower,
 * a chest, a machine, any modded block, an unnamed id) refuses the dig: removing the block
 * could flood the hole, drop an attached block or change a build. Beside it (not on top),
 * the plants the body walks through are fine too (digDoesNotDisturb): they stand on the
 * block under them, not on the dug one.
 */
export const DIG_NEIGHBOURS: ReadonlySet<string> = new Set<string>([
  'minecraft:air',
  ...WALKABLE_SURFACES,
  ...DIGGABLE_BLOCKS,
]);

export interface BlockPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Where digging is allowed: the fence's columns. A fence on one level (the test pen) digs
 * from its level up to maxHeightAboveFence above it, never its floor. A terrain fence (a
 * height range, like the walker's) digs around the feet: from one block below them (the
 * ground layer next to the player, as a player digs sand or dirt) up to maxHeightAboveFence
 * above them, within the fence's heights.
 */
export interface DigArea {
  readonly fence: Fence;
  readonly maxHeightAboveFence: number;
}

export type DigCheck =
  | { ok: true; block: DiggableBlock; blockId: number; face: number; reach: number }
  | { ok: false; reason: string };

/**
 * The block heights (inclusive) an area allows work at, for feet in block level
 * `feetLevel` (see DigArea), and the rule in words for refusals. Placing uses the same.
 */
export function workHeights(
  area: DigArea,
  feetLevel: number,
): { low: number; high: number; rule: string } {
  const { fence, maxHeightAboveFence } = area;
  if (fence.min.y !== fence.max.y) {
    return {
      low: Math.max(fence.min.y - 1, feetLevel - 1),
      high: Math.min(fence.max.y, feetLevel) + maxHeightAboveFence,
      rule: `from one below the feet up to ${maxHeightAboveFence} above them, inside the fence`,
    };
  }
  const level = fence.min.y;
  return {
    low: level,
    high: level + maxHeightAboveFence,
    rule: 'never the floor below the fence level',
  };
}

const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

const fmt = (p: BlockPos): string => `(${p.x}, ${p.y}, ${p.z})`;

/** The player's eye position for feet at `feet`. */
export function eyesOf(feet: Vec3): Vec3 {
  return { x: feet.x, y: feet.y + PLAYER_EYE_HEIGHT, z: feet.z };
}

/**
 * The face of the block turned towards the eyes (0 bottom, 1 top, 2 north, 3 south, 4 west,
 * 5 east), like the face a player would click.
 */
export function faceTowards(eyes: Vec3, target: BlockPos): number {
  const dx = eyes.x - (target.x + 0.5);
  const dy = eyes.y - (target.y + 0.5);
  const dz = eyes.z - (target.z + 0.5);
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  if (ay >= ax && ay >= az) return dy > 0 ? 1 : 0;
  if (az >= ax) return dz > 0 ? 3 : 2;
  return dx > 0 ? 5 : 4;
}

/** Distance from the eyes to the block centre. */
export function reachTo(feet: Vec3, target: BlockPos): number {
  const e = eyesOf(feet);
  return Math.hypot(target.x + 0.5 - e.x, target.y + 0.5 - e.y, target.z + 0.5 - e.z);
}

/**
 * Whether the player standing at `feet` may dig the block at `target`, and why not.
 * Fail closed: an unloaded block, an unnamed block id or anything not explicitly allowed
 * refuses. Checked before the dig starts and again every tick while digging.
 */
export function checkDig(world: WalkWorld, area: DigArea, feet: Vec3, target: BlockPos): DigCheck {
  const refuse = (reason: string): DigCheck => ({ ok: false, reason });
  const { x, y, z } = target;
  if (![x, y, z].every(Number.isInteger) || y < 0 || y > 255) {
    return refuse(`${fmt(target)} is not a block position`);
  }

  const { fence } = area;
  if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) {
    return refuse(`${fmt(target)} is outside the fence's columns`);
  }
  const feetLevel = Math.floor(feet.y + 1e-6);
  const heights = workHeights(area, feetLevel);
  if (y < heights.low || y > heights.high) {
    return refuse(
      `${fmt(target)} is outside the dig heights y=${heights.low}..${heights.high} (${heights.rule})`,
    );
  }

  const id = world.blockAt(x, y, z);
  if (id === undefined) return refuse(`${fmt(target)} is not loaded`);
  if (id === 0) return refuse(`${fmt(target)} is air: there is nothing to dig`);
  const name = world.blockName(id);
  if (name === undefined)
    return refuse(`${fmt(target)} holds block id ${id}, which the registry does not name`);
  if (!isDiggableBlock(name))
    return refuse(`${fmt(target)} is ${name}, which is not on the dig allowlist`);

  const reach = reachTo(feet, target);
  if (reach > MAX_DIG_REACH + 1e-9) {
    return refuse(
      `${fmt(target)} is ${reach.toFixed(2)} blocks from the eyes (max ${MAX_DIG_REACH})`,
    );
  }

  // Never the player's own support or its own body; never a falling block over its head.
  const head = Math.floor(feet.y + 1.8 - 1e-6);
  const own = sweptColumns(feet, feet).some(([cx, cz]) => cx === x && cz === z);
  if (own && y <= head) {
    return refuse(`${fmt(target)} is under the player (the block it stands on, or its own column)`);
  }
  if (own && diggableInfo(name).falls) {
    return refuse(`${fmt(target)} is ${name} directly above the player's head`);
  }

  // Everything touching it must be known and inert (see DIG_NEIGHBOURS).
  for (const [dx, dy, dz] of FACES) {
    const n = { x: x + dx, y: y + dy, z: z + dz };
    const nid = world.blockAt(n.x, n.y, n.z);
    if (nid === undefined) return refuse(`the block next to it at ${fmt(n)} is not loaded`);
    const nname = nid === 0 ? 'minecraft:air' : world.blockName(nid);
    if (nname === undefined)
      return refuse(`it touches block id ${nid} at ${fmt(n)}, which the registry does not name`);
    if (!digDoesNotDisturb(world, n, nname, dy)) {
      return refuse(
        `it touches ${nname} at ${fmt(n)} (only air and plain full blocks may touch a dug block, and plants only beside it)`,
      );
    }
  }
  // Below the feet, only a hole one block deep: the block under it must stay (a cave or a
  // deeper hole below would turn a one-block step down into a fall).
  if (y < feetLevel && (world.blockAt(x, y - 1, z) ?? 0) === 0) {
    return refuse(`${fmt(target)} has nothing under it: digging it would open a deeper hole`);
  }
  const aboveId = world.blockAt(x, y + 1, z) ?? 0;
  const above = aboveId === 0 ? undefined : world.blockName(aboveId);
  if (above !== undefined && isDiggableBlock(above) && FALLING_DIGGABLE_BLOCKS.has(above)) {
    return refuse(`${above} on top of ${fmt(target)} would fall into the hole`);
  }

  // Nothing dangerous anywhere around it (lava, fire, harmful fluids, damaging blocks).
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const nid = world.blockAt(x + dx, y + dy, z + dz);
        if (nid === undefined) return refuse(`a block near it is not loaded`);
        if (world.hazardCode(nid) !== BLOCK_CODE.safe) {
          const n = { x: x + dx, y: y + dy, z: z + dz };
          return refuse(`it is next to ${world.blockName(nid) ?? `block id ${nid}`} at ${fmt(n)}`);
        }
      }
    }
  }

  return { ok: true, block: name, blockId: id, face: faceTowards(eyesOf(feet), target), reach };
}

/** Feet heights tried for a stand spot, relative to the block: on the ground beside it (+1), level with it, or below it (logs overhead). */
const STAND_HEIGHTS = [1, 0, -1, -2, -3, -4] as const;

/**
 * Where the player can stand to dig `target`: feet at the centre of a block beside it (one
 * of the 8 columns around it, never on top of it), standable by the terrain rules, inside
 * the fence, and from which checkDig allows the dig. The spot nearest to `from`; null when
 * there is none. A planner walks there (MOVE_TO) and then digs. With `reachable` (from
 * terrain.ts reachableFeet), only spots a walk from the player reaches, the shortest walk
 * first.
 */
export function standSpotFor(
  world: WalkWorld,
  area: DigArea,
  target: BlockPos,
  from: Vec3,
  reachable?: ReadonlyMap<string, ReachedFeet>,
): Vec3 | null {
  const { fence } = area;
  let best: { spot: Vec3; d: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const fx = target.x + dx;
      const fz = target.z + dz;
      if (fx < fence.min.x || fx > fence.max.x || fz < fence.min.z || fz > fence.max.z) continue;
      for (const dy of STAND_HEIGHTS) {
        const fy = target.y + dy;
        if (fy < fence.min.y || fy > fence.max.y) continue;
        if (standProblem(world, fx, fy, fz) !== null) continue;
        const walk = reachable?.get(`${fx},${fy},${fz}`);
        if (reachable !== undefined && walk === undefined) continue;
        const spot = { x: fx + 0.5, y: fy, z: fz + 0.5 };
        if (!checkDig(world, area, spot, target).ok) continue;
        const d = walk?.length ?? Math.hypot(spot.x - from.x, spot.y - from.y, spot.z - from.z);
        if (best === null || d < best.d - 1e-9) best = { spot, d };
      }
    }
  }
  return best?.spot ?? null;
}

// ---------------------------------------------------------------------------
// Digging down: the block under the player's own feet (DIG_DOWN, the night pit only)

/**
 * Whether a cell around a dig-down (the dug block, the landing, and the player's body before
 * and after the drop) may hold its block `name`: air, a plain full block, the dig allowlist,
 * or a plant the body passes (passable.ts, which tells plant variants apart by metadata).
 * Never a fluid (water would pour into the hole), a hazard, another modded block, an unnamed
 * or unloaded one.
 */
function digDownSurroundingOk(world: WalkWorld, n: BlockPos, name: string): boolean {
  return DIG_NEIGHBOURS.has(name) || passProblem(world, n.x, n.y, n.z) === null;
}

/**
 * Whether block `name` at `n` may touch a dug block from a face `dy` above or below it:
 * DIG_NEIGHBOURS, or on a side face a plant the body passes (passable.ts, by metadata). Seen
 * live: tall grass beside the ground block ruled out every night pit around. A plant hangs on
 * the block under it, so only one on top of the dug block would drop.
 */
function digDoesNotDisturb(world: WalkWorld, n: BlockPos, name: string, dy: number): boolean {
  return DIG_NEIGHBOURS.has(name) || (dy === 0 && passProblem(world, n.x, n.y, n.z) === null);
}

const nameAt = (world: WalkWorld, x: number, y: number, z: number): string | undefined => {
  const id = world.blockAt(x, y, z);
  return id === undefined ? undefined : id === 0 ? 'minecraft:air' : world.blockName(id);
};

/**
 * True when the player's body, with the server's floating-check margin, stands in exactly
 * one block column: digging the block under it then drops it straight into the hole.
 */
export function inOneColumn(feet: Vec3): boolean {
  const w = FLOAT_CHECK_HALF_WIDTH;
  return (
    Math.floor(feet.x - w) === Math.floor(feet.x + w) &&
    Math.floor(feet.z - w) === Math.floor(feet.z + w)
  );
}

/** Feet exactly on a block top (where walks end), not mid-step or mid-fall. */
export function onBlockTop(feet: Vec3): boolean {
  return Math.abs(feet.y - Math.round(feet.y)) <= 1e-6;
}

/**
 * Why a player landing on the block at (x, y, z) would not stop exactly there, or null: it
 * must be one of the walker's plain full blocks, and sand or gravel needs a plain full block
 * under it too (a block update would drop it into a hole below, with the player on it).
 */
export function landingProblem(world: WalkWorld, x: number, y: number, z: number): string | null {
  const at = { x, y, z };
  const name = nameAt(world, x, y, z);
  if (name === undefined) return `the block under it at ${fmt(at)} is not loaded or not named`;
  if (!WALKABLE_SURFACES.has(name)) {
    return (
      `${name} is under it at ${fmt(at)}, not a plain full block: the player would not land ` +
      'exactly one block lower (a cave, a fluid or a plant drops it farther)'
    );
  }
  if (FALLING_DIGGABLE_BLOCKS.has(name as DiggableBlock)) {
    const below = nameAt(world, x, y - 1, z);
    if (below === undefined || !WALKABLE_SURFACES.has(below)) {
      return `${name} under it at ${fmt(at)} has ${below ?? 'an unknown block'} under it: it could fall with the player on it`;
    }
  }
  return null;
}

/**
 * Whether the player standing at `feet` may dig the block under its own feet, `target`, and
 * drop exactly one block onto the block under that (DIG_DOWN, the night pit only). Fail
 * closed. It refuses:
 *  - a fence on one level (the pen keeps its floor), a target outside the fence's columns,
 *    or a landing outside its heights;
 *  - anything but the block right under the feet, with the player on top of it and its body
 *    (with the server's 0.0625 margin) in that one column;
 *  - a block that is not dirt, grass, sand, gravel or clay;
 *  - a landing that is not a plain full block (a cave, a fluid, a plant: a longer fall),
 *    or sand or gravel with nothing solid under it;
 *  - anything but air and plain blocks touching the dug block (as checkDig), or sand or
 *    gravel beside it with nothing under it (it would fall when the block goes);
 *  - in every cell around the dug block, the landing and the body before and after the
 *    drop (3 x 3 columns, from the landing's level to the head's): anything not loaded or
 *    not named, a hazard (lava, fire, harmful fluids, damaging blocks), a fluid such as
 *    water, or any other block but air, plants the walker passes and plain blocks; and
 *    hazards one level lower still.
 * Checked before the dig starts and again every tick while digging.
 */
export function checkDigDown(
  world: WalkWorld,
  area: DigArea,
  feet: Vec3,
  target: BlockPos,
): DigCheck {
  const refuse = (reason: string): DigCheck => ({ ok: false, reason });
  const { x, y, z } = target;
  if (![x, y, z].every(Number.isInteger) || y < 2 || y > 254) {
    return refuse(`${fmt(target)} is not a block the agent digs down into`);
  }
  const { fence } = area;
  if (fence.min.y === fence.max.y) {
    return refuse('digging down needs a terrain fence (a height range): the pen keeps its floor');
  }
  if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) {
    return refuse(`${fmt(target)} is outside the fence's columns`);
  }
  // The feet land in the dug cell: it must be a level the fence holds.
  if (y < fence.min.y || y > fence.max.y) {
    return refuse(
      `landing with the feet at y=${y} would leave the fence's heights y=${fence.min.y}..${fence.max.y}`,
    );
  }
  const feetLevel = Math.floor(feet.y + 1e-6);
  if (!onBlockTop(feet)) {
    return refuse(`the player's feet are at y=${feet.y.toFixed(3)}, not on a block top`);
  }
  if (x !== Math.floor(feet.x) || z !== Math.floor(feet.z) || y !== feetLevel - 1) {
    return refuse(`${fmt(target)} is not the block under the player's feet`);
  }
  if (!inOneColumn(feet)) {
    return refuse(
      `the player at (${feet.x.toFixed(2)}, ${feet.z.toFixed(2)}) stands across more than one column: it would not drop into the hole (walk to the column's centre first)`,
    );
  }

  const id = world.blockAt(x, y, z);
  if (id === undefined) return refuse(`${fmt(target)} is not loaded`);
  if (id === 0) return refuse(`${fmt(target)} is air: the player does not stand on it`);
  const name = world.blockName(id);
  if (name === undefined) {
    return refuse(`${fmt(target)} holds block id ${id}, which the registry does not name`);
  }
  if (!isDiggableBlock(name) || !isDigDownBlock(name)) {
    return refuse(
      `${fmt(target)} is ${name}: digging down takes only dirt, grass, sand, gravel or clay`,
    );
  }

  // Exactly one block down, onto something that stays put.
  const landing = landingProblem(world, x, y - 1, z);
  if (landing !== null) return refuse(landing);

  // Everything touching it must be known and inert (as for any dug block). The cell above
  // is the player's feet cell.
  for (const [dx, dy, dz] of FACES) {
    const n = { x: x + dx, y: y + dy, z: z + dz };
    const nname = nameAt(world, n.x, n.y, n.z);
    if (nname === undefined)
      return refuse(`the block next to it at ${fmt(n)} is not loaded or not named`);
    if (!digDoesNotDisturb(world, n, nname, dy)) {
      return refuse(
        `it touches ${nname} at ${fmt(n)} (only air and plain full blocks may touch a dug block, and plants only beside it)`,
      );
    }
    // Sand or gravel beside it, with nothing under it, would fall when the block goes.
    if (dy === 0 && FALLING_DIGGABLE_BLOCKS.has(nname as DiggableBlock)) {
      const under = nameAt(world, n.x, n.y - 1, n.z);
      if (under === undefined || !WALKABLE_SURFACES.has(under)) {
        return refuse(`${nname} beside it at ${fmt(n)} has nothing solid under it: it would fall`);
      }
    }
  }

  // The cells around the dug block, the landing and the body before and after the drop.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const n = { x: x + dx, y: y + dy, z: z + dz };
        const nid = world.blockAt(n.x, n.y, n.z);
        if (nid === undefined) return refuse(`a block near it at ${fmt(n)} is not loaded`);
        if (world.hazardCode(nid) !== BLOCK_CODE.safe) {
          return refuse(`it is near ${world.blockName(nid) ?? `block id ${nid}`} at ${fmt(n)}`);
        }
        if (dy === -2) continue; // below the landing: only hazards matter
        const nname = nid === 0 ? 'minecraft:air' : world.blockName(nid);
        if (nname === undefined || !digDownSurroundingOk(world, n, nname)) {
          const what =
            nname === undefined ? `block id ${nid}` : variantName(world, n.x, n.y, n.z, nname);
          return refuse(
            `${what} at ${fmt(n)} is near it (only air, plants the walker passes and plain blocks may be around a dig down: no fluid)`,
          );
        }
      }
    }
  }

  const reach = reachTo(feet, target);
  return { ok: true, block: name, blockId: id, face: faceTowards(eyesOf(feet), target), reach };
}

/**
 * The ground in the player's own column, as the observation reports it (DIG_DOWN), or null
 * when the player is not on a block top in one column, or a block is not loaded or named.
 */
export function underFeetOf(world: WalkWorld, feet: Vec3): UnderFeet | null {
  if (!onBlockTop(feet) || !inOneColumn(feet)) return null;
  const x = Math.floor(feet.x);
  const z = Math.floor(feet.z);
  const y = Math.floor(feet.y + 1e-6) - 1;
  if (y < 1) return null;
  const block = nameAt(world, x, y, z);
  const landing = nameAt(world, x, y - 1, z);
  if (block === undefined || landing === undefined) return null;
  return {
    position: { x, y, z },
    block,
    landing,
    landingHolds: landingProblem(world, x, y - 1, z) === null,
  };
}
