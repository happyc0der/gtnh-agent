import type { Cell } from '../terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../walking.ts';
import { CELL, CellCache, changedWorld, type BlockChange, type CellBox } from './cells.ts';
import {
  CLIMB_ACROSS_PER_TICK,
  CLIMB_DOWN_PER_TICK,
  CLIMB_UP_PER_TICK,
  LEVEL_JUMP_TICKS,
  MAX_WATER_DROP,
} from './costs.ts';
import type { BlockBreak, DoorToggle, Movement } from './movements.ts';
import {
  AIR_DRAG,
  blocksX,
  blocksZ,
  clipX,
  clipZ,
  FallAccount,
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
 *  - downward: the dig (before the steps), then the fall into the hole;
 *  - door: a walk into the doorway; a door or gate in the way is right-clicked first, standing
 *    still, and once the walk out of the doorway has stopped, right-clicked again: it is left
 *    as it was found.
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
  /**
   * A step on a ladder (or just off its top): no gravity, at most CLIMB_UP_PER_TICK up,
   * CLIMB_DOWN_PER_TICK down and CLIMB_ACROSS_PER_TICK across (validate.ts checks it by those
   * rules; the server checks only the blocks in the way, and resets the fall on a ladder).
   */
  readonly climb?: boolean;
}

/**
 * Whether feet at `p` rest on a block: on a block top (a whole y), with a block that has a box
 * under the body's footprint (one it overlaps by more than a hair).
 */
export function standingOn(world: CellCache, p: Vec3): boolean {
  if (Math.abs(p.y - Math.round(p.y)) > 1e-9) return false;
  const [x0, x1, , , z0, z1] = overlappedCells(p.x, p.y, p.z);
  const y = Math.round(p.y) - 1;
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) if (world.solid(x, y, z)) return true;
  }
  return false;
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

