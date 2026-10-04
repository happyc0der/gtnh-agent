import type { Fence, Vec3, WalkWorld } from '../walking.ts';
import { CELL, CellCache, changedWorld, type BlockChange, type CellBox } from './cells.ts';
import { CLIMB_ACROSS_PER_TICK, CLIMB_DOWN_PER_TICK, CLIMB_UP_PER_TICK } from './costs.ts';
import {
  standingOn,
  type DoorClick,
  type ExecutionPlan,
  type PathStep,
  type Segment,
} from './execute.ts';
import {
  blocksX,
  blocksZ,
  clipX,
  clipZ,
  FallAccount,
  freeOfBlocksAndLiquid,
  GROUND_MOTION_Y,
  HALF_WIDTH,
  HEIGHT,
  horizontalDrag,
  inWater,
  JUMP_VELOCITY,
  maxAccel,
  moveY,
  nextMotionY,
  overlappedCells,
  SPRINT_JUMP_BOOST,
  SWIM_UP,
  WATER_DRAG,
  WATER_GRAVITY,
  WATER_POP,
  type MoveMode,
} from './physics.ts';

/**
 * The step validator: replays an execution plan (execute.ts) tick by tick against Minecraft
 * 1.7.10's rules and the server's checks, independently of how the plan was made, and says
 * where it breaks one. For every step:
 *  - the vertical move is the game's: a jump only from the ground (motionY 0.42), swimming up
 *    in water (+0.04), otherwise the motion carried over (gravity and drag, or water's, and
 *    water's push up a block the box was pressed against), stopped by blocks, which sets
 *    onGround exactly when a move down is stopped: falls land exactly on block tops, and
 *    nothing hovers;
 *  - the horizontal move differs from the motion carried over (the last move after the drag
 *    of the mode it started in: ground 0.546, air 0.91, water 0.8; a sprinting jump adds 0.2
 *    forward) by no more than the keys can add in that mode (ground 0.1, sprinting 0.13; air
 *    0.02, sprinting 0.026; water 0.02): no faster than walking or sprinting on the ground, no
 *    jump longer than a real one;
 *  - the server's own move from the last position (Y, then X, then Z, with collisions) is not
 *    stopped by any block, so it lands exactly on the reported position: the box never
 *    enters a block;
 *  - every cell the box touches (and the Y move sweeps) is passable (or calm water when
 *    allowed), not next to a hazard, not unloaded, inside the fence; the feet are never in a
 *    vine (ladder physics are not modelled);
 *  - the server's fall accounting deals no damage at any landing;
 *  - blocks are broken only standing still, never the block under the player unless digging
 *    down; placed only into an empty cell the body is not in, against a solid block that
 *    touches the face clicked.
 * Pure; used by the tests, and available to the executor as a last check.
 */

export interface StepFault {
  /** The segment and step (an index into its steps; -1 before them) where the plan fails. */
  readonly segment: number;
  readonly step: number;
  readonly reason: string;
}

export type Validation =
  { readonly ok: true; readonly ticks: number } | ({ readonly ok: false } & StepFault);

export interface ValidationOptions {
  /** Calm one-deep water may hold the body. */
  readonly water?: boolean;
}

interface State {
  x: number;
  y: number;
  z: number;
  cx: number;
  cz: number;
  vy: number;
  onGround: boolean;
}

const FACE_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
  [-1, 0, 0],
  [1, 0, 0],
];

class Replay {
  readonly #world: WalkWorld;
  readonly #box: CellBox;
  readonly #fence: Fence;
  readonly #water: boolean;
  readonly #changes: BlockChange[] = [];
  view: CellCache;
  readonly fall: FallAccount;

  constructor(
    world: WalkWorld,
    box: CellBox,
    fence: Fence,
    water: boolean,
    fall = new FallAccount(),
  ) {
    this.#world = world;
    this.#box = box;
    this.#fence = fence;
    this.#water = water;
    this.view = new CellCache(world, box);
    this.fall = fall;
  }

