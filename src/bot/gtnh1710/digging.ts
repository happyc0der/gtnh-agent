import {
  DIGGABLE_BLOCKS,
  FALLING_DIGGABLE_BLOCKS,
  isDiggableBlock,
  type DiggableBlock,
} from '../../domain/blocks.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import { PLAYER_EYE_HEIGHT } from './packets.ts';
import {
  sweptColumns,
  WALKABLE_SURFACES,
  type Fence,
  type Vec3,
  type WalkWorld,
} from './walking.ts';

/**
 * Digging ONE block for the live GTNH client: the allowlist, the dig time, and every check
 * a target must pass. Pure functions over the blocks the server sent; no I/O.
 *
 * How a 1.7.10 server (with Forge 10.13.4.1614) handles digging, verified in the test
 * server's jars (docs/gtnh-compatibility.md, "Digging"):
 *  - C07 status 0 starts: the server remembers the tick. Status 2 finishes: the server
 *    breaks the block only if progress-per-tick x (ticks since the start + 1) >= 0.7;
 *    otherwise it re-sends the block (S23) and breaks it on its own once the progress
 *    reaches 1.0. Status 1 cancels.
 *  - Reach: the block centre within 6 blocks of the player's feet + 1.5.
 *  - Progress per tick = dig speed / hardness / 30 when the block can be harvested (1/100
 *    when it cannot, and then nothing drops). An empty hand digs at speed 1, divided by 5
 *    in water and by 5 when not on the ground; potions and mods can change it.
 *  - The drop spawns inside the block's cell and can be picked up after 10 ticks, when it
 *    touches the player's box grown by 1 block sideways and 0.5 up and down.
 *
 * The agent digs with an EMPTY hand only, on the ground, and waits well past the vanilla
 * time, so the server's 70% rule leaves a wide margin.
 */

/** Facts about an allowlisted block, from minecraft_server.1.7.10.jar (verified). */
export interface DiggableBlockInfo {
  /** Block.setHardness value. */
  hardness: number;
  /** Its material needs no tool: a bare hand digs it at 1/30 per hardness and it drops. */
  bareHandHarvests: boolean;
  /** Falls when the block below it goes (BlockFalling). */
  falls: boolean;
}

/**
 * The allowlist with its hardness. Hardness from Block.registerBlocks (grass 0.6, dirt 0.5,
 * sand 0.5, gravel 0.6, clay 0.6) and the BlockLog (2.0) / BlockLeaves (0.2) constructors;
 * materials wood, leaves, grass, ground, sand and clay do not require a tool.
 */
export const DIGGABLE: ReadonlyMap<DiggableBlock, DiggableBlockInfo> = new Map<
  DiggableBlock,
  DiggableBlockInfo
>([
  ['minecraft:log', { hardness: 2, bareHandHarvests: true, falls: false }],
  ['minecraft:log2', { hardness: 2, bareHandHarvests: true, falls: false }],
  ['minecraft:leaves', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['minecraft:leaves2', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['minecraft:dirt', { hardness: 0.5, bareHandHarvests: true, falls: false }],
  ['minecraft:grass', { hardness: 0.6, bareHandHarvests: true, falls: false }],
  ['minecraft:sand', { hardness: 0.5, bareHandHarvests: true, falls: true }],
  ['minecraft:gravel', { hardness: 0.6, bareHandHarvests: true, falls: true }],
  ['minecraft:clay', { hardness: 0.6, bareHandHarvests: true, falls: false }],
]);

export const TICK_MS = 50;
/** The server accepts a finish at this fraction of the full dig progress. */
export const SERVER_FINISH_FRACTION = 0.7;
/** The agent digs this multiple of the vanilla client's time, plus DIG_EXTRA_TICKS. */
export const DIG_TIME_FACTOR = 1.25;
export const DIG_EXTRA_TICKS = 2;
/** The client digs only blocks whose centre is this close to its eyes (the server allows 6). */
export const MAX_DIG_REACH = 4.5;

function info(block: DiggableBlock): DiggableBlockInfo {
  const i = DIGGABLE.get(block);
  if (i === undefined) throw new Error(`internal: no dig facts for ${block}`);
  return i;
}

/** Progress per server tick with an empty hand, on the ground, out of water, no potions. */
export function bareHandProgressPerTick(block: DiggableBlock): number {
  const i = info(block);
  return 1 / i.hardness / (i.bareHandHarvests ? 30 : 100);
}

/** Ticks a vanilla client digs before it sends the finish (progress reaches 1). */
export function vanillaDigTicks(block: DiggableBlock): number {
  const i = info(block);
  return Math.ceil(i.hardness * (i.bareHandHarvests ? 30 : 100) - 1e-9);
}

/** The fewest ticks after the start at which the server accepts the finish. */
export function serverMinimumTicks(block: DiggableBlock): number {
  const i = info(block);
  const perFull = i.hardness * (i.bareHandHarvests ? 30 : 100);
  return Math.max(0, Math.ceil(SERVER_FINISH_FRACTION * perFull - 1 - 1e-9));
}

/** How long the agent digs before sending the finish, in ticks (vanilla time x 1.25 + 2). */
export function digWaitTicks(block: DiggableBlock): number {
  return Math.ceil(vanillaDigTicks(block) * DIG_TIME_FACTOR - 1e-9) + DIG_EXTRA_TICKS;
}

/**
 * Blocks that may touch a block the agent digs: plain full blocks with no tile entity that
 * do not fall, flow or hang on their neighbours (the walker's known full blocks), plus the
 * allowlist itself and air. Anything else next to the target (water, a torch, a flower,
 * a chest, a machine, any modded block, an unnamed id) refuses the dig: removing the block
 * could flood the hole, drop an attached block or change a build.
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

  const { fence, maxHeightAboveFence } = area;
  if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) {
    return refuse(`${fmt(target)} is outside the fence's columns`);
  }
  const terrain = fence.min.y !== fence.max.y;
  const feetLevel = Math.floor(feet.y + 1e-6);
  if (terrain) {
    const low = Math.max(fence.min.y - 1, feetLevel - 1);
    const high = Math.min(fence.max.y, feetLevel) + maxHeightAboveFence;
    if (y < low || y > high) {
      return refuse(
        `${fmt(target)} is outside the dig heights y=${low}..${high} (from one below the feet up to ${maxHeightAboveFence} above them, inside the fence)`,
      );
    }
  } else {
    const level = fence.min.y;
    if (y < level || y > level + maxHeightAboveFence) {
      return refuse(
        `${fmt(target)} is outside the dig heights y=${level}..${level + maxHeightAboveFence} (never the floor below the fence level)`,
      );
    }
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
  if (own && info(name).falls) {
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
    if (!DIG_NEIGHBOURS.has(nname)) {
      return refuse(
        `it touches ${nname} at ${fmt(n)} (only air and plain full blocks may touch a dug block)`,
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
