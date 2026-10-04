/**
 * Minecraft 1.7.10's movement physics for a player on foot, as the pathfinder plans with it and
 * the step validator checks it: the numbers, the jump arc and the fall, the order in which a
 * tick moves the box, and the server's fall-damage accounting. Read in the vanilla code the test
 * server runs (MCP names): EntityLivingBase.moveEntityWithHeading, jump and moveFlying,
 * EntityPlayer.onLivingUpdate, Entity.moveEntity and handleWaterMovement, World.
 * handleMaterialAcceleration, AxisAlignedBB.calculate[XYZ]Offset and NetHandlerPlayServer.
 * processPlayer. Pure.
 *
 * One client tick of a player on foot:
 *  1. In water? (the box, shrunk by 0.4 at its top and bottom, overlaps a water block).
 *  2. A jump (only from the ground, never in water) sets motionY to 0.42; a sprinting player
 *     also gets 0.2 forward.
 *  3. The keys add an acceleration (moveFlying): on the ground 0.1 per unit of input (0.13
 *     sprinting), in the air 0.02 (0.026 sprinting), in water 0.02. One key is an input of
 *     0.98, two keys at most 1, so 0.098 forward on the ground.
 *  4. moveEntity: the box moves by motionY first, then motionX, then motionZ, each stopped by
 *     the blocks' boxes; a move stopped while going down sets onGround, and a stopped axis
 *     loses its motion.
 *  5. Drag: motionY = (motionY - 0.08) x 0.98 (in water: x 0.8, then - 0.02); horizontal
 *     motion x 0.546 on the ground (slipperiness 0.6 x 0.91), x 0.91 in the air, x 0.8 in
 *     water. Ground or air is decided before the move, from where the tick began.
 * The client sends its feet and onGround. The server repeats step 4 from the last position it
 * accepted and resets the player ("moved wrongly") when the result is more than 0.25 off
 * horizontally or the reported box overlaps blocks (docs/gtnh-compatibility.md, "Walking").
 * Steady speeds follow: walking 0.2159 blocks per tick (4.317 blocks/s), sprinting 0.2806
 * (5.612), wading 0.098.
 */

const f32 = Math.fround;

/** Half the player's width (0.6F / 2) and its height (1.8F). */
export const HALF_WIDTH = 0.3;
export const HEIGHT = 1.8;

/** motionY a jump starts with (0.42F, read as a double). */
export const JUMP_VELOCITY = f32(0.42);
export const GRAVITY = 0.08;
/** Vertical drag per tick (0.98F as a double). */
export const VERTICAL_DRAG = f32(0.98);
/** Horizontal drag in the air (0.91F). */
export const AIR_DRAG = f32(0.91);
/** Horizontal drag on the ground: slipperiness 0.6 (every block the walker stands on) x 0.91. */
export const GROUND_DRAG = f32(f32(0.6) * AIR_DRAG);
/** Drag in water, on every axis (0.8F). */
export const WATER_DRAG = f32(0.8);
/** In water motionY loses this after the drag. */
export const WATER_GRAVITY = 0.02;
/** motionY of a player standing on the ground: gravity once, then stopped by the floor. */
export const GROUND_MOTION_Y = (0 - GRAVITY) * VERTICAL_DRAG;

/** The ground acceleration factor 0.16277136F / drag^3: 1 for slipperiness 0.6. */
const GROUND_FACTOR = f32(f32(0.16277136) / f32(f32(GROUND_DRAG * GROUND_DRAG) * GROUND_DRAG));
/** The movement speed attribute (0.1), and with the sprinting modifier (x 1.3). */
const MOVE_SPEED = 0.10000000149011612;
const SPRINT_MOVE_SPEED = MOVE_SPEED * (1 + 0.30000001192092896);

/**
 * The most a tick's keys can add to the horizontal motion (moveFlying's "friction": any
 * input is scaled down to a length of at most 1), per mode.
 */
export const ACCEL = {
  ground: f32(f32(MOVE_SPEED) * GROUND_FACTOR),
  groundSprint: f32(f32(SPRINT_MOVE_SPEED) * GROUND_FACTOR),
  air: f32(0.02),
  airSprint: f32(0.02 + 0.02 * 0.3),
  water: f32(0.02),
} as const;
/** One movement key is an input of 0.98 (EntityLivingBase.onLivingUpdate). */
export const KEY_INPUT = f32(0.98);
/** A sprinting jump adds this much forward. */
export const SPRINT_JUMP_BOOST = f32(0.2);

export type MoveMode = 'ground' | 'air' | 'water';

/** The horizontal drag at the end of a tick that began in `mode`. */
export function horizontalDrag(mode: MoveMode): number {
  return mode === 'ground' ? GROUND_DRAG : mode === 'air' ? AIR_DRAG : WATER_DRAG;
}