  change(c: BlockChange): void {
    this.#changes.push(c);
    this.view = new CellCache(changedWorld(this.#world, this.#changes), this.#box);
  }

  mode(s: State): MoveMode {
    if (inWater(this.view, s.x, s.y, s.z)) return 'water';
    return s.onGround ? 'ground' : 'air';
  }

  /**
   * A step on a ladder (execute.ts climb): 1.7.10's ladder motion, not gravity's. At most
   * CLIMB_UP_PER_TICK up (a client pressed against the ladder), CLIMB_DOWN_PER_TICK down
   * (motionY is never below -0.15 there) and CLIMB_ACROSS_PER_TICK across (motionX and Z are
   * clamped there), with a ladder where the feet are (1.7.10's isOnLadder), or at a block's
   * level right under them (over its top, onto or off it), or a block holding the feet (the
   * ledge beside the top); the box clear of every block (a ladder's slab included); onGround
   * exactly when a block holds the feet; the server resets the fall when the step begins on a
   * ladder (the player's living update, before the packet is applied). `s` becomes the state
   * after it, at rest.
   */
  climbStep(s: State, step: PathStep): string | null {
    const v = this.view;
    const p = step.pos;
    const dy = p.y - s.y;
    if (dy > CLIMB_UP_PER_TICK + 1e-9) return `a climb of ${dy.toFixed(4)} up in one tick`;
    if (dy < -CLIMB_DOWN_PER_TICK - 1e-9) return `a climb of ${(-dy).toFixed(4)} down in one tick`;
    const across = Math.hypot(p.x - s.x, p.z - s.z);
    if (across > CLIMB_ACROSS_PER_TICK + 1e-9) return `a climb of ${across.toFixed(4)} across`;
    const fx = Math.floor(p.x);
    const fy = Math.floor(p.y + 1e-9);
    const fz = Math.floor(p.z);
    const level = Math.abs(p.y - fy) < 1e-9;
    const ground = standingOn(v, p);
    const ladder =
      v.has(fx, fy, fz, CELL.CLIMB) || (level && v.has(fx, fy - 1, fz, CELL.CLIMB)) || ground;
    if (!ladder) return 'a climb with no ladder where the feet are';
    const problem =
      this.cellsAt(s.x, Math.min(s.y, p.y), Math.max(s.y, p.y), s.z) ??
      this.cellsAt(p.x, p.y, p.y, p.z);
    if (problem !== null) return problem;
    if (step.onGround !== ground)
      return `onGround is ${step.onGround} on the ladder, not ${ground}`;
    const fromLadder = v.has(Math.floor(s.x), Math.floor(s.y + 1e-9), Math.floor(s.z), CELL.CLIMB);
    const damage = this.fall.packet(fromLadder, dy, step.onGround);
    if (damage > 0) return `the landing deals ${damage} fall damage`;
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.cx = 0;
    s.cz = 0;
    s.vy = ground ? GROUND_MOTION_Y : 0;
    s.onGround = ground;
    return null;
  }

  /** Why the step from `s` breaks a rule, or null; `s` becomes the state after it. */
  step(s: State, step: PathStep): string | null {
    if (step.climb === true) return this.climbStep(s, step);
    const v = this.view;
    const p = step.pos;
    const mode = this.mode(s);
    // Holding jump: off the ground a jump, in water swimming up, in the air nothing at all.
    if (step.jump && mode === 'air') return 'a jump from the air';
    // Vertical: the game's own move.
    const vy = !step.jump ? s.vy : mode === 'water' ? s.vy + SWIM_UP : JUMP_VELOCITY;
    const moved = moveY(v, s.x, s.y, s.z, vy);
    const clipped = moved !== vy;
    const down = clipped && vy < 0;
    const y = s.y + moved;
    if (Math.abs(p.y - y) > 1e-7) {
      return `the feet go to y=${p.y.toFixed(4)}, where the game's move takes them to ${y.toFixed(4)}`;
    }
    if (step.onGround !== down) {
      return `onGround is ${step.onGround}, the game's move says ${down}`;
    }
    // Horizontal: no more change than the keys allow.
    const mx = p.x - s.x;
    const mz = p.z - s.z;
    const len = Math.hypot(mx, mz);
    if (len > 10) return 'more than 10 blocks in one tick';
    // A bump: the keys pushed the box against a block, so it ends touching that block's face
    // and the move asked for went further (the block stopped it, and took that axis's motion).
    const bump = step.bump ?? { x: 0, z: 0 };
    if (bump.x !== 0 && (Math.abs(bump.x) !== 1 || clipX(v, p.x, y, s.z, bump.x * 1e-6) !== 0)) {
      return 'a bump against no block (X)';
    }
    if (bump.z !== 0 && (Math.abs(bump.z) !== 1 || clipZ(v, p.x, y, p.z, bump.z * 1e-6) !== 0)) {
      return 'a bump against no block (Z)';
    }
    let cx = s.cx;
    let cz = s.cz;
    if (step.jump && step.sprint && mode === 'ground' && len > 1e-12) {
      cx += (SPRINT_JUMP_BOOST * mx) / len;
      cz += (SPRINT_JUMP_BOOST * mz) / len;
    }
    // The least change of motion that explains the move: on a bumped axis any request going at
    // least as far that way.
    const need = (m: number, c: number, b: number): number =>
      b !== 0 && b * (c - m) > 0 ? 0 : m - c;
    const ax = need(mx, cx, bump.x);
    const az = need(mz, cz, bump.z);
    const allowed = maxAccel(mode, step.sprint);
    if (Math.hypot(ax, az) > allowed + 1e-9) {
      return `the move across changes by ${Math.hypot(ax, az).toFixed(4)} (at most ${allowed.toFixed(4)} ${mode === 'ground' ? 'on the ground' : `in ${mode === 'air' ? 'the air' : 'water'}`})`;
    }
    // The server's move from the last position: Y, then X, then Z, never stopped (a bumped
    // move ends just touching the block).
    if (blocksX(v, s.x, y, s.z, mx)) return 'the move across runs into a block (X)';
    if (blocksZ(v, s.x + mx, y, s.z, mz)) return 'the move across runs into a block (Z)';
    const problem =
      this.cellsAt(s.x, Math.min(s.y, y), Math.max(s.y, y), s.z) ??
      this.cellsAt(p.x, p.y, p.y, p.z);
    if (problem !== null) return problem;
    // The server's fall accounting.
    const damage = this.fall.packet(inWater(v, s.x, s.y, s.z), p.y - s.y, step.onGround);
    if (damage > 0) return `the landing deals ${damage} fall damage`;
    let ncx = bump.x !== 0 ? 0 : mx;
    let ncz = bump.z !== 0 ? 0 : mz;
    let nvy = clipped ? 0 : vy;
    if (mode === 'water') {
      ncx *= WATER_DRAG;
      ncz *= WATER_DRAG;
      nvy = nvy * WATER_DRAG - WATER_GRAVITY;
      // Pressed against a block with the space 0.6 higher free of blocks and water: pushed up.
      const pushed = bump.x !== 0 || bump.z !== 0;
      if (pushed && freeOfBlocksAndLiquid(v, p.x, p.y, p.z, ncx, nvy + 0.6 - (p.y - s.y), ncz)) {
        nvy = WATER_POP;
      }
    } else {
      const drag = horizontalDrag(mode);
      ncx *= drag;
      ncz *= drag;
      nvy = nextMotionY(nvy, mode);
    }
    s.x = p.x;
    s.y = p.y;
    s.z = p.z;
    s.cx = ncx;
    s.cz = ncz;
    s.vy = nvy;
    s.onGround = down;
    return null;
  }

  /** Why a box at (x, z) spanning feet heights y0..y1 touches a cell it must not, or null. */
  cellsAt(x: number, y0: number, y1: number, z: number): string | null {
    const f = this.#fence;
    if (
      x - HALF_WIDTH < f.min.x - 1e-9 ||
      x + HALF_WIDTH > f.max.x + 1 + 1e-9 ||
      z - HALF_WIDTH < f.min.z - 1e-9 ||
      z + HALF_WIDTH > f.max.z + 1 + 1e-9 ||
      y0 < f.min.y - 1e-9 ||
      y1 > f.max.y + 1 + 1e-9
    ) {
      return 'the box leaves the fence';
    }
    const v = this.view;
    if (v.has(Math.floor(x), Math.floor(y1 + 1e-9), Math.floor(z), CELL.LADDER)) {
      return 'the feet are in a vine';
    }
    const [x0, x1, , , z0, z1] = overlappedCells(x, y0, z);
    const cy0 = Math.floor(y0 + 1e-7);
    const cy1 = Math.ceil(y1 + HEIGHT - 1e-7) - 1;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cz = z0; cz <= z1; cz++) {
          if (
            !v.has(cx, cy, cz, CELL.PASSABLE) &&
            !(this.#water && v.calmWater(cx, cy, cz)) &&
            !v.bodyFitsDoorway(
              cx,
              cy,
              cz,
              x - HALF_WIDTH,
              x + HALF_WIDTH,
              z - HALF_WIDTH,
              z + HALF_WIDTH,
            ) &&
            !v.bodyFitsLadder(
              cx,
              cy,
              cz,
              x - HALF_WIDTH,
              x + HALF_WIDTH,
              z - HALF_WIDTH,
              z + HALF_WIDTH,
            )
          ) {
            return `the box is in the block at (${cx}, ${cy}, ${cz})`;
          }
          if (v.nearHazard(cx, cy, cz))
            return `the box is next to a hazard at (${cx}, ${cy}, ${cz})`;
        }
      }
    }
    return null;
  }
}

