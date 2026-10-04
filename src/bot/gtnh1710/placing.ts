import {
  SOLID_DIGGABLE_BLOCKS,
  fallsWhenPlaced,
  isStationItem,
  placedBlockOf,
  type PlaceableBlock,
  type PlaceableItem,
} from '../../domain/blocks.ts';
import { bodyColumns, PLAYER_HALF_WIDTH, PLAYER_HEIGHT } from '../../domain/geometry.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import {
  DIG_NEIGHBOURS,
  eyesOf,
  MAX_DIG_REACH,
  reachTo,
  workHeights,
  type BlockPos,
  type DigArea,
} from './digging.ts';
import { PASSABLE_BLOCKS, passProblem, variantName } from './passable.ts';
import { reachableFeet } from './terrain.ts';
import { WALKABLE_SURFACES, type Fence, type Vec3, type WalkWorld } from './walking.ts';

/**
 * Placing ONE block for the live GTNH client: which cells may take a block, which block is
 * clicked to place it, and every check a placement must pass. Pure functions over the
 * blocks the server sent; no I/O.
 *
 * How a 1.7.10 server (Forge 10.13.4.1614, GTNH 2.8.4) handles C08 Player Block Placement,
 * verified in the test server's jars (docs/gtnh-compatibility.md, "Placing"):
 *  - The packet names the CLICKED block and its face; the new block goes into the cell next
 *    to that face. (A clicked tall grass, dead bush, vine or thin snow layer is replaced in
 *    place instead; the agent never clicks one.)
 *  - The clicked block's centre must be closer than 6 blocks (reach 5 + 1) to the player;
 *    GTNH's ArchaicFix and Hodgepodge move the point the server measures from upwards.
 *  - The clicked block is activated FIRST: a chest, crafting table or machine opens its
 *    window and nothing is placed. Only a block whose activation does nothing (every block
 *    in CLICKABLE_SUPPORTS, verified) lets the held block item place.
 *  - The new block needs a replaceable cell (air, tall grass, dead bush, but not flowers or
 *    double plants) whose box no entity overlaps, EXCEPT the placing player: the server
 *    leaves the placer out of that check (only a vanilla client checks its own body), so
 *    the agent does it.
 *  - Forge's BlockEvent.PlaceEvent comes last (a mod may cancel it: the cell is restored);
 *    success takes one item from the held stack.
 *  - The server answers every C08 with S23 for the clicked block and for the cell next to
 *    its face (the world's own change follows), and with S2F for the held slot whenever its
 *    stack differs from the one the client sent, or the placement failed.
 *
 * A crafting table or a furnace (STATION_ITEMS, approved 2026-09-30) is placed to be used,
 * and stays where it is (the agent never breaks one): checkStation keeps it on a solid
 * floor beside the player and out of the way the player walks. Placed like any block (the
 * click on the floor below; BlockWorkbench and BlockFurnace place as plain ItemBlocks, the
 * furnace turning its front to the player), it then opens like any table or furnace found.
 */

/** The agent places only into cells this close to its eyes (the same reach as digging). */
export const MAX_PLACE_REACH = MAX_DIG_REACH;
/** The server takes a click when the clicked block's centre is closer than this (5 + 1). */
export const SERVER_PLACE_REACH = 6;
/** The agent clicks only blocks this close to the feet and to the point 2 above them. */
export const MAX_CLICK_DISTANCE = SERVER_PLACE_REACH - 0.5;
/**
 * How far above the feet the server may measure the reach from: vanilla uses the feet,
 * ArchaicFix (fixPlacementFlicker) and Hodgepodge (fixWrongBlockPlacementDistanceCheck)
 * raise that point by 1.5 and 0.5. Clicks stay inside the reach from every point between.
 */
const SERVER_REACH_LIFT = 2;

/**
 * Cells a block may be placed into: air, and the plants a placed block replaces (their
 * material is Material.vine, which is replaceable; flowers and double plants are not).
 */