/** The most a tick that began in `mode` can accelerate (any keys). */
export function maxAccel(mode: MoveMode, sprint: boolean): number {
  if (mode === 'water') return ACCEL.water;
  if (mode === 'ground') return sprint ? ACCEL.groundSprint : ACCEL.ground;
  return sprint ? ACCEL.airSprint : ACCEL.air;
}

/** What one key adds per tick in `mode` (the pathfinder's own controls never use more). */
export function keyAccel(mode: MoveMode, sprint: boolean): number {
  return KEY_INPUT * maxAccel(mode, sprint);
}

/** Steady speeds, blocks per tick, holding one key: walking, sprinting, wading. */
export const WALK_SPEED = keyAccel('ground', false) / (1 - GROUND_DRAG);
export const SPRINT_SPEED = keyAccel('ground', true) / (1 - GROUND_DRAG);
export const WADE_SPEED = keyAccel('water', false) / (1 - WATER_DRAG);

/** motionY after a tick in `mode` that moved by `used` (0 when the floor or ceiling stopped it). */
export function nextMotionY(used: number, mode: MoveMode): number {
  return mode === 'water' ? used * WATER_DRAG - WATER_GRAVITY : (used - GRAVITY) * VERTICAL_DRAG;
}

/** Feet heights above the take-off of a jump in the open, after each tick (tick 1: 0.42). */
export function jumpHeights(ticks: number): number[] {
  const out: number[] = [];
  let y = 0;
  let vy: number = JUMP_VELOCITY;
  for (let t = 0; t < ticks; t++) {
    y += vy;
    out.push(y);
    vy = nextMotionY(vy, 'air');
  }
  return out;
}

/**
 * How far below the edge the feet are after each tick of a fall begun by walking off it: the
 * first tick falls 0.0784 (a player on the ground already carries one tick of gravity).
 */
export function fallDepths(ticks: number): number[] {
  const out: number[] = [];
  let y = 0;
  let vy = GROUND_MOTION_Y;
  for (let t = 0; t < ticks; t++) {
    y += vy;
    out.push(-y);
    vy = nextMotionY(vy, 'air');
  }
  return out;
}

/** The tick on which a fall from walking off an edge lands `height` blocks lower (1-based). */
export function fallLandingTick(height: number): number {
  const depths = fallDepths(64);
  const i = depths.findIndex((d) => d >= height - 1e-9);
  if (i < 0) throw new Error(`internal: no landing within 64 ticks for a fall of ${height}`);
  return i + 1;
}

/**
 * The tick on which a jump lands on a block top `height` above the take-off (1: a step up, 0:
 * the same level), with feet never above `ceiling` (a block over the head stops the rise, and
 * the fall starts again from rest): the first tick whose move would take the feet below it.
 */
export function jumpLandingTick(height: number, ceiling = Infinity): number {
  let y = 0;
  let vy: number = JUMP_VELOCITY;
  for (let t = 1; t <= 64; t++) {
    let next = y + vy;
    let used = vy;
    if (next > ceiling) {
      next = ceiling;
      used = 0;
    }
    if (vy < 0 && next < height && y >= height - 1e-9) return t;
    y = next;
    vy = nextMotionY(used, 'air');
  }
  throw new Error(`internal: a jump never comes down to ${height}`);
}

/**
 * Fall damage for a landing (EntityLivingBase.fall, Forge's 1.7.10): ceil(distance - 3) in
 * float arithmetic, so a fall of exactly 3 does none and anything a hair above 3 deals 1.
 */
export function fallDamage(distance: number): number {
  const d = f32(f32(distance) - 3);
  const i = Math.trunc(d);
  return Math.max(0, d > i ? i + 1 : i);
}

/**
 * The server's fall accounting, packet by packet (processPlayer -> handleFalling): before a
 * packet is applied, a player whose last position was in water has its fall distance reset;
 * then a packet on the ground deals damage for the distance so far (not counting its own move)
 * and resets it, and a packet in the air adds its drop. Falling into one-block-deep water
 * therefore helps only when some position before the landing is in water: from some heights
 * every tick skips the 0.6 blocks above the floor where the box counts as in water.
 */
export class FallAccount {
  #distance = 0;

  get distance(): number {
    return this.#distance;
  }

  /** The same account, to follow another branch of what may happen. */
  copy(): FallAccount {
    const c = new FallAccount();
    c.#distance = this.#distance;
    return c;
  }

  /** One packet: where it moved from was in water or not, its drop (dy), its onGround. Returns the damage. */
  packet(fromInWater: boolean, dy: number, onGround: boolean): number {
    if (fromInWater) this.#distance = 0;
    if (onGround) {
      const damage = this.#distance > 0 ? fallDamage(this.#distance) : 0;
      this.#distance = 0;
      return damage;
    }
    if (dy < 0) this.#distance = f32(this.#distance - dy);
    return 0;
  }
}

