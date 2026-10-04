import { DIG_SETTLE_TICKS } from '../digging.ts';
import {
  FallAccount,
  fallLandingTick,
  GROUND_DRAG,
  GROUND_MOTION_Y,
  jumpLandingTick,
  keyAccel,
  nextMotionY,
  AIR_DRAG,
  SPRINT_JUMP_BOOST,
  SPRINT_SPEED,
  WADE_SPEED,
  WALK_SPEED,
} from './physics.ts';

/**
 * What each movement costs, in game ticks, derived from the physics (physics.ts) and from the
 * waits the client's dig and place routines make: the idea of Baritone's ActionCosts (time
 * from the game's physics, a penalty on top for breaking and placing), worked out anew for
 * this executor. Pure.
 */

/** Ticks per block at the steady speeds: walking 4.633 (20 / 4.317), sprinting 3.564, wading 10.2. */
export const WALK_ONE_BLOCK = 1 / WALK_SPEED;
export const SPRINT_ONE_BLOCK = 1 / SPRINT_SPEED;
export const WADE_ONE_BLOCK = 1 / WADE_SPEED;
/** From a block's centre until the body has left it (0.5, plus half the body's width 0.3). */
export const WALK_OFF_EDGE = 0.8 * WALK_ONE_BLOCK;
/** After a fall, the rest of the way to the centre of the block landed on. */
export const CENTRE_AFTER_FALL = 0.2 * WALK_ONE_BLOCK;
/** A jump lands on a block one higher on its 9th tick... */
export const ASCEND_TICKS = jumpLandingTick(1);
/** ...and back on the same level on its 12th. */
export const LEVEL_JUMP_TICKS = jumpLandingTick(0);
/** Coming to rest at a block's centre and starting again: a move that breaks or places starts at rest. */
export const STOP_START_TICKS = 2;
/**
 * After a dig's finish the client waits for the server's answer (about a tick) and
 * DIG_SETTLE_TICKS quiet ticks before it trusts the block is gone (client/dig-actions.ts).
 */
export const BREAK_VERDICT_TICKS = 1 + DIG_SETTLE_TICKS;
/** After a placement's click: the answer and a quiet 250 ms (client/place-actions.ts). */
export const PLACE_VERDICT_TICKS = 1 + 5;
/** A door or gate's right-click: the server's block update (about a tick), and a little more. */
export const DOOR_CLICK_TICKS = 1 + 3;
/** Where a running jump takes off: about this far past the centre (the body leaves the block at 0.8). */
const TAKE_OFF = 0.6;
/**
 * Climbing out of one-deep water onto the bank one higher, from the water block's centre: about
 * 8 ticks swimming up against the bank, the push up, 8 in the air, then a little to the centre
 * (execute.ts waterExit; the tests compare).
 */
export const WATER_EXIT_TICKS = 18;

/** Penalties on top of the time, in ticks: so going round wins unless breaking or placing is clearly cheaper. */
export interface Penalties {
  /** Per block broken (Baritone's blockBreakAdditionalPenalty is the idea). */
  readonly breakPenalty: number;
  /** Per block placed: throwaway blocks are spent (Baritone's placement penalty is the idea). */
  readonly placePenalty: number;
  /** Per jump (ascend, parkour, pillar): a jump costs hunger and risks more than a step. */
  readonly jumpPenalty: number;
}

export const DEFAULT_PENALTIES: Penalties = { breakPenalty: 4, placePenalty: 20, jumpPenalty: 2 };

/** How far a running jump carries over its 12 ticks (jump tick included), from the steady speed. */
function jumpReach(sprint: boolean): number {
  const v = sprint ? SPRINT_SPEED : WALK_SPEED;
  let m = v * GROUND_DRAG + keyAccel('ground', sprint) + (sprint ? SPRINT_JUMP_BOOST : 0);
  let reach = m;
  let c = m * GROUND_DRAG;
  for (let t = 2; t <= LEVEL_JUMP_TICKS; t++) {
    m = c + keyAccel('air', sprint);
    reach += m;
    c = m * AIR_DRAG;
  }
  return reach;
}