export const PLACE_TARGETS: ReadonlySet<string> = new Set([
  'minecraft:air',
  'minecraft:tallgrass',
  'minecraft:deadbush',
]);

/**
 * Blocks the agent clicks to place against: plain full vanilla blocks (the walker's known
 * surfaces and the dig allowlist's solid blocks). Verified: none of their classes overrides
 * onBlockActivated or isReplaceable, and none has a tile entity. Never a chest, crafting
 * table, machine or modded block: clicking those opens them instead. Never a HarvestCraft
 * garden either: its onBlockActivated picks the garden up (BlockGarden, javap).
 */
export const CLICKABLE_SUPPORTS: ReadonlySet<string> = new Set<string>([
  ...WALKABLE_SURFACES,
  // The vanilla ones: the modded leaves on the dig allowlist were checked for digging only,
  // and a garden is no block to click (it would be picked up).
  ...SOLID_DIGGABLE_BLOCKS.filter((b) => b.startsWith('minecraft:')),
]);

/** Blocks that hold sand or gravel up: the walker's full blocks (not leaves, not plants). */
export const FALLING_SUPPORTS: ReadonlySet<string> = WALKABLE_SURFACES;

/**
 * What may touch a cell the agent fills: air, plain full blocks, the dig allowlist and the
 * plants the walker passes (a full block beside a plant changes nothing for it). This set
 * holds the plants passable at any metadata; checkPlaceCell also lets through those passable
 * only at some metadata, at that metadata (passable.ts). Anything else (water, lava, a torch,
 * redstone, a chest, a machine, any other modded or unnamed block) refuses: a new block next
 * to it could redirect a fluid, power a circuit, cover a machine face or seal a chest.
 */
export const PLACE_NEIGHBOURS: ReadonlySet<string> = new Set<string>([
  ...DIG_NEIGHBOURS,
  ...PASSABLE_BLOCKS,
]);

/**
 * Entity sizes are not observed, so every tracked entity counts as a box this wide and tall
 * around its position: larger than any player, passive mob or object the agent can meet
 * (hostile and unidentified ones within the threat radius stop the placement anyway).
 */
export const ENTITY_HALF_WIDTH = 1;
export const ENTITY_HEIGHT = 3;

/** Where the agent may place: the same window as digging (fence columns, heights). */
export type PlaceArea = DigArea;

/** A tracked entity's position (its feet). */
export interface EntityPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The neighbour a block is placed against, and where the click lands on it. */
export interface PlaceSupport {
  /** The block clicked; it stays as it is. */
  readonly clicked: BlockPos;
  /** Its face towards the cell (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east). */
  readonly face: number;
  /** The centre of that face, in sixteenths of the clicked block (C08's cursor bytes). */
  readonly cursor: Vec3;
}

export type CellCheck =
  | {
      ok: true;
      /** The block id the cell holds now (air, tall grass or a dead bush). */
      replaces: number;
      support: PlaceSupport;
      /** Distance from the eyes to the cell's centre. */
      reach: number;
      /** Why sand or gravel may not go here, or null when they may. */
      fallingProblem: string | null;
    }
  | { ok: false; reason: string };

export type PlaceCheck =
  | { ok: true; block: PlaceableBlock; replaces: number; support: PlaceSupport; reach: number }
  | { ok: false; reason: string };

/**
 * The neighbours tried, in order (below first, then the sides, then above): the offset from
 * the cell, and the face of that neighbour which points back at the cell.
 */
const SUPPORTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, -1, 0, 1],
  [0, 0, -1, 3],
  [0, 0, 1, 2],
  [-1, 0, 0, 5],
  [1, 0, 0, 4],
  [0, 1, 0, 0],
];

