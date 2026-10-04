import { describe, expect, it } from 'vitest';
import {
  planTravelStep,
  surfaceTarget,
  type TravelInput,
} from '../../../src/app/play/owner-travel.ts';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import type { PlayArea } from '../../../src/bot/gtnh1710/play-area.ts';
import { walkPolicy, type WalkSettings } from '../../../src/bot/gtnh1710/path-policy.ts';
import { goalNear } from '../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath } from '../../../src/bot/gtnh1710/pathing/search.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, dirt: 3, water: 9, leaves: 18, tallgrass: 31 } as const;
const NAMES = new Map<number, string>([
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
  [ID.water, 'minecraft:water'],
  [ID.leaves, 'minecraft:leaves'],
  [ID.tallgrass, 'minecraft:tallgrass'],
]);

/** Grass at y=63 (the feet at 64), stone under it; `blocks` overrides single blocks. */
function flat(blocks: Record<string, number> = {}): WalkWorld {
  return {
    blockAt: (x, y, z) =>
      blocks[`${x},${y},${z}`] ?? (y > 63 ? ID.air : y === 63 ? ID.grass : ID.stone),
    blockName: (id) => NAMES.get(id),
    hazardCode: () => BLOCK_CODE.safe,
  };
}

/** A river of water at x 10..12, as deep as the ground. */
function river(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let x = 10; x <= 12; x++) {
    for (let z = -40; z <= 40; z++) out[`${x},63,${z}`] = ID.water;
  }
  return out;
}

const AREA: PlayArea = {
  fence: { min: { x: -31, y: 48, z: -31 }, max: { x: 32, y: 80, z: 32 } },
  problem: null,
};

function input(over: Partial<TravelInput> & Pick<TravelInput, 'target'>): TravelInput {
  return {
    world: flat(),
    area: AREA,
    feet: { x: 0.5, y: 64, z: 0.5 },
    movement: { enabled: true, canExplore: true, maxPathLength: 32 },
    moveReach: 25.5,
    ...over,
  };
}

