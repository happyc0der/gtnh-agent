import { isDiggableBlock, ORE_DIGGABLE_BLOCKS, type DiggableBlock } from '../../domain/blocks.ts';
import { isBlockInsideBox } from '../../domain/geometry.ts';
import { isProtected } from '../../safety/protected-items.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import { checkDig, digDoesNotDisturb, reachTo, type DigArea, type DigCheck } from './digging.ts';
import { passProblem } from './passable.ts';
import type { PathOptions } from './pathing/search.ts';
import {
  bodyOverlaps,
  CLICKABLE_SUPPORTS,
  entityOverlaps,
  MAX_CLICK_DISTANCE,
  MAX_PLACE_REACH,
  PLACE_NEIGHBOURS,
  PLACE_TARGETS,
  placeAreaProblem,
  type EntityPosition,
  type PlaceArea,
} from './placing.ts';
import type { PointBox } from './play-area.ts';
import type { Cell } from './terrain.ts';
import type { Vec3, WalkWorld } from './walking.ts';

/**
 * What a walk may do on its way, as the pathfinder's options (pathing/search.ts PathOptions):
 * Baritone's allowBreak, allowPlace, allowParkour and allowSprint settings (the ideas only),
 * with this agent's dig and place rules. Pure: the client (client/path-actions.ts) builds a
 * policy for each walk from its config, inventory and world, plans with it, and checks every
 * break and place again with the same rules just before it (checkPathBreak, checkPathPlace).
 *
 *  - Breaking (allowBreak, with digging enabled): natural blocks on the dig allowlist, by
 *    every rule of digging.ts checkDig (natural metadata, only air, plain blocks and plants
 *    beside it touching it, nothing to fall in or flow in, no hazard near, inside the fence's
 *    columns and dig heights), with the dig time of the tool the dig would hold (stone only
 *    with a carried pickaxe that harvests it); never an ore (ores are for mining), never a
 *    block a player built (seen placed while a player stood near: WalkWorld.builtByPlayer),
 *    never a block within PLAYER_BREAK_DISTANCE of another player, never outside the safety
 *    boundary.
 *  - Placing (allowPlace, with placing enabled): pillars and bridges of throwaway blocks
 *    (chooseThrowaway: dirt, cobblestone or netherrack the player carries, never a protected
 *    item, keeping `throwawayReserve` dirt for the night shelter's roof), into air, tall
 *    grass or a dead bush with only air, plants and plain blocks around it (placing.ts's
 *    neighbour rule), never within PLAYER_PLACE_DISTANCE of another player, never outside the
 *    safety boundary; clicking only a plain full block (placing.ts CLICKABLE_SUPPORTS) or a
 *    block the same walk placed.
 *  - Hostile mobs: a path keeps MOB_AVOID_RADIUS from them where it can (movements near one
 *    cost MOB_AVOID_COEFFICIENT times as much), as Baritone avoids mobs.
 *  - Doors (allowDoors): wooden doors and fence gates in the way are opened with a right-click
 *    and closed again once the walk is through (pathing/movements.ts door); never an iron one.
 *  - Parkour (allowParkour): only over gaps that falling into would not hurt, unless
 *    parkourOverDeepGaps; sprinting (allowSprint) only when the caller says the walk is long
 *    and the food bar high enough (client/path-actions.ts); wading (allowWater) in calm
 *    one-deep water.
 *  - A walk that does no work (a retreat, a flee, the walk to a drop: threats do not stop
 *    them, and a dig or a placement would) breaks and places nothing.
 */

/** Hostile mobs are kept this far from (blocks) by making movements near them dearer. */
export const MOB_AVOID_RADIUS = 8;
/** How much dearer (Baritone's mobAvoidanceCoefficient default, the idea). */
export const MOB_AVOID_COEFFICIENT = 1.5;

