import { describe, expect, it } from 'vitest';
import type { ExplorationSummary } from '../../src/domain/world-memory.ts';
import { MAX_JOURNAL_LINE } from '../../src/planner/plan-schema.ts';
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

describe("an owner's goal of any kind", () => {
  it('reaches the planner: every kind held counts, and the stock says so', () => {
    // Seen live 2026-10-04: the request's schema refused the stock line, every cycle.
    const state = needing({ 'minecraft:log': 8 });
    if (!state.inventory.known) throw new Error('fixture inventory unknown');
    const request = buildPlannerRequest({
      state: {
        ...state,
        inventory: {
          known: true,
          value: { ...state.inventory.value, items: { 'minecraft:log@2': 3 } },
        },
        currentTask: { ...state.currentTask, anyKind: ['minecraft:log'] },
      },
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
    });
    expect(request.route?.stock).toEqual([
      { item: 'minecraft:log', have: 3, stored: 0, need: 8, missing: 5, anyKind: true },
    ]);
  });
});

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

  describe('water as the way to gravel, clay and sand', () => {
    type Place = (typeof WORLD.places)[number];
    const water = (x: number, z: number, distance: number, over: Partial<Place> = {}): Place => ({
      resource: 'water',
      x,
      y: 62,
      z,
      distance,
      direction: 'north_east',
      count: 24,
      biome: 'River Oasis',
      seenMinutesAgo: 3.2,
      ...over,
    });
    /** By the player (9 m), and a lake far sight saw. */
    const POND = water(8, 7, 9, { direction: 'here' });
    const LAKE = water(97, -60, 112);
    const WET = { ...WORLD, places: [...WORLD.places, POND, LAKE] };
    const step = (needs: Record<string, number>, world: ExplorationSummary, text: string) =>
      routeForPlanner(needing(needs), world)?.steps.find((s) => s.includes(text));
    const GRAVEL = 'gather 9 minecraft:gravel';
    const SHORE =
      'look in the shore of the water at x 97, z -60, 112 m north_east (seen 3.2 min ago): ' +
      'gravel, clay and sand lie on river and lake shores and beds; EXPLORE toward that x and z';

    it('points a gather leg with no place at the nearest water the player is not by', () => {
      // Sticks 'n Stones: 9 gravel, none seen anywhere (seen live: 94 chunks of desert and forest).
      expect(step({ 'minecraft:gravel': 9 }, WET, 'gather 9 minecraft:gravel')).toContain(
        `no known place yet: explore (${SHORE}; river and lake beds, beaches, mountains`,
      );
      expect(step({ 'minecraft:clay': 4 }, WET, 'gather 16 minecraft:clay_ball')).toContain(SHORE);
      expect(step({ 'minecraft:sand': 8 }, WET, 'gather 8 minecraft:sand')).toContain(SHORE);
      // The nearer of two lakes; the pond by the player is left out (its shore is in view).
      const nearer = water(-30, 20, 36, { direction: 'south_west' });
      expect(
        step({ 'minecraft:gravel': 9 }, { ...WET, places: [LAKE, nearer, POND] }, GRAVEL),
      ).toContain('the shore of the water at x -30, z 20, 36 m south_west');
      // Only the pond: no water hint, new ground instead.
      const pondOnly = step({ 'minecraft:gravel': 9 }, { ...WORLD, places: [POND] }, GRAVEL);
      expect(pondOnly).not.toContain('the shore of the water');
      expect(pondOnly).toContain('look in new ground, none seen so far: EXPLORE north_east');
    });

    it('leaves out water the resource scan covers', () => {
      // A scan reaching 40 blocks has the lake's shore at 30 m, at the feet's level, in view.
      const base = needing({ 'minecraft:gravel': 9 });
      const wide = {
        ...base,
        nearbyBlocks: base.nearbyBlocks.known
          ? { known: true as const, value: { ...base.nearbyBlocks.value, scanRadius: 40 } }
          : base.nearbyBlocks,
      };
      const covered = water(25, 19, 30, { y: 64, direction: 'east' });
      const gravel = (world: ExplorationSummary) =>
        routeForPlanner(wide, world)?.steps.find((s) => s.includes('gather 9 minecraft:gravel'));
      expect(gravel({ ...WORLD, places: [covered] })).not.toContain('the shore of the water');
      expect(gravel({ ...WORLD, places: [covered, LAKE] })).toContain(SHORE);
    });

    it('is no hint for a leg with a known place, nor for logs', () => {
      const bank = { ...LAKE, resource: 'gravel' as const, x: 90, y: 63, z: -55, count: 6 };
      const known = step(
        { 'minecraft:gravel': 9 },
        { ...WET, places: [...WET.places, bank] },
        'gather 9 minecraft:gravel',
      );
      expect(known).toContain('best: remembered (River Oasis), seen 3.2 min ago, north_east');
      expect(known).not.toContain('the shore of the water');
      // Logs do not lie by water: the forest it saw, or new ground.
      const noLogs = { ...WET, places: [POND, LAKE] };
      expect(step({ 'minecraft:log': 8 }, noLogs, 'gather 8 minecraft:log')).toContain(
        'look in the Hot Forest at x -8, z 40, 40 m south',
      );
      expect(
        step({ 'minecraft:log': 8 }, { ...noLogs, biomes: [] }, 'gather 8 minecraft:log'),
      ).not.toContain('the shore of the water');
    });

    it('comes after a likely biome away from here, and before the one the player stands in', () => {
      const oasis = {
        biome: 'River Oasis',
        chunks: 3,
        x: 72,
        z: 40,
        distance: 80,
        direction: 'south_east' as const,
      };
      expect(
        step({ 'minecraft:gravel': 9 }, { ...WET, biomes: [...WET.biomes, oasis] }, GRAVEL),
      ).toContain('look in the River Oasis at x 72, z 40, 80 m south_east (seen, 3 chunk(s))');
      const here = { ...oasis, x: 3, z: 2, distance: 3, direction: 'here' as const };
      expect(
        step({ 'minecraft:gravel': 9 }, { ...WET, biomes: [...WET.biomes, here] }, GRAVEL),
      ).toContain(SHORE);
      expect(
        step(
          { 'minecraft:gravel': 9 },
          { ...WET, places: [POND], biomes: [...WET.biomes, here] },
          GRAVEL,
        ),
      ).toContain('look in the River Oasis the player stands in (seen, 3 chunk(s))');
    });

    it("fits the planner request's limits, far coordinates and all", () => {
      const far = water(-29_999_000, 29_999_000, 1_234_567, { seenMinutesAgo: 12_345.6 });
      const request = buildPlannerRequest({
        state: needing({ 'minecraft:gravel': 9, 'minecraft:clay': 4, 'minecraft:sand': 8 }),
        safety: safetyCtx(),
        maxPlanSteps: 8,
        recentActions: [],
        recentFailures: [],
        exploration: { ...WORLD, places: [far] },
      });
      const steps = request.route?.steps ?? [];
      const hinted = steps.filter((s) => s.includes('the shore of the water at x -29999000'));
      expect(hinted).toHaveLength(3);
      for (const s of hinted) expect(s.length).toBeLessThanOrEqual(500);
      const hint = /look in (the shore of the water[^;]*;[^;]*)/.exec(hinted[0] ?? '')?.[1] ?? '';
      expect(hint.length).toBeGreaterThan(100);
      expect(hint.length).toBeLessThanOrEqual(MAX_JOURNAL_LINE);
    });
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