describe('planning an owner travel step', () => {
  it('is there already: near a player, or at a point', () => {
    expect(
      planTravelStep(
        input({ target: { kind: 'near', point: { x: 2.5, y: 64, z: 1.5 }, within: 3 } }),
      ),
    ).toEqual({ kind: 'arrived', distance: 2.2 });
    expect(
      planTravelStep(input({ target: { kind: 'point', point: { x: 1, y: null, z: 0 } } })),
    ).toEqual({ kind: 'arrived', distance: 0.7 });
  });

  it('walks to a stand spot near a player: within reach of it, never into its body', () => {
    const step = planTravelStep(
      input({ target: { kind: 'near', point: { x: 10.5, y: 64, z: 0.5 }, within: 3 } }),
    );
    expect(step).toMatchObject({ kind: 'step', distance: 10, spec: { type: 'MOVE_TO' } });
    if (step.kind !== 'step' || step.spec.type !== 'MOVE_TO') throw new Error('no walk');
    const t = step.spec.args.target;
    const fromPlayer = Math.hypot(t.x - 10.5, t.z - 0.5);
    expect(fromPlayer).toBeLessThanOrEqual(3);
    expect(fromPlayer).toBeGreaterThanOrEqual(1);
    // The nearest such spot by the walk: on this side of the player.
    expect(t.x).toBeLessThan(10.5);
    expect(t.y).toBe(64);
  });

  it('walks to a point a walk reaches; explores toward one it does not', () => {
    expect(
      planTravelStep(input({ target: { kind: 'point', point: { x: 20, y: 64, z: 5 } } })),
    ).toMatchObject({
      kind: 'step',
      spec: { type: 'MOVE_TO', args: { target: { x: 20.5, y: 64, z: 5.5 }, tolerance: 1 } },
    });
    // Far beyond the play area: EXPLORE in hops toward it.
    expect(
      planTravelStep(input({ target: { kind: 'point', point: { x: 300, y: 70, z: -40 } } })),
    ).toMatchObject({
      kind: 'step',
      spec: { type: 'EXPLORE', args: { toward: { x: 300, z: -40 }, maxDistance: 96 } },
    });
    // Close, but beyond what the hazard scan covers for a MOVE_TO (25.5): EXPLORE too.
    expect(
      planTravelStep(input({ target: { kind: 'point', point: { x: 0.5, y: 64, z: 29.5 } } })),
    ).toMatchObject({ kind: 'step', spec: { type: 'EXPLORE', args: { maxDistance: 29 } } });
  });

  it('at x and z only, walks to the ground there', () => {
    expect(
      planTravelStep(input({ target: { kind: 'point', point: { x: -6.2, y: null, z: 4.9 } } })),
    ).toMatchObject({
      kind: 'step',
      spec: { type: 'MOVE_TO', args: { target: { x: -6.5, y: 64, z: 4.5 } } },
    });
  });

  it('across a river: explores (follow mode); in a fixed fence, as near as a walk gets', () => {
    const world = flat(river());
    expect(
      planTravelStep(input({ world, target: { kind: 'point', point: { x: 15, y: 64, z: 0 } } })),
    ).toMatchObject({ kind: 'step', spec: { type: 'EXPLORE' } });
    const fixed = { enabled: true, canExplore: false, maxPathLength: 32 };
    const nearer = planTravelStep(
      input({ world, movement: fixed, target: { kind: 'point', point: { x: 15, y: 64, z: 0 } } }),
    );
    expect(nearer).toMatchObject({ kind: 'step', spec: { type: 'MOVE_TO' } });
    if (nearer.kind !== 'step' || nearer.spec.type !== 'MOVE_TO') throw new Error('no walk');
    expect(nearer.spec.args.target.x).toBe(9.5); // the bank
    // On the bank already: no walk gets nearer.
    expect(
      planTravelStep(
        input({
          world,
          movement: fixed,
          feet: { x: 9.5, y: 64, z: 0.5 },
          target: { kind: 'point', point: { x: 15, y: 64, z: 0 } },
        }),
      ),
    ).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/^no walk gets nearer/) as string,
    });
  });

  it('refuses without a position, without walking, or without a play area', () => {
    const target = { kind: 'point' as const, point: { x: 5, y: 64, z: 5 } };
    expect(planTravelStep(input({ target, feet: null }))).toEqual({
      kind: 'refused',
      reason: 'my position is not known',
    });
    expect(
      planTravelStep(
        input({ target, movement: { enabled: false, canExplore: false, maxPathLength: 32 } }),
      ),
    ).toEqual({ kind: 'refused', reason: 'walking is off (MC_ENABLE_MOVEMENT)' });
    expect(
      planTravelStep(input({ target, area: { fence: null, problem: 'no fence here' } })),
    ).toEqual({ kind: 'refused', reason: 'no fence here' });
    expect(planTravelStep(input({ target, world: null }))).toMatchObject({ kind: 'refused' });
  });
});

describe('the surface (Baritone #surface)', () => {
  const base: Omit<TravelInput, 'target'> = {
    world: flat(),
    area: AREA,
    feet: { x: 0.5, y: 64, z: 0.5 },
    movement: { enabled: true, canExplore: true, maxPathLength: 32 },
    moveReach: 25.5,
  };

  it('is here already under open sky (plants above do not count)', () => {
    const world = flat({ '0,64,0': ID.tallgrass });
    expect(surfaceTarget({ ...base, world })).toEqual({
      point: { x: 0.5, y: 64, z: 0.5 },
      here: true,
    });
  });

  it('goes back up the stairs it came down rather than through the rock', () => {
    // Stairs east from the grass at x = 0: at each x the feet at 64 - x, three blocks dug.
    const stairs: Record<string, number> = {};
    for (let x = 1; x <= 8; x++) {
      for (let dy = 0; dy <= 2; dy++) stairs[`${x},${64 - x + dy},0`] = ID.air;
    }
    const found = surfaceTarget({
      ...base,
      world: flat(stairs),
      feet: { x: 8.5, y: 56, z: 0.5 },
    });
    // The first stair open to the sky (x 1-3 lie in the cut through the ground).
    expect(found).toEqual({ point: { x: 3.5, y: 61, z: 0.5 }, here: false });
  });

  it('is at the surface only in the cell found: one block across and up is under the roof', () => {
    const stairs: Record<string, number> = {};
    for (let x = 1; x <= 8; x++) {
      for (let dy = 0; dy <= 2; dy++) stairs[`${x},${64 - x + dy},0`] = ID.air;
    }
    const target = { x: 3.5, y: 61, z: 0.5 };
    const feet = { x: 4.5, y: 60, z: 0.5 };
    const at = (exact: boolean) =>
      planTravelStep({
        ...base,
        world: flat(stairs),
        feet,
        target: exact ? { kind: 'point', point: target, exact } : { kind: 'point', point: target },
      }).kind;
    expect(at(false)).toBe('arrived');
    expect(at(true)).toBe('step');
  });

  it('says so when no natural ground under open sky is near', () => {
    const canopy: Record<string, number> = {};
    for (let x = -20; x <= 20; x++) {
      for (let z = -20; z <= 20; z++) canopy[`${x},70,${z}`] = ID.leaves;
    }
    expect(surfaceTarget({ ...base, world: flat(canopy) })).toEqual({
      problem: 'I see no open sky on natural ground within 16 blocks',
    });
  });
});