/** The centre of each face (0-5), in sixteenths of the block. */
const FACE_CENTRES: readonly Vec3[] = [
  { x: 8, y: 0, z: 8 },
  { x: 8, y: 16, z: 8 },
  { x: 8, y: 8, z: 0 },
  { x: 8, y: 8, z: 16 },
  { x: 0, y: 8, z: 8 },
  { x: 16, y: 8, z: 8 },
];

const EPS = 1e-6;
const fmt = (p: BlockPos): string => `(${p.x}, ${p.y}, ${p.z})`;
const nameOf = (world: WalkWorld, id: number): string | undefined =>
  id === 0 ? 'minecraft:air' : world.blockName(id);

/** Whether the box [min, max] overlaps the block cell (touching a face is not overlapping). */
function boxOverlapsCell(min: Vec3, max: Vec3, c: BlockPos): boolean {
  return (
    min.x < c.x + 1 - EPS &&
    max.x > c.x + EPS &&
    min.y < c.y + 1 - EPS &&
    max.y > c.y + EPS &&
    min.z < c.z + 1 - EPS &&
    max.z > c.z + EPS
  );
}

/** Whether the player's body (0.6 x 1.8 x 0.6 around its feet) overlaps the cell. */
export function bodyOverlaps(feet: Vec3, cell: BlockPos): boolean {
  const h = PLAYER_HALF_WIDTH;
  return boxOverlapsCell(
    { x: feet.x - h, y: feet.y, z: feet.z - h },
    { x: feet.x + h, y: feet.y + PLAYER_HEIGHT, z: feet.z + h },
    cell,
  );
}

/** Whether an entity's (assumed, see ENTITY_HALF_WIDTH) box overlaps the cell. */
export function entityOverlaps(e: EntityPosition, cell: BlockPos): boolean {
  const h = ENTITY_HALF_WIDTH;
  return boxOverlapsCell(
    { x: e.x - h, y: e.y, z: e.z - h },
    { x: e.x + h, y: e.y + ENTITY_HEIGHT, z: e.z + h },
    cell,
  );
}

/** Why the cell is outside the area placing may change, or null (see workHeights). */
export function placeAreaProblem(area: PlaceArea, feet: Vec3, target: BlockPos): string | null {
  const { fence } = area;
  const { x, y, z } = target;
  if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) {
    return `${fmt(target)} is outside the fence's columns`;
  }
  const heights = workHeights(area, Math.floor(feet.y + EPS));
  if (y < heights.low || y > heights.high) {
    return `${fmt(target)} is outside the place heights y=${heights.low}..${heights.high} (${heights.rule})`;
  }
  return null;
}

/**
 * Whether a block could be placed into the cell at `target` by the player standing at
 * `feet`, whatever the block (the fence and the item are checkPlace's), and against which
 * neighbour. Fail closed: an unloaded block, an unnamed block id or anything not explicitly
 * allowed refuses.
 */