function boxOf(area: Fence, from: Vec3, plan: Extract<ExecutionPlan, { ok: true }>): CellBox {
  let x0 = Math.floor(from.x);
  let x1 = x0;
  let z0 = Math.floor(from.z);
  let z1 = z0;
  for (const seg of plan.segments) {
    for (const s of [...seg.steps, ...(seg.fallback?.steps ?? [])]) {
      x0 = Math.min(x0, Math.floor(s.pos.x));
      x1 = Math.max(x1, Math.floor(s.pos.x));
      z0 = Math.min(z0, Math.floor(s.pos.z));
      z1 = Math.max(z1, Math.floor(s.pos.z));
    }
  }
  return {
    min: { x: x0 - 3, y: area.min.y - 3, z: z0 - 3 },
    max: { x: x1 + 3, y: area.max.y + 5, z: z1 + 3 },
  };
}

/**
 * Validates `plan` for a player at rest on the ground at `from`, over `world`, inside `area`
 * (the fence). The pillar fallbacks are checked too, as if the block never came.
 */
export function validatePlan(
  world: WalkWorld,
  area: Fence,
  from: Vec3,
  plan: ExecutionPlan,
  options: ValidationOptions = {},
): Validation {
  if (!plan.ok) return { ok: false, segment: -1, step: -1, reason: `no plan: ${plan.reason}` };
  const replay = new Replay(world, boxOf(area, from, plan), area, options.water ?? false);
  const s: State = {
    x: from.x,
    y: from.y,
    z: from.z,
    cx: 0,
    cz: 0,
    vy: GROUND_MOTION_Y,
    onGround: true,
  };
  let ticks = 0;
  for (let k = 0; k < plan.segments.length; k++) {
    const seg = plan.segments[k] as Segment;
    const fault = (step: number, reason: string): Validation => ({
      ok: false,
      segment: k,
      step,
      reason,
    });
    if (Math.hypot(seg.start.x - s.x, seg.start.y - s.y, seg.start.z - s.z) > 1e-7) {
      return fault(-1, 'the segment does not start where the last one ended');
    }
    if (seg.toggle != null) {
      // A door is clicked standing still, within reach, and turns as the click says.
      const why = doorClickProblem(replay.view, s, seg.toggle, replay.mode(s));
      if (why !== null) return fault(-1, why);
      replay.change({ cell: seg.toggle.cell, block: seg.toggle.block, meta: seg.toggle.meta });
    }
    if (seg.breaks.length > 0) {
      // Digging stands still: one idle tick takes off what is carried over.
      const mode = replay.mode(s);
      if (!s.onGround || Math.hypot(s.cx, s.cz) > maxAccel(mode, false) + 1e-9) {
        return fault(-1, 'blocks are broken while moving');
      }
      s.cx = 0;
      s.cz = 0;
      for (const b of seg.breaks) {
        const c = b.cell;
        const under =
          c.y === Math.round(s.y) - 1 &&
          c.x >= Math.floor(s.x - HALF_WIDTH) &&
          c.x <= Math.floor(s.x + HALF_WIDTH) &&
          c.z >= Math.floor(s.z - HALF_WIDTH) &&
          c.z <= Math.floor(s.z + HALF_WIDTH);
        if (under && seg.movement?.kind !== 'downward') {
          return fault(-1, `the block under the player at (${c.x}, ${c.y}, ${c.z}) is broken`);
        }
        replay.change({ cell: c, block: null });
      }
    }
    let branch: { state: State; view: CellCache; fall: FallAccount } | null = null;
    let withoutBlock: CellCache | null = null;
    for (let i = 0; i < seg.steps.length; i++) {
      const problem = replay.step(s, seg.steps[i] as PathStep);
      if (problem !== null) return fault(i, problem);
      ticks++;
      for (const pl of seg.places) {
        if (pl.afterStep !== i) continue;
        const why = placeProblem(replay.view, s, pl.cell, pl.against, pl.face);
        if (why !== null) return fault(i, why);
        withoutBlock = replay.view;
        replay.change({ cell: pl.cell, block: pl.block });
      }
      // The fallback takes over before step fromStep, in the world without the block.
      if (seg.fallback !== null && seg.fallback.fromStep === i + 1 && withoutBlock !== null) {
        branch = { state: { ...s }, view: withoutBlock, fall: replay.fall.copy() };
      }
    }
    if (seg.fallback !== null) {
      if (branch === null) return fault(-1, 'a fallback with no place before it');
      // As if the block never came: the same checks, without it.
      const side = new Replay(
        world,
        boxOf(area, from, plan),
        area,
        options.water ?? false,
        branch.fall,
      );
      side.view = branch.view;
      const t = branch.state;
      for (let i = 0; i < seg.fallback.steps.length; i++) {
        const problem = side.step(t, seg.fallback.steps[i] as PathStep);
        if (problem !== null) return fault(i, `fallback: ${problem}`);
      }
      if (!t.onGround) return fault(-1, 'the fallback ends in the air');
    }
    if (seg.restore != null) {
      // The door the walk turned to pass, put back as it was once the body is through.
      const why = doorClickProblem(replay.view, s, seg.restore, replay.mode(s));
      if (why !== null) return fault(seg.steps.length - 1, why);
      replay.change({ cell: seg.restore.cell, block: seg.restore.block, meta: seg.restore.meta });
    }
    const m = seg.movement;
    if (m !== null) {
      const feet = { x: Math.floor(s.x), y: Math.round(s.y), z: Math.floor(s.z) };
      // On the ground, or (a climb up, down, onto one or across) held by the ladder at a
      // block's level.
      const held =
        (m.kind === 'climbUp' ||
          m.kind === 'climbDown' ||
          m.kind === 'climbOn' ||
          m.kind === 'climbAcross') &&
        replay.view.held(feet.x, feet.y, feet.z) &&
        Math.abs(s.y - feet.y) < 1e-9;
      if (feet.x !== m.to.x || feet.y !== m.to.y || feet.z !== m.to.z || !(s.onGround || held)) {
        return fault(
          seg.steps.length - 1,
          `the ${m.kind} ends at (${feet.x}, ${feet.y}, ${feet.z}), not on its block (${m.to.x}, ${m.to.y}, ${m.to.z})`,
        );
      }
    }
  }
  return { ok: true, ticks };
}

