import { describe, expect, it } from 'vitest';
import { exploreGoal } from '../../../src/bot/gtnh1710/explore.ts';
import type { Vec3 } from '../../../src/bot/gtnh1710/walking.ts';

const BOX = { min: { x: -100, y: 0, z: -100 }, max: { x: 100, y: 255, z: 100 } };
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('where EXPLORE heads', () => {
  it('a direction: maxDistance that way, pulled in to stay inside the boundary', () => {
    expect(exploreGoal(at(0.5, 64, 0.5), 'north', 64, BOX)).toEqual({
      x: 0.5,
      z: 0.5 - 64,
      clipped: false,
    });
    const ne = exploreGoal(at(0, 64, 0), 'north_east', 10, BOX);
    expect(ne.x).toBeCloseTo(10 / Math.SQRT2, 9);
    expect(ne.z).toBeCloseTo(-10 / Math.SQRT2, 9);
    // 1.5 blocks inside the edge at x = 100.
    expect(exploreGoal(at(90.5, 64, 0.5), 'east', 96, BOX)).toEqual({
      x: 98.5,
      z: 0.5,
      clipped: true,
    });
  });

  it('a point: the point itself, pulled in the same way', () => {
    expect(exploreGoal(at(0, 64, 0), { x: 40, z: -30 }, 32, BOX)).toEqual({
      x: 40,
      z: -30,
      clipped: false,
    });
    expect(exploreGoal(at(0, 64, 0), { x: 400, z: -30 }, 32, BOX)).toEqual({
      x: 98.5,
      z: -30,
      clipped: true,
    });
  });
});
