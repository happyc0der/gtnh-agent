import type { Cell } from '../terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../walking.ts';
import { CELL, CellCache, changedWorld, type BlockChange, type CellBox } from './cells.ts';
import { LEVEL_JUMP_TICKS } from './costs.ts';
import type { BlockBreak, Movement } from './movements.ts';
import {
  AIR_DRAG,
  blocksX,
  blocksZ,
  clipX,
  clipZ,
  freeOfBlocksAndLiquid,
  GROUND_DRAG,
  GROUND_MOTION_Y,
  HALF_WIDTH,
  HEIGHT,
  horizontalDrag,
  inWater,
  JUMP_VELOCITY,
  jumpLandingTick,
  keyAccel,
  moveY,
  nextMotionY,
  overlappedCells,
  SPRINT_JUMP_BOOST,
  SPRINT_SPEED,
  SWIM_UP,
  WADE_SPEED,
  WALK_SPEED,
  WATER_DRAG,
  WATER_GRAVITY,
  WATER_POP,
  type MoveMode,
} from './physics.ts';

/**
 * Execution plans: for each movement of a path, the per-tick steps a client sends (feet
 * position, onGround, sprinting, jumping) and the actions at the right ticks (blocks to break
 * before it, a block to place right after a given step). The steps come from vanilla's
 * physics (physics.ts) tick by tick: the vertical motion is the game's own (a jump's 0.42 and
 * gravity, a fall landing exactly on the block top, a block over the head cutting a jump
 * short), and each tick's horizontal displacement is one the game's controls can make from
 * the motion carried over (|change| <= what the keys add on the ground, in the air or in
 * water, after the drag), so walking reaches 0.216 blocks per tick, a jump carries only as far
 * as a real one, and turns slow down. No step ever moves the box into a block (no collision
 * at all, so the server's own move from the last position lands exactly where the client says)
 * or into a cell that is not passable or is next to a hazard. Pure.
 *
 * How the movements are driven (each from the centre of its start block, along the line to
 * its end block's centre):
 *  - walking and wading: as fast as allowed, braking in time to reach a turn exactly at the
 *    block centre at a speed from which the new direction can be taken (or to stop there);
 *    straight runs flow on from one movement into the next;
 *  - ascend: jump from the start block's centre, keeping off the step until the feet are
 *    above it, landing on it near its centre;
 *  - descend and fall: walk off the edge, then steer during the fall to land inside the column
 *    (never back over the start block, never past the landing block);
 *  - parkour: run up and jump from the last tick still on the start block, as fast as allowed
 *    until the landing is sure, then steer to land near the centre;
 *  - pillar: jump straight up from rest and place the block in the cell the feet just left,
 *    once they are above it; land on it;
 *  - bridge: walk to 0.6 past the centre (the eyes beyond the edge, seeing the side of the block
 *    underfoot), stop, place against that side, wait for the server, walk on;
 *  - downward: the dig (before the steps), then the fall into the hole.
 * A movement that breaks blocks, pillars or digs down starts at rest (the one before it stops
 * at its end). If a movement cannot be driven from the way the one before ends, the plan is
 * made again with the one before stopping, so the movement starts from rest.
 */

/** One tick: what the client sends. */
export interface PathStep {
  /** Feet position at the end of the tick. */
  readonly pos: Vec3;
  readonly onGround: boolean;
  /** Sprinting this tick (the client sends START_SPRINTING when this turns on, STOP when off). */
  readonly sprint: boolean;
  /** Holding jump: a jump off the ground, or swimming up in water. */
  readonly jump: boolean;
  /**
   * The keys pushed the box against a block this tick (it stopped touching that block's face),
   * along x and/or z (-1 or 1): only climbing out of water does that (the push up a bank).
   */
  readonly bump?: { readonly x: number; readonly z: number };
}

/** A block placed during a segment. */
export interface StepPlace {
  /** Where the block goes. */
  readonly cell: Cell;
  /** The block clicked, and its face (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east). */
  readonly against: Cell;
  readonly face: number;
  /** C08's cursor on that face, in sixteenths. */
  readonly cursor: Vec3;
  /** The registry name of the block placed. */
  readonly block: string;
  /** Send the click right after this step's position (an index into the segment's steps). */
  readonly afterStep: number;
  /** The first step that needs the block (stands on it): the server must have confirmed it before. */
  readonly neededBy: number;
}

/** One movement's part of the plan (or, first, centring on the start block). */
export interface Segment {
  /** The movement; null for centring on the start block. */
  readonly movement: Movement | null;
  /** Where the player is when the segment begins: it digs the breaks from here. */
  readonly start: Vec3;
  /** Broken before the first step, standing still, upper blocks first. */
  readonly breaks: readonly BlockBreak[];
  readonly steps: readonly PathStep[];
  readonly places: readonly StepPlace[];
  /**
   * Pillar: when the server has not confirmed the block before step `fromStep` (the landing on
   * it) is due, send these instead of steps[fromStep..]: the jump comes back down where it
   * began. (Up to there the steps are the same either way.)
   */
  readonly fallback: { readonly fromStep: number; readonly steps: readonly PathStep[] } | null;
}

export type ExecutionPlan =
  | {
      readonly ok: true;
      readonly segments: readonly Segment[];
      /** Steps in all. */
      readonly ticks: number;
      readonly end: Vec3;
    }
  | { readonly ok: false; readonly reason: string; readonly movement: number };