/** The block cells physics reads: which ones have a (full-cube) collision box, which hold water. */
export interface PhysicsWorld {
  /** A full-cube collision box (anything not passable and not a fluid; unloaded counts too). */
  solid(x: number, y: number, z: number): boolean;
  /** Water (still or flowing). */
  water(x: number, y: number, z: number): boolean;
}

/** Cells c with c + 1 > lo and c < hi: those a span overlaps (vanilla's strict overlap). */
function first(lo: number): number {
  return Math.floor(lo);
}
function last(hi: number): number {
  return Math.ceil(hi) - 1;
}

/**
 * Vanilla's Y move of the box with its feet at (x, y, z) by `dy` (calculateYOffset against
 * every block box overlapping its x and z span): how far it really moves.
 */
export function moveY(world: PhysicsWorld, x: number, y: number, z: number, dy: number): number {
  if (dy === 0) return 0;
  const x0 = first(x - HALF_WIDTH);
  const x1 = last(x + HALF_WIDTH);
  const z0 = first(z - HALF_WIDTH);
  const z1 = last(z + HALF_WIDTH);
  let out = dy;
  if (dy < 0) {
    // Block tops at or below the feet and above where the move would take them.
    for (let cy = Math.floor(y) - 1; cy + 1 > y + dy; cy--) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          if (world.solid(cx, cy, cz)) out = Math.max(out, cy + 1 - y);
        }
      }
      if (out > dy) return out;
    }
    return out;
  }
  // Block bottoms at or above the head and below where the move would take it.
  const top = y + HEIGHT;
  for (let cy = Math.ceil(top); cy < top + dy; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        if (world.solid(cx, cy, cz)) out = Math.min(out, cy - top);
      }
    }
    if (out < dy) return out;
  }
  return out;
}

/**
 * Whether vanilla's X move of the box at (x, y, z) by `dx` would be stopped by a block
 * (calculateXOffset): a block box overlapping its y and z span lies ahead within the move.
 */
export function blocksX(world: PhysicsWorld, x: number, y: number, z: number, dx: number): boolean {
  if (dx === 0) return false;
  const y0 = first(y);
  const y1 = last(y + HEIGHT);
  const z0 = first(z - HALF_WIDTH);
  const z1 = last(z + HALF_WIDTH);
  const face = dx > 0 ? x + HALF_WIDTH : x - HALF_WIDTH;
  const lo = dx > 0 ? Math.ceil(face) : Math.floor(face + dx);
  const hi = dx > 0 ? Math.ceil(face + dx) - 1 : Math.floor(face) - 1;
  for (let cx = lo; cx <= hi; cx++) {
    // Only cells wholly ahead of the box's face: the box does not already overlap them.
    if (dx > 0 ? cx < face : cx + 1 > face) continue;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) if (world.solid(cx, cy, cz)) return true;
    }
  }
  return false;
}

/** As blocksX, for the Z move. */
export function blocksZ(world: PhysicsWorld, x: number, y: number, z: number, dz: number): boolean {
  if (dz === 0) return false;
  const swapped: PhysicsWorld = {
    solid: (a, b, c) => world.solid(c, b, a),
    water: (a, b, c) => world.water(c, b, a),
  };
  return blocksX(swapped, z, y, x, dz);
}

/**
 * Whether a player with its feet at (x, y, z) is in water (Entity.handleWaterMovement): its box
 * grown by -0.4 vertically (0.4 off its top and bottom) and shrunk by 0.001 overlaps a water
 * block. (The liquid-height test there always passes for the blocks the loop visits.)
 */
export function inWater(world: PhysicsWorld, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - HALF_WIDTH + 0.001);
  const x1 = Math.floor(x + HALF_WIDTH - 0.001);
  const y0 = Math.floor(y + 0.4 + 0.001);
  const y1 = Math.floor(y + HEIGHT - 0.4 - 0.001);
  const z0 = Math.floor(z - HALF_WIDTH + 0.001);
  const z1 = Math.floor(z + HALF_WIDTH - 0.001);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      for (let cz = z0; cz <= z1; cz++) if (world.water(cx, cy, cz)) return true;
    }
  }
  return false;
}

/**
 * The cells a box with its feet at (x, y, z) overlaps by more than `tolerance` on every axis
 * (touching a face is not overlapping), as [x0, x1, y0, y1, z0, z1] inclusive.
 */
export function overlappedCells(
  x: number,
  y: number,
  z: number,
  tolerance = 1e-7,
): [number, number, number, number, number, number] {
  return [
    Math.floor(x - HALF_WIDTH + tolerance),
    Math.ceil(x + HALF_WIDTH - tolerance) - 1,
    Math.floor(y + tolerance),
    Math.ceil(y + HEIGHT - tolerance) - 1,
    Math.floor(z - HALF_WIDTH + tolerance),
    Math.ceil(z + HALF_WIDTH - tolerance) - 1,
  ];
}
