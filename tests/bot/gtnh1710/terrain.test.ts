import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import {
  bodyProblem,
  checkSupport,
  fallDistances,
  landingHazard,
  MAX_DROP,
  planTerrainWalk,
  terrainSteps,
  type TerrainMove,
} from '../../../src/bot/gtnh1710/terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, water: 9, lava: 11, tallgrass: 31 } as const;
const NAMES = new Map<number, string>([
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
  [ID.tallgrass, 'minecraft:tallgrass'],
]);

/**
 * Terrain from a height map: column (x, z) is solid up to and including `height(x, z)`
 * (grass on top, stone below), then air; `blocks` overrides single blocks.
 */
function terrain(
  height: (x: number, z: number) => number,
  blocks: Record<string, number> = {},
): WalkWorld {
  return {
    blockAt(x, y, z) {
      const o = blocks[`${x},${y},${z}`];
      if (o !== undefined) return o;
      const h = height(x, z);
      return y > h ? ID.air : y === h ? ID.grass : ID.stone;
    },
    blockName: (id) => NAMES.get(id),
    hazardCode: (id) => (id === ID.lava ? BLOCK_CODE.lava : BLOCK_CODE.safe),
  };
}

const FENCE: Fence = { min: { x: -8, y: 60, z: -8 }, max: { x: 8, y: 70, z: 8 } };
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const kinds = (moves: TerrainMove[]): string[] => moves.map((m) => m.kind);

function mustPlan(w: WalkWorld, from: Vec3, to: Vec3) {
  const plan = planTerrainWalk(w, FENCE, from, to, 64);
  if (!plan.ok) throw new Error(plan.reason);
  return plan;
}

describe('terrain planning', () => {
  it('walks level ground', () => {
    const plan = mustPlan(
      terrain(() => 63),
      at(0.5, 64, 0.5),
      at(3.5, 64, 0.5),
    );
    expect(new Set(kinds(plan.moves))).toEqual(new Set(['walk']));
    expect(plan.moves.at(-1)?.to).toEqual(at(3.5, 64, 0.5));
  });

  it('steps up one block and drops down two', () => {
    // A plateau one block higher at x >= 2, and a pit two blocks lower at x <= -2.
    const w = terrain((x) => (x >= 2 ? 64 : x <= -2 ? 61 : 63));
    const up = mustPlan(w, at(0.5, 64, 0.5), at(3.5, 65, 0.5));
    expect(kinds(up.moves)).toContain('step-up');
    const down = mustPlan(w, at(0.5, 64, 0.5), at(-3.5, 62, 0.5));
    expect(down.moves.find((m) => m.kind === 'drop')).toMatchObject({ kind: 'drop', height: 2 });
  });

  it('never climbs two blocks or drops more than MAX_DROP', () => {
    const wall = terrain((x) => (x >= 2 ? 65 : 63)); // a two-block wall
    expect(planTerrainWalk(wall, FENCE, at(0.5, 64, 0.5), at(3.5, 66, 0.5), 64)).toMatchObject({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence',
    });
    const cliff = terrain((x) => (x <= -2 ? 63 - (MAX_DROP + 1) : 63));
    expect(
      planTerrainWalk(cliff, FENCE, at(0.5, 64, 0.5), at(-3.5, 64 - (MAX_DROP + 1), 0.5), 64).ok,
    ).toBe(false);
  });

  it('needs headroom to step up', () => {
    // A block above the start's head: no jump possible there.
    const w = terrain((x) => (x >= 1 ? 64 : 63), { '0,66,0': ID.stone });
    const plan = planTerrainWalk(
      w,
      { ...FENCE, min: { ...FENCE.min, z: 0 }, max: { ...FENCE.max, z: 0 } },
      at(0.5, 64, 0.5),
      at(1.5, 65, 0.5),
      64,
    );
    expect(plan.ok).toBe(false);
  });

  it('walks through tall grass, never into water or next to lava', () => {
    const grassy = terrain(() => 63, { '1,64,0': ID.tallgrass, '1,65,0': ID.air });
    expect(mustPlan(grassy, at(0.5, 64, 0.5), at(2.5, 64, 0.5)).ok).toBe(true);
    // A water trench across z=0..; the only way is around (fence limits z to 0..1 here).
    const strip: Fence = { min: { x: -8, y: 60, z: 0 }, max: { x: 8, y: 70, z: 0 } };
    const wet = terrain(() => 63, { '1,64,0': ID.water });
    expect(planTerrainWalk(wet, strip, at(0.5, 64, 0.5), at(2.5, 64, 0.5), 64).ok).toBe(false);
    const hot = terrain(() => 63, { '3,63,0': ID.lava });
    expect(planTerrainWalk(hot, strip, at(0.5, 64, 0.5), at(2.5, 64, 0.5), 64)).toMatchObject({
      ok: false,
    });
  });
});