export function checkPlaceCell(
  world: WalkWorld,
  feet: Vec3,
  target: BlockPos,
  entities: readonly EntityPosition[],
): CellCheck {
  const refuse = (reason: string): CellCheck => ({ ok: false, reason });
  const { x, y, z } = target;
  // y 255 is refused by the server for solid blocks, and its build limit stops clicks there.
  if (![x, y, z].every(Number.isInteger) || y < 1 || y > 254) {
    return refuse(`${fmt(target)} is not a cell the agent places into (y 1..254)`);
  }
  const id = world.blockAt(x, y, z);
  if (id === undefined) return refuse(`${fmt(target)} is not loaded`);
  const name = nameOf(world, id);
  if (name === undefined) {
    return refuse(`${fmt(target)} holds block id ${id}, which the registry does not name`);
  }
  if (!PLACE_TARGETS.has(name)) {
    return refuse(
      `${fmt(target)} holds ${name} (only air, tall grass and dead bushes are placed into)`,
    );
  }

  const reach = reachTo(feet, target);
  if (reach > MAX_PLACE_REACH + 1e-9) {
    return refuse(
      `${fmt(target)} is ${reach.toFixed(2)} blocks from the eyes (max ${MAX_PLACE_REACH})`,
    );
  }
  if (bodyOverlaps(feet, target)) return refuse(`${fmt(target)} is a cell the player's body is in`);
  const entity = entities.find((e) => entityOverlaps(e, target));
  if (entity !== undefined) {
    return refuse(
      `an entity at (${entity.x.toFixed(1)}, ${entity.y.toFixed(1)}, ${entity.z.toFixed(1)}) is in or next to ${fmt(target)}`,
    );
  }

  // Everything touching it must be known and inert (see PLACE_NEIGHBOURS).
  for (const [dx, dy, dz] of SUPPORTS) {
    const n = { x: x + dx, y: y + dy, z: z + dz };
    const nid = world.blockAt(n.x, n.y, n.z);
    if (nid === undefined) return refuse(`the block next to it at ${fmt(n)} is not loaded`);
    const nname = nameOf(world, nid);
    if (nname === undefined) {
      return refuse(`it touches block id ${nid} at ${fmt(n)}, which the registry does not name`);
    }
    if (!PLACE_NEIGHBOURS.has(nname) && passProblem(world, n.x, n.y, n.z) !== null) {
      return refuse(
        `it touches ${variantName(world, n.x, n.y, n.z, nname)} at ${fmt(n)} (only air, plants and plain full blocks may touch a placed block)`,
      );
    }
  }
  // Nothing dangerous anywhere around it (lava, fire, harmful fluids, damaging blocks).
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const nid = world.blockAt(x + dx, y + dy, z + dz);
        if (nid === undefined) return refuse('a block near it is not loaded');
        if (world.hazardCode(nid) !== BLOCK_CODE.safe) {
          const n = { x: x + dx, y: y + dy, z: z + dz };
          return refuse(`it is next to ${world.blockName(nid) ?? `block id ${nid}`} at ${fmt(n)}`);
        }
      }
    }
  }

  // The block it goes against: the first plain full neighbour whose face towards the cell
  // faces the eyes (as a player clicks it) and that is well within the server's reach.
  const eyes = eyesOf(feet);
  const lifted = { x: feet.x, y: feet.y + SERVER_REACH_LIFT, z: feet.z };
  let support: PlaceSupport | null = null;
  for (const [dx, dy, dz, face] of SUPPORTS) {
    const n = { x: x + dx, y: y + dy, z: z + dz };
    const nname = nameOf(world, world.blockAt(n.x, n.y, n.z) ?? -1);
    if (nname === undefined || !CLICKABLE_SUPPORTS.has(nname)) continue;
    const towards =
      (eyes.x - (x + 0.5)) * dx + (eyes.y - (y + 0.5)) * dy + (eyes.z - (z + 0.5)) * dz;
    if (towards >= 0.5 - 1e-9) continue; // its face towards the cell points away from the eyes
    const c = { x: n.x + 0.5, y: n.y + 0.5, z: n.z + 0.5 };
    const far = Math.max(
      Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z),
      Math.hypot(c.x - lifted.x, c.y - lifted.y, c.z - lifted.z),
    );
    if (far > MAX_CLICK_DISTANCE + 1e-9) continue;
    support = { clicked: n, face, cursor: FACE_CENTRES[face] as Vec3 };
    break;
  }
  if (support === null) {
    return refuse(
      `there is nothing to place it against: no plain full block next to ${fmt(target)} faces the player within the server's reach`,
    );
  }

  // Sand and gravel stay only on a full block, and never go over the player's head.
  const own = bodyColumns(feet).some((c) => c.x === x && c.z === z);
  const belowId = world.blockAt(x, y - 1, z);
  const below = belowId === undefined ? undefined : nameOf(world, belowId);
  const fallingProblem = own
    ? 'it is in a column the player stands in: it could fall on its head'
    : below === undefined || !FALLING_SUPPORTS.has(below)
      ? `it would fall: ${below ?? 'an unknown block'} is under it, not a plain full block`
      : null;
  return { ok: true, replaces: id, support, reach, fallingProblem };
}

