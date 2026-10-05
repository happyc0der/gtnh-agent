import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { overlappedCells } from '../../../src/bot/gtnh1710/pathing/physics.ts';
import {
  describeStepOutCause,
  hazardsAt,
  STEP_OUT_PACE,
  stepOut,
  websAt,
} from '../../../src/bot/gtnh1710/step-out.ts';
import type { Fence, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const ID = { air: 0, stone: 1, grass: 2, web: 30, fire: 51, lava: 11, mystery: 4000 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.web, 'minecraft:web'],
  [ID.fire, 'minecraft:fire'],
  [ID.lava, 'minecraft:lava'],
]);
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
/** Flat grass at y 92 (feet at 93), stone below, air above; `over` sets single blocks. */
function land(over: Record<string, number> = {}): WalkWorld {
  return {
    blockAt: (x, y, z) => over[k(x, y, z)] ?? (y === 92 ? ID.grass : y < 92 ? ID.stone : ID.air),
    blockName: (id) => NAMES.get(id),
    hazardCode: (id) =>
      id === ID.lava
        ? BLOCK_CODE.lava
        : id === ID.fire
          ? BLOCK_CODE.fire
          : id === 0 || NAMES.has(id)
            ? BLOCK_CODE.safe
            : BLOCK_CODE.unknown,
  };
}
const FENCE: Fence = { min: { x: -40, y: 80, z: -10 }, max: { x: -10, y: 100, z: 30 } };
/** Where the agent stood in the web, seen live 2026-10-05. */
const FEET = { x: -27.5, y: 93, z: 10.55 };

/** Each step at most STEP_OUT_PACE across, level, on the ground, ending on `to`. */
function checkSteps(
  from: { x: number; y: number; z: number },
  exit: { steps: Array<{ pos: { x: number; y: number; z: number }; onGround: boolean }> },
  to: { x: number; y: number; z: number },
): void {
  let at = from;
  for (const s of exit.steps) {
    expect(Math.hypot(s.pos.x - at.x, s.pos.z - at.z)).toBeLessThanOrEqual(STEP_OUT_PACE + 1e-9);
    expect(s.pos.y).toBe(from.y);
    expect(s.onGround).toBe(true);
    at = s.pos;
  }
  expect(at).toEqual(to);
}

describe('stepping out of a cobweb (step-out.ts)', () => {
  it('is nothing to do out of a web and away from hazards', () => {
    expect(websAt(land(), FEET)).toEqual([]);
    expect(hazardsAt(land(), FEET)).toEqual([]);
    expect(stepOut(land(), FENCE, FEET)).toBeNull();
  });

  it('steps level onto the nearest side, at most STEP_OUT_PACE a tick, ending on its centre', () => {
    // Seen live: the web at the feet, a retreat home stopped there; every walk was refused.
    const world = land({ [k(-28, 93, 10)]: ID.web });
    const exit = stepOut(world, FENCE, FEET);
    if (exit === null || !exit.ok) throw new Error(JSON.stringify(exit));
    expect(exit.cause).toEqual({ kind: 'cobweb', cells: [{ x: -28, y: 93, z: 10 }] });
    expect(describeStepOutCause(exit.cause)).toBe('the cobweb at (-28, 93, 10)');
    // z 10.55 is nearer the +z side (0.95) than the -z one (1.05).
    expect(exit.to).toEqual({ x: -27.5, y: 93, z: 11.5 });
    checkSteps(FEET, exit, exit.to);
    // Out of the web at the end: the body overlaps no web cell.
    const [x0, x1, , , z0, z1] = overlappedCells(exit.to.x, exit.to.y, exit.to.z);
    expect([x0, x1, z0, z1]).toEqual([-28, -28, 11, 11]);
  });

  it('never steps into another web, a wall or beside a hazard: another side, then a corner', () => {
    const webs = { [k(-28, 93, 10)]: ID.web, [k(-28, 94, 10)]: ID.web };
    const world = land({
      ...webs,
      [k(-28, 93, 11)]: ID.web, // +z: another web
      [k(-28, 94, 9)]: ID.stone, // -z: a wall at head height
      [k(-26, 92, 10)]: ID.lava, // +x: lava next to (-27, 93, 10)
    });
    const exit = stepOut(world, FENCE, FEET);
    if (exit === null || !exit.ok) throw new Error(JSON.stringify(exit));
    expect(exit.cause.cells).toHaveLength(2); // feet and head in the web
    expect(exit.to).toEqual({ x: -28.5, y: 93, z: 10.5 }); // -x, the side left
    // No side to stand on (holes all round, open above): the nearest corner, over their edges.
    const holes = land({
      ...webs,
      [k(-29, 92, 10)]: ID.air,
      [k(-27, 92, 10)]: ID.air,
      [k(-28, 92, 11)]: ID.air,
      [k(-28, 92, 9)]: ID.air,
    });
    const corner = stepOut(holes, FENCE, FEET);
    if (corner === null || !corner.ok) throw new Error(JSON.stringify(corner));
    expect(corner.to).toEqual({ x: -26.5, y: 93, z: 11.5 });
    // Walled on every side: a corner's way passes the walls' edges, so there is none.
    const boxed = land({
      ...webs,
      [k(-29, 93, 10)]: ID.stone,
      [k(-27, 93, 10)]: ID.stone,
      [k(-28, 93, 11)]: ID.stone,
      [k(-28, 93, 9)]: ID.stone,
    });
    const none = stepOut(boxed, FENCE, { x: -27.5, y: 93, z: 10.5 });
    expect(none?.ok).toBe(false);
    expect(none?.ok === false && none.reason).toMatch(/^no cell beside it to step onto: /);
  });

  it('takes no step from a web over a hole: gravity first (an independent review)', () => {
    const world = land({ [k(-28, 93, 10)]: ID.web, [k(-28, 92, 10)]: ID.air });
    expect(stepOut(world, FENCE, { x: -27.5, y: 93, z: 10.5 })).toEqual({
      ok: false,
      cause: { kind: 'cobweb', cells: [{ x: -28, y: 93, z: 10 }] },
      reason: 'no floor under the feet: gravity first',
    });
  });

  it('leaves a web holding the player in the air to gravity', () => {
    const world = land({ [k(-28, 95, 10)]: ID.web });
    const exit = stepOut(world, FENCE, { x: -27.5, y: 95.3, z: 10.5 });
    expect(exit).toEqual({
      ok: false,
      cause: { kind: 'cobweb', cells: [{ x: -28, y: 95, z: 10 }] },
      reason: 'the feet are not on a block top',
    });
  });
});

