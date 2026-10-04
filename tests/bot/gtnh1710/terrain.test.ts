import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { MAX_WALK_BREAKS, walkBreakCost, walkBreaks } from '../../../src/bot/gtnh1710/digging.ts';
import {
  bodyProblem,
  checkSupport,
  edgeLanding,
  restingY,
  standingCell,
  fallDistances,
  landingHazard,
  MAX_DROP,
  planTerrainWalk,
  reachableFeet,
  standProblem,
  terrainSteps,
  type TerrainMove,
  type TerrainPlan,
} from '../../../src/bot/gtnh1710/terrain.ts';
import type { Fence, Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = {
  air: 0,
  stone: 1,
  grass: 2,
  water: 9,
  lava: 11,
  leaves: 18,
  sapling: 6,
  tallgrass: 31,
  foliage: 1102,
} as const;
const NAMES = new Map<number, string>([
  [ID.sapling, 'minecraft:sapling'],
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
  [ID.leaves, 'minecraft:leaves'],
  [ID.tallgrass, 'minecraft:tallgrass'],
  [ID.foliage, 'BiomesOPlenty:foliage'],
]);
/** BiomesOPlenty:foliage variants. */
const SHORT_GRASS = 1;
const POISON_IVY = 7;

/**
 * Terrain from a height map: column (x, z) is solid up to and including `height(x, z)`
 * (grass on top, stone below), then air; `blocks` overrides single blocks, `metas` their
 * metadata (0 elsewhere). Without `metas` the world reports no metadata at all.
 */
function terrain(
  height: (x: number, z: number) => number,
  blocks: Record<string, number> = {},
  metas?: Record<string, number>,
): WalkWorld {
  const world: WalkWorld = {
    blockAt(x, y, z) {
      const o = blocks[`${x},${y},${z}`];
      if (o !== undefined) return o;
      const h = height(x, z);
      return y > h ? ID.air : y === h ? ID.grass : ID.stone;
    },
    blockName: (id) => NAMES.get(id),
    hazardCode: (id) => (id === ID.lava ? BLOCK_CODE.lava : BLOCK_CODE.safe),
  };
  if (metas === undefined) return world;
  return { ...world, metaAt: (x, y, z) => metas[`${x},${y},${z}`] ?? 0 };
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

describe('walking through plants (BOP foliage)', () => {
  // Seen live 2026-10-01: on a Hot Forest hillside the straight line to logs 7 blocks away
  // was blocked three times by BiomesOPlenty:foliage at feet level.
  const from = at(0.5, 64, 0.5);
  const to = at(4.5, 64, 0.5);

  /** A hedge of foliage across x = 2 (the fence's whole width): short grass, but for `other`. */
  function hedge(other: Record<string, number> = {}) {
    const blocks: Record<string, number> = {};
    const metas: Record<string, number> = {};
    for (let z = FENCE.min.z; z <= FENCE.max.z; z++) {
      blocks[`2,64,${z}`] = ID.foliage;
      metas[`2,64,${z}`] = other[`2,64,${z}`] ?? SHORT_GRASS;
    }
    return { blocks, metas };
  }

  it('walks straight through foliage it used to take for a wall', () => {
    const { blocks, metas } = hedge();
    const w = terrain(() => 63, blocks, metas);
    const plan = mustPlan(w, from, to);
    expect(new Set(kinds(plan.moves))).toEqual(new Set(['walk']));
    expect(plan.length).toBeCloseTo(4, 9); // the straight line
    expect(reachableFeet(w, FENCE, from, 64).get('4,64,0')?.length).toBeCloseTo(4, 9);
    expect(standProblem(w, 2, 64, 0)).toBeNull(); // standing in it, too
    // The same hedge where the metadata is not known: a wall, as before.
    const blind = terrain(() => 63, blocks);
    expect(planTerrainWalk(blind, FENCE, from, to, 64)).toMatchObject({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence',
    });
    expect(reachableFeet(blind, FENCE, from, 64).has('4,64,0')).toBe(false);
  });

  it('goes around poison ivy without touching its cell, and stops at a hedge of it', () => {
    const { blocks, metas } = hedge({ '2,64,0': POISON_IVY });
    const w = terrain(() => 63, blocks, metas);
    const plan = mustPlan(w, from, to);
    for (const s of terrainSteps(from, plan.moves)) {
      expect(bodyProblem(w, FENCE, s.pos)).toBeNull();
      const { x, z } = s.pos;
      expect(x + 0.3 > 2 && x - 0.3 < 3 && z + 0.3 > 0 && z - 0.3 < 1, `${x}, ${z}`).toBe(false);
    }
    const reached = reachableFeet(w, FENCE, from, 64);
    expect(reached.has('2,64,0')).toBe(false);
    expect(reached.has('2,64,1')).toBe(true);
    // Ivy beside a stand spot is no hazard: it hurts only a body inside its cell.
    expect(standProblem(w, 1, 64, 0)).toBeNull();
    expect(standProblem(w, 2, 64, 0)).toBe('blocked by BiomesOPlenty:foliage@7');

    const ivy: Record<string, number> = {};
    for (let z = FENCE.min.z; z <= FENCE.max.z; z++) ivy[`2,64,${z}`] = POISON_IVY;
    expect(
      planTerrainWalk(
        terrain(() => 63, blocks, ivy),
        FENCE,
        from,
        to,
        64,
      ).ok,
    ).toBe(false);
  });
});

describe('where a walk can get to (reachableFeet)', () => {
  it("floods the walker's own moves, with the blocks walked, up to the limit", () => {
    const w = terrain((x) => (x >= 3 ? 64 : 63)); // a one-block step up at x = 3
    const r = reachableFeet(w, FENCE, at(0.5, 64, 0.5), 64);
    expect(r.get('0,64,0')?.length).toBe(0);
    expect(r.get('2,64,0')?.length).toBe(2);
    expect(r.get('3,65,0')?.length).toBe(4); // a step up: one across and one up
    expect(r.has('3,64,0')).toBe(false); // inside the step
    // Every spot planTerrainWalk could walk to is in it, and nothing outside the fence.
    expect(r.has('8,65,8')).toBe(true);
    expect(r.has('9,65,0')).toBe(false);
    const near = reachableFeet(w, FENCE, at(0.5, 64, 0.5), 2);
    expect(near.has('2,64,0')).toBe(true);
    expect(near.has('3,65,0')).toBe(false);
    expect([...near.values()].every((n) => n.length <= 2)).toBe(true);
  });

  it('does not get into a pocket walled in by leaves, or anywhere from off a block top', () => {
    const blocks: Record<string, number> = {};
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const y of [64, 65]) blocks[`${5 + dx},${y},${5 + dz}`] = ID.leaves;
      }
    }
    const w = terrain(() => 63, blocks);
    const r = reachableFeet(w, FENCE, at(0.5, 64, 0.5), 64);
    expect(r.has('5,64,5')).toBe(false);
    expect(r.has('3,64,3')).toBe(true);
    expect(planTerrainWalk(w, FENCE, at(0.5, 64, 0.5), at(5.5, 64, 5.5), 64).ok).toBe(false);
    expect(reachableFeet(w, FENCE, at(0.5, 64.5, 0.5), 64).size).toBe(0);
  });
});