export interface ExecutionOptions {
  /** Cells of calm one-deep water may hold the body (the path's movements wade). */
  readonly water?: boolean;
}

/** The box (and its motion) at the end of a tick. */
export interface Body {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Horizontal motion carried into the next tick (after this tick's drag). */
  readonly cx: number;
  readonly cz: number;
  /** motionY the next tick moves by, unless it jumps. */
  readonly vy: number;
  readonly onGround: boolean;
}

/** A player standing still on the ground at `p`. */
export function restingBody(p: Vec3): Body {
  return { x: p.x, y: p.y, z: p.z, cx: 0, cz: 0, vy: GROUND_MOTION_Y, onGround: true };
}

/** What a tick starts as: in water, on the ground, or in the air (physics.ts). */
export function modeOf(world: CellCache, b: Body): MoveMode {
  if (inWater(world, b.x, b.y, b.z)) return 'water';
  return b.onGround ? 'ground' : 'air';
}

/**
 * One tick of vanilla movement with the horizontal displacement (mx, mz) chosen: the Y move
 * first (stopped by blocks, which sets onGround when going down), then X, then Z. Null when
 * the X or Z move would hit a block.
 */
export function physicsTick(
  world: CellCache,
  b: Body,
  mx: number,
  mz: number,
  jump: boolean,
): Body | null {
  const mode = modeOf(world, b);
  const vy = jump ? JUMP_VELOCITY : b.vy;
  const moved = moveY(world, b.x, b.y, b.z, vy);
  const clipped = moved !== vy;
  const down = clipped && vy < 0;
  const y = down ? Math.round(b.y + moved) : b.y + moved;
  if (blocksX(world, b.x, y, b.z, mx)) return null;
  const x = b.x + mx;
  if (blocksZ(world, x, y, b.z, mz)) return null;
  const drag = horizontalDrag(mode);
  return {
    x,
    y,
    z: b.z + mz,
    cx: mx * drag,
    cz: mz * drag,
    vy: nextMotionY(clipped ? 0 : vy, mode),
    onGround: down,
  };
}

/** The box stays this far from the edges where support or overlap changes. */
const EDGE_MARGIN = 0.01;
/** A straight run hands over to the next movement this close to the shared block centre. */
const FLOW_HANDOFF = 0.1;
/** A run is at its end this close to it. */
const ARRIVED = 1e-7;
/** A bridge is placed standing this far past the centre: the eyes beyond the block's edge. */
const BRIDGE_EDGE = 0.6;

/** The faces' centres (C08's cursor), in sixteenths. */
const FACE_CENTRES: readonly Vec3[] = [
  { x: 8, y: 0, z: 8 },
  { x: 8, y: 16, z: 8 },
  { x: 8, y: 8, z: 0 },
  { x: 8, y: 8, z: 16 },
  { x: 0, y: 8, z: 8 },
  { x: 16, y: 8, z: 8 },
];

/** How a run ends: flowing on into the next movement, exactly at the centre at most this fast, or stopped there. */
type Exit = { kind: 'flow' } | { kind: 'exact'; v: number } | { kind: 'stop' };

interface RunParams {
  /** Speed cap, blocks per tick. */
  readonly vmax: number;
  readonly sprint: boolean;
  /** For braking: what a key takes off per tick, and the drag. */
  readonly brake: number;
  readonly drag: number;
}

const WALK_RUN: RunParams = {
  vmax: WALK_SPEED,
  sprint: false,
  brake: keyAccel('ground', false),
  drag: GROUND_DRAG,
};
const SPRINT_RUN: RunParams = { ...WALK_RUN, vmax: SPRINT_SPEED, sprint: true };
const WADE_RUN: RunParams = {
  vmax: WADE_SPEED,
  sprint: false,
  brake: keyAccel('water', false),
  drag: WATER_DRAG,
};

/** The fastest last step of a stop: the next tick's keys can then cancel what is carried over. */
const stopSpeed = (p: RunParams): number => (0.97 * p.brake) / p.drag;

/** A movement's line: from its start block's centre along the unit (ux, uz). */
interface Line {
  readonly ox: number;
  readonly oz: number;
  readonly ux: number;
  readonly uz: number;
}

function lineOf(m: Movement): Line {
  const len = Math.hypot(m.dir.x, m.dir.z);
  return { ox: m.from.x + 0.5, oz: m.from.z + 0.5, ux: m.dir.x / len, uz: m.dir.z / len };
}

/** A block's centre across (where a movement ends). */
function centreOf(c: Cell): { x: number; z: number } {
  return { x: c.x + 0.5, z: c.z + 0.5 };
}

/** The run's end along its line: the end block's centre. */
function lengthOf(m: Movement): number {
  return Math.hypot(m.to.x - m.from.x, m.to.z - m.from.z);
}

/** Starts at rest: breaks first, or a vertical movement. */
function needsRest(m: Movement): boolean {
  return m.breaks.length > 0 || m.kind === 'pillar' || m.kind === 'downward';
}

/**
 * The fastest a run may reach a corner from direction u1 and leave it in direction u2, when
 * the next tick's keys must turn the carried motion: |v u2 - drag v u1| <= what a key adds,
 * for either drag the last tick may have had (ground or water).
 */
function cornerSpeed(u1: Line, u2: Line, wet: boolean, vmax: number): number {
  const a = keyAccel(wet ? 'water' : 'ground', false);
  let v = vmax;
  for (const drag of wet ? [GROUND_DRAG, WATER_DRAG] : [GROUND_DRAG]) {
    const k = Math.hypot(u2.ux - drag * u1.ux, u2.uz - drag * u1.uz);
    v = Math.min(v, (0.97 * a) / k);
  }
  return v;
}

/** The distance still covered braking as hard as possible from displacement d until one is at most vEnd. */
function brakingDistance(d: number, vEnd: number, p: RunParams): number {
  let b = d;
  let total = 0;
  for (let k = 0; k < 200; k++) {
    b = Math.max(0, p.drag * b - p.brake);
    total += b;
    if (b <= vEnd) return total;
  }
  return Infinity;
}

/** The distance still covered over `ticks` air ticks braking as hard as possible after displacement d. */
function airBrakingDistance(d: number, ticks: number): number {
  const brake = keyAccel('air', false);
  let b = d;
  let total = 0;
  for (let k = 0; k < ticks; k++) {
    b = Math.max(0, AIR_DRAG * b - brake);
    total += b;
  }
  return total;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

class Fail extends Error {}

/** Builds the steps, tick by tick, over the world as the path changes it. */
class StepBuilder {
  readonly #world: WalkWorld;
  readonly #box: CellBox;
  readonly #fence: Fence;
  readonly #water: boolean;
  readonly #changes: BlockChange[] = [];
  view: CellCache;
  body: Body;
  readonly steps: PathStep[] = [];

  constructor(world: WalkWorld, box: CellBox, fence: Fence, water: boolean, from: Vec3) {
    this.#world = world;
    this.#box = box;
    this.#fence = fence;
    this.#water = water;
    this.view = new CellCache(world, box);
    this.body = restingBody(from);
  }

  change(c: BlockChange): void {
    this.#changes.push(c);
    this.view = new CellCache(changedWorld(this.#world, this.#changes), this.#box);
  }

  mark(): { body: Body; steps: number } {
    return { body: this.body, steps: this.steps.length };
  }

  restore(m: { body: Body; steps: number }): void {
    this.body = m.body;
    this.steps.length = m.steps;
  }

  /** Along the line from its origin. */
  s(l: Line): number {
    return (this.body.x - l.ox) * l.ux + (this.body.z - l.oz) * l.uz;
  }

  /**
   * The displacements along `l` this tick can make: [lo, hi] (lo braking with one key, hi
   * going with one key, sprinting when asked), and the motion carried along it. Null when the
   * carried motion has more sideways than a key can take off.
   */
  bounds(l: Line, sprint: boolean, jump: boolean): { lo: number; hi: number; par: number } {
    const b = this.body;
    const mode = modeOf(this.view, b);
    let cx = b.cx;
    let cz = b.cz;
    if (jump && sprint) {
      cx += SPRINT_JUMP_BOOST * l.ux;
      cz += SPRINT_JUMP_BOOST * l.uz;
    }
    const par = cx * l.ux + cz * l.uz;
    const perp = Math.abs(cx * l.uz - cz * l.ux);
    const brake = keyAccel(mode, false);
    const go = keyAccel(mode, sprint);
    if (perp > brake) throw new Fail('the motion carried sideways is more than a key can take off');
    return {
      lo: par - Math.sqrt(brake * brake - perp * perp),
      hi: par + Math.sqrt(go * go - perp * perp),
      par,
    };
  }

  /** One tick with displacement d along `l`: physics, then the safety of every cell the box touches. */
  tick(l: Line, d: number, jump: boolean, sprint: boolean): void {
    const next = physicsTick(this.view, this.body, d * l.ux, d * l.uz, jump);
    if (next === null) throw new Fail('a step would run into a block');
    const problem = this.unsafe(this.body, next);
    if (problem !== null) throw new Fail(problem);
    this.body = next;
    this.steps.push({
      pos: { x: next.x, y: next.y, z: next.z },
      onGround: next.onGround,
      sprint,
      jump,
    });
  }

  /**
   * Standing still for a tick (the carried motion is taken off), on `at` when given: a run that
   * stops short of its end by a hair (it brakes with a hair to spare) comes to rest exactly on
   * the block's centre, where a walk is said to end.
   */
  hold(at?: { readonly x: number; readonly z: number }): void {
    const b = this.body;
    const mode = modeOf(this.view, b);
    if (Math.hypot(b.cx, b.cz) > keyAccel(mode, false) + 1e-12) {
      throw new Fail('moving too fast to stop');
    }
    const mx = at === undefined ? 0 : at.x - b.x;
    const mz = at === undefined ? 0 : at.z - b.z;
    if (Math.hypot(mx, mz) > 1e-6) throw new Fail('internal: standing still would move');
    const moved = physicsTick(this.view, b, mx, mz, false);
    if (moved === null || !moved.onGround) throw new Fail('cannot stand still here');
    const next = at === undefined ? moved : { ...moved, x: at.x, z: at.z };
    this.body = next;
    this.steps.push({
      pos: { x: next.x, y: next.y, z: next.z },
      onGround: true,
      sprint: false,
      jump: false,
    });
  }

  /**
   * One tick exactly as a vanilla client runs it with one key held toward `l` (and, in water,
   * jump held: swimming up): the keys' acceleration added to the carried motion, the Y, X and Z
   * moves stopped by blocks (a stopped axis loses its motion), the drag, and in water the push
   * up a block the box is pressed against when the space 0.6 higher is free of blocks and
   * water (EntityLivingBase.moveEntityWithHeading). Used to climb out of water, where the box
   * must press against the bank: the only steps that touch a block.
   */
  vanillaTick(l: Line, swim: boolean): void {
    const b = this.body;
    const v = this.view;
    const mode = modeOf(v, b);
    const a = keyAccel(mode, false);
    const rx = b.cx + a * l.ux;
    const rz = b.cz + a * l.uz;
    let vy = b.vy;
    if (swim && mode === 'water') vy += SWIM_UP;
    const moved = moveY(v, b.x, b.y, b.z, vy);
    const clippedY = moved !== vy;
    const down = clippedY && vy < 0;
    const y = down ? Math.round(b.y + moved) : b.y + moved;
    const dx = clipX(v, b.x, y, b.z, rx);
    const x = b.x + dx;
    const dz = clipZ(v, x, y, b.z, rz);
    const z = b.z + dz;
    let mx = dx === rx ? rx : 0;
    let mz = dz === rz ? rz : 0;
    let my = clippedY ? 0 : vy;
    if (mode === 'water') {
      mx *= WATER_DRAG;
      mz *= WATER_DRAG;
      my = my * WATER_DRAG - WATER_GRAVITY;
      const pushed = dx !== rx || dz !== rz;
      if (pushed && freeOfBlocksAndLiquid(v, x, y, z, mx, my + 0.6 - (y - b.y), mz)) {
        my = WATER_POP;
      }
    } else {
      const drag = horizontalDrag(mode);
      mx *= drag;
      mz *= drag;
      my = nextMotionY(my, mode);
    }
    const next: Body = { x, y, z, cx: mx, cz: mz, vy: my, onGround: down };
    const problem = this.unsafe(b, next);
    if (problem !== null) throw new Fail(problem);
    this.body = next;
    const step: PathStep = {
      pos: { x, y, z },
      onGround: down,
      sprint: false,
      jump: swim && mode === 'water',
    };
    const bx = dx === rx ? 0 : Math.sign(rx);
    const bz = dz === rz ? 0 : Math.sign(rz);
    this.steps.push(bx === 0 && bz === 0 ? step : { ...step, bump: { x: bx, z: bz } });
  }

  /**
   * Why the box going from `a` to `b` would touch a cell it must not (not passable, or
   * next to a hazard, or outside the fence), or null. The Y move's sweep (at a's x and z) and
   * the end are checked; the X and Z moves are shorter than the box, so their sweeps lie
   * within the ends'.
   */
  unsafe(a: Body, b: Body): string | null {
    const f = this.#fence;
    const h = HALF_WIDTH;
    if (
      b.x - h < f.min.x - 1e-9 ||
      b.x + h > f.max.x + 1 + 1e-9 ||
      b.z - h < f.min.z - 1e-9 ||
      b.z + h > f.max.z + 1 + 1e-9 ||
      b.y < f.min.y - 1e-9 ||
      b.y > f.max.y + 1 + 1e-9
    ) {
      return 'a step would leave the search area';
    }
    const v = this.view;
    if (v.has(Math.floor(b.x), Math.floor(b.y + 1e-9), Math.floor(b.z), CELL.LADDER)) {
      return 'the feet would be in a vine (a game client climbs it)';
    }
    const low = Math.min(a.y, b.y);
    const high = Math.max(a.y, b.y);
    for (const [px, py0, py1, pz] of [
      [a.x, low, high, a.z],
      [b.x, b.y, b.y, b.z],
    ] as const) {
      const [x0, x1, , , z0, z1] = overlappedCells(px, py0, pz);
      const y0 = Math.floor(py0 + 1e-7);
      const y1 = Math.ceil(py1 + HEIGHT - 1e-7) - 1;
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) {
            const flags = v.flags(x, y, z);
            if ((flags & CELL.PASSABLE) === 0 && !(this.#water && v.calmWater(x, y, z))) {
              return `a step would put the body in the block at (${x}, ${y}, ${z})`;
            }
            if (v.nearHazard(x, y, z))
              return `a step would pass next to a hazard at (${x}, ${y}, ${z})`;
          }
        }
      }
    }
    return null;
  }

  /**
   * Runs along `l` to `sEnd`: exactly there (its last displacement at most the exit's speed,
   * then a tick standing still for a stop), or until within FLOW_HANDOFF of it. As fast as
   * allowed, braking just in time (each tick keeps the rest of the way at least the braking
   * distance). Stays on the ground at its level.
   */
  run(
    l: Line,
    sEnd: number,
    exit: Exit,
    p: RunParams,
    end?: { readonly x: number; readonly z: number },
  ): void {
    const level = this.body.y;
    const vEnd = exit.kind === 'exact' ? exit.v : exit.kind === 'stop' ? stopSpeed(p) : Infinity;
    for (let guard = 0; guard < 4000; guard++) {
      const r = sEnd - this.s(l);
      if (exit.kind === 'flow' && r <= FLOW_HANDOFF) return;
      if (exit.kind !== 'flow' && Math.abs(r) <= ARRIVED) {
        // There, and slow enough for what comes next (a landing may arrive too fast).
        if (Math.hypot(this.body.cx, this.body.cz) <= p.drag * vEnd + 1e-9) {
          if (exit.kind === 'stop') this.hold(end);
          return;
        }
        this.#reverse(l, sEnd, p, end);
        return;
      }
      if (r < 0) {
        this.#reverse(l, sEnd, p, end);
        return;
      }
      const bnd = this.bounds(l, p.sprint, false);
      if (bnd.hi < 0) throw new Fail('moving backwards along a run');
      const lo = Math.max(bnd.lo, 0);
      let hi = Math.min(bnd.hi, p.vmax);
      if (hi < lo) hi = lo;
      let d: number;
      if (exit.kind !== 'flow' && r >= lo - ARRIVED && r <= hi + ARRIVED && r <= vEnd) {
        d = clamp(r, bnd.lo, bnd.hi);
      } else if (exit.kind === 'flow') {
        d = hi;
      } else {
        // The largest step after which braking still stops in time (with a hair to spare).
        const fits = (x: number): boolean =>
          r - x >= brakingDistance(x, vEnd, p) + 1e-9 && (x <= vEnd || r - x > 1e-9);
        if (!fits(lo)) throw new Fail('cannot stop in time');
        d = Math.min(hi, r);
        if (!fits(d)) {
          let a = lo;
          let b = d;
          for (let k = 0; k < 50; k++) {
            const mid = (a + b) / 2;
            if (fits(mid)) a = mid;
            else b = mid;
          }
          d = a;
        }
      }
      this.tick(l, d, false, p.sprint && d > bnd.par + 1e-12);
      if (!this.body.onGround || Math.abs(this.body.y - level) > 1e-9) {
        throw new Fail('a run left the ground');
      }
    }
    throw new Fail('a run did not end');
  }

  /** Past the end of a run (after a landing): brake to rest, then come back to it and stop. */
  #reverse(
    l: Line,
    sEnd: number,
    p: RunParams,
    end?: { readonly x: number; readonly z: number },
  ): void {
    for (let guard = 0; guard < 100; guard++) {
      const bnd = this.bounds(l, false, false);
      if (bnd.lo <= 0 && bnd.hi >= 0) break;
      this.tick(l, Math.max(bnd.lo, 0), false, false);
    }
    this.hold();
    const back: Line = { ox: l.ox, oz: l.oz, ux: -l.ux, uz: -l.uz };
    this.run(back, -sEnd, { kind: 'stop' }, p, end);
  }

  /** Ticks the vertical alone (no move across) from the current state until it lands, counting them. */
  ticksToLand(atX: number, atZ: number): number {
    let b: Body = { ...this.body, x: atX, z: atZ };
    for (let t = 1; t <= 200; t++) {
      const next = physicsTick(this.view, b, 0, 0, false);
      if (next === null) return t;
      if (next.onGround) return t;
      b = next;
    }
    return 200;
  }
}

/** The way the run of `cur` must end, given the movement after it. */
function exitFor(
  b: StepBuilder,
  cur: Line,
  curParams: RunParams,
  next: Movement | undefined,
  restNext: boolean,
): Exit {
  if (next === undefined || restNext || needsRest(next)) return { kind: 'stop' };
  const u2 = lineOf(next);
  const same = Math.abs(cur.ux - u2.ux) < 1e-9 && Math.abs(cur.uz - u2.uz) < 1e-9;
  if (same) {
    if (next.kind === 'ascend') return { kind: 'exact', v: curParams.vmax };
    return { kind: 'flow' };
  }
  const wet = b.view.has(next.from.x, next.from.y, next.from.z, CELL.WATER);
  return { kind: 'exact', v: cornerSpeed(cur, u2, wet, curParams.vmax) };
}

function paramsFor(m: Movement, wet: boolean): RunParams {
  if (wet) return WADE_RUN;
  return m.sprint ? SPRINT_RUN : WALK_RUN;
}

/**
 * Builds the execution plan of `movements` (a path from planPath), for a player at rest at
 * `from`. `area` is the search area (the fence): no step leaves it.
 */
export function planExecution(
  world: WalkWorld,
  area: Fence,
  from: Vec3,
  movements: readonly Movement[],
  options: ExecutionOptions = {},
): ExecutionPlan {
  const restBefore = new Set<number>();
  for (let attempt = 0; attempt <= movements.length; attempt++) {
    const r = build(world, area, from, movements, options.water ?? false, restBefore);
    if (r.ok) return r;
    // Drive the failing movement from rest: the one before it stops at its end.
    if (r.movement < 0 || restBefore.has(r.movement)) return r;
    restBefore.add(r.movement);
  }
  return { ok: false, reason: 'internal: too many attempts', movement: -1 };
}

function boxAround(area: Fence, from: Vec3, movements: readonly Movement[]): CellBox {
  let x0 = Math.floor(from.x);
  let x1 = x0;
  let z0 = Math.floor(from.z);
  let z1 = z0;
  for (const m of movements) {
    x0 = Math.min(x0, m.from.x, m.to.x);
    x1 = Math.max(x1, m.from.x, m.to.x);
    z0 = Math.min(z0, m.from.z, m.to.z);
    z1 = Math.max(z1, m.from.z, m.to.z);
  }
  return {
    min: { x: x0 - 3, y: area.min.y - 3, z: z0 - 3 },
    max: { x: x1 + 3, y: area.max.y + 5, z: z1 + 3 },
  };
}

function build(
  world: WalkWorld,
  area: Fence,
  from: Vec3,
  movements: readonly Movement[],
  water: boolean,
  restBefore: ReadonlySet<number>,
): ExecutionPlan {
  const b = new StepBuilder(world, boxAround(area, from, movements), area, water, from);
  const segments: Segment[] = [];
  let index = -1;
  try {
    // Centre on the start block.
    const first = movements[0];
    const startCell = first?.from ?? {
      x: Math.floor(from.x),
      y: Math.round(from.y),
      z: Math.floor(from.z),
    };
    const cx = startCell.x + 0.5;
    const cz = startCell.z + 0.5;
    const dist = Math.hypot(cx - from.x, cz - from.z);
    const startWet = b.view.has(startCell.x, startCell.y, startCell.z, CELL.WATER);
    if (dist > 1e-9) {
      const l: Line = {
        ox: from.x,
        oz: from.z,
        ux: (cx - from.x) / dist,
        uz: (cz - from.z) / dist,
      };
      const p = startWet ? WADE_RUN : WALK_RUN;
      const exit: Exit =
        first === undefined || needsRest(first) || restBefore.has(0)
          ? { kind: 'stop' }
          : { kind: 'exact', v: cornerSpeed(l, lineOf(first), startWet, p.vmax) };
      b.run(l, dist, exit, p, { x: cx, z: cz });
      if (Math.hypot(b.body.x - cx, b.body.z - cz) > 1e-6) {
        throw new Fail('centring missed the centre');
      }
    }
    segments.push({
      movement: null,
      start: from,
      breaks: [],
      steps: b.steps.splice(0),
      places: [],
      fallback: null,
    });

    for (index = 0; index < movements.length; index++) {
      const m = movements[index] as Movement;
      const next = movements[index + 1];
      const start: Vec3 = { x: b.body.x, y: b.body.y, z: b.body.z };
      for (const brk of m.breaks) b.change({ cell: brk.cell, block: null });
      const out = drive(b, m, next, restBefore.has(index + 1));
      segments.push({
        movement: m,
        start,
        breaks: m.breaks,
        steps: b.steps.splice(0),
        places: out.places,
        fallback: out.fallback,
      });
    }
  } catch (e) {
    if (e instanceof Fail) {
      const what =
        index < 0
          ? 'centring on the start block'
          : `movement ${index + 1} (${movements[index]?.kind ?? '?'})`;
      return { ok: false, reason: `${what}: ${e.message}`, movement: index };
    }
    throw e;
  }
  return {
    ok: true,
    segments,
    ticks: segments.reduce((n, s) => n + s.steps.length, 0),
    end: { x: b.body.x, y: b.body.y, z: b.body.z },
  };
}

/** Drives one movement; its run ends as the next movement needs. */
function drive(
  b: StepBuilder,
  m: Movement,
  next: Movement | undefined,
  restNext: boolean,
): { places: StepPlace[]; fallback: Segment['fallback'] } {
  if (m.kind === 'pillar' || m.kind === 'downward') {
    // Both start at rest at the centre of the start block (the movement before stopped).
    const body = b.body;
    if (
      Math.hypot(body.x - (m.from.x + 0.5), body.z - (m.from.z + 0.5)) > 1e-6 ||
      Math.hypot(body.cx, body.cz) > 1e-9
    ) {
      throw new Fail('not at rest at the start block centre');
    }
    if (m.kind === 'pillar') return pillar(b, m);
    land(b, m.to.y);
    return { places: [], fallback: null };
  }
  const l = lineOf(m);
  const end = lengthOf(m);
  // A movement that starts at rest begins exactly at its start block's centre.
  if (needsRest(m) && Math.hypot(b.body.x - l.ox, b.body.z - l.oz) > 1e-6) {
    throw new Fail('not at the start block centre');
  }
  const wetEnd = b.view.has(m.to.x, m.to.y, m.to.z, CELL.WATER);
  const after = paramsFor(m, m.water && (wetEnd || m.kind !== 'fall'));
  const exit = exitFor(b, l, after, next, restNext);
  switch (m.kind) {
    case 'traverse':
    case 'diagonal':
      b.run(l, end, exit, after, centreOf(m.to));
      return { places: [], fallback: null };
    case 'bridge':
      return bridge(b, m, l, exit);
    case 'ascend':
      if (b.view.has(m.from.x, m.from.y, m.from.z, CELL.WATER)) waterExit(b, m, l, exit);
      else ascend(b, m, l, exit);
      return { places: [], fallback: null };
    case 'descend':
    case 'fall':
      fall(b, m, l, exit, after);
      return { places: [], fallback: null };
    case 'parkour':
      parkour(b, m, l, exit);
      return { places: [], fallback: null };
  }
}

function placeOf(m: Movement, afterStep: number, neededBy: number): StepPlace {
  const p = m.place;
  if (p === null) throw new Fail('internal: no block to place');
  return {
    cell: p.cell,
    against: p.against,
    face: p.face,
    cursor: FACE_CENTRES[p.face] as Vec3,
    block: p.block,
    afterStep,
    neededBy,
  };
}

/** Walk to the edge, stop, place against the side of the block underfoot, walk on. */
function bridge(
  b: StepBuilder,
  m: Movement,
  l: Line,
  exit: Exit,
): { places: StepPlace[]; fallback: null } {
  b.run(l, BRIDGE_EDGE, { kind: 'stop' }, WALK_RUN);
  const afterStep = b.steps.length - 1;
  const place = m.place;
  if (place === null) throw new Fail('internal: a bridge with nothing to place');
  b.change({ cell: place.cell, block: place.block });
  b.run(l, lengthOf(m), exit, WALK_RUN, centreOf(m.to));
  return { places: [placeOf(m, afterStep, afterStep + 1)], fallback: null };
}

/** Lets the body fall (no move across) until it lands at `y`. */
function land(b: StepBuilder, y: number): void {
  const l: Line = { ox: b.body.x, oz: b.body.z, ux: 1, uz: 0 };
  for (let t = 0; t < 200; t++) {
    b.tick(l, 0, false, false);
    if (b.body.onGround) break;
  }
  if (!b.body.onGround || Math.abs(b.body.y - y) > 1e-9) throw new Fail(`did not land at y=${y}`);
}

/**
 * Pillar: from rest, jump straight up; once the feet are above the cell they left, place the
 * block there; land on it. The fallback: the same jump without the block, landing where it
 * began.
 */
function pillar(
  b: StepBuilder,
  m: Movement,
): { places: StepPlace[]; fallback: Segment['fallback'] } {
  const place = m.place;
  if (place === null) throw new Fail('internal: a pillar with nothing to place');
  const l: Line = { ox: b.body.x, oz: b.body.z, ux: 1, uz: 0 };
  const y0 = m.from.y;
  b.tick(l, 0, true, false);
  let afterStep = -1;
  let before: { body: Body; view: CellCache } | null = null;
  for (let t = 0; t < 60 && !b.body.onGround; t++) {
    if (afterStep < 0 && b.body.y >= y0 + 1 - 1e-9) {
      afterStep = b.steps.length - 1;
      before = { body: b.body, view: b.view };
      b.change({ cell: place.cell, block: place.block });
    }
    b.tick(l, 0, false, false);
  }
  if (
    afterStep < 0 ||
    before === null ||
    !b.body.onGround ||
    Math.abs(b.body.y - (y0 + 1)) > 1e-9
  ) {
    throw new Fail('the pillar jump did not land on the placed block');
  }
  const neededBy = b.steps.length - 1;
  // Without the block the jump comes back down to where it began: the same steps until the
  // landing on the block, then on down.
  const without: PathStep[] = [];
  let body = before.body;
  for (let t = 0; t < 60 && !body.onGround; t++) {
    const next = physicsTick(before.view, body, 0, 0, false);
    if (next === null) throw new Fail('internal: the pillar fallback hit a block');
    body = next;
    without.push({
      pos: { x: body.x, y: body.y, z: body.z },
      onGround: body.onGround,
      sprint: false,
      jump: false,
    });
  }
  if (!body.onGround || Math.abs(body.y - y0) > 1e-9) {
    throw new Fail('internal: the pillar fallback did not land');
  }
  const steps = without.slice(neededBy - afterStep - 1);
  return { places: [placeOf(m, afterStep, neededBy)], fallback: { fromStep: neededBy, steps } };
}

/**
 * Ascend: from the start block's centre, jump; while the feet are below the step's top the
 * box keeps off the step's column; then on to land near the step's centre. A few ways are
 * tried (waiting a tick or more to slow down first, landing a little short or long).
 */
function ascend(b: StepBuilder, m: Movement, l: Line, exit: Exit): void {
  const y0 = m.from.y;
  const v = b.view;
  // A block above either head cuts the jump short (the feet then peak 1.2 up).
  const capped =
    v.solid(m.from.x, y0 + 3, m.from.z) || v.solid(m.to.x, y0 + 3, m.to.z) ? 3 - HEIGHT : Infinity;
  const landTick = jumpLandingTick(1, capped);
  const offStep = 0.2 - EDGE_MARGIN;
  const inColumn = 1.2 - EDGE_MARGIN;
  const air = keyAccel('air', false);
  let lastError = 'no way found';
  for (const wait of [0, 1, 2, 3]) {
    for (const target of [0.95, 0.85, 1.05, 0.75]) {
      const mark = b.mark();
      try {
        for (let w = 0; w < wait; w++) {
          const bnd = b.bounds(l, false, false);
          const d = clamp(0, bnd.lo, bnd.hi);
          if (b.s(l) + d > offStep - 0.05) throw new Fail('too fast to wait');
          b.tick(l, d, false, false);
        }
        // The jump tick, then one more, end with the feet still below the step's top.
        const bj = b.bounds(l, false, true);
        const room = offStep - b.s(l);
        const cap = room <= air / GROUND_DRAG ? room : (room + air) / (1 + GROUND_DRAG);
        if (cap < bj.lo) throw new Fail('too fast to jump without reaching over the step');
        b.tick(l, clamp((target - b.s(l)) / landTick, bj.lo, Math.min(bj.hi, cap)), true, false);
        for (let t = 2; t <= 40 && !b.body.onGround; t++) {
          const bnd = b.bounds(l, false, false);
          const s = b.s(l);
          const body = b.body;
          // Where the feet are once this tick's Y move is done: the move across comes after.
          const ny = body.y + moveY(b.view, body.x, body.y, body.z, body.vy);
          let hi = Math.min(bnd.hi, inColumn - s);
          if (ny < y0 + 1 - 1e-9) hi = Math.min(hi, offStep - s);
          if (hi < bnd.lo) throw new Fail('cannot keep off the step');
          const d = clamp((target - s) / Math.max(1, landTick - t + 1), bnd.lo, hi);
          b.tick(l, d, false, false);
        }
        if (!b.body.onGround || Math.abs(b.body.y - (y0 + 1)) > 1e-9) {
          throw new Fail('the jump did not land on the step');
        }
        b.run(l, 1, exit, WALK_RUN, centreOf(m.to));
        return;
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        lastError = e.message;
        b.restore(mark);
      }
    }
  }
  throw new Fail(`no jump onto the step works: ${lastError}`);
}

/**
 * Out of water onto the bank one block higher, as a player climbs out: forward held, and jump
 * held while in the water (swimming up), the box pressed against the bank; once the space 0.6
 * higher holds no water, the game pushes the player up (0.3), the feet clear the bank's top and
 * the box moves over it; then it lands and walks on to the centre.
 */
function waterExit(b: StepBuilder, m: Movement, l: Line, exit: Exit): void {
  const top = m.to.y;
  for (let t = 0; t < 80; t++) {
    const body = b.body;
    if (body.onGround && Math.abs(body.y - top) <= 1e-9) break;
    b.vanillaTick(l, modeOf(b.view, body) === 'water');
  }
  if (!b.body.onGround || Math.abs(b.body.y - top) > 1e-9) {
    throw new Fail('did not climb out onto the bank');
  }
  b.run(l, 1, exit, WALK_RUN, centreOf(m.to));
}

/**
 * Descend and fall: walk off the edge; falling, steer to land near the landing block's centre,
 * never back over the start block (its floor is beside the falling body) and never past the
 * landing column.
 */
function fall(b: StepBuilder, m: Movement, l: Line, exit: Exit, after: RunParams): void {
  const y0 = m.from.y;
  const off = 0.8 + EDGE_MARGIN;
  const inColumn = 1.2 - EDGE_MARGIN;
  const landX = m.to.x + 0.5;
  const landZ = m.to.z + 0.5;
  for (let t = 0; t < 400; t++) {
    const body = b.body;
    if (body.onGround && Math.abs(body.y - m.to.y) <= 1e-9) break;
    const s = b.s(l);
    const bnd = b.bounds(l, false, false);
    const supported = moveY(b.view, body.x, body.y, body.z, body.vy) !== body.vy;
    if (supported && Math.abs(body.y - y0) <= 1e-9) {
      // Walking to the edge: never ending a tick right at the edge of the support.
      let d = Math.min(Math.max(bnd.hi, 0), WALK_SPEED, inColumn - s);
      if (Math.abs(s + d - 0.8) < EDGE_MARGIN)
        d = Math.max(Math.max(bnd.lo, 0), 0.8 - EDGE_MARGIN - s);
      b.tick(l, d, false, false);
      continue;
    }
    const left = b.ticksToLand(landX, landZ);
    const lo = Math.max(bnd.lo, off - s);
    const hi = Math.min(bnd.hi, inColumn - s);
    if (hi < lo) throw new Fail('cannot steer the fall into the landing column');
    b.tick(l, clamp((1 - s) / Math.max(1, left), lo, hi), false, false);
  }
  if (!b.body.onGround || Math.abs(b.body.y - m.to.y) > 1e-9)
    throw new Fail('the fall did not land');
  b.run(l, 1, exit, after, centreOf(m.to));
}

/**
 * Parkour: run up as fast as allowed and jump on the last tick that starts on the start block;
 * fly forward as hard as needed to be over the landing block before the feet come down to its
 * top, steering to land near its centre and never past it.
 */
function parkour(b: StepBuilder, m: Movement, l: Line, exit: Exit): void {
  const gap = m.gap;
  const sprint = m.sprint;
  const p = sprint ? SPRINT_RUN : WALK_RUN;
  const edge = 0.8 - EDGE_MARGIN;
  const over = gap + 0.2 + EDGE_MARGIN;
  const beyond = gap + 1.2 - EDGE_MARGIN;
  for (let guard = 0; ; guard++) {
    if (guard > 200) throw new Fail('the run-up did not reach the edge');
    const bnd = b.bounds(l, sprint, false);
    const d = Math.min(bnd.hi, p.vmax);
    if (b.s(l) + d >= edge) break;
    b.tick(l, d, false, sprint && d > bnd.par + 1e-12);
  }
  if (b.s(l) >= 0.8) throw new Fail('past the edge before the jump');
  const bj = b.bounds(l, sprint, true);
  b.tick(l, bj.hi, true, sprint);
  const landTick = LEVEL_JUMP_TICKS;
  const target = gap + 1;
  for (let t = 2; t <= 60 && !b.body.onGround; t++) {
    const bnd = b.bounds(l, sprint, false);
    const s = b.s(l);
    const hi = Math.min(bnd.hi, beyond - s);
    if (hi < bnd.lo) throw new Fail('cannot keep inside the landing column');
    let d = clamp((target - s) / Math.max(1, landTick - t + 1), bnd.lo, hi);
    // Still over the landing block by the tick before the feet come down to its top.
    const sure = (x: number): boolean =>
      t >= landTick || s + x + airBrakingDistance(x, landTick - 1 - t) >= over;
    if (!sure(d)) {
      if (!sure(hi)) {
        d = hi;
      } else {
        let a = d;
        let c = hi;
        for (let k = 0; k < 50; k++) {
          const mid = (a + c) / 2;
          if (sure(mid)) c = mid;
          else a = mid;
        }
        d = c;
      }
    }
    b.tick(l, d, false, sprint && d > bnd.par + 1e-12);
  }
  const s = b.s(l);
  if (!b.body.onGround || Math.abs(b.body.y - m.to.y) > 1e-9 || s <= gap + 0.2 || s > gap + 1.2) {
    throw new Fail('the jump did not land on the far side');
  }
  b.run(l, gap + 1, exit, p, centreOf(m.to));
}