describe('stepping away from a hazard beside the player (step-out.ts)', () => {
  it('steps away from a fire lit beside it, onto a cell no hazard is near (seen live)', () => {
    // 2026-10-05: hurt by something out of sight in its morning staircase, the agent stood at
    // x -31.45 over the step whose floor had caught fire, every retreat refused ("cannot walk
    // from here: next to minecraft:fire"), from 20 health to 6.
    const world = land({ [k(-31, 92, 10)]: ID.fire, [k(-31, 91, 10)]: ID.grass });
    const feet = { x: -31.45, y: 93, z: 10.5 };
    const exit = stepOut(world, FENCE, feet);
    if (exit === null || !exit.ok) throw new Error(JSON.stringify(exit));
    expect(exit.cause).toEqual({
      kind: 'hazard',
      cells: [{ x: -31, y: 92, z: 10, name: 'minecraft:fire' }],
    });
    expect(describeStepOutCause(exit.cause)).toBe('the minecraft:fire at (-31, 92, 10)');
    // Two blocks from the fire's column: no hazard in the 3 x 3 around the feet any more.
    expect(exit.to).toEqual({ x: -32.5, y: 93, z: 10.5 });
    checkSteps(feet, exit, exit.to);
    expect(hazardsAt(world, exit.to)).toEqual([]);
  });

  it('passes only open cells on the way, never into the hazard, and says why when none is left', () => {
    // Lava on both sides along x, and the floor a fire on the -z side: +z is the way.
    const world = land({
      [k(-29, 93, 10)]: ID.lava,
      [k(-27, 93, 10)]: ID.lava,
      [k(-28, 92, 9)]: ID.fire,
    });
    const feet = { x: -27.5, y: 93, z: 10.5 };
    const exit = stepOut(world, FENCE, feet);
    // Every cell beside it is within a block of the lava or the fire: nowhere to stand.
    expect(exit?.ok).toBe(false);
    expect(exit?.ok === false && exit.reason).toMatch(/next to minecraft:(lava|fire)/);
  });

  it('is not set off by a hazard two blocks away, nor by a block nobody named', () => {
    const far = land({ [k(-30, 93, 10)]: ID.fire });
    expect(stepOut(far, FENCE, { x: -27.5, y: 93, z: 10.5 })).toBeNull();
    const unknown = land({ [k(-27, 93, 10)]: ID.mystery });
    expect(hazardsAt(unknown, { x: -27.5, y: 93, z: 10.5 })).toEqual([]);
  });
});
