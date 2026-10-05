import { passProblem } from '../../bot/gtnh1710/passable.ts';
import {
  goalAny,
  goalBlock,
  goalNear,
  goalXZ,
  type Goal,
} from '../../bot/gtnh1710/pathing/goals.ts';
import type { Movement } from '../../bot/gtnh1710/pathing/movements.ts';
import { planPath, type PathOptions } from '../../bot/gtnh1710/pathing/search.ts';
import type { PlayArea } from '../../bot/gtnh1710/play-area.ts';
import type { Vec3, WalkWorld } from '../../bot/gtnh1710/walking.ts';
import {
  MAX_EXPLORE_DISTANCE,
  MIN_EXPLORE_DISTANCE,
  type ActionSpec,
} from '../../domain/actions.ts';
import type { Position } from '../../domain/common.ts';

/**
 * The next step of an owner's travel command (come, follow, goto, home, a waypoint), planned
 * by code, never by a planner, with the live client's own pathfinder and walk policy
 * (src/bot/gtnh1710/pathing/, the client's MOVE_TO options): a MOVE_TO to where a path ends
 * (goalNear the player for come and follow, the point's block for goto), or, toward a point
 * the play area does not reach, an EXPLORE (segments over land, in daylight). The play loop
 * (commands.ts) re-plans after every cycle, so a moving owner is followed; follow walks about a
 * second of its path at a time, so it re-plans about every second and keeps about 3 blocks from
 * the owner. Each step runs as a known safe step: the executor validates it (the safety
 * policy, the boundary, hazards, the night), executes and verifies it like any other. The walk
 * policy breaks nothing within 4 blocks and places nothing within 3 blocks of another player,
 * so never near the owner.
 */

/** Where a travel command goes: near a player (come, follow), or to a point (y null: any). */
export type TravelTarget =
  | {
      kind: 'near';
      point: Position;
      within: number;
      /** Follow: walk about a second of the path at a time, then plan again. */
      step?: boolean;
    }
  | {
      kind: 'point';
      point: { x: number; y: number | null; z: number };
      /** Arrived only with the feet in the point's own block (else within AT_POINT). */
      exact?: boolean;
    };

export type TravelStep =
  /** There already: `distance` blocks across from the target. */
  | { kind: 'arrived'; distance: number }
  | { kind: 'step'; spec: ActionSpec; text: string; distance: number }
  | { kind: 'refused'; reason: string };

export interface TravelInput {
  /** The client's blocks (null while unknown). */
  world: WalkWorld | null;
  /** Where walks may go now: the fence, or the play area around the player. */
  area: PlayArea;
  /** The player's feet (null while unknown). */
  feet: Vec3 | null;
  target: TravelTarget;
  movement: {
    enabled: boolean;
    /** EXPLORE is possible (movement mode 'follow'). */
    canExplore: boolean;
    /** Longest walk (blocks), as the walker plans it. */
    maxPathLength: number;
  };
  /**
   * How far (straight, from the feet) a MOVE_TO's target may be: the safety policy refuses one
   * whose surroundings the hazard scan has not covered.
   */
  moveReach: number;
  /**
   * The client's walk policy for a MOVE_TO (what it may break and place, parkour...), so a step
   * plans as its walk will; walking only (no breaks or places) when absent.
   */
  path?: PathOptions;
  /** The step's search time (default STEP_MAX_MS; tests on a loaded machine allow more). */
  searchMs?: number;
}

/** At a point: this close across (blocks), and up or down. */
export const AT_POINT = 1.5;
/** Near a player: at most this far up or down. */
const NEAR_DY = 2.5;
/** A stand spot is never closer to the player it goes to than this: not into its body. */
const PERSONAL_SPACE = 1;
/** A walk toward a target must get at least this much closer across. */
const MIN_GAIN = 1;
/** Farther than this across, a target a walk does not reach is explored toward. */
const EXPLORE_BEYOND = 4;
/** Follow walks about this many ticks of its path per step (about a second), then plans again. */
export const FOLLOW_STEP_TICKS = 24;
/** The step's search: it runs between packets, every cycle of a travel command. */
const STEP_MAX_NODES = 40_000;
const STEP_MAX_MS = 250;