/** Blocks broken per walk at most: a tunnel of a dozen blocks, or a belt of leaves. */
export const MAX_PATH_BREAKS = 24;
/** Nothing is broken this close (blocks) to another player: the owner plays alongside. */
export const PLAYER_BREAK_DISTANCE = 4;
/** Nothing is placed this close (blocks) to another player. */
export const PLAYER_PLACE_DISTANCE = 3;
/**
 * The blocks a walk places, most preferred first (dirt last: the night shelter's roof is
 * dirt). Each is a plain full block the walker stands on (terrain.ts TERRAIN_SURFACES) that
 * a click opens nothing on.
 */
export const THROWAWAY_BLOCKS = [
  'minecraft:cobblestone',
  'minecraft:netherrack',
  'minecraft:dirt',
] as const;

/** The throwaway blocks a walk may place: which, and how many. */
export interface WalkThrowaway {
  readonly block: string;
  readonly count: number;
}

/**
 * How walks move (the config's minecraft.movement.path, config/env.ts PathConfigSchema:
 * Baritone's allowBreak, allowPlace, allowParkour and allowSprint, and wading).
 */
export interface WalkSettings {
  readonly allowBreak: boolean;
  readonly allowPlace: boolean;
  readonly allowParkour: boolean;
  readonly parkourOverDeepGaps: boolean;
  readonly allowSprint: boolean;
  readonly allowWater: boolean;
  /** Through doorways, opening and closing wooden doors and fence gates. */
  readonly allowDoors: boolean;
  /** Dirt never placed on a walk: kept for the night shelter's roof. */
  readonly throwawayReserve: number;
}

/** Where other players stand: what breaks and places keep away from. */
export interface PolicyContext {
  readonly boundary: PointBox | null;
  /** Other players' feet (never the bot itself). */
  readonly players: readonly Vec3[];
}

export interface WalkPolicyInput extends PolicyContext {
  readonly world: WalkWorld;
  readonly settings: WalkSettings;
  /** Hostile mobs near, where they stand: paths keep away from them where they can. */
  readonly hostiles?: readonly Vec3[];
  /** Digging may break on this walk: digging is enabled and the walk does work. */
  readonly breaking: boolean;
  /** Placing may place on this walk: placing is enabled and the walk does work. */
  readonly placing: boolean;
  /** Digging's maxHeightAboveFence: an ascend breaks two blocks above the feet. */
  readonly digHeight: number;
  /** The dig time of a block with what the dig would hold, or why it cannot be dug. */
  readonly digTicks: (
    block: DiggableBlock,
    meta: number | undefined,
  ) => { ticks: number } | { problem: string };
  /** The throwaway blocks (chooseThrowaway), or null: none to place. */
  readonly throwaway: WalkThrowaway | null;
  /** Plan sprinting (the caller decided the walk is long and the food bar high enough). */
  readonly sprint: boolean;
}

export interface WalkPolicy {
  readonly options: PathOptions;
  /** Breaking, placing and their throwaway as allowed, in words for logs. */
  readonly summary: string;
  /** Wading allowed: the execution plan and its checks must know. */
  readonly water: boolean;
}

const fmt = (c: Cell): string => `(${c.x}, ${c.y}, ${c.z})`;

const FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

/** The block's registry name (air for id 0), or undefined while unloaded or unnamed. */
function nameAt(world: WalkWorld, x: number, y: number, z: number): string | undefined {
  const id = world.blockAt(x, y, z);
  if (id === undefined) return undefined;
  return id === 0 ? 'minecraft:air' : world.blockName(id);
}

/**
 * The player nearest to the block whose body (feet to head, 1.8 high) is within `radius` of
 * the block's centre, or undefined.
 */
export function playerNear(cell: Cell, players: readonly Vec3[], radius: number): Vec3 | undefined {
  const cx = cell.x + 0.5;
  const cy = cell.y + 0.5;
  const cz = cell.z + 0.5;
  return players.find((p) => {
    const dy = Math.max(0, p.y - cy, cy - (p.y + 1.8));
    return Math.hypot(cx - p.x, dy, cz - p.z) <= radius;
  });
}