/** A walking jump carries 2.03 blocks, a sprinting one 3.63. */
export const WALK_JUMP_REACH = jumpReach(false);
export const SPRINT_JUMP_REACH = jumpReach(true);

/**
 * A parkour jump over `gap` blocks: the run to the take-off, the jump's 12 ticks, and walking
 * whatever the flight does not cover (from centre to centre is gap + 1).
 */
export function parkourTicks(gap: number, sprint: boolean): number {
  const perBlock = sprint ? SPRINT_ONE_BLOCK : WALK_ONE_BLOCK;
  const reach = sprint ? SPRINT_JUMP_REACH : WALK_JUMP_REACH;
  return (
    TAKE_OFF * perBlock + LEVEL_JUMP_TICKS + Math.max(0, gap + 1 - TAKE_OFF - reach) * perBlock
  );
}

/**
 * Landing in calm one-block-deep water after walking off an edge `height` above its floor: the
 * ticks until the feet are on the floor, and the damage the server deals. The box counts as in
 * water once the feet are below 0.6 above the floor; the server resets the fall distance only
 * for a packet whose previous position was in water, so a fall that skips those 0.6 blocks in
 * one tick lands with all of it (from 4, 12-14, 17, 18 and 20 and more blocks: a hit).
 */
export function waterLanding(height: number): { ticks: number; damage: number } {
  let y = height;
  let vy = GROUND_MOTION_Y;
  const account = new FallAccount();
  for (let t = 1; t <= 200; t++) {
    const wet = y < 0.599;
    let moved = vy;
    const landed = y + vy <= 0;
    if (landed) moved = -y;
    const damage = account.packet(wet, moved, landed);
    if (landed) return { ticks: t, damage };
    y += moved;
    vy = nextMotionY(moved, wet ? 'water' : 'air');
  }
  throw new Error(`internal: no landing in water from ${height}`);
}

/** The highest fall the pathfinder ever considers (into water): the search area is 32 levels at most. */
export const MAX_WATER_FALL = 48;

/** The resolved cost table for one search. */
export interface PathCosts {
  /** One block cardinal on dry ground (sprinting when allowed), and diagonally. */
  readonly walk: number;
  readonly diagonal: number;
  /** One block wading in one-deep water, and diagonally. */
  readonly wade: number;
  readonly wadeDiagonal: number;
  readonly ascend: number;
  /** Out of one-deep water onto a bank one higher. */
  readonly waterExit: number;
  /** A fall onto dry ground, by height (index 1 is a descend); Infinity where not allowed. */
  readonly fall: readonly number[];
  /** A fall into calm one-deep water, by height; Infinity where the landing hurts. */
  readonly waterFall: readonly number[];
  /** A parkour jump, by gap (1..3); Infinity where not allowed. */
  readonly parkour: readonly number[];
  readonly parkourSprint: readonly boolean[];
  readonly pillar: number;
  readonly bridge: number;
  /** Digging down, without the dig's own ticks. */
  readonly downward: number;
  /** On top of a block's dig ticks: the verdict and the penalty. */
  readonly breakExtra: number;
  /** Once per move that breaks: coming to rest first. */
  readonly breakStart: number;
  /**
   * On top of a walk into a doorway it opens (or closes) to pass: coming to rest, the click,
   * and the one after it that leaves the door as it was.
   */
  readonly door: number;
}

export interface CostOptions extends Penalties {
  readonly sprint: boolean;
  readonly parkour: boolean;
  readonly maxFall: number;
  readonly water: boolean;
}

