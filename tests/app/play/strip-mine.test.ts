import { describe, expect, it } from 'vitest';
import {
  firstLeg,
  nextLeg,
  STRIP_LEG,
  stripDirection,
  waysByRoom,
  stripLevel,
  type StripState,
} from '../../../src/app/play/strip-mine.ts';

describe('strip mining (Baritone legitMine, the idea)', () => {
  it('tunnels where the most vein weight lies, no lower than the boundary, the highest of equals', () => {
    const veins = [
      { minY: 5, maxY: 60, weight: 80 },
      { minY: 60, maxY: 180, weight: 30 },
    ];
    // y 60 is in both: 110.
    expect(stripLevel(veins, 100, 40)).toBe(60);
    // Below the boundary nothing counts; above the feet nothing is dug up to.
    expect(stripLevel([{ minY: 5, maxY: 20, weight: 50 }], 100, 40)).toBeNull();
    expect(stripLevel([{ minY: 120, maxY: 180, weight: 50 }], 100, 40)).toBeNull();
    // Within the vein's heights already: a little under the feet, in the ground.
    expect(stripLevel([{ minY: 30, maxY: 80, weight: 10 }], 70, 40)).toBe(64);
  });

  it('digs stairs down to the level, then level legs; a blocked leg turns clockwise', () => {
    const feet = { x: 0, y: 100, z: 0 };
    expect(firstLeg(feet, 60, 'east')).toEqual({
      start: feet,
      direction: 'east',
      slope: 'down',
      length: 40,
    });
    const s0: StripState = { level: 60, leg: firstLeg(feet, 60, 'east'), dug: 0, turns: 0 };
    // The stairs reached the level: a level tunnel the same way, from there.
    const s1 = nextLeg(s0, { x: 40, y: 60, z: 0 }, 40, false);
    expect(s1).toEqual({
      level: 60,
      leg: { start: { x: 40, y: 60, z: 0 }, direction: 'east', slope: 'level', length: STRIP_LEG },
      dug: 40,
      turns: 0,
    });
    // Blocked after 5 cells (lava ahead): south from where it stands, a first turn.
    const s2 = nextLeg(s1, { x: 45, y: 60, z: 0 }, 5, true);
    expect(s2.leg).toMatchObject({ direction: 'south', slope: 'level' });
    expect([s2.dug, s2.turns]).toEqual([45, 1]);
    // Blocked at once again: turns in a row add up.
    const s3 = nextLeg(s2, { x: 45, y: 60, z: 0 }, 0, true);
    expect([s3.leg.direction, s3.turns]).toEqual(['west', 2]);
  });

  it('starts the way with the most room to the boundary', () => {
    const rooms: Record<string, number> = { north: 40, east: 200, south: 90, west: 10 };
    expect(stripDirection((d) => rooms[d])).toBe('east');
    expect(stripDirection(() => undefined)).toBe('north');
  });

  it('orders the ways by room for a tunnel whose owner named none: unknown ones last', () => {
    const rooms: Record<string, number> = { south: 90, east: 200 };
    expect(waysByRoom((d) => rooms[d])).toEqual(['east', 'south', 'north', 'west']);
    expect(waysByRoom(() => 50)).toEqual(['north', 'east', 'south', 'west']);
  });
});
