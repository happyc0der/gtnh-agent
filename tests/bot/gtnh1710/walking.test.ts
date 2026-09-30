import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import {
  planWalk,
  positionProblem,
  renderWalkMap,
  segmentProblem,
  stepsAlong,
  sweptColumns,
  yawTowards,
  type Fence,
  type Vec3,
  type WalkWorld,
} from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, lava: 11, water: 9, glass: 20, slab: 44, cactus: 81 } as const;
const NAMES = new Map<number, string>([
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.lava, 'minecraft:lava'],
  [ID.water, 'minecraft:water'],
  [ID.glass, 'minecraft:glass'],
  [ID.slab, 'minecraft:stone_slab'],
  [ID.cactus, 'minecraft:cactus'],
]);
const HAZARDS = new Map<number, number>([
  [ID.lava, BLOCK_CODE.lava],
  [ID.cactus, BLOCK_CODE.damaging_block],
]);

/** Glass floor at y=199 (feet level 200) from -20 to 20 on x and z; air elsewhere. */
function world(
  opts: { blocks?: Record<string, number>; unloaded?: Array<[number, number]> } = {},
): WalkWorld {
  const blocks = new Map(Object.entries(opts.blocks ?? {}));
  const unloaded = new Set((opts.unloaded ?? []).map(([x, z]) => `${x},${z}`));
  return {
    blockAt(x, y, z) {
      if (unloaded.has(`${x},${z}`)) return undefined;
      const o = blocks.get(`${x},${y},${z}`);
      if (o !== undefined) return o;
      return y === 199 && Math.abs(x) <= 20 && Math.abs(z) <= 20 ? ID.glass : ID.air;
    },
    blockName: (id) => NAMES.get(id),
    hazardCode: (id) => (NAMES.has(id) ? (HAZARDS.get(id) ?? BLOCK_CODE.safe) : BLOCK_CODE.unknown),
  };
}

/** Stone at the feet and head blocks of each (x, z): a 2-high wall or pillar. */
function walls(...cells: Array<[number, number]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [x, z] of cells) {
    out[`${x},200,${z}`] = ID.stone;
    out[`${x},201,${z}`] = ID.stone;
  }
  return out;
}

const FENCE: Fence = { min: { x: -4, y: 200, z: -4 }, max: { x: 4, y: 200, z: 4 } };
const at = (x: number, z: number): Vec3 => ({ x, y: 200, z });
const dist = (a: Vec3, b: Vec3): number => Math.hypot(b.x - a.x, b.z - a.z);

function mustPlan(w: WalkWorld, from: Vec3, to: Vec3, fence = FENCE, max = 32) {
  const plan = planWalk(w, fence, from, to, max);
  if (!plan.ok) throw new Error(plan.reason);
  return plan;
}

