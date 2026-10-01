import {
  DIGGABLE_BLOCKS,
  fallsWhenPlaced,
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
import { WALKABLE_SURFACES, type Vec3, type WalkWorld } from './walking.ts';

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
 * surfaces and the dig allowlist). Verified: none of their classes overrides
 * onBlockActivated or isReplaceable, and none has a tile entity. Never a chest, crafting
 * table, machine or modded block: clicking those opens them instead.
 */
export const CLICKABLE_SUPPORTS: ReadonlySet<string> = new Set<string>([
  ...WALKABLE_SURFACES,
  ...DIGGABLE_BLOCKS,
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
 * against which neighbour: inside the area, every checkPlaceCell rule, and sand or gravel
 * only where they cannot fall. Checked before the click and again just before sending it.
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
  return {
    ok: true,
    block: placedBlockOf(item),
    replaces: cell.replaces,
    support: cell.support,
    reach: cell.reach,
  };
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