/**
 * Why a walk may not break the block at `cell` whoever stands where, or null: what the
 * policy adds to the dig rules (the allowlist without ores, a player's build, a player near,
 * the safety boundary) and the dig rules that do not depend on where the player stands
 * (natural blocks touching it). checkPathBreak adds the rest just before the dig.
 */
export function pathBreakProblem(world: WalkWorld, cell: Cell, ctx: PolicyContext): string | null {
  const { x, y, z } = cell;
  const name = nameAt(world, x, y, z);
  if (name === undefined) return `${fmt(cell)} is not loaded or not named`;
  if (name === 'minecraft:air') return `${fmt(cell)} is air`;
  if (!isDiggableBlock(name)) return `${fmt(cell)} is ${name}, which is not on the dig allowlist`;
  if ((ORE_DIGGABLE_BLOCKS as readonly string[]).includes(name)) {
    return `${fmt(cell)} is ${name}: ores are mined, never broken on a walk`;
  }
  if (world.builtByPlayer?.(x, y, z) === true) {
    return `${fmt(cell)} was built by a player (seen placed while one stood near): never broken`;
  }
  if (ctx.boundary !== null && !isBlockInsideBox(cell, ctx.boundary)) {
    return `${fmt(cell)} is not inside the safety boundary`;
  }
  const player = playerNear(cell, ctx.players, PLAYER_BREAK_DISTANCE);
  if (player !== undefined) {
    return `${fmt(cell)} is within ${PLAYER_BREAK_DISTANCE} blocks of a player at (${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)})`;
  }
  for (const [dx, dy, dz] of FACES) {
    const n = { x: x + dx, y: y + dy, z: z + dz };
    const nname = nameAt(world, n.x, n.y, n.z);
    if (nname === undefined) return `the block next to ${fmt(cell)} at ${fmt(n)} is not known`;
    if (!digDoesNotDisturb(world, n, nname, dy)) {
      return `${fmt(cell)} touches ${nname} at ${fmt(n)} (only air and plain blocks may touch a broken block, and plants only beside it)`;
    }
  }
  return null;
}

/**
 * Whether the player standing at `feet` may break `cell` on a walk now: every rule of
 * checkDig (from where it stands: reach, never its own support, the dig heights, hazards,
 * fluids, falling blocks) and the policy's (pathBreakProblem). Checked just before the dig
 * and every tick while digging; the dig itself holds what harvests the block, or refuses.
 */
export function checkPathBreak(
  world: WalkWorld,
  area: DigArea,
  feet: Vec3,
  cell: Cell,
  ctx: PolicyContext,
): DigCheck {
  const c = checkDig(world, area, feet, cell);
  if (!c.ok) return c;
  const why = pathBreakProblem(world, cell, ctx);
  return why === null ? c : { ok: false, reason: why };
}

/**
 * Why a walk may not place a block into `cell` whoever stands where, or null: inside the
 * safety boundary, no player near, and only air, plants and plain full blocks touching it
 * (placing.ts's rule for PLACE_BLOCK: a block next to a fluid, a torch, a chest or a machine
 * could change it). The pathfinder itself keeps placements out of fluids and hazards.
 */
export function pathPlaceProblem(world: WalkWorld, cell: Cell, ctx: PolicyContext): string | null {
  if (ctx.boundary !== null && !isBlockInsideBox(cell, ctx.boundary)) {
    return `${fmt(cell)} is not inside the safety boundary`;
  }
  const player = playerNear(cell, ctx.players, PLAYER_PLACE_DISTANCE);
  if (player !== undefined) {
    return `${fmt(cell)} is within ${PLAYER_PLACE_DISTANCE} blocks of a player at (${player.x.toFixed(1)}, ${player.y.toFixed(1)}, ${player.z.toFixed(1)})`;
  }
  for (const [dx, dy, dz] of FACES) {
    const n = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    const nname = nameAt(world, n.x, n.y, n.z);
    if (nname === undefined) return `the block next to ${fmt(cell)} at ${fmt(n)} is not known`;
    if (!PLACE_NEIGHBOURS.has(nname) && passProblem(world, n.x, n.y, n.z) !== null) {
      return `${fmt(cell)} touches ${nname} at ${fmt(n)} (only air, plants and plain blocks may touch a placed block)`;
    }
  }
  return null;
}