describe('breaking leaves on the way (WalkBreaks)', () => {
  const BREAKS = walkBreaks({ fence: FENCE, maxHeightAboveFence: 4 });
  const LEAF = walkBreakCost('minecraft:leaves');
  const FROM = at(0.5, 64, 0.5);
  /** A wall of leaves across the fence at x = 2, `high` blocks tall, open at the `gaps` (z). */
  const wall = (high: number, gaps: number[] = []): Record<string, number> => {
    const blocks: Record<string, number> = {};
    for (let z = FENCE.min.z; z <= FENCE.max.z; z++) {
      if (gaps.includes(z)) continue;
      for (let y = 64; y < 64 + high; y++) blocks[`2,${y},${z}`] = ID.leaves;
    }
    return blocks;
  };
  const planned = (plan: TerrainPlan) => {
    if (!plan.ok) throw new Error(plan.reason);
    return plan;
  };
  const brokenBy = (plan: TerrainPlan) => planned(plan).moves.flatMap((m) => m.breaks ?? []);

  it('costs a leaf its dig time by hand and the wait for the verdict, at the walking pace', () => {
    // (10 ticks of digging + 1 + 5 quiet) x 0.2 blocks per tick.
    expect(LEAF).toBeCloseTo(3.2, 9);
    expect(walkBreakCost('minecraft:leaves2')).toBeCloseTo(3.2, 9);
  });

  it('crosses a wall of leaves by breaking one block, or two (the upper one first)', () => {
    for (const high of [1, 2]) {
      const w = terrain(() => 63, wall(high));
      // Without digging there is no way through.
      expect(planTerrainWalk(w, FENCE, FROM, at(4.5, 64, 0.5), 64).ok).toBe(false);
      const plan = planned(planTerrainWalk(w, FENCE, FROM, at(4.5, 64, 0.5), 64, BREAKS));
      // One straight move into the wall breaks what is in the body's way first.
      const breaking = plan.moves.filter((m) => m.breaks !== undefined);
      expect(breaking).toHaveLength(1);
      expect(breaking[0]).toMatchObject({ kind: 'walk', to: at(2.5, 64, 0.5) });
      expect(brokenBy(plan)).toEqual(
        high === 1
          ? [{ x: 2, y: 64, z: 0 }]
          : [
              { x: 2, y: 65, z: 0 },
              { x: 2, y: 64, z: 0 },
            ],
      );
      expect(plan.length).toBeCloseTo(4, 9);
      expect(plan.moves.at(-1)?.to).toEqual(at(4.5, 64, 0.5));
    }
  });

  it('walks round a bush when that is only a little longer, and through when much longer', () => {
    // A gap two blocks off the line: round is 4 + 2 x 1.41 = 6.8 blocks, through is 4 blocks
    // and a leaf (3.2): round wins, though it walks 2.8 blocks more.
    const round = planned(
      planTerrainWalk(
        terrain(() => 63, wall(1, [2])),
        FENCE,
        FROM,
        at(4.5, 64, 0.5),
        64,
        BREAKS,
      ),
    );
    expect(brokenBy(round)).toEqual([]);
    expect(round.length).toBeCloseTo(4 + 2 * Math.SQRT2, 9);
    // The gap at the fence's edge, 8 blocks off: round would be about 19 blocks.
    const far = terrain(() => 63, wall(1, [8]));
    expect(brokenBy(planTerrainWalk(far, FENCE, FROM, at(4.5, 64, 0.5), 64, BREAKS))).toEqual([
      { x: 2, y: 64, z: 0 },
    ]);
  });

  it('breaks only what checkDig allows: never above the dig heights or under a plant', () => {
    // Digging reaches only the feet level: the head-level leaves stay, so no way through.
    const low = walkBreaks({ fence: FENCE, maxHeightAboveFence: 0 });
    expect(
      planTerrainWalk(
        terrain(() => 63, wall(2)),
        FENCE,
        FROM,
        at(4.5, 64, 0.5),
        64,
        low,
      ),
    ).toMatchObject({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence',
    });
    expect(
      planTerrainWalk(
        terrain(() => 63, wall(1)),
        FENCE,
        FROM,
        at(4.5, 64, 0.5),
        64,
        low,
      ).ok,
    ).toBe(true);
    // Tall grass along the wall stands on the ground beside the leaves: they are broken...
    const to = at(4.5, 64, 0.5);
    const beside = wall(1);
    for (let z = FENCE.min.z; z <= FENCE.max.z; z++) beside[`1,64,${z}`] = ID.tallgrass;
    const plan = planTerrainWalk(
      terrain(() => 63, beside),
      FENCE,
      FROM,
      to,
      64,
      BREAKS,
    );
    expect(brokenBy(plan)).toEqual([{ x: 2, y: 64, z: 0 }]);
    // ...but a planted plant on top of a leaf would drop with it: none is (a wild one may).
    const onTop = wall(1);
    for (let z = FENCE.min.z; z <= FENCE.max.z; z++) onTop[`2,65,${z}`] = ID.sapling;
    expect(
      planTerrainWalk(
        terrain(() => 63, onTop),
        FENCE,
        FROM,
        to,
        64,
        BREAKS,
      ).ok,
    ).toBe(false);
  });

  it('breaks the head-room of a step up, but never a leaf next to lava', () => {
    // A one-block step up at x = 1 along a strip, with a leaf over the player's head before it.
    const strip: Fence = { min: { x: -8, y: 60, z: 0 }, max: { x: 8, y: 70, z: 0 } };
    const breaks = walkBreaks({ fence: strip, maxHeightAboveFence: 4 });
    const step = (x: number): number => (x >= 1 ? 64 : 63);
    const overhang = { '0,66,0': ID.leaves };
    const plan = planned(
      planTerrainWalk(terrain(step, overhang), strip, FROM, at(3.5, 65, 0.5), 64, breaks),
    );
    expect(plan.moves.find((m) => m.breaks !== undefined)).toMatchObject({
      kind: 'step-up',
      breaks: [{ x: 0, y: 66, z: 0 }],
    });
    // Lava touching that leaf's corner (and no block the walker stands next to): refused.
    const lava = { '-1,67,0': ID.lava };
    const hot = terrain(step, { ...overhang, ...lava });
    expect(planTerrainWalk(hot, strip, FROM, at(3.5, 65, 0.5), 64, breaks)).toMatchObject({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence',
    });
    // The lava alone stops no walk: it is the break next to it that is refused.
    expect(planTerrainWalk(terrain(step, lava), strip, FROM, at(3.5, 65, 0.5), 64).ok).toBe(true);
  });

  it(`breaks at most ${MAX_WALK_BREAKS} blocks per walk`, () => {
    const end = MAX_WALK_BREAKS + 4;
    const strip: Fence = { min: { x: -8, y: 60, z: 0 }, max: { x: end, y: 70, z: 0 } };
    const breaks = walkBreaks({ fence: strip, maxHeightAboveFence: 4 });
    const hedge = (long: number): WalkWorld => {
      const blocks: Record<string, number> = {};
      for (let x = 1; x <= long; x++) blocks[`${x},64,0`] = ID.leaves;
      return terrain(() => 63, blocks);
    };
    const to = at(end - 0.5, 64, 0.5);
    expect(
      brokenBy(planTerrainWalk(hedge(MAX_WALK_BREAKS), strip, FROM, to, 64, breaks)),
    ).toHaveLength(MAX_WALK_BREAKS);
    expect(planTerrainWalk(hedge(MAX_WALK_BREAKS + 1), strip, FROM, to, 64, breaks)).toMatchObject({
      ok: false,
      reason: `there is no walkable path to the target inside the fence breaking at most ${MAX_WALK_BREAKS} blocks on the way`,
    });
  });

  it('reachableFeet reaches the pocket walled in by leaves, as the walker plans its walk there', () => {
    const ring: Record<string, number> = {};
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const y of [64, 65]) ring[`${5 + dx},${y},${5 + dz}`] = ID.leaves;
      }
    }
    const w = terrain(() => 63, ring);
    const r = reachableFeet(w, FENCE, FROM, 64, BREAKS);
    const inside = r.get('5,64,5');
    // Through one cell of the ring: its head and feet blocks; the breaks count in the cost.
    expect(inside).toMatchObject({ breaks: 2 });
    expect(inside?.cost).toBeCloseTo((inside?.length ?? 0) + 2 * LEAF, 9);
    expect(r.get('3,64,3')).toMatchObject({ breaks: 0 });
    // Each spot in and around the pocket is planned to the same way: breaks and blocks walked.
    for (let x = 3; x <= 7; x++) {
      for (let z = 3; z <= 7; z++) {
        const flood = r.get(`${x},64,${z}`);
        if (flood === undefined) throw new Error(`(${x}, 64, ${z}) not reached`);
        const plan = planned(planTerrainWalk(w, FENCE, FROM, at(x + 0.5, 64, z + 0.5), 64, BREAKS));
        expect(brokenBy(plan), `(${x}, 64, ${z})`).toHaveLength(flood.breaks);
        expect(plan.length, `(${x}, 64, ${z})`).toBeCloseTo(flood.length, 9);
      }
    }
    // Over the length limit, neither gets there.
    const short = reachableFeet(w, FENCE, FROM, 6, BREAKS);
    expect(short.has('5,64,5')).toBe(false);
    expect(planTerrainWalk(w, FENCE, FROM, at(5.5, 64, 5.5), 6, BREAKS)).toMatchObject({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence within 6 blocks',
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

  it('a walk starts from the block it stands on the edge of, when there is none under its centre', () => {
    // Seen live: a walk stopped at z 9.1, on the edge of the block at z 8 (air at z 9), and
    // every walk from there was refused: "no known full block underfoot (minecraft:air)".
    const ledge = terrain((_, z) => (z <= 0 ? 63 : 50)); // ground at z <= 0, a drop beyond
    const from = at(0.5, 64, 1.1); // the box reaches back over z 0 by 0.2
    expect(standingCell(ledge, from)).toEqual({ x: 0, y: 64, z: 0 });
    const plan = planTerrainWalk(ledge, FENCE, from, at(0.5, 64, -3.5), 64);
    expect(plan.ok).toBe(true);
    expect(standingCell(flat, at(0.5, 64, 0.5))).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('feet hanging a little above the ground come to rest on it, as in a game client', () => {
    // Seen live: saved mid-jump at logout, the player joined at y 92.42 over sand at 91.
    expect(checkSupport(flat, at(0.5, 64.42, 0.5))).toEqual({ kind: 'supported' });
    expect(restingY(flat, at(0.5, 64.42, 0.5))).toBe(64);
    expect(restingY(flat, at(0.5, 64, 0.5))).toBeNull(); // on the ground already
    // Over an edge: the block under one side of the box holds it.
    const edge = terrain((x) => (x >= 1 ? 63 : 60));
    expect(restingY(edge, at(0.9, 64.3, 0.5))).toBe(64);
    // Something at the feet's level (a plant it stands in, a block beside it): no settling.
    const grassy = terrain(() => 63, { '0,64,0': ID.tallgrass });
    expect(restingY(grassy, at(0.5, 64.42, 0.5))).toBeNull();
  });

  it('feet just past an edge, over nothing under the box, come down (the server holds them up)', () => {
    // Seen live 2026-10-04: a walk stopped at z 27.67 stepping down into a hole at z 27; the
    // server's wider box reached the block at z 28, so it never fell and its walks refused.
    const hole = terrain((x) => (x >= 1 ? 63 : 62));
    const past = at(0.97, 64, 0.5); // box 0.67..1.27: over x 0 (62) and x 1 (63)
    expect(edgeLanding(hole, past)).toBeNull(); // still over the block at x 1
    const over = at(0.67, 64, 0.5); // box 0.37..0.97: over x 0 only; the server's reaches 1.03
    expect(checkSupport(hole, over)).toEqual({ kind: 'supported' });
    expect(edgeLanding(hole, over)).toBe(63);
    expect(edgeLanding(hole, at(0.67, 64.42, 0.5))).toBeNull(); // between levels: restingY's
    expect(edgeLanding(flat, at(0.5, 64, 0.5))).toBeNull(); // on the ground
    // Deeper than a safe fall: no landing.
    const pit = terrain((x) => (x >= 1 ? 63 : 55));
    expect(edgeLanding(pit, over)).toBeNull();
    // Water under the way down is no floor: it stays rather than sink (no swimming).
    const pond = terrain((x) => (x >= 1 ? 63 : 60), { '0,61,0': ID.water });
    expect(edgeLanding(pond, over)).toBeNull();
  });

  it('a player left in the air by a stopped jump falls to the block below', () => {
    expect(checkSupport(flat, at(0.5, 64.83, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    expect(checkSupport(flat, at(0.5, 66.5, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    // Tall grass does not stop a fall, but it holds the player up for the server (not air).
    const grassy = terrain(() => 63, { '0,64,0': ID.tallgrass });
    expect(checkSupport(grassy, at(0.5, 64.83, 0.5))).toEqual({ kind: 'supported' });
  });

  it('falls through a plant it passes, but stops on top of one it may not enter', () => {
    const plant = { '0,64,0': ID.foliage };
    const grass = terrain(() => 63, plant, { '0,64,0': SHORT_GRASS });
    expect(checkSupport(grass, at(0.5, 66.5, 0.5))).toEqual({ kind: 'floating', landY: 64 });
    const ivy = terrain(() => 63, plant, { '0,64,0': POISON_IVY });
    expect(checkSupport(ivy, at(0.5, 66.5, 0.5))).toEqual({ kind: 'floating', landY: 65 });
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
