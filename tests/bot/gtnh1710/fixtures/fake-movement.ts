import { PASSABLE_BLOCKS, PASSABLE_BY_METADATA } from '../../../../src/bot/gtnh1710/passable.ts';

/**
 * The server side of a player's moves, as a 1.7.10 server checks them
 * (NetHandlerPlayServer.processPlayer, from the vanilla server jar the test server runs), so a
 * walk on the fake server is accepted or corrected the way the real one would treat it:
 *  - after an S08 placement the server ignores position packets until the client echoes it
 *    (x and z exactly, y within 0.1);
 *  - otherwise each position packet is a move from the last position the server accepted: it
 *    moves the player's box (0.6 x 1.8) by the difference with the world's collisions (the Y
 *    move first, then X, then Z, each stopped by the boxes of the blocks it would enter), and
 *    resets the player to the last position (S08) when the box was clear before and either
 *    the move ends more than 0.25 away horizontally from where the packet says ("moved
 *    wrongly"; the vertical difference is ignored) or the box, shrunk by 0.0625, overlaps a
 *    block where the packet puts it;
 *  - the fall accounting (Entity.updateFallState): a packet in the air adds its drop to the
 *    fall distance, one on the ground deals ceil(distance - 3) damage and resets it; a player
 *    whose last position was in water has it reset first.
 * Blocks with a collision box: every block but air, the plants the walker passes (passable.ts,
 * which lists blocks with no box), fluids, fire and thin snow. Unloaded columns are solid.
 * Not modelled: the step-up assist (no block here is a slab), the "moved too quickly" check
 * (no walk comes near it) and the floating kick (the test server allows flight).
 */

export interface FakeMoveWorld {
  blockAt(x: number, y: number, z: number): number;
  blockName(id: number): string | undefined;
}

export interface FakeMovePacket {
  x: number;
  feetY: number;
  z: number;
  onGround: boolean;
}

/** Blocks with no collision box besides the passable plants. */
const NO_BOX: ReadonlySet<string> = new Set([
  'minecraft:air',
  'minecraft:water',
  'minecraft:flowing_water',
  'minecraft:lava',
  'minecraft:flowing_lava',
  'minecraft:fire',
  'minecraft:snow_layer',
  'minecraft:torch',
]);
const WATER: ReadonlySet<string> = new Set(['minecraft:water', 'minecraft:flowing_water']);

const HALF = 0.3;
const HEIGHT = 1.8;
/** The box is shrunk by this much on every side for the collision test after a move. */
const CONTRACT = 0.0625;

interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const boxAt = (x: number, y: number, z: number): Box => ({
  minX: x - HALF,
  minY: y,
  minZ: z - HALF,
  maxX: x + HALF,
  maxY: y + HEIGHT,
  maxZ: z + HALF,
});

export class FakeMoveSim {
  /** Moves the server reset, and why. */
  readonly corrections: Array<{
    from: { x: number; y: number; z: number };
    to: { x: number; y: number; z: number };
    reason: string;
  }> = [];
  /** Landings that dealt fall damage. */
  readonly falls: Array<{ distance: number; damage: number }> = [];
  /** Position packets the server ignored while it waited for the echo of a placement. */
  ignored = 0;
  readonly #world: FakeMoveWorld;
  /** Where the server has the player (its feet), and whether it waits for an echo. */
  #last: { x: number; y: number; z: number } | null = null;
  #awaitingEcho = false;
  #fallDistance = 0;

  constructor(world: FakeMoveWorld) {
    this.#world = world;
  }

  /** The server's own position for the player (its feet), or null before the join. */
  get position(): { x: number; y: number; z: number } | null {
    return this.#last === null ? null : { ...this.#last };
  }