/** A block a walk places: into `cell`, clicking face `face` of `against`. */
export interface WalkPlace {
  readonly cell: Cell;
  readonly against: Cell;
  readonly face: number;
}

/** How far above the feet the server may measure the reach from (placing.ts). */
const SERVER_REACH_LIFT = 2;

/**
 * Whether the player standing at `feet` may place a block into `place.cell` now, clicking
 * `place.against`, or why not: inside the place area, the cell air, tall grass or a dead
 * bush (pathPlaceProblem's neighbours, no hazard in the 3 x 3 x 3 cube), the clicked block
 * a plain full block (or one this walk placed: `ownPlaced`, "x,y,z") whose face touches the
 * cell, within the reach the client keeps to (the cell within 4.5 of the eyes, the clicked
 * block within 5.5 of the feet and of the point 2 above them), never the player's own body,
 * and no entity in it but dropped items (which a block does not mind).
 */
export function checkPathPlace(
  world: WalkWorld,
  area: PlaceArea,
  feet: Vec3,
  place: WalkPlace,
  ctx: PolicyContext & {
    readonly entities: readonly EntityPosition[];
    readonly ownPlaced: ReadonlySet<string>;
  },
): string | null {
  const { cell, against, face } = place;
  const outside = placeAreaProblem(area, feet, cell);
  if (outside !== null) return outside;
  const here = nameAt(world, cell.x, cell.y, cell.z);
  if (here === undefined || !PLACE_TARGETS.has(here)) {
    return `${fmt(cell)} holds ${here ?? 'an unknown block'} (only air, tall grass and dead bushes are placed into)`;
  }
  const problem = pathPlaceProblem(world, cell, ctx);
  if (problem !== null) return problem;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const id = world.blockAt(cell.x + dx, cell.y + dy, cell.z + dz);
        if (id === undefined) return `a block near ${fmt(cell)} is not loaded`;
        if (world.hazardCode(id) !== BLOCK_CODE.safe) {
          return `${fmt(cell)} is next to ${world.blockName(id) ?? `block id ${id}`}`;
        }
      }
    }
  }
  const off = FACES[face];
  if (
    off === undefined ||
    against.x + off[0] !== cell.x ||
    against.y + off[1] !== cell.y ||
    against.z + off[2] !== cell.z
  ) {
    return `face ${face} of ${fmt(against)} does not touch ${fmt(cell)}`;
  }
  const clicked = nameAt(world, against.x, against.y, against.z);
  const own = ctx.ownPlaced.has(`${against.x},${against.y},${against.z}`);
  if (clicked === undefined || (!CLICKABLE_SUPPORTS.has(clicked) && !own)) {
    return `${fmt(against)} is ${clicked ?? 'not known'}: only a plain full block is clicked (a click may open anything else)`;
  }
  if (reachTo(feet, cell) > MAX_PLACE_REACH + 1e-9) {
    return `${fmt(cell)} is ${reachTo(feet, cell).toFixed(2)} blocks from the eyes (max ${MAX_PLACE_REACH})`;
  }
  const c = { x: against.x + 0.5, y: against.y + 0.5, z: against.z + 0.5 };
  const far = Math.max(
    Math.hypot(c.x - feet.x, c.y - feet.y, c.z - feet.z),
    Math.hypot(c.x - feet.x, c.y - (feet.y + SERVER_REACH_LIFT), c.z - feet.z),
  );
  if (far > MAX_CLICK_DISTANCE + 1e-9) {
    return `${fmt(against)} is ${far.toFixed(2)} blocks away (the server takes a click within ${MAX_CLICK_DISTANCE})`;
  }
  if (bodyOverlaps(feet, cell)) return `${fmt(cell)} is a cell the player's body is in`;
  const entity = ctx.entities.find((e) => entityOverlaps(e, cell));
  if (entity !== undefined) {
    return `an entity at (${entity.x.toFixed(1)}, ${entity.y.toFixed(1)}, ${entity.z.toFixed(1)}) is in or next to ${fmt(cell)}`;
  }
  return null;
}

