import { describe, expect, it } from 'vitest';
import {
  checkPathPlace,
  chooseThrowaway,
  MAX_PATH_BREAKS,
  pathBreakProblem,
  pathPlaceProblem,
  playerNear,
  walkPolicy,
  type WalkPolicyInput,
  type WalkSettings,
} from '../../../src/bot/gtnh1710/path-policy.ts';
import { goalBlock } from '../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath } from '../../../src/bot/gtnh1710/pathing/search.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { area, B, centre, TestWorld } from './fixtures/path-worlds.ts';

const SETTINGS: WalkSettings = {
  allowBreak: true,
  allowPlace: true,
  allowParkour: true,
  parkourOverDeepGaps: false,
  allowSprint: false,
  allowWater: false,
  allowDoors: true,
  throwawayReserve: 4,
};
const NO_ONE = { boundary: null, players: [] };

function input(over: Partial<WalkPolicyInput> = {}): WalkPolicyInput {
  return {
    world: new TestWorld(),
    ...NO_ONE,
    settings: SETTINGS,
    breaking: true,
    placing: true,
    digHeight: 4,
    digTicks: () => ({ ticks: 10 }),
    throwaway: { block: 'minecraft:cobblestone', count: 8 },
    sprint: false,
    ...over,
  };
}

