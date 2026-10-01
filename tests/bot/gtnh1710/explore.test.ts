import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { chooseHop, exploreGoal, MIN_HOP_PROGRESS } from '../../../src/bot/gtnh1710/explore.ts';
import { planTerrainWalk } from '../../../src/bot/gtnh1710/terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, water: 9, lava: 11 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
]);

/** Ground from a height map (grass on top), with single blocks overridden. */
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
    blockName: (id) => (id === 0 ? 'minecraft:air' : NAMES.get(id)),
    hazardCode: (id) => (id === ID.lava ? BLOCK_CODE.lava : BLOCK_CODE.safe),
  };
}

const FENCE: Fence = { min: { x: -8, y: 60, z: -8 }, max: { x: 8, y: 70, z: 8 } };
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

describe('choosing the next hop', () => {
  const flat = terrain(() => 63);

  it('goes as far toward the goal as the play area and the walk length allow', () => {
    const r = chooseHop(flat, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -50 }, 32);
    if (!r.ok) throw new Error(r.reason);
    const best = r.candidates[0];
    expect(best?.target).toEqual(at(0.5, 64, -7.5)); // the area's north edge
    // The walker itself plans every candidate within the limit.
    for (const c of r.candidates) {
      expect(planTerrainWalk(flat, FENCE, at(0.5, 64, 0.5), c.target, 32).ok).toBe(true);
    }
    const short = chooseHop(flat, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -50 }, 6);
    if (!short.ok) throw new Error(short.reason);
    expect(short.candidates[0]?.length).toBeLessThanOrEqual(6);
    expect(planTerrainWalk(flat, FENCE, at(0.5, 64, 0.5), short.candidates[0]!.target, 6).ok).toBe(
      true,
    );
  });

  it('climbs and drops like the walker, and goes around water', () => {
    // A pond across the way north (z -3..-1, x -4..4); the hill beyond it is one block up.
    const pond: Record<string, number> = {};
    for (let x = -4; x <= 4; x++) for (let z = -3; z <= -1; z++) pond[`${x},63,${z}`] = ID.water;
    const w = terrain((_x, z) => (z <= -5 ? 64 : 63), pond);
    const r = chooseHop(w, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -40 }, 40);
    if (!r.ok) throw new Error(r.reason);
    const best = r.candidates[0];
    expect(best?.target.z).toBe(-7.5);
    expect(best?.target.y).toBe(65);
    const plan = planTerrainWalk(w, FENCE, at(0.5, 64, 0.5), best!.target, 40);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.moves.some((m) => m.kind === 'step-up')).toBe(true);
      // Around the pond, never through it.
      for (const m of plan.moves) {
        expect(w.blockAt(Math.floor(m.to.x), 63, Math.floor(m.to.z))).not.toBe(ID.water);
      }
    }
  });

  it('refuses when nothing gets closer: water all across, a hazard, or the goal behind a wall', () => {
    const lake: Record<string, number> = {};
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= -2; z++) lake[`${x},63,${z}`] = ID.water;
    const r = chooseHop(
      terrain(() => 63, lake),
      FENCE,
      at(0.5, 64, 0.5),
      { x: 0.5, z: -40 },
      32,
    );
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? '' : r.reason).toMatch(/no walkable spot in the play area gets closer/);
    // Standing next to lava: no walk starts.
    const hot = terrain(() => 63, { '1,63,0': ID.lava });
    expect(chooseHop(hot, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -40 }, 32)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/cannot walk from here/) as string,
    });
    // A cliff two blocks high all along z = -2: the north is out of reach.
    const cliff = terrain((_x, z) => (z <= -2 ? 66 : 63));
    expect(chooseHop(cliff, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -40 }, 32).ok).toBe(false);
  });

  it('every hop gets at least MIN_HOP_PROGRESS closer, and skips spots already tried', () => {
    const r = chooseHop(flat, FENCE, at(0.5, 64, 0.5), { x: 0.5, z: -50 }, 32);
    if (!r.ok) throw new Error(r.reason);
    for (const c of r.candidates) {
      expect(c.distanceToGoal).toBeLessThanOrEqual(50.5 - MIN_HOP_PROGRESS);
    }
    const again = chooseHop(
      flat,
      FENCE,
      at(0.5, 64, 0.5),
      { x: 0.5, z: -50 },
      32,
      new Set(['0,64,-8']),
    );
    if (!again.ok) throw new Error(again.reason);
    expect(again.candidates[0]?.target).not.toEqual(at(0.5, 64, -7.5));
  });
});
