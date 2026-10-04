import { describe, expect, it } from 'vitest';
import {
  ASCEND_TICKS,
  LEVEL_JUMP_TICKS,
  SPRINT_JUMP_REACH,
  SPRINT_ONE_BLOCK,
  WADE_ONE_BLOCK,
  WALK_JUMP_REACH,
  WALK_ONE_BLOCK,
  waterLanding,
} from '../../../../src/bot/gtnh1710/pathing/costs.ts';
import {
  blocksX,
  blocksZ,
  FallAccount,
  fallDamage,
  fallDepths,
  fallLandingTick,
  inWater,
  jumpHeights,
  jumpLandingTick,
  moveY,
  SPRINT_SPEED,
  WADE_SPEED,
  WALK_SPEED,
  type PhysicsWorld,
} from '../../../../src/bot/gtnh1710/pathing/physics.ts';

/** Solid cells from a set of "x,y,z" keys, water from another. */
function cells(solid: string[], water: string[] = []): PhysicsWorld {
  const s = new Set(solid);
  const w = new Set(water);
  return {
    solid: (x, y, z) => s.has(`${x},${y},${z}`),
    water: (x, y, z) => w.has(`${x},${y},${z}`),
    liquid: (x, y, z) => w.has(`${x},${y},${z}`),
  };
}

describe('1.7.10 movement physics', () => {
  it('walks at 4.317 blocks a second, sprints at 5.612 and wades at 1.96', () => {
    expect(WALK_SPEED * 20).toBeCloseTo(4.317, 3);
    expect(SPRINT_SPEED * 20).toBeCloseTo(5.612, 3);
    expect(WADE_SPEED * 20).toBeCloseTo(1.96, 3);
    // The cost of a block, in ticks: Baritone's 20 / 4.317 and 20 / 5.612 come out of the same physics.
    expect(WALK_ONE_BLOCK).toBeCloseTo(20 / 4.317, 2);
    expect(SPRINT_ONE_BLOCK).toBeCloseTo(20 / 5.612, 2);
    expect(WADE_ONE_BLOCK).toBeCloseTo(10.2, 1);
  });

  it('jumps 0.42, peaks at 1.25 and comes down on a block one higher at tick 9, the same level at 12', () => {
    const arc = jumpHeights(12);
    expect(arc[0]).toBeCloseTo(0.42, 6);
    expect(arc[1]).toBeCloseTo(0.7532, 4);
    expect(Math.max(...arc)).toBeCloseTo(1.2522, 4);
    expect(ASCEND_TICKS).toBe(9);
    expect(LEVEL_JUMP_TICKS).toBe(12);
    // A block 3 above the feet stops the head: the feet peak at 1.2 and land on the step at 7.
    expect(jumpLandingTick(1, 1.2)).toBe(7);
  });

  it('falls with vanilla gravity: 0.0784 first, landing 1, 2 and 3 blocks down at ticks 5, 7, 9', () => {
    const d = fallDepths(9);
    expect(d[0]).toBeCloseTo(0.0784, 6);
    expect(d[1]).toBeCloseTo(0.0784 + 0.155232, 5);
    expect([1, 2, 3, 4].map(fallLandingTick)).toEqual([5, 7, 9, 10]);
  });

  it('a fall of 3 does no damage, 4 deals 1 (the landing tick does not count)', () => {
    expect(fallDamage(3)).toBe(0);
    expect(fallDamage(3.0001)).toBe(1);
    const land = (height: number): number => {
      const account = new FallAccount();
      const depths = fallDepths(fallLandingTick(height));
      let damage = 0;
      let at = 0;
      depths.forEach((d, i) => {
        const last = i === depths.length - 1;
        const y = last ? height : d;
        damage += account.packet(false, -(y - at), last);
        at = y;
      });
      return damage;
    };
    expect(land(2)).toBe(0);
    expect(land(3)).toBe(0);
    expect(land(4)).toBe(1);
    expect(land(5)).toBe(2);
  });

  it('one-deep water saves a fall only when a tick before the landing is in it', () => {
    // The box counts as in water below 0.6 over the floor; the server resets the fall only
    // for a packet whose last position was in water.
    const safe = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 15, 16, 19];
    const hurts = [4, 12, 13, 14, 17, 18, 20];
    for (const h of safe) expect(waterLanding(h).damage, `from ${h}`).toBe(0);
    for (const h of hurts) expect(waterLanding(h).damage, `from ${h}`).toBeGreaterThan(0);
    // A packet from inside the water resets the account.
    const a = new FallAccount();
    a.packet(false, -5, false);
    expect(a.packet(true, -0.5, true)).toBe(0);
  });

  it('a running jump carries 2.0 blocks walking and 3.6 sprinting', () => {
    expect(WALK_JUMP_REACH).toBeGreaterThan(2.0);
    expect(WALK_JUMP_REACH).toBeLessThan(2.1);
    expect(SPRINT_JUMP_REACH).toBeGreaterThan(3.6);
    expect(SPRINT_JUMP_REACH).toBeLessThan(3.7);
  });

  it("moves Y first, stopped by block tops and bottoms, as the game's calculateYOffset", () => {
    const floor = cells(['0,63,0']);
    expect(moveY(floor, 0.5, 64, 0.5, -0.0784)).toBe(0); // standing: stopped at once
    expect(moveY(floor, 0.5, 64.5, 0.5, -1)).toBeCloseTo(-0.5, 12); // lands on the top
    expect(moveY(floor, 1.5, 64.5, 0.5, -1)).toBe(-1); // not over the block: falls on
    // The box reaches 0.3 each way: over the block's edge it is held.
    expect(moveY(floor, 1.29, 64.5, 0.5, -1)).toBeCloseTo(-0.5, 12);
    expect(moveY(floor, 1.3, 64.5, 0.5, -1)).toBe(-1); // touching is not overlapping
    const ceiling = cells(['0,67,0']);
    expect(moveY(ceiling, 0.5, 64.9, 0.5, 0.42)).toBeCloseTo(67 - 1.8 - 64.9, 12);
  });

  it('a move across is stopped by a block ahead overlapping the box, not by one it touches', () => {
    const wall = cells(['1,64,0', '0,64,1']);
    expect(blocksX(wall, 0.5, 64, 0.5, 0.25)).toBe(true);
    expect(blocksX(wall, 0.5, 64, 0.5, 0.2)).toBe(false); // ends touching it
    expect(blocksX(wall, 0.5, 65, 0.5, 0.25)).toBe(false); // above it
    expect(blocksX(wall, 0.5, 64, 1.7, 0.25)).toBe(false); // beside it
    expect(blocksZ(wall, 0.5, 64, 0.5, 0.25)).toBe(true);
    expect(blocksZ(wall, 0.5, 64, 0.5, -0.25)).toBe(false);
  });

  it('is in water when the box shrunk by 0.4 top and bottom overlaps a water block', () => {
    const pool = cells([], ['0,64,0']);
    expect(inWater(pool, 0.5, 64, 0.5)).toBe(true);
    expect(inWater(pool, 0.5, 64.59, 0.5)).toBe(true);
    expect(inWater(pool, 0.5, 64.61, 0.5)).toBe(false);
    expect(inWater(pool, 0.5, 62.7, 0.5)).toBe(true); // the head in it
    expect(inWater(pool, 1.31, 64, 0.5)).toBe(false);
  });
});