const refused = (reason: string): TravelStep => ({ kind: 'refused', reason });
const centre = (c: { x: number; y: number; z: number }): Position => ({
  x: c.x + 0.5,
  y: c.y,
  z: c.z + 0.5,
});
const fmt = (p: { x: number; y: number | null; z: number }): string =>
  [p.x, p.y, p.z]
    .filter((v): v is number => v !== null)
    .map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)))
    .join(', ');

/** `!surface` looks this far across for open sky. */
export const SURFACE_RADIUS = 16;
/** At most this many open-sky cells go to the search, the nearest first. */
const SURFACE_CANDIDATES = 48;
/** The surface search runs once, as the command begins: a little longer than a step's. */
const SURFACE_MAX_NODES = 80_000;
const SURFACE_MAX_MS = 600;
/** Natural ground `!surface` stands on: not a roof, a tree top or water. */
const SURFACE_GROUND: ReadonlySet<string> = new Set([
  'minecraft:grass',
  'minecraft:dirt',
  'minecraft:stone',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:sandstone',
  'minecraft:clay',
  'minecraft:hardened_clay',
  'minecraft:stained_hardened_clay',
  'minecraft:snow',
  'minecraft:mycelium',
  'minecraft:cobblestone',
  'minecraft:mossy_cobblestone',
]);

/**
 * Where `!surface` goes (Baritone's #surface): a cell on natural ground with nothing but air
 * or plants above it, within SURFACE_RADIUS across. Of the nearest SURFACE_CANDIDATES, the one
 * the cheapest path reaches (the search's goal is any of them: back up a staircase when that
 * is cheaper than digging straight up), else the nearest; `here` when the feet are under open
 * sky already. Fixed when the command begins, like an explore's point.
 */
export function surfaceTarget(
  input: Omit<TravelInput, 'target'>,
): { point: Position; here: boolean } | { problem: string } {
  const { world, feet } = input;
  if (feet === null) return { problem: 'my position is not known' };
  if (world === null) return { problem: 'the blocks around me are not known yet' };
  const fence = input.area.fence;
  if (fence === null) return { problem: input.area.problem };
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + 1e-6);
  const fz = Math.floor(feet.z);
  /** The column's highest block that is not air or a plant; undefined when not known. */
  const topOf = (x: number, z: number): number | undefined => {
    for (let y = 255; y >= 0; y--) {
      if (world.blockAt(x, y, z) === undefined) return undefined;
      if (passProblem(world, x, y, z) !== null) return y;
    }
    return undefined;
  };
  const own = topOf(fx, fz);
  if (own !== undefined && own < fy) return { point: { ...feet }, here: true };
  const cells: Array<{ x: number; y: number; z: number; d: number }> = [];
  const r = SURFACE_RADIUS;
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (dx * dx + dz * dz > r * r) continue;
      const x = fx + dx;
      const z = fz + dz;
      if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) continue;
      const top = topOf(x, z);
      if (top === undefined) continue;
      const id = world.blockAt(x, top, z);
      const name = id === undefined ? undefined : world.blockName(id);
      if (name === undefined || !SURFACE_GROUND.has(name)) continue;
      const y = top + 1;
      if (y < fence.min.y || y > fence.max.y) continue;
      cells.push({ x, y, z, d: Math.hypot(dx, y - fy, dz) });
    }
  }
  if (cells.length === 0) {
    return { problem: `I see no open sky on natural ground within ${r} blocks` };
  }
  cells.sort((a, b) => a.d - b.d);
  const offered = cells.slice(0, SURFACE_CANDIDATES);
  const found = planPath(
    world,
    fence,
    feet,
    goalAny(...offered.map((c) => goalBlock(c.x, c.y, c.z))),
    { ...input.path, maxNodes: SURFACE_MAX_NODES, maxTimeMs: SURFACE_MAX_MS },
  );
  const best = (found.status === 'reached' ? found.end : null) ?? (offered[0] as Vec3);
  return { point: { x: best.x + 0.5, y: best.y, z: best.z + 0.5 }, here: false };
}