/**
 * Why the box going from feet `a` to feet `b` (one step of a plan) would touch a cell it
 * must not, on the blocks as they are now, or null: a cell the box (and the Y move's sweep at
 * a's x and z) touches that is not passable (or calm one-deep water, with `water`), is next
 * to a hazard or an unloaded block, or lies outside the fence, or the feet in a vine. The
 * validator's own rule for a step, for the executor to check each step just before it sends
 * it: the world may have changed since the plan was made.
 */
export function stepProblem(
  world: WalkWorld,
  fence: Fence,
  a: Vec3,
  b: Vec3,
  water = false,
): string | null {
  const box: CellBox = {
    min: {
      x: Math.floor(Math.min(a.x, b.x)) - 3,
      y: Math.floor(Math.min(a.y, b.y)) - 3,
      z: Math.floor(Math.min(a.z, b.z)) - 3,
    },
    max: {
      x: Math.floor(Math.max(a.x, b.x)) + 3,
      y: Math.floor(Math.max(a.y, b.y)) + 5,
      z: Math.floor(Math.max(a.z, b.z)) + 3,
    },
  };
  const replay = new Replay(world, box, fence, water);
  return (
    replay.cellsAt(a.x, Math.min(a.y, b.y), Math.max(a.y, b.y), a.z) ??
    replay.cellsAt(b.x, b.y, b.y, b.z)
  );
}