/**
 * Whether the player standing at `feet` may place `item` into the cell at `target`, and
 * against which neighbour: inside the area, every checkPlaceCell rule, sand or gravel only
 * where they cannot fall, and a crafting table or furnace only where checkStation allows it.
 * Checked before the click and again just before sending it.
 */
export function checkPlace(
  world: WalkWorld,
  area: PlaceArea,
  feet: Vec3,
  target: BlockPos,
  item: PlaceableItem,
  entities: readonly EntityPosition[],
): PlaceCheck {
  const outside = placeAreaProblem(area, feet, target);
  if (outside !== null) return { ok: false, reason: outside };
  const cell = checkPlaceCell(world, feet, target, entities);
  if (!cell.ok) return cell;
  if (fallsWhenPlaced(item) && cell.fallingProblem !== null) {
    return { ok: false, reason: `${item} at ${fmt(target)}: ${cell.fallingProblem}` };
  }
  if (isStationItem(item)) {
    const station = checkStation(world, area.fence, feet, target);
    if (station !== null) return { ok: false, reason: `${item} at ${fmt(target)}: ${station}` };
  }
  return {
    ok: true,
    block: placedBlockOf(item),
    replaces: cell.replaces,
    support: cell.support,
    reach: cell.reach,
  };
}

/** Feet blocks around a station's cell whose walks checkStation compares (columns each way). */
const STATION_AROUND = 2;
/** Levels below and above the cell and the feet that the comparison walks over. */
const STATION_BELOW = 3;
const STATION_ABOVE = 2;
/** Longest walk the comparison follows inside its small box. */
const STATION_WALK = 48;

/** `world` with a station's block in `cell`: no body passes it, and nobody stands on it. */
function withStation(world: WalkWorld, cell: BlockPos): WalkWorld {
  // An id above every real (16-bit) block id, named as a block the walker treats as solid.
  const id = 1 << 20;
  const at = (x: number, y: number, z: number): boolean =>
    x === cell.x && y === cell.y && z === cell.z;
  return {
    blockAt: (x, y, z) => (at(x, y, z) ? id : world.blockAt(x, y, z)),
    metaAt: (x, y, z) => (at(x, y, z) ? 0 : world.metaAt?.(x, y, z)),
    blockName: (n) => (n === id ? 'minecraft:crafting_table' : world.blockName(n)),
    hazardCode: (n) => (n === id ? BLOCK_CODE.safe : world.hazardCode(n)),
  };
}

/**
 * Why a crafting table or furnace may not go into the cell at `target`, or null. A player
 * puts one down on the ground beside it, where it does not block the way:
 *  - on a solid floor: a plain full block the walker stands on under it (it stays put, at
 *    the height the player uses it from);
 *  - never in a column the player's body is in: not in the cell it stands in (the server
 *    would allow that), nor over its head;
 *  - never where the player walks: in a small box around the cell and the player, the
 *    walker's own moves (terrain.ts reachableFeet: level moves, steps up, drops) must still
 *    reach every feet block they reach now, but the cell itself, with the block in place. A
 *    1-wide passage, a doorway, a staircase's step or the only way out of a hole all fail:
 *    the agent never breaks a station to get by.
 * Fail closed: the player not standing on walkable ground (no walk to compare) refuses.
 */