/** The next step toward `target`, or that it is there, or why there is no step. */
export function planTravelStep(input: TravelInput): TravelStep {
  const { world, feet, target } = input;
  if (feet === null) return refused('my position is not known');
  const goalPoint = target.point;
  const across = Math.hypot(goalPoint.x - feet.x, goalPoint.z - feet.z);
  const dy = goalPoint.y === null ? 0 : Math.abs(goalPoint.y - feet.y);
  const sameBlock =
    Math.floor(feet.x) === Math.floor(goalPoint.x) &&
    Math.floor(feet.z) === Math.floor(goalPoint.z) &&
    (goalPoint.y === null || Math.floor(feet.y + 1e-6) === Math.floor(goalPoint.y + 1e-6));
  const arrived =
    target.kind === 'near'
      ? across <= target.within && dy <= NEAR_DY
      : target.exact === true
        ? sameBlock
        : across <= AT_POINT && dy <= AT_POINT;
  if (arrived) return { kind: 'arrived', distance: Number(across.toFixed(1)) };
  if (!input.movement.enabled) return refused('walking is off (MC_ENABLE_MOVEMENT)');
  const fence = input.area.fence;
  if (fence === null) return refused(input.area.problem);
  if (world === null) return refused('the blocks around me are not known yet');

  const distance = Number(across.toFixed(1));
  const acrossFrom = (c: { x: number; z: number }): number =>
    Math.hypot(c.x + 0.5 - goalPoint.x, c.z + 0.5 - goalPoint.z);
  const block = {
    x: Math.floor(goalPoint.x),
    y: goalPoint.y === null ? null : Math.floor(goalPoint.y + 1e-6),
    z: Math.floor(goalPoint.z),
  };
  // Near a player: within reach of it (as Baritone's goal near); a point: its own block (as
  // Baritone's goal block: `goto 20 64 5` is the block at 20 64 5), or its column.
  const goal: Goal =
    target.kind === 'near'
      ? goalNear(target.point, target.within)
      : block.y === null
        ? goalXZ(block.x, block.z)
        : goalBlock(block.x, block.y, block.z);
  const found = planPath(world, fence, feet, goal, {
    ...input.path,
    maxNodes: STEP_MAX_NODES,
    maxTimeMs: input.searchMs ?? STEP_MAX_MS,
  });

  const explore = (): TravelStep => ({
    kind: 'step',
    spec: {
      type: 'EXPLORE',
      args: {
        toward: { x: goalPoint.x, z: goalPoint.z },
        maxDistance: Math.min(
          MAX_EXPLORE_DISTANCE,
          Math.max(MIN_EXPLORE_DISTANCE, Math.ceil(across)),
        ),
      },
    },
    text: `EXPLORE toward (${fmt({ x: goalPoint.x, y: null, z: goalPoint.z })}): ${distance} blocks across`,
    distance,
  });
  const walk = (end: { x: number; y: number; z: number }, why: string): TravelStep => ({
    kind: 'step',
    spec: { type: 'MOVE_TO', args: { target: centre(end), tolerance: 1 } },
    text: `walk to (${fmt(centre(end))}): ${why}`,
    distance,
  });
  const beyondReach = (end: { x: number; y: number; z: number }): boolean =>
    Math.hypot(end.x + 0.5 - feet.x, end.y - feet.y, end.z + 0.5 - feet.z) > input.moveReach;
  // EXPLORE heads across (any height): toward a target more below or above than across from the
  // player, in a column the play area holds, it walks nearer instead (seen live 2026-10-04:
  // water 19 blocks below and 4 across; each walk down took it across, the EXPLORE back up
  // toward the column, and so on until dusk). A column beyond the play area is explored toward,
  // however high or low (an independent review, 2026-10-04: a tower's top 39 across and 46 up
  // was refused, or pillared toward in the open field).
  const columnInArea =
    block.x >= fence.min.x &&
    block.x <= fence.max.x &&
    block.z >= fence.min.z &&
    block.z <= fence.max.z;
  const canExploreThere =
    input.movement.canExplore && across > EXPLORE_BEYOND && (across > dy || !columnInArea);

  let moves: Movement[] = [...found.movements];
  if (target.kind === 'near') {
    // Never into the player's body: a path that ends too close ends a movement or two sooner.
    while (moves.length > 0 && acrossFrom((moves.at(-1) as Movement).to) < PERSONAL_SPACE) {
      moves.pop();
    }
  }
  const reached = found.status === 'reached' && moves.length === found.movements.length;
  if (target.kind === 'near' && target.step === true) {
    // Follow: about a second of the path, then plan again from there (the owner moves).
    let ticks = 0;
    const kept: Movement[] = [];
    for (const m of moves) {
      if (kept.length > 0 && ticks + m.cost > FOLLOW_STEP_TICKS) break;
      ticks += m.cost;
      kept.push(m);
    }
    moves = kept;
  }
  /**
   * How far a feet cell is from the target: across, and up or down too when the target's height
   * is known (a walk down toward a block below gets nearer: seen live, "!goto stone" to stone 9
   * blocks below, the walk that dug half way down was refused as getting no nearer across).
   */
  const away = (c: { x: number; y: number; z: number }): number =>
    goalPoint.y === null
      ? acrossFrom(c)
      : Math.hypot(c.x + 0.5 - goalPoint.x, c.y - goalPoint.y, c.z + 0.5 - goalPoint.z);
  const awayNow =
    goalPoint.y === null
      ? across
      : Math.hypot(feet.x - goalPoint.x, feet.y - goalPoint.y, feet.z - goalPoint.z);
  /** The part of the path within what a MOVE_TO may reach, if it gets nearer; else null. */
  const nearer = (): { x: number; y: number; z: number } | null => {
    const within = [...moves];
    while (within.length > 0 && beyondReach((within.at(-1) as Movement).to)) within.pop();
    const last = within.at(-1)?.to;
    return last !== undefined && away(last) <= awayNow - MIN_GAIN ? last : null;
  };
  const end = moves.at(-1)?.to;
  if (end !== undefined && reached) {
    const why = target.kind === 'near' ? `near (${fmt(goalPoint)})` : `at (${fmt(goalPoint)})`;
    const cut = moves.length < found.movements.length;
    if (!beyondReach(end)) return walk(end, cut ? `on the way ${why}` : why);
    // Beyond what the hazard scan covers for a MOVE_TO: in segments (EXPLORE), else the part
    // of the path within reach.
    if (canExploreThere) return explore();
    const part = nearer();
    if (part !== null) return walk(part, `nearer to (${fmt(goalPoint)})`);
  }
  // Beyond a walk: EXPLORE toward it, in segments (daylight only: the policy refuses it at night).
  if (canExploreThere) return explore();
  // Else as near as a walk gets (the fixed fence, or a target just out of reach).
  const part = nearer();
  if (part !== null) return walk(part, `nearer to (${fmt(goalPoint)})`);
  // No walk gets nearer: an EXPLORE across may still find a way round (a command that then goes
  // back and forth fails: command-travel.ts MAX_VISITS).
  if (input.movement.canExplore && across > EXPLORE_BEYOND) return explore();
  return refused(
    `no walk gets nearer to (${fmt(goalPoint)}) from here (a wall, water, a cliff, or the edge of ` +
      `where I may walk${found.status === 'none' ? `: ${found.reason}` : ''})`.slice(0, 400),
  );
}
