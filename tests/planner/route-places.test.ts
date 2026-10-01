import { describe, expect, it } from 'vitest';
import type { ExplorationSummary } from '../../src/domain/world-memory.ts';
import { routeForPlanner } from '../../src/planner/planner-provider.ts';
import { makeState } from '../fixtures/index.ts';

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