export function checkStation(
  world: WalkWorld,
  fence: Fence,
  feet: Vec3,
  target: BlockPos,
): string | null {
  if (bodyColumns(feet).some((c) => c.x === target.x && c.z === target.z)) {
    return 'it would be in a column the player stands in (never where the player stands)';
  }
  const belowId = world.blockAt(target.x, target.y - 1, target.z);
  const below = belowId === undefined ? undefined : nameOf(world, belowId);
  if (below === undefined || !FALLING_SUPPORTS.has(below)) {
    return `it would not stand on a solid floor: ${below ?? 'an unknown block'} is under it`;
  }
  const feetY = Math.floor(feet.y + EPS);
  const box: Fence = {
    min: {
      x: Math.max(fence.min.x, Math.min(target.x, Math.floor(feet.x)) - STATION_AROUND),
      y: Math.max(fence.min.y, Math.min(target.y, feetY) - STATION_BELOW),
      z: Math.max(fence.min.z, Math.min(target.z, Math.floor(feet.z)) - STATION_AROUND),
    },
    max: {
      x: Math.min(fence.max.x, Math.max(target.x, Math.floor(feet.x)) + STATION_AROUND),
      y: Math.min(fence.max.y, Math.max(target.y, feetY) + STATION_ABOVE),
      z: Math.min(fence.max.z, Math.max(target.z, Math.floor(feet.z)) + STATION_AROUND),
    },
  };
  const before = reachableFeet(world, box, feet, STATION_WALK);
  if (before.size === 0) {
    return 'the player does not stand on walkable ground here, so the way it walks is not known';
  }
  const after = reachableFeet(withStation(world, target), box, feet, STATION_WALK);
  const cut = [...before.values()].filter(
    (p) =>
      !(p.x === target.x && p.y === target.y && p.z === target.z) &&
      !after.has(`${p.x},${p.y},${p.z}`),
  );
  if (cut.length === 0) return null;
  const first = cut[0] as { x: number; y: number; z: number };
  return (
    `it would be in the player's way: ${cut.length} spot(s) it walks to now ` +
    `(e.g. ${fmt(first)}) would be cut off (a 1-wide passage or the only way on)`
  );
}

/** A cell checkPlaceCell allows, as an observation lists it. */
export interface FoundPlaceableCell {
  position: BlockPos;
  /** Sand and gravel may go here. */
  takesFalling: boolean;
  reach: number;
}

/**
 * The cells around the player a block could be placed into (every cell checkPlaceCell
 * allows), nearest to the eyes first, ties by position; at most `max`.
 */
export function scanPlaceable(
  world: WalkWorld,
  feet: Vec3,
  entities: readonly EntityPosition[],
  max: number,
): FoundPlaceableCell[] {
  const eyes = eyesOf(feet);
  const r = MAX_PLACE_REACH;
  // Only entities that could touch a cell within reach matter.
  const near = entities.filter(
    (e) => Math.hypot(e.x - eyes.x, e.y - eyes.y, e.z - eyes.z) <= r + ENTITY_HEIGHT + 1,
  );
  const found: FoundPlaceableCell[] = [];
  for (let x = Math.floor(eyes.x - r); x <= Math.floor(eyes.x + r); x++) {
    for (let y = Math.max(1, Math.floor(eyes.y - r)); y <= Math.min(254, eyes.y + r); y++) {
      for (let z = Math.floor(eyes.z - r); z <= Math.floor(eyes.z + r); z++) {
        if (reachTo(feet, { x, y, z }) > r + 1e-9) continue;
        if (world.blockAt(x, y, z) !== 0 && !isPlantCell(world, x, y, z)) continue;
        const cell = checkPlaceCell(world, feet, { x, y, z }, near);
        if (!cell.ok) continue;
        found.push({
          position: { x, y, z },
          takesFalling: cell.fallingProblem === null,
          reach: cell.reach,
        });
      }
    }
  }
  found.sort(
    (a, b) =>
      a.reach - b.reach ||
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.position.z - b.position.z,
  );
  return found.slice(0, max);
}

function isPlantCell(world: WalkWorld, x: number, y: number, z: number): boolean {
  const id = world.blockAt(x, y, z);
  if (id === undefined || id === 0) return false;
  const name = world.blockName(id);
  return name !== undefined && PLACE_TARGETS.has(name);
}