describe('owner travel on the pathfinder', () => {
  it('follow walks about a second of its way at a time; come walks all the way', () => {
    const owner = { x: 20.5, y: 64, z: 0.5 };
    const follow = planTravelStep(
      input({ target: { kind: 'near', point: owner, within: 3, step: true } }),
    );
    if (follow.kind !== 'step' || follow.spec.type !== 'MOVE_TO') throw new Error('no walk');
    // About a second at walking pace (4.3 blocks), then the next cycle plans again.
    expect(follow.spec.args.target.x).toBeGreaterThan(2);
    expect(follow.spec.args.target.x).toBeLessThanOrEqual(6.5);
    expect(follow.text).toMatch(/on the way near/);
    const come = planTravelStep(input({ target: { kind: 'near', point: owner, within: 3 } }));
    if (come.kind !== 'step' || come.spec.type !== 'MOVE_TO') throw new Error('no walk');
    expect(
      Math.hypot(come.spec.args.target.x - owner.x, come.spec.args.target.z - owner.z),
    ).toBeLessThanOrEqual(3);
  });

  it("plans with the client's walk policy: through a wall far from the owner, never next to it", () => {
    // A dirt wall two high across the whole area at x = 5.
    const wall: Record<string, number> = {};
    for (let z = -31; z <= 32; z++) {
      wall[`5,64,${z}`] = ID.dirt;
      wall[`5,65,${z}`] = ID.dirt;
    }
    const world = flat(wall);
    const settings: WalkSettings = {
      allowBreak: true,
      allowPlace: false,
      allowParkour: true,
      parkourOverDeepGaps: false,
      allowSprint: false,
      allowWater: false,
      allowDoors: true,
      throwawayReserve: 4,
    };
    const policy = (players: Array<{ x: number; y: number; z: number }>) =>
      walkPolicy({
        world,
        boundary: null,
        players,
        settings,
        breaking: true,
        placing: false,
        digHeight: 4,
        digTicks: () => ({ ticks: 21 }),
        throwaway: null,
        sprint: false,
      }).options;
    const fixed = { enabled: true, canExplore: false, maxPathLength: 32 };
    // Going to a point beyond the wall: through it (the owner far away).
    const through = planTravelStep(
      input({
        world,
        movement: fixed,
        path: policy([{ x: 30.5, y: 64, z: 25.5 }]),
        target: { kind: 'point', point: { x: 9, y: 64, z: 0 } },
      }),
    );
    expect(through).toMatchObject({
      kind: 'step',
      spec: { type: 'MOVE_TO', args: { target: { x: 9.5, y: 64, z: 0.5 } } },
    });
    // Coming to the owner just behind the wall: the wall next to the owner is never broken;
    // the way goes through it farther along, more than 4 blocks from the owner.
    const owner = { x: 7.5, y: 64, z: 0.5 };
    const options = policy([owner]);
    const near = planTravelStep(
      input({
        world,
        movement: fixed,
        path: options,
        target: { kind: 'near', point: owner, within: 2.5 },
      }),
    );
    if (near.kind !== 'step' || near.spec.type !== 'MOVE_TO') throw new Error('no walk');
    expect(near.spec.args.target.x).toBeGreaterThan(5);
    const path = planPath(
      world,
      AREA.fence,
      { x: 0.5, y: 64, z: 0.5 },
      goalNear(owner, 2.5),
      options,
    );
    const broken = path.movements.flatMap((m) => m.breaks.map((b) => b.cell));
    expect(broken.length).toBeGreaterThan(0);
    for (const c of broken) {
      expect(Math.hypot(c.x + 0.5 - owner.x, c.z + 0.5 - owner.z)).toBeGreaterThan(4);
    }
  });
});