/** A right-click on a door or gate: the cell, the face toward the player, and the change. */
export interface DoorClick extends DoorToggle {
  /** 0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east (C08's face). */
  readonly face: number;
  /** C08's cursor on that face, in sixteenths. */
  readonly cursor: Vec3;
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
  /** A door or gate opened (or closed) before the first step, standing still. */
  readonly toggle?: DoorClick | null;
  /** One opened (or closed) by the movement before, put back after the last step, at rest. */
  readonly restore?: DoorClick | null;
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
  /**
   * The feet block the path starts from (planPath's `start`), where the walk first centres:
   * the first movement's own, else the block under the feet.
   */
  readonly start?: Cell | null;
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
  // Holding jump: off the ground a jump, in water swimming up (EntityLivingBase.onLivingUpdate).
  const vy = !jump ? b.vy : mode === 'water' ? b.vy + SWIM_UP : JUMP_VELOCITY;
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
/** A braking run's steps keep this much more than its braking distance to the end. */
const BRAKING_SPARE = 1e-7;
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
  /**
   * Swimming: floating in water (jump held on every tick that still ends in it), not on the
   * ground at one level (StepBuilder.run).
   */
  readonly swim?: boolean;
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
const SWIM_RUN: RunParams = { ...WADE_RUN, swim: true };

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

/** Starts at rest: breaks first, a door to open first, a vertical movement, or a ladder's. */
function needsRest(m: Movement): boolean {
  return (
    m.breaks.length > 0 ||
    m.toggle !== null ||
    m.kind === 'pillar' ||
    m.kind === 'downward' ||
    isClimb(m)
  );
}

const isClimb = (m: Movement): boolean =>
  m.kind === 'climbUp' ||
  m.kind === 'climbDown' ||
  m.kind === 'climbOn' ||
  m.kind === 'climbOff' ||
  m.kind === 'climbAcross';

/** The face of a block turned along (dx, dz): east 5, west 4, south 3, north 2. */
function faceAlong(dx: number, dz: number): number {
  return dx > 0 ? 5 : dx < 0 ? 4 : dz > 0 ? 3 : 2;
}

/** The click on `t`'s door from a player on its side (dx, dz) (a unit step), to make it `meta`. */
function doorClick(t: DoorToggle, dx: number, dz: number, meta: number, was: number): DoorClick {
  const face = faceAlong(dx, dz);
  return { ...t, was, meta, face, cursor: FACE_CENTRES[face] as Vec3 };
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

  /** Any water may hold the body, calm or not (surfacing: coming up out of it). */
  readonly #anyWater: boolean;

  constructor(
    world: WalkWorld,
    box: CellBox,
    fence: Fence,
    water: boolean,
    from: Vec3,
    anyWater = false,
  ) {
    this.#world = world;
    this.#box = box;
    this.#fence = fence;
    this.#water = water;
    this.#anyWater = anyWater;
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
   * Floating still in water for a tick (the carried motion taken off; on `at` when given),
   * jump held when the tick still ends in water (floats); and where a floor is under the feet
   * block (one-deep water), sinking onto it, jump let go, and standing (hold).
   */
  float(at?: { readonly x: number; readonly z: number }): void {
    const b = this.body;
    if (Math.hypot(b.cx, b.cz) > keyAccel('water', false) + 1e-12) {
      throw new Fail('moving too fast to stop');
    }
    const mx = at === undefined ? 0 : at.x - b.x;
    const mz = at === undefined ? 0 : at.z - b.z;
    if (Math.hypot(mx, mz) > 1e-6) throw new Fail('internal: floating still would move');
    const l: Line = { ox: b.x, oz: b.z, ux: 1, uz: 0 };
    const jump = this.floats(l, 0, mx, mz);
    const moved = physicsTick(this.view, b, mx, mz, jump);
    if (moved === null) throw new Fail('cannot float still here');
    const problem = this.unsafe(b, moved);
    if (problem !== null) throw new Fail(problem);
    const next = at === undefined ? moved : { ...moved, x: at.x, z: at.z };
    this.body = next;
    this.steps.push({
      pos: { x: next.x, y: next.y, z: next.z },
      onGround: next.onGround,
      sprint: false,
      jump,
    });
    const feet = Math.floor(next.y + 1e-9);
    if (!this.view.has(Math.floor(next.x), feet - 1, Math.floor(next.z), CELL.SURFACE)) return;
    // One-deep water: let go and sink onto the floor, then stand.
    for (let t = 0; t < 40 && !this.body.onGround; t++) {
      const sink = physicsTick(this.view, this.body, 0, 0, false);
      if (sink === null) throw new Fail('cannot sink onto the floor');
      const why = this.unsafe(this.body, sink);
      if (why !== null) throw new Fail(why);
      this.body = sink;
      this.steps.push({
        pos: { x: sink.x, y: sink.y, z: sink.z },
        onGround: sink.onGround,
        sprint: false,
        jump: false,
      });
    }
    if (!this.body.onGround) throw new Fail('did not sink onto the floor');
    this.hold();
  }

  /**
   * Whether a swimmer holds jump this tick, moving d along `l` (or by mx, mz): only when the
   * tick still ends in water, so every tick is the water's and the feet float just under the
   * top (inWater: below the top water block's level + 0.599), the eyes well above it.
   */
  floats(l: Line, d: number, mx = d * l.ux, mz = d * l.uz): boolean {
    if (modeOf(this.view, this.body) !== 'water') return false;
    let up = physicsTick(this.view, this.body, mx, mz, true);
    if (up === null || !inWater(this.view, up.x, up.y, up.z)) return false;
    // The rise it carries on, jump let go, must end in the water too.
    for (let t = 0; t < 20 && up.vy > 0; t++) {
      const next = physicsTick(this.view, up, 0, 0, false);
      if (next === null || !inWater(this.view, next.x, next.y, next.z)) return false;
      up = next;
    }
    return true;
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
   * Steps on a ladder (climbing pressed against it, or onto or off its top): straight toward
   * (x, y, z), first along y then across (`acrossFirst`: across then along y), at
   * CLIMB_UP_PER_TICK up, CLIMB_DOWN_PER_TICK down and CLIMB_ACROSS_PER_TICK across, with no
   * gravity: a climbing client's moves, which the server checks only for blocks in the way.
   * Every step is checked like any other (the box clear of every block, a ladder's slab
   * included); it ends at rest there, on the ground when a block is under it.
   */
  climb(x: number, y: number, z: number, acrossFirst: boolean): void {
    const vertical = (): void => {
      while (Math.abs(this.body.y - y) > 1e-9) {
        const dy = y - this.body.y;
        const step = dy > 0 ? Math.min(dy, CLIMB_UP_PER_TICK) : Math.max(dy, -CLIMB_DOWN_PER_TICK);
        this.#climbTo(this.body.x, this.body.y + step, this.body.z);
      }
    };
    const across = (): void => {
      for (;;) {
        const dx = x - this.body.x;
        const dz = z - this.body.z;
        const d = Math.hypot(dx, dz);
        if (d <= 1e-9) return;
        const k = Math.min(1, CLIMB_ACROSS_PER_TICK / d);
        this.#climbTo(this.body.x + dx * k, this.body.y, this.body.z + dz * k);
      }
    };
    if (acrossFirst) {
      across();
      vertical();
    } else {
      vertical();
      across();
    }
  }

  #climbTo(x: number, y: number, z: number): void {
    const ground = standingOn(this.view, { x, y, z });
    const next: Body = {
      x,
      y,
      z,
      cx: 0,
      cz: 0,
      vy: ground ? GROUND_MOTION_Y : 0,
      onGround: ground,
    };
    const problem = this.unsafe(this.body, next);
    if (problem !== null) throw new Fail(problem);
    this.body = next;
    this.steps.push({
      pos: { x, y, z },
      onGround: ground,
      sprint: false,
      jump: false,
      climb: true,
    });
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
            if (
              (flags & CELL.PASSABLE) === 0 &&
              !(this.#water && (this.#anyWater ? v.water(x, y, z) : v.calmWater(x, y, z))) &&
              !v.bodyFitsDoorway(x, y, z, px - h, px + h, pz - h, pz + h) &&
              !v.bodyFitsLadder(x, y, z, px - h, px + h, pz - h, pz + h)
            ) {
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
   * distance). Stays on the ground at its level; swimming (p.swim), in the water instead,
   * floating (jump held on every tick that still ends in water: floats), and a stop there floats
   * at the end, or with a floor under it (one-deep water) sinks onto it and stands.
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
          if (exit.kind === 'stop') {
            if (p.swim === true) this.float(end);
            else this.hold(end);
          }
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
        // The largest step after which braking still stops in time (with a hair to spare), the
        // step taken keeping a little more (BRAKING_SPARE): the next tick's check, a tick of
        // rounding later, must still pass (seen braking in water, slow over several ticks).
        const fits = (x: number, spare = 1e-9): boolean =>
          r - x >= brakingDistance(x, vEnd, p) + spare && (x <= vEnd || r - x > 1e-9);
        if (!fits(lo)) throw new Fail('cannot stop in time');
        d = Math.min(hi, r);
        if (!fits(d, BRAKING_SPARE)) {
          let a = lo;
          let b = d;
          for (let k = 0; k < 50; k++) {
            const mid = (a + b) / 2;
            if (fits(mid, BRAKING_SPARE)) a = mid;
            else b = mid;
          }
          d = a;
        }
      }
      if (p.swim === true) {
        this.tick(l, d, this.floats(l, d), false);
        if (modeOf(this.view, this.body) !== 'water') throw new Fail('a swim left the water');
        continue;
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
      const d = Math.max(bnd.lo, 0);
      this.tick(l, d, p.swim === true && this.floats(l, d), false);
    }
    if (p.swim === true) this.float();
    else this.hold();
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
  // Out of a swim into anything but more swimming or a climb out up a bank: it stops, and in
  // one-deep water stands on the floor (StepBuilder.float), for the walk or wade after it.
  if (curParams.swim === true && !next.swim && next.kind !== 'ascend') return { kind: 'stop' };
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
  // Out of the water up a bank, the run after it is on the bank (waterExit).
  if (m.swim && m.kind !== 'ascend') return SWIM_RUN;
  if (wet) return WADE_RUN;
  return m.sprint ? SPRINT_RUN : WALK_RUN;
}

/** How far below the feet idle looks for water to come down into (blocks): any drop a path makes. */
const WATER_BELOW = MAX_WATER_DROP + 1;
/** How far idle swims up to the top of the water (blocks), and for how long at most (ticks). */
const MAX_SURFACING_RISE = 40;
const MAX_SURFACING_TICKS = 600;

/**
 * Idle in or over water (a stop, a correction or a login there): the ticks that bring the
 * player, standing still, up into the top block of the water, as a client swimming up does
 * (jump held while that keeps it in the water: StepBuilder.floats), falling in first from just
 * above calm water, or down onto the floor of one-deep water; until it is afloat in the top
 * block, rising, or on that floor. Under water any water will do on the way up (it must not
 * drown); from above, only calm water under every column the body is over, a drop of at most
 * MAX_WATER_DROP, and no fall damage. Null when nothing is to be done (afloat there already,
 * standing on something, no water), or no safe way is known (a block or a hazard on the way;
 * the caller says so when the eyes are under water).
 */
export function surfacing(world: WalkWorld, feet: Vec3): PathStep[] | null {
  const fx = Math.floor(feet.x);
  const fz = Math.floor(feet.z);
  const fy = Math.floor(feet.y + 1e-9);
  const box: CellBox = {
    min: { x: fx - 3, y: fy - WATER_BELOW - 3, z: fz - 3 },
    max: { x: fx + 3, y: fy + MAX_SURFACING_RISE + 3, z: fz + 3 },
  };
  const view = new CellCache(world, box);
  const [x0, x1, , , z0, z1] = overlappedCells(feet.x, feet.y, feet.z);
  let water = -1;
  const under = inWater(view, feet.x, feet.y, feet.z);
  // Out of the water, standing on something (a bank, a ledge): nothing to do.
  if (!under && Math.abs(feet.y - Math.round(feet.y)) < 1e-6) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const below = Math.round(feet.y) - 1;
        if (view.solid(x, below, z) && !view.water(x, below, z)) return null;
      }
    }
  }
  if (under) {
    // In it: one-deep water's floor, or the top block of the water above.
    let top = fy;
    while (top < fy + MAX_SURFACING_RISE && view.water(fx, top + 1, fz)) top++;
    if (top === fy && feet.y - fy < 0.599) return null; // afloat in the top block already
    water = top;
  } else {
    // Just above calm water, nothing under any column the body is over but air down to it.
    for (let y = fy; y >= fy - WATER_BELOW; y--) {
      let wet = 0;
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          if (view.calmWater(x, y, z)) wet++;
          else if (!view.open(x, y, z)) return null;
        }
      }
      if (wet === (x1 - x0 + 1) * (z1 - z0 + 1)) {
        water = y;
        break;
      }
      if (wet > 0) return null;
    }
    if (water < 0) return null;
  }
  const b = new StepBuilder(world, box, LOOSE_FENCE, true, feet, under);
  b.body = { ...b.body, vy: 0, onGround: false };
  const l: Line = { ox: feet.x, oz: feet.z, ux: 1, uz: 0 };
  const fall = new FallAccount();
  let there = false;
  try {
    for (let t = 0; t < MAX_SURFACING_TICKS; t++) {
      const body = b.body;
      const wet = modeOf(view, body) === 'water';
      // Afloat in the top block, rising; or on one-deep water's floor, the eyes out of it.
      there =
        (Math.floor(body.y + 1e-9) === water && body.vy > 0 && wet) ||
        (body.onGround && wet && Math.floor(body.y + 1e-9) === water);
      if (there) break;
      b.tick(l, 0, b.floats(l, 0), false);
      const next = b.body;
      // Never onto a block from the air, never a fall that hurts.
      if (next.onGround && !inWater(view, next.x, next.y, next.z)) return null;
      if (fall.packet(inWater(view, body.x, body.y, body.z), next.y - body.y, next.onGround) > 0) {
        return null;
      }
    }
  } catch (e) {
    if (e instanceof Fail) return null;
    throw e;
  }
  const end = b.steps.at(-1);
  if (!there || end === undefined || Math.abs(end.pos.y - feet.y) < 1e-6) return null;
  return b.steps;
}

