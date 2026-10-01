import { describe, expect, it } from 'vitest';
import type { ExplorationSummary } from '../../src/domain/world-memory.ts';
import { buildPlannerRequest, routeForPlanner } from '../../src/planner/planner-provider.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

/** The live situation of 2026-10-01: the first quest wants 8 dirt; the agent stands in a desert. */
function needing(requirements: Record<string, number>) {
  const base = makeState();
  return {
    ...base,
    nearbyBlocks: base.nearbyBlocks.known
      ? { known: true as const, value: { ...base.nearbyBlocks.value, resources: [] } }
      : base.nearbyBlocks,
    currentTask: {
      taskId: 'quest-0:0',
      goal: 'Age 0 quest "Your First Night": have 8 minecraft:dirt',
      subgoal: null,
      status: 'active' as const,
      requirements,
    },
  };
}

const WORLD: ExplorationSummary = {
  chunksSeen: 40,
  directions: {
    north: { seen: 34, room: 240 },
    north_east: { seen: 43, room: 340 },
    east: { seen: 34, room: 256 },
    south_east: { seen: 69, room: 362 },
    south: { seen: 99, room: 271 },
    south_west: { seen: 104, room: 361 },
    west: { seen: 48, room: 255 },
    north_west: { seen: 54, room: 340 },
  },
  places: [
    {
      resource: 'log',
      x: -16,
      y: 72,
      z: 33,
      distance: 51,
      direction: 'south',
      count: 10,
      biome: 'Hot Forest',
      seenMinutesAgo: 40.7,
    },
  ],
  biomes: [
    { biome: 'Hot Desert', chunks: 24, x: -8, z: -8, distance: 11, direction: 'south_west' },
    { biome: 'Hot Forest', chunks: 16, x: -8, z: 40, distance: 40, direction: 'south' },
  ],
};

describe('the route uses what exploring found', () => {
  it('counts places remembered from exploring as known places', () => {
    const route = routeForPlanner(needing({ 'minecraft:log': 8 }), WORLD);
    const gather = route?.steps.find((s) => s.includes('gather 8 minecraft:log'));
    expect(gather).toContain(
      'best: remembered (Hot Forest), seen 40.7 min ago, south (-16, 72, 33) 51 m away',
    );
    // Without world memory, nothing is known.
    expect(
      routeForPlanner(needing({ 'minecraft:log': 8 }))?.steps.find((s) =>
        s.includes('gather 8 minecraft:log'),
      ),
    ).toContain('no known place yet');
  });

  it('leaves out a remembered place the scan covers: in view already, or out of reach', () => {
    // The player stands at (1, 64, 1); the scan covers 16 blocks from the feet, at or above them.
    const log = WORLD.places[0] as (typeof WORLD.places)[number];
    const at = (x: number, y: number, z: number) => ({
      ...WORLD,
      places: [{ ...log, x, y, z, distance: Math.round(Math.hypot(x - 1, z - 1)) }],
      biomes: [],
    });
    const gather = (world: typeof WORLD, state = needing({ 'minecraft:log': 8 })) =>
      routeForPlanner(state, world)?.steps.find((s) => s.includes('gather 8 minecraft:log'));
    // 8 m away, at head height: covered (seen live: walled in by leaves, EXPLORE never got there).
    expect(gather(at(6, 65, 7))).toContain('no known place yet');
    // Out of the sphere, or below the feet (the scan does not list logs there): still a place.
    expect(gather(at(20, 65, 7))).toContain('(20, 65, 7)');
    expect(gather(at(6, 60, 7))).toContain('(6, 60, 7)');
    // Nor does the request's own copy of world memory list it.
    const request = buildPlannerRequest({
      state: needing({ 'minecraft:log': 8 }),
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
      exploration: { ...at(6, 65, 7), places: [...at(6, 65, 7).places, ...at(20, 65, 7).places] },
    });
    expect(request.exploration?.places.map((p) => [p.x, p.y, p.z])).toEqual([[20, 65, 7]]);
    // The biome patch the player stands in is no point to explore toward either.
    const here = buildPlannerRequest({
      state: needing({ 'minecraft:log': 8 }),
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
      exploration: WORLD,
    });
    expect(here.exploration?.biomes.map((b) => b.biome)).toEqual(['Hot Forest']);
    // With the nearby blocks unknown, nothing is covered.
    const blind = needing({ 'minecraft:log': 8 });
    expect(
      gather(at(6, 65, 7), { ...blind, nearbyBlocks: { known: false, reason: 'test' } }),
    ).toContain('(6, 65, 7)');
  });

  it('never points at the biome patch the player stands in: past it, or on through it', () => {
    const forest = WORLD.biomes[1] as (typeof WORLD.biomes)[number];
    const gather = (biomes: (typeof WORLD)['biomes']) =>
      routeForPlanner(needing({ 'minecraft:dirt': 8 }), { ...WORLD, biomes })?.steps.find((s) =>
        s.includes('gather 8 minecraft:dirt'),
      );
    // Seen live: the nearest Hot Forest chunk was the one the player stood in.
    const here = { ...forest, x: 2, z: 1, distance: 1, direction: 'here' as const };
    const farther = { ...forest, biome: 'Bamboo Forest', x: 40, z: 1, distance: 39 };
    expect(gather([here, farther])).toContain('the Bamboo Forest at x 40, z 1, 39 m');
    expect(gather([here])).toContain(
      'look in the Hot Forest the player stands in (seen, 16 chunk(s)), beyond what it can reach from here: EXPLORE on through it',
    );
    expect(gather([here])).not.toContain('x 2, z 1');
  });

  it('with no place and no likely biome known, names the direction with the most new ground', () => {
    // Seen live: no gravel in 94 chunks of desert and forest; the model wandered between two
    // nearby points. Clay is common by rivers, swamps and lakes, none of them seen here.
    const gather = routeForPlanner(needing({ 'minecraft:clay': 4 }), WORLD)?.steps.find((s) =>
      s.includes('gather 16 minecraft:clay_ball'),
    );
    expect(gather).toContain(
      'look in new ground, none seen so far: EXPLORE north_east (seen only 43 blocks that way, 340 blocks of room)',
    );
  });

  it('points at the nearest seen biome where a material is common when no place is known', () => {
    const route = routeForPlanner(needing({ 'minecraft:dirt': 8 }), WORLD);
    const gather = route?.steps.find((s) => s.includes('gather 8 minecraft:dirt'));
    expect(gather).toContain(
      'no known place yet: explore (look in the Hot Forest at x -8, z 40, 40 m south (seen, 16 chunk(s)): it is common there; EXPLORE toward that x and z',
    );
    // The desert is nearer, but dirt is not common there.
    expect(gather).not.toContain('Hot Desert');
  });
});