/**
 * The throwaway blocks a walk may place: of THROWAWAY_BLOCKS, the one the player carries most
 * of (counting dirt less `reserve`, kept for the night shelter's roof), never a protected
 * item; ties go to the first. Counts are of the plain items (no damage value: the GameState
 * names, `minecraft:dirt`), which are the blocks' own items in 1.7.10. Null: none to place.
 */
export function chooseThrowaway(
  items: Readonly<Record<string, number>>,
  protectedItems: ReadonlySet<string>,
  reserve: number,
): WalkThrowaway | null {
  let best: WalkThrowaway | null = null;
  for (const block of THROWAWAY_BLOCKS) {
    if (isProtected(block, protectedItems)) continue;
    const held = items[block] ?? 0;
    const count = block === 'minecraft:dirt' ? held - reserve : held;
    if (count > 0 && (best === null || count > best.count)) best = { block, count };
  }
  return best;
}

/**
 * The pathfinder's options for one walk (see the file comment). Breaking needs digging's
 * heights to reach two blocks above the feet (an ascend's head room); a lower setting
 * breaks nothing on walks, so the planner never counts on a dig the client would refuse.
 */
export function walkPolicy(input: WalkPolicyInput): WalkPolicy {
  const s = input.settings;
  const world = input.world;
  const ctx: PolicyContext = { boundary: input.boundary, players: input.players };
  const breaking = input.breaking && s.allowBreak && input.digHeight >= 2;
  const throwaway = input.throwaway;
  const placing = input.placing && s.allowPlace && throwaway !== null && throwaway.count > 0;
  const options: PathOptions = {
    sprint: input.sprint,
    parkour: s.allowParkour,
    parkourOverDeepGaps: s.parkourOverDeepGaps,
    water: s.allowWater,
    // Doors and gates are opened (and closed again) on any walk: an escape into a house too.
    doors: s.allowDoors,
    ...((input.hostiles ?? []).length === 0
      ? {}
      : {
          avoid: (input.hostiles ?? []).map((h) => ({
            x: h.x,
            y: h.y,
            z: h.z,
            radius: MOB_AVOID_RADIUS,
            coefficient: MOB_AVOID_COEFFICIENT,
          })),
        }),
    maxFall: 3,
    ...(breaking
      ? {
          maxBreaks: MAX_PATH_BREAKS,
          canBreak: (cell: Cell): number | null => {
            if (pathBreakProblem(world, cell, ctx) !== null) return null;
            const name = nameAt(world, cell.x, cell.y, cell.z);
            if (name === undefined || !isDiggableBlock(name)) return null;
            const dig = input.digTicks(name, world.metaAt?.(cell.x, cell.y, cell.z));
            return 'ticks' in dig ? dig.ticks : null;
          },
        }
      : {}),
    ...(placing
      ? {
          pillar: true,
          bridge: true,
          throwaway: { count: throwaway.count, block: throwaway.block },
          canPlace: (cell: Cell): boolean => pathPlaceProblem(world, cell, ctx) === null,
        }
      : {}),
  };
  const words = [
    breaking ? 'breaking' : 'no breaking',
    placing ? `placing up to ${throwaway.count} ${throwaway.block}` : 'no placing',
    s.allowParkour ? (s.parkourOverDeepGaps ? 'parkour (deep gaps too)' : 'parkour') : null,
    input.sprint ? 'sprinting' : null,
    s.allowWater ? 'wading' : null,
    s.allowDoors ? 'doors' : null,
  ].filter((w) => w !== null);
  return { options, summary: words.join(', '), water: s.allowWater };
}