describe('terrain steps', () => {
  it('a step up rises in place, crosses above the block, and settles on it', () => {
    const w = terrain((x) => (x >= 1 ? 64 : 63));
    const plan = mustPlan(w, at(0.5, 64, 0.5), at(1.5, 65, 0.5));
    const steps = terrainSteps(at(0.5, 64, 0.5), plan.moves);
    const firstMoveAcross = steps.findIndex((s) => s.pos.x > 0.5 + 1e-9);
    // Before moving across, the feet are already above the step's top (65).
    expect(steps[firstMoveAcross]?.pos.y).toBeGreaterThan(65);
    expect(steps.at(-1)).toEqual({ pos: at(1.5, 65, 0.5), onGround: true });
    for (const s of steps) expect(bodyProblem(w, FENCE, s.pos)).toBeNull();
  });

  it('a drop crosses the edge at its height, falls with gravity, and lands exactly', () => {
    const w = terrain((x) => (x <= -1 ? 61 : 63));
    const plan = mustPlan(w, at(0.5, 64, 0.5), at(-0.5, 62, 0.5));
    const steps = terrainSteps(at(0.5, 64, 0.5), plan.moves);
    const falling = steps.filter((s) => s.pos.y < 64);
    const drops = falling.map((s, i) => (i === 0 ? 64 - s.pos.y : falling[i - 1]!.pos.y - s.pos.y));
    for (let i = 1; i < drops.length - 1; i++) expect(drops[i]!).toBeGreaterThan(drops[i - 1]!); // accelerating
    expect(steps.at(-1)).toEqual({ pos: at(-0.5, 62, 0.5), onGround: true });
    expect(falling.slice(0, -1).every((s) => !s.onGround)).toBe(true);
    for (const s of steps) expect(bodyProblem(w, FENCE, s.pos)).toBeNull();
  });

  it('moves at most 0.2 blocks sideways per tick', () => {
    const w = terrain((x) => (x >= 2 ? 64 : x <= -2 ? 62 : 63));
    const plan = mustPlan(w, at(-3.5, 63, 0.5), at(3.5, 65, 0.5));
    let prev = at(-3.5, 63, 0.5);
    for (const s of terrainSteps(prev, plan.moves)) {
      expect(Math.hypot(s.pos.x - prev.x, s.pos.z - prev.z)).toBeLessThanOrEqual(0.2 + 1e-9);
      prev = s.pos;
    }
  });
});

describe('gravity: what holds the player up', () => {
  const flat = terrain(() => 63); // grass at y 63: feet stand at 64

  it("a player on the ground, or within the server's 0.55 margin above it, is held up", () => {
    expect(checkSupport(flat, at(0.5, 64, 0.5))).toEqual({ kind: 'supported' });
    expect(checkSupport(flat, at(0.5, 64.5, 0.5))).toEqual({ kind: 'supported' });
    // A block one level up beside the player: hanging next to it is not held up by it, but
    // standing over its edge (the box reaches into its column) is.
    const step = terrain(() => 63, { '1,64,0': ID.stone });
    expect(checkSupport(step, at(0.5, 65, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    expect(checkSupport(step, at(0.9, 65, 0.5))).toEqual({ kind: 'supported' });
  });

  it('a player left in the air by a stopped jump falls to the block below', () => {
    expect(checkSupport(flat, at(0.5, 64.83, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    expect(checkSupport(flat, at(0.5, 66.5, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    // Tall grass does not stop a fall, but it holds the player up for the server (not air).
    const grassy = terrain(() => 63, { '0,64,0': ID.tallgrass });
    expect(checkSupport(grassy, at(0.5, 64.83, 0.5))).toEqual({ kind: 'supported' });
  });

  it('finds no floor when it is deeper than a safe fall, and nothing when chunks are missing', () => {
    expect(checkSupport(flat, at(0.5, 70, 0.5))).toEqual({ kind: 'floating', landY: null });
    const unloaded: WalkWorld = { ...flat, blockAt: () => undefined };
    expect(checkSupport(unloaded, at(0.5, 64.83, 0.5))).toEqual({ kind: 'unknown' });
  });

  it('falls with vanilla gravity and flags lava next to the landing', () => {
    const d = fallDistances(0.83);
    expect(d.at(-1)).toBeCloseTo(0.83, 9);
    expect(d.every((x, i) => i === 0 || x > (d[i - 1] ?? 0))).toBe(true);
    expect(landingHazard(flat, 0, 64, 0)).toBeNull();
    expect(
      landingHazard(
        terrain(() => 63, { '1,64,0': ID.lava }),
        0,
        64,
        0,
      ),
    ).toMatch(/lava/);
  });
});