  #solid(x: number, y: number, z: number): boolean {
    const id = this.#world.blockAt(x, y, z);
    if (id === 0) return false;
    const name = this.#world.blockName(id);
    if (name === undefined) return true;
    return !NO_BOX.has(name) && !PASSABLE_BLOCKS.has(name) && !PASSABLE_BY_METADATA.has(name);
  }

  #water(x: number, y: number, z: number): boolean {
    const name = this.#world.blockName(this.#world.blockAt(x, y, z));
    return name !== undefined && WATER.has(name);
  }

  /** The block boxes (unit cubes) that overlap `b` grown by the move (dx, dy, dz). */
  #boxesAround(b: Box, dx: number, dy: number, dz: number): Box[] {
    const out: Box[] = [];
    const x0 = Math.floor(Math.min(b.minX, b.minX + dx));
    const x1 = Math.floor(Math.max(b.maxX, b.maxX + dx));
    const y0 = Math.floor(Math.min(b.minY, b.minY + dy)) - 1;
    const y1 = Math.floor(Math.max(b.maxY, b.maxY + dy));
    const z0 = Math.floor(Math.min(b.minZ, b.minZ + dz));
    const z1 = Math.floor(Math.max(b.maxZ, b.maxZ + dz));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          if (this.#solid(x, y, z)) {
            out.push({ minX: x, minY: y, minZ: z, maxX: x + 1, maxY: y + 1, maxZ: z + 1 });
          }
        }
      }
    }
    return out;
  }

  /** Entity.moveEntity's collisions (AxisAlignedBB.calculate[YXZ]Offset): where the feet end. */
  #move(from: { x: number; y: number; z: number }, dx0: number, dy0: number, dz0: number) {
    let b = boxAt(from.x, from.y, from.z);
    const boxes = this.#boxesAround(b, dx0, dy0, dz0);
    let dy = dy0;
    for (const o of boxes) {
      if (b.maxX > o.minX && b.minX < o.maxX && b.maxZ > o.minZ && b.minZ < o.maxZ) {
        if (dy > 0 && b.maxY <= o.minY) dy = Math.min(dy, o.minY - b.maxY);
        if (dy < 0 && b.minY >= o.maxY) dy = Math.max(dy, o.maxY - b.minY);
      }
    }
    b = { ...b, minY: b.minY + dy, maxY: b.maxY + dy };
    let dx = dx0;
    for (const o of boxes) {
      if (b.maxY > o.minY && b.minY < o.maxY && b.maxZ > o.minZ && b.minZ < o.maxZ) {
        if (dx > 0 && b.maxX <= o.minX) dx = Math.min(dx, o.minX - b.maxX);
        if (dx < 0 && b.minX >= o.maxX) dx = Math.max(dx, o.maxX - b.minX);
      }
    }
    b = { ...b, minX: b.minX + dx, maxX: b.maxX + dx };
    let dz = dz0;
    for (const o of boxes) {
      if (b.maxX > o.minX && b.minX < o.maxX && b.maxY > o.minY && b.minY < o.maxY) {
        if (dz > 0 && b.maxZ <= o.minZ) dz = Math.min(dz, o.minZ - b.maxZ);
        if (dz < 0 && b.minZ >= o.maxZ) dz = Math.max(dz, o.maxZ - b.minZ);
      }
    }
    return { x: from.x + dx, y: from.y + dy, z: from.z + dz };
  }

  /** Whether the box at (x, y, z), shrunk by 0.0625, overlaps a block's box. */
  #colliding(x: number, y: number, z: number): boolean {
    const b = boxAt(x, y, z);
    const minX = b.minX + CONTRACT;
    const maxX = b.maxX - CONTRACT;
    const minY = b.minY + CONTRACT;
    const maxY = b.maxY - CONTRACT;
    const minZ = b.minZ + CONTRACT;
    const maxZ = b.maxZ - CONTRACT;
    for (let cx = Math.floor(minX); cx <= Math.floor(maxX); cx++) {
      for (let cy = Math.floor(minY); cy <= Math.floor(maxY); cy++) {
        for (let cz = Math.floor(minZ); cz <= Math.floor(maxZ); cz++) {
          if (this.#solid(cx, cy, cz)) return true;
        }
      }
    }
    return false;
  }

  /** Entity.handleWaterMovement: the box shrunk by 0.4 at top and bottom touches water. */
  #inWater(p: { x: number; y: number; z: number }): boolean {
    for (let cx = Math.floor(p.x - HALF + 0.001); cx <= Math.floor(p.x + HALF - 0.001); cx++) {
      for (
        let cy = Math.floor(p.y + 0.4 + 0.001);
        cy <= Math.floor(p.y + HEIGHT - 0.4 - 0.001);
        cy++
      ) {
        for (let cz = Math.floor(p.z - HALF + 0.001); cz <= Math.floor(p.z + HALF - 0.001); cz++) {
          if (this.#water(cx, cy, cz)) return true;
        }
      }
    }
    return false;
  }

  /** The server placed the player (S08: the join, a teleport, a correction). */
  placed(x: number, feetY: number, z: number): void {
    this.#last = { x, y: feetY, z };
    this.#awaitingEcho = true;
    this.#fallDistance = 0;
  }

  /**
   * A position packet (C04 or C06). Returns null when the move is accepted (or ignored), or
   * the position the server resets the player to.
   */
  move(p: FakeMovePacket): { x: number; y: number; z: number } | null {
    const last = this.#last;
    if (last === null) return null;
    if (this.#awaitingEcho) {
      const dy = p.feetY - last.y;
      if (p.x === last.x && dy * dy < 0.01 && p.z === last.z) this.#awaitingEcho = false;
      else {
        this.ignored += 1;
        return null;
      }
    }
    const clearBefore = !this.#colliding(last.x, last.y, last.z);
    const moved = this.#move(last, p.x - last.x, p.feetY - last.y, p.z - last.z);
    const off = (p.x - moved.x) ** 2 + (p.z - moved.z) ** 2;
    const wrong = off > 0.0625;
    const collidingAfter = this.#colliding(p.x, p.feetY, p.z);
    if (clearBefore && (wrong || collidingAfter)) {
      const reason = wrong
        ? `moved wrongly (${Math.sqrt(off).toFixed(3)} off)`
        : 'the box ends inside a block';
      this.corrections.push({ from: { ...last }, to: { x: p.x, y: p.feetY, z: p.z }, reason });
      return { ...last };
    }
    // The fall accounting, then the new position.
    if (this.#inWater(last)) this.#fallDistance = 0;
    const drop = p.feetY - last.y;
    if (p.onGround) {
      if (this.#fallDistance > 0) {
        const damage = Math.max(0, Math.ceil(Math.fround(this.#fallDistance) - 3));
        if (damage > 0) this.falls.push({ distance: this.#fallDistance, damage });
      }
      this.#fallDistance = 0;
    } else if (drop < 0) {
      this.#fallDistance -= drop;
    }
    this.#last = { x: p.x, y: p.feetY, z: p.z };
    return null;
  }

  /** A packet without a position (C03, C05): only its onGround counts (the fall accounting). */
  stand(onGround: boolean): void {
    if (this.#last === null || this.#awaitingEcho) return;
    if (onGround) {
      if (this.#fallDistance > 3) {
        const damage = Math.ceil(Math.fround(this.#fallDistance) - 3);
        if (damage > 0) this.falls.push({ distance: this.#fallDistance, damage });
      }
      this.#fallDistance = 0;
    }
  }
}