describe('walk planning', () => {
  it('walks straight across open floor', () => {
    const plan = mustPlan(world(), at(-3.5, -3.5), at(3.5, 3.5));
    expect(plan.waypoints).toEqual([at(-3.5, -3.5), at(3.5, 3.5)]);
    expect(plan.length).toBeCloseTo(7 * Math.SQRT2, 9);
  });

  it('steps never exceed 0.2 blocks and end exactly on the target', () => {
    const from = at(-3.5, -3.5);
    const plan = mustPlan(world(), from, at(2.25, 3.9));
    const steps = stepsAlong(plan.waypoints);
    let prev = from;
    for (const s of steps) {
      expect(dist(prev, s)).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(s.y).toBe(200);
      prev = s;
    }
    expect(steps.at(-1)).toEqual(at(2.25, 3.9));
  });

  it('goes around a wall through its gap, never touching it', () => {
    // A wall across x=0 from z=-4 to z=3: the only way through is at z=4.
    const wall: Array<[number, number]> = [];
    for (let z = -4; z <= 3; z++) wall.push([0, z]);
    const w = world({ blocks: walls(...wall) });
    const plan = mustPlan(w, at(-2.5, 0.5), at(2.5, 0.5));
    expect(plan.length).toBeGreaterThan(8);
    for (let i = 1; i < plan.waypoints.length; i++) {
      const a = plan.waypoints[i - 1] as Vec3;
      const b = plan.waypoints[i] as Vec3;
      expect(segmentProblem(w, FENCE, a, b)).toBeNull();
      for (const [x, z] of sweptColumns(a, b)) expect(x === 0 && z <= 3).toBe(false);
    }
  });

  it('never cuts a corner between two blocked diagonal neighbours', () => {
    // Only a diagonal squeeze between (0,1) and (1,0) would connect the two halves.
    const blocked: Array<[number, number]> = [];
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        const lowerLeft = x <= 0 && z <= 0;
        const upperRight = x >= 1 && z >= 1;
        if (!lowerLeft && !upperRight) blocked.push([x, z]);
      }
    }
    const plan = planWalk(
      world({ blocks: walls(...blocked) }),
      FENCE,
      at(-2.5, -2.5),
      at(2.5, 2.5),
      32,
    );
    expect(plan).toEqual({
      ok: false,
      reason: 'there is no walkable path to the target inside the fence',
    });
  });

  it('refuses targets it cannot reach safely, before any step', () => {
    const cases: Array<[string, WalkWorld, Vec3, Vec3, RegExp]> = [
      ['outside', world(), at(0.5, 0.5), at(6.5, 0.5), /outside the movement fence/],
      ['level', world(), at(0.5, 0.5), { x: 1.5, y: 201, z: 1.5 }, /walking stays on level y=200/],
      ['floating', world(), { x: 0.5, y: 200.5, z: 0.5 }, at(1.5, 1.5), /feet are at y=200.5/],
      [
        'blocked',
        world({ blocks: walls([2, 2]) }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /blocked by minecraft:stone/,
      ],
      [
        'hole',
        world({ blocks: { '2,199,2': ID.air } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /no known full block underfoot \(minecraft:air\)/,
      ],
      [
        'slab',
        world({ blocks: { '2,199,2': ID.slab } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /minecraft:stone_slab/,
      ],
      [
        'water',
        world({ blocks: { '2,200,2': ID.water } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /blocked by minecraft:water/,
      ],
      [
        'lava',
        world({ blocks: { '3,199,3': ID.lava } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /next to minecraft:lava/,
      ],
      [
        'cactus',
        world({ blocks: { '3,200,2': ID.cactus } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /next to minecraft:cactus/,
      ],
      [
        'unnamed',
        world({ blocks: { '2,201,3': 999 } }),
        at(0.5, 0.5),
        at(2.5, 2.5),
        /next to unnamed block id 999/,
      ],
      ['unloaded', world({ unloaded: [[2, 2]] }), at(0.5, 0.5), at(2.5, 2.5), /not loaded/],
    ];
    for (const [name, w, from, to, reason] of cases) {
      const plan = planWalk(w, FENCE, from, to, 32);
      expect(plan.ok, name).toBe(false);
      if (!plan.ok) expect(plan.reason, name).toMatch(reason);
    }
  });

  it('refuses a path longer than the limit', () => {
    const plan = planWalk(world(), FENCE, at(-3.5, -3.5), at(3.5, 3.5), 5);
    expect(plan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/limit is 5/) as string,
    });
  });

  it('ends at the block centre when the exact target would touch a wall', () => {
    const w = world({ blocks: walls([2, 0], [2, 1], [2, -1]) });
    const plan = mustPlan(w, at(-1.5, 0.5), at(1.9, 0.5));
    expect(plan.waypoints.at(-1)).toEqual(at(1.5, 0.5));
  });

  it('keeps the whole body inside the fence', () => {
    const w = world();
    expect(positionProblem(w, FENCE, at(-3.7, 0.5))).toBeNull(); // body edge exactly on the fence
    expect(positionProblem(w, FENCE, at(-3.8, 0.5))).toMatch(/outside the movement fence/);
    expect(positionProblem(w, FENCE, at(4.7, 0.5))).toBeNull();
    expect(positionProblem(w, FENCE, at(4.8, 0.5))).toMatch(/outside the movement fence/);
  });
});

describe('swept body checks', () => {
  it('a standing body overlaps one column at a block centre and four at a corner', () => {
    expect(sweptColumns(at(0.5, 0.5), at(0.5, 0.5))).toEqual([[0, 0]]);
    expect(sweptColumns(at(1, 1), at(1, 1))).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it('catches a corner clip that both end positions miss', () => {
    const w = world({ blocks: walls([1, 1]) });
    const a = at(0.65, 1.5);
    const b = at(1.5, 0.65);
    expect(positionProblem(w, FENCE, a)).toBeNull();
    expect(positionProblem(w, FENCE, b)).toBeNull();
    expect(segmentProblem(w, FENCE, a, b)).toMatch(/block \(1, 200, 1\): blocked/);
  });

  it('faces the direction of travel', () => {
    expect(yawTowards(at(0, 0), at(0, 1))).toBeCloseTo(0); // south
    expect(yawTowards(at(0, 0), at(-1, 0))).toBeCloseTo(90); // west
    expect(Math.abs(yawTowards(at(0, 0), at(0, -1)))).toBeCloseTo(180); // north
    expect(yawTowards(at(0, 0), at(1, 0))).toBeCloseTo(-90); // east
  });
});

describe('walk map', () => {
  it('draws the fence, obstacles, hazards, the path, the player and the target', () => {
    const fence: Fence = { min: { x: 0, y: 200, z: 0 }, max: { x: 3, y: 200, z: 2 } };
    const w = world({ blocks: { ...walls([1, 1]), '5,199,0': ID.lava } });
    const from = at(0.5, 2.5);
    const to = at(3.5, 0.5);
    const plan = mustPlan(w, from, to, fence);
    expect(
      renderWalkMap(w, fence, {
        player: from,
        target: to,
        path: plan.waypoints,
        entities: [{ x: 2.5, z: 2.5, threat: true }],
      }),
    ).toEqual([
      'x -1..4 (west to east), z -1..3 (north to south), feet level y=200',
      '. . . . . !',
      '. . . . T !',
      '. . # * * !',
      '. @ * E . .',
      '. . . . . .',
      '. walkable  # blocked  _ no floor  ! hazard  ? not loaded  * path  @ player  T target  E threat',
    ]);
  });
});