/**
 * Why a door or gate may not be clicked now (doors open in the doorway's cell only; the player
 * stands still on the ground, within reach, not in the doorway), or null.
 */
function doorClickProblem(
  view: CellCache,
  s: State,
  click: DoorClick,
  mode: MoveMode,
): string | null {
  const c = click.cell;
  if (!view.has(c.x, c.y, c.z, CELL.DOORWAY) || !view.has(c.x, c.y, c.z, CELL.TOGGLE)) {
    return `the click at (${c.x}, ${c.y}, ${c.z}) is on no door or gate a click turns`;
  }
  if (!s.onGround || Math.hypot(s.cx, s.cz) > maxAccel(mode, false) + 1e-9) {
    return 'a door is clicked while moving';
  }
  if (Math.hypot(c.x + 0.5 - s.x, c.y + 0.5 - (s.y + 1.62), c.z + 0.5 - s.z) > 4.5) {
    return `the door at (${c.x}, ${c.y}, ${c.z}) is out of reach`;
  }
  if (Math.floor(s.x) === c.x && Math.floor(s.z) === c.z) return 'the player stands in the doorway';
  return null;
}

/** Why a block may not be placed into `cell` by clicking face `face` of `against`, or null. */
function placeProblem(
  view: CellCache,
  s: State,
  cell: { x: number; y: number; z: number },
  against: { x: number; y: number; z: number },
  face: number,
): string | null {
  const off = FACE_OFFSETS[face];
  if (off === undefined) return `no face ${face}`;
  if (
    against.x + off[0] !== cell.x ||
    against.y + off[1] !== cell.y ||
    against.z + off[2] !== cell.z
  ) {
    return 'the face clicked does not touch the cell placed into';
  }
  if (!view.has(cell.x, cell.y, cell.z, CELL.REPLACEABLE))
    return 'the cell placed into is not empty';
  if (!view.has(against.x, against.y, against.z, CELL.CLICKABLE)) {
    return 'the block clicked is not a plain full block';
  }
  const overlap =
    s.x + HALF_WIDTH > cell.x + 1e-7 &&
    s.x - HALF_WIDTH < cell.x + 1 - 1e-7 &&
    s.z + HALF_WIDTH > cell.z + 1e-7 &&
    s.z - HALF_WIDTH < cell.z + 1 - 1e-7 &&
    s.y + HEIGHT > cell.y + 1e-7 &&
    s.y < cell.y + 1 - 1e-7;
  if (overlap) return 'the block would be placed inside the body';
  return null;
}