export function pathCosts(o: CostOptions): PathCosts {
  const walk = o.sprint ? SPRINT_ONE_BLOCK : WALK_ONE_BLOCK;
  const fall: number[] = [Infinity];
  for (let h = 1; h <= 3; h++) {
    fall.push(h <= o.maxFall ? WALK_OFF_EDGE + fallLandingTick(h) + CENTRE_AFTER_FALL : Infinity);
  }
  const waterFall: number[] = [Infinity];
  for (let h = 1; h <= MAX_WATER_FALL; h++) {
    const landing = waterLanding(h);
    waterFall.push(
      o.water && landing.damage === 0
        ? WALK_OFF_EDGE + landing.ticks + 0.2 * WADE_ONE_BLOCK
        : Infinity,
    );
  }
  const parkour: number[] = [Infinity];
  const parkourSprint: boolean[] = [false];
  for (let gap = 1; gap <= 3; gap++) {
    // A walking jump clears two blocks, a sprinting one three (physics.ts; tested).
    const sprint = o.sprint;
    const allowed = o.parkour && (gap <= 2 || sprint);
    parkour.push(allowed ? parkourTicks(gap, sprint) + o.jumpPenalty : Infinity);
    parkourSprint.push(sprint);
  }
  return {
    walk,
    diagonal: walk * Math.SQRT2,
    wade: WADE_ONE_BLOCK,
    wadeDiagonal: WADE_ONE_BLOCK * Math.SQRT2,
    ascend: ASCEND_TICKS + 1 + o.jumpPenalty,
    waterExit: WATER_EXIT_TICKS + o.jumpPenalty,
    fall,
    waterFall,
    parkour,
    parkourSprint,
    pillar: STOP_START_TICKS + ASCEND_TICKS + o.jumpPenalty + o.placePenalty,
    bridge: WALK_ONE_BLOCK + STOP_START_TICKS + PLACE_VERDICT_TICKS + o.placePenalty,
    downward: STOP_START_TICKS + BREAK_VERDICT_TICKS + fallLandingTick(1) + o.breakPenalty,
    breakExtra: BREAK_VERDICT_TICKS + o.breakPenalty,
    breakStart: STOP_START_TICKS,
    door: 2 * STOP_START_TICKS + 2 * DOOR_CLICK_TICKS,
  };
}

/**
 * The cheapest cost per block of each kind of progress, over every movement allowed: per block
 * across (on the grid: diagonal steps count √2), per block up and per block down. A movement
 * costs at least rate x its progress of each kind, so a heuristic built from them never
 * overestimates (admissible) and never drops by more than a movement costs (consistent).
 */
export interface HeuristicRates {
  readonly across: number;
  readonly up: number;
  readonly down: number;
}

export function heuristicRates(
  c: PathCosts,
  o: { pillar: boolean; downward: boolean; minDigTicks: number },
): HeuristicRates {
  let across = Math.min(c.walk, c.diagonal / Math.SQRT2, c.wade, c.bridge);
  for (let gap = 1; gap < c.parkour.length; gap++) {
    across = Math.min(across, (c.parkour[gap] as number) / (gap + 1));
  }
  // Ascend, descend and falls move one block across too.
  across = Math.min(across, c.ascend, c.waterExit);
  let up = Math.min(c.ascend, c.waterExit);
  if (o.pillar) up = Math.min(up, c.pillar);
  let down = Infinity;
  for (let h = 1; h < c.fall.length; h++) down = Math.min(down, (c.fall[h] as number) / h);
  for (let h = 1; h < c.waterFall.length; h++) {
    down = Math.min(down, (c.waterFall[h] as number) / h);
  }
  if (o.downward) down = Math.min(down, c.downward + o.minDigTicks);
  // Descends and falls (dry or into water) move one block across too.
  for (let h = 1; h < c.fall.length; h++) across = Math.min(across, c.fall[h] as number);
  for (let h = 1; h < c.waterFall.length; h++) across = Math.min(across, c.waterFall[h] as number);
  return { across, up, down: Number.isFinite(down) ? down : 0 };
}