describe('the walk policy (path-policy.ts)', () => {
  it('turns the settings into the pathfinder options', () => {
    const all = walkPolicy(input());
    expect(all.options).toMatchObject({
      parkour: true,
      parkourOverDeepGaps: false,
      pillar: true,
      bridge: true,
      water: false,
      doors: true,
      maxFall: 3,
      maxBreaks: MAX_PATH_BREAKS,
      throwaway: { count: 8, block: 'minecraft:cobblestone' },
    });
    expect(all.summary).toBe('breaking, placing up to 8 minecraft:cobblestone, parkour, doors');
    // Each needs its ability, a throwaway block, and digging's heights for an ascend's room.
    expect(walkPolicy(input({ breaking: false })).options.canBreak).toBeUndefined();
    expect(walkPolicy(input({ digHeight: 1 })).options.canBreak).toBeUndefined();
    expect(walkPolicy(input({ placing: false })).options.pillar).toBeUndefined();
    expect(walkPolicy(input({ throwaway: null })).options.bridge).toBeUndefined();
    const off = walkPolicy(
      input({
        settings: {
          ...SETTINGS,
          allowBreak: false,
          allowPlace: false,
          allowParkour: false,
          allowDoors: false,
        },
      }),
    );
    expect(off.options).toMatchObject({ parkour: false, doors: false });
    expect(off.options.canBreak).toBeUndefined();
    expect(off.options.canPlace).toBeUndefined();
    expect(off.summary).toBe('no breaking, no placing');
  });

  it('breaks natural blocks the dig rules allow, never ores, builds or near a player', () => {
    const w = new TestWorld()
      .set(1, 64, 0, B.dirt)
      .set(3, 64, 0, B.stone)
      .set(5, 64, 0, B.chest)
      .set(6, 64, 0, B.dirt);
    expect(pathBreakProblem(w, { x: 1, y: 64, z: 0 }, NO_ONE)).toBeNull();
    // Not on the allowlist, or touching what may not touch a broken block.
    expect(pathBreakProblem(w, { x: 5, y: 64, z: 0 }, NO_ONE)).toMatch(/not on the dig allowlist/);
    expect(pathBreakProblem(w, { x: 6, y: 64, z: 0 }, NO_ONE)).toMatch(/touches minecraft:chest/);
    // A player near: within 4 blocks of its body.
    const owner = { x: 1.5, y: 64, z: 3.4 };
    expect(
      pathBreakProblem(w, { x: 1, y: 64, z: 0 }, { boundary: null, players: [owner] }),
    ).toMatch(/within 4 blocks of a player/);
    expect(playerNear({ x: 1, y: 64, z: 0 }, [{ x: 1.5, y: 64, z: 4.6 }], 4)).toBeUndefined();
    // A player's build.
    const built: WalkWorld = {
      blockAt: (x, y, z) => w.blockAt(x, y, z),
      metaAt: (x, y, z) => w.metaAt(x, y, z),
      blockName: (id) => w.blockName(id),
      hazardCode: (id) => w.hazardCode(id),
      builtByPlayer: (x, y, z) => x === 1 && y === 64 && z === 0,
    };
    expect(pathBreakProblem(built, { x: 1, y: 64, z: 0 }, NO_ONE)).toMatch(/built by a player/);
    // Outside the safety boundary.
    const boundary = { min: { x: 2, y: 0, z: -10 }, max: { x: 20, y: 255, z: 10 } };
    expect(pathBreakProblem(w, { x: 1, y: 64, z: 0 }, { boundary, players: [] })).toMatch(
      /not inside the safety boundary/,
    );
    // The dig time decides: a block no carried tool harvests is never planned through.
    const policy = walkPolicy(
      input({
        world: w,
        digTicks: (block) =>
          block === 'minecraft:stone' ? { problem: 'no pickaxe' } : { ticks: 21 },
      }),
    );
    expect(policy.options.canBreak?.({ x: 1, y: 64, z: 0 })).toBe(21);
    expect(policy.options.canBreak?.({ x: 3, y: 64, z: 0 })).toBeNull();
  });

  it('places only away from players, with only air, plants and plain blocks around', () => {
    const w = new TestWorld().set(2, 64, 1, B.chest);
    expect(pathPlaceProblem(w, { x: 0, y: 64, z: 0 }, NO_ONE)).toBeNull();
    expect(pathPlaceProblem(w, { x: 2, y: 64, z: 0 }, NO_ONE)).toMatch(/touches minecraft:chest/);
    expect(
      pathPlaceProblem(
        w,
        { x: 0, y: 64, z: 0 },
        { boundary: null, players: [{ x: 2, y: 64, z: 2 }] },
      ),
    ).toMatch(/within 3 blocks of a player/);
    // Just before the click: the cell, the clicked block, the reach, the body, entities.
    const feet = centre(0, 64, 0);
    const placeArea = { fence: area(8, 50, 80), maxHeightAboveFence: 4 };
    const pillar = { cell: { x: 0, y: 64, z: 0 }, against: { x: 0, y: 63, z: 0 }, face: 1 };
    const ctx = { ...NO_ONE, entities: [], ownPlaced: new Set<string>() };
    expect(checkPathPlace(w, placeArea, feet, pillar, ctx)).toMatch(/the player's body is in/);
    const above = { ...feet, y: 65.2 };
    expect(checkPathPlace(w, placeArea, above, pillar, ctx)).toBeNull();
    expect(
      checkPathPlace(w, placeArea, above, pillar, {
        ...ctx,
        entities: [{ x: 0.5, y: 63, z: 1.2 }],
      }),
    ).toMatch(/an entity at/);
    expect(checkPathPlace(w, placeArea, above, { ...pillar, face: 2 }, ctx)).toMatch(
      /does not touch/,
    );
  });

  it('chooses the throwaway: the most carried, dirt less the reserve, never a protected item', () => {
    const none = new Set<string>();
    expect(chooseThrowaway({ 'minecraft:dirt': 30, 'minecraft:cobblestone': 9 }, none, 4)).toEqual({
      block: 'minecraft:dirt',
      count: 26,
    });
    expect(chooseThrowaway({ 'minecraft:dirt': 13, 'minecraft:cobblestone': 9 }, none, 4)).toEqual({
      block: 'minecraft:cobblestone',
      count: 9,
    });
    expect(chooseThrowaway({ 'minecraft:dirt': 4 }, none, 4)).toBeNull();
    expect(chooseThrowaway({ 'minecraft:netherrack': 2 }, none, 4)).toEqual({
      block: 'minecraft:netherrack',
      count: 2,
    });
    expect(
      chooseThrowaway({ 'minecraft:cobblestone': 9 }, new Set(['minecraft:cobblestone']), 4),
    ).toBeNull();
    // Only the plain items count (dirt@1 is coarse dirt).
    expect(chooseThrowaway({ 'minecraft:dirt@1': 40 }, none, 0)).toBeNull();
  });

  it('plans over a wall of dirt by the dig time, and round stone it may not break', () => {
    // A wall across a strip: dirt is broken; stone with no pickaxe is not.
    const strip = { min: { x: -4, y: 56, z: 0 }, max: { x: 8, y: 72, z: 0 } };
    const dirt = new TestWorld().fill({ x: 2, y: 64, z: 0 }, { x: 2, y: 66, z: 0 }, B.dirt);
    const options = walkPolicy(input({ world: dirt, placing: false })).options;
    const through = planPath(dirt, strip, centre(0, 64, 0), goalBlock(4, 64, 0), options);
    expect(through.status).toBe('reached');
    expect(through.movements.flatMap((m) => m.breaks.map((b) => b.cell.y))).toEqual([65, 64]);
    const stone = new TestWorld().fill({ x: 2, y: 64, z: 0 }, { x: 2, y: 66, z: 0 }, B.stone);
    const refused = walkPolicy(
      input({ world: stone, placing: false, digTicks: () => ({ problem: 'no pickaxe' }) }),
    ).options;
    expect(planPath(stone, strip, centre(0, 64, 0), goalBlock(4, 64, 0), refused).status).toBe(
      'none',
    );
  });
});
