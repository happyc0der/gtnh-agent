import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import type { DigArea } from '../../../src/bot/gtnh1710/digging.ts';
import { planTunnel, TUNNEL_SEGMENT } from '../../../src/bot/gtnh1710/tunnel.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, dirt: 3, water: 9, gravel: 13 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
  [ID.water, 'minecraft:water'],
  [ID.gravel, 'minecraft:gravel'],
]);
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * Flat land: grass at y=63, dirt at 60-62, stone below, air above; the tunnel starts in a
 * hole two high at (0, 61, 0), where the player stands, plus `blocks`.
 */
function land(blocks: Record<string, number> = {}): WalkWorld {
  const overrides = new Map(
    Object.entries({ [k(0, 61, 0)]: ID.air, [k(0, 62, 0)]: ID.air, ...blocks }),
  );
  return {
    blockAt(x, y, z) {
      const o = overrides.get(k(x, y, z));
      if (o !== undefined) return o;
      if (y === 63) return ID.grass;
      if (y >= 60 && y < 63) return ID.dirt;
      return y < 60 ? ID.stone : ID.air;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    metaAt: () => 0,
    hazardCode: (id) => (id === 0 || NAMES.has(id) ? BLOCK_CODE.safe : BLOCK_CODE.unknown),
  };
}

const AREA: DigArea = {
  fence: { min: { x: -20, y: 40, z: -20 }, max: { x: 20, y: 90, z: 20 } },
  maxHeightAboveFence: 4,
};
const START = { x: 0, y: 61, z: 0 };
const FEET: Vec3 = { x: 0.5, y: 61, z: 0.5 };
/** The cells dug from the start up to x = `n` (east), the player then standing in the last. */
const dugTo = (n: number): Record<string, number> => {
  const out: Record<string, number> = {};
  for (let i = 1; i <= n; i++) {
    out[k(i, 61, 0)] = ID.air;
    out[k(i, 62, 0)] = ID.air;
  }
  return out;
};

describe('a tunnel one wide and two high, as Baritone digs one (tunnel.ts)', () => {
  it('digs the head block, then the feet block, then steps in, a few cells at a time', () => {
    const plan = planTunnel(land(), FEET, START, 'east', 10, { area: AREA });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.done).toBe(0);
    expect(plan.problem).toBeNull();
    expect(plan.steps.map((s) => s.spec)).toEqual(
      Array.from({ length: TUNNEL_SEGMENT }, (_, i) => [
        { type: 'DIG_BLOCK', args: { position: { x: i + 1, y: 62, z: 0 } } },
        { type: 'DIG_BLOCK', args: { position: { x: i + 1, y: 61, z: 0 } } },
        {
          type: 'MOVE_TO',
          args: { target: { x: i + 1.5, y: 61, z: 0.5 }, tolerance: 0.5 },
        },
      ]).flat(),
    );
    expect(plan.steps[0]?.text).toBe(
      'dig the minecraft:dirt at (1, 62, 0) (the head of (1, 61, 0))',
    );
  });

  it('goes on from where the player stands, skips what is already open, and ends at its length', () => {
    // Three cells dug, the fourth's head already open (a cave's roof, say).
    const world = land({ ...dugTo(3), [k(4, 62, 0)]: ID.air });
    const at = { x: 3.5, y: 61, z: 0.5 };
    const plan = planTunnel(world, at, START, 'east', 5, { area: AREA });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.done).toBe(3);
    expect(plan.steps.map((s) => s.spec.type)).toEqual([
      'DIG_BLOCK', // (4, 61, 0): its head was open
      'MOVE_TO',
      'DIG_BLOCK',
      'DIG_BLOCK',
      'MOVE_TO',
    ]);
    const end = planTunnel(land(dugTo(5)), { x: 5.5, y: 61, z: 0.5 }, START, 'east', 5, {
      area: AREA,
    });
    expect(end).toEqual({ ok: true, done: 5, steps: [], problem: null });
  });

  it('stops, and says why, at an open floor, water, gravel above, or a block it cannot harvest', () => {
    const stopsAt = (blocks: Record<string, number>, canHarvest?: (b: string) => string | null) => {
      const plan = planTunnel(land(blocks), FEET, START, 'east', 10, {
        area: AREA,
        ...(canHarvest === undefined ? {} : { canHarvest }),
      });
      if (!plan.ok) throw new Error(plan.reason);
      return {
        moves: plan.steps.filter((s) => s.spec.type === 'MOVE_TO').length,
        why: plan.problem,
      };
    };
    expect(stopsAt({ [k(3, 60, 0)]: ID.air })).toEqual({
      moves: 2,
      why: 'the tunnel stops before (3, 61, 0): the floor at (3, 60, 0) is open (a cave or a drop ahead)',
    });
    const wet = stopsAt({ [k(2, 61, 1)]: ID.water });
    expect(wet.moves).toBe(1);
    expect(wet.why).toMatch(/^the tunnel stops before \(2, 61, 0\): .*minecraft:water/);
    const gravel = stopsAt({ [k(2, 63, 0)]: ID.gravel });
    expect(gravel.moves).toBe(1);
    expect(gravel.why).toMatch(/minecraft:gravel on top of \(2, 62, 0\) would fall into the hole/);
    const noPickaxe = (b: string): string | null =>
      b === 'minecraft:stone' ? 'it needs a pickaxe, and the player carries none' : null;
    expect(stopsAt({ [k(1, 61, 0)]: ID.stone }, noPickaxe)).toEqual({
      moves: 0,
      why: 'the tunnel stops before (1, 61, 0): (1, 61, 0): it needs a pickaxe, and the player carries none',
    });
  });

  it('going down, a staircase: one forward and one down each, three blocks dug, the top first', () => {
    // From the surface: the player on the grass at (0, 64, 0), stairs east into the ground.
    const surface = land({ [k(0, 61, 0)]: ID.dirt, [k(0, 62, 0)]: ID.dirt });
    const top = { x: 0, y: 64, z: 0 };
    const plan = planTunnel(
      surface,
      { x: 0.5, y: 64, z: 0.5 },
      top,
      'east',
      3,
      { area: AREA },
      'down',
    );
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.problem).toBeNull();
    expect(plan.steps.map((s) => s.spec)).toEqual([
      // (1, 63, 0): the grass it steps down into; above it is air already.
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 63, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 1.5, y: 63, z: 0.5 }, tolerance: 0.5 } },
      { type: 'DIG_BLOCK', args: { position: { x: 2, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 2, y: 62, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 2.5, y: 62, z: 0.5 }, tolerance: 0.5 } },
      { type: 'DIG_BLOCK', args: { position: { x: 3, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 3, y: 62, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 3, y: 61, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 3.5, y: 61, z: 0.5 }, tolerance: 0.5 } },
    ]);
    // Halfway down, it goes on from its step: the level the cells dug so far reach.
    const half = planTunnel(
      land({ [k(1, 63, 0)]: ID.air, [k(2, 63, 0)]: ID.air, [k(2, 62, 0)]: ID.air }),
      { x: 2.5, y: 62, z: 0.5 },
      top,
      'east',
      3,
      { area: AREA },
      'down',
    );
    expect(half).toMatchObject({ ok: true, done: 2 });
    // A cave under the next step: it stops before stepping down into it.
    const cave = planTunnel(
      land({ [k(1, 62, 0)]: ID.air }),
      { x: 0.5, y: 64, z: 0.5 },
      top,
      'east',
      3,
      { area: AREA },
      'down',
    );
    expect(cave).toMatchObject({
      ok: true,
      steps: [],
      problem:
        'the tunnel stops before (1, 63, 0): the floor at (1, 62, 0) is open (a cave or a drop ahead)',
    });
  });

  it('only from the tunnel line: the start level, its row, at or past its start', () => {
    for (const feet of [
      { x: 0.5, y: 61, z: 1.5 },
      { x: 0.5, y: 62, z: 0.5 },
      { x: -0.5, y: 61, z: 0.5 },
    ]) {
      const plan = planTunnel(land(), feet, START, 'east', 4, { area: AREA });
      expect(plan.ok).toBe(false);
      expect(plan.ok ? '' : plan.reason).toMatch(
        /is not in the tunnel's line from \(0, 61, 0\) east$/,
      );
    }
  });
});
