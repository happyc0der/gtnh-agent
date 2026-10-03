import { describe, expect, it } from 'vitest';
import { planTravelStep, type TravelInput } from '../../../src/app/play/owner-travel.ts';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import type { PlayArea } from '../../../src/bot/gtnh1710/play-area.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, water: 9 } as const;
const NAMES = new Map<number, string>([
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.water, 'minecraft:water'],
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