/** A fence that holds nothing back (idle's own checks keep it in the play area). */
const LOOSE_FENCE: Fence = {
  min: { x: -30_000_000, y: 0, z: -30_000_000 },
  max: { x: 30_000_000, y: 255, z: 30_000_000 },
};

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
    const r = build(world, area, from, movements, options, restBefore);
    if (r.ok) return r;
    // Drive the failing movement from rest: the one before it (or the centring on the start
    // block, for the first) stops at its end.
    const k = Math.max(r.movement, 0);
    if (restBefore.has(k)) return r;
    restBefore.add(k);
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
  options: ExecutionOptions,
  restBefore: ReadonlySet<number>,
): ExecutionPlan {
  const water = options.water ?? false;
  const b = new StepBuilder(world, boxAround(area, from, movements), area, water, from);
  const segments: Segment[] = [];
  let index = -1;
  try {
    // Centre on the start block.
    const first = movements[0];
    const startCell = first?.from ??
      options.start ?? {
        x: Math.floor(from.x),
        y: Math.round(from.y),
        z: Math.floor(from.z),
      };
    const cx = startCell.x + 0.5;
    const cz = startCell.z + 0.5;
    const dist = Math.hypot(cx - from.x, cz - from.z);
    const startWet = b.view.has(startCell.x, startCell.y, startCell.z, CELL.WATER);
    const startSwim = water && b.view.swimmable(startCell.x, startCell.y, startCell.z);
    // Held by a ladder with no floor (beside its column's centre, over its top, or between
    // levels): across to the column's centre and up or down to the start block's level, as a
    // climbing client moves (search.ts startOf).
    const hanging =
      b.view.has(startCell.x, startCell.y, startCell.z, CELL.CLIMB) &&
      (!b.view.has(startCell.x, startCell.y - 1, startCell.z, CELL.SURFACE) ||
        Math.abs(from.y - startCell.y) > 1e-9);
    if (hanging) {
      b.climb(cx, startCell.y, cz, true);
    } else if (startSwim) {
      // Under water (a stop or a login there), or sinking in its top block (a walk starts as if
      // at rest, sinking): up into the top block, rising, first, jump held while that keeps the
      // body in the water (floats), then swimming to its centre.
      for (let t = 0; t < 200; t++) {
        const body = b.body;
        if (Math.floor(body.y + 1e-9) === startCell.y && body.vy > 0) break;
        const l: Line = { ox: body.x, oz: body.z, ux: 1, uz: 0 };
        b.tick(l, 0, b.floats(l, 0), false);
        if (modeOf(b.view, b.body) !== 'water') throw new Fail('rising out of the water');
      }
      if (Math.floor(b.body.y + 1e-9) !== startCell.y) {
        throw new Fail('did not rise into the top of the water');
      }
      const left = Math.hypot(cx - b.body.x, cz - b.body.z);
      if (left > 1e-9) {
        const l: Line = {
          ox: b.body.x,
          oz: b.body.z,
          ux: (cx - b.body.x) / left,
          uz: (cz - b.body.z) / left,
        };
        const exit: Exit =
          first === undefined || needsRest(first) || restBefore.has(0)
            ? { kind: 'stop' }
            : { kind: 'exact', v: cornerSpeed(l, lineOf(first), true, SWIM_RUN.vmax) };
        b.run(l, left, exit, SWIM_RUN, { x: cx, z: cz });
        if (Math.hypot(b.body.x - cx, b.body.z - cz) > 1e-6) {
          throw new Fail('centring missed the centre');
        }
      }
    } else if (startWet && Math.abs(from.y - startCell.y) > 1e-9) {
      // Afloat over one-deep water: jump let go, it sinks onto the floor, then wades.
      land(b, startCell.y);
      if (dist > 1e-9) {
        const l: Line = {
          ox: from.x,
          oz: from.z,
          ux: (cx - from.x) / dist,
          uz: (cz - from.z) / dist,
        };
        const exit: Exit =
          first === undefined || needsRest(first) || restBefore.has(0)
            ? { kind: 'stop' }
            : { kind: 'exact', v: cornerSpeed(l, lineOf(first), true, WADE_RUN.vmax) };
        b.run(l, dist, exit, WADE_RUN, { x: cx, z: cz });
        if (Math.hypot(b.body.x - cx, b.body.z - cz) > 1e-6) {
          throw new Fail('centring missed the centre');
        }
      }
    } else if (dist > 1e-9) {
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
      toggle: null,
      restore: null,
    });

    /** A door the movement before opened (or closed): put back once this one is through it. */
    let toRestore: DoorClick | null = null;
    for (index = 0; index < movements.length; index++) {
      const m = movements[index] as Movement;
      const next = movements[index + 1];
      const start: Vec3 = { x: b.body.x, y: b.body.y, z: b.body.z };
      for (const brk of m.breaks) b.change({ cell: brk.cell, block: null });
      let toggle: DoorClick | null = null;
      if (m.toggle !== null) {
        // Clicked from where the player stands, on the side it comes from.
        toggle = doorClick(m.toggle, -m.dir.x, -m.dir.z, m.toggle.meta, m.toggle.was);
        b.change({ cell: m.toggle.cell, block: m.toggle.block, meta: m.toggle.meta });
      }
      const restore = toRestore;
      // The walk out of a doorway it opened stops beyond it, for the click that closes it.
      const out = drive(b, m, next, restBefore.has(index + 1) || restore !== null);
      if (restore !== null) {
        b.change({ cell: restore.cell, block: restore.block, meta: restore.meta });
      }
      toRestore =
        m.toggle === null
          ? null
          : doorClick(m.toggle, m.dir.x, m.dir.z, m.toggle.was, m.toggle.meta);
      segments.push({
        movement: m,
        start,
        breaks: m.breaks,
        steps: b.steps.splice(0),
        places: out.places,
        fallback: out.fallback,
        toggle,
        restore,
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
  if (isClimb(m)) {
    // A ladder's movements start at rest at the centre of the start block.
    const body = b.body;
    if (
      Math.hypot(body.x - (m.from.x + 0.5), body.z - (m.from.z + 0.5)) > 1e-6 ||
      Math.hypot(body.cx, body.cz) > 1e-6
    ) {
      throw new Fail('not at rest at the start block centre');
    }
    // Onto a ladder from its top: across over it first, then down into it.
    b.climb(m.to.x + 0.5, m.to.y, m.to.z + 0.5, m.kind === 'climbOn');
    return { places: [], fallback: null };
  }
  if (m.kind === 'pillar' || m.kind === 'downward') {
    // Both start at rest at the centre of the start block (the movement before stopped).
    const body = b.body;
    if (
      Math.hypot(body.x - (m.from.x + 0.5), body.z - (m.from.z + 0.5)) > 1e-6 ||
      Math.hypot(body.cx, body.cz) > 1e-6
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
    case 'door':
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
    case 'climbUp':
    case 'climbDown':
    case 'climbOn':
    case 'climbOff':
    case 'climbAcross':
      // Ladder movements were driven above.
      throw new Fail(`internal: ${m.kind} is not driven along a line`);
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
    if (m.swim && modeOf(b.view, body) === 'water') {
      // Into deep water: the dive is over once the body is back up in the top block, rising
      // (jump held while that keeps it in the water: #floats); then the swim to the landing
      // block's centre takes over. Meanwhile it keeps inside the landing column.
      if (Math.floor(body.y + 1e-9) === m.to.y && body.vy > 0) break;
      const bnd = b.bounds(l, false, false);
      const lo = Math.max(bnd.lo, off - s);
      const hi = Math.min(bnd.hi, inColumn - s);
      if (hi < lo) throw new Fail('cannot keep inside the landing column');
      const d = clamp(1 - s, lo, hi);
      b.tick(l, d, b.floats(l, d), false);
      continue;
    }
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
  const swimming = m.swim && modeOf(b.view, b.body) === 'water';
  if (!swimming && (!b.body.onGround || Math.abs(b.body.y - m.to.y) > 1e-9))
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
