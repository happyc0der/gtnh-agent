import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { FOOD_TASK_ID } from '../../src/domain/food.ts';
import type { ExplorationSummary } from '../../src/domain/world-memory.ts';
import { routeForPlanner, type FoodContext } from '../../src/planner/planner-provider.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

/**
 * Food 9 with nothing to eat, on the play loop's food task (seen live: food 9/20, its only
 * apple eaten). The player stands at (1, 64, 1); the mock lists no other resources.
 */
const hungry = (mutate: (w: MockWorld) => void = () => undefined) =>
  makeState((w) => {
    w.player.hunger = 9;
    delete w.inventory.items['minecraft:bread'];
    w.task = { taskId: FOOD_TASK_ID, goal: 'Get food', subgoal: '0/10', status: 'active' };
    w.recipe = null;
    w.resourceBlocks = [];
    mutate(w);
  });
const food = (combatEnabled = true, recentMeals: string[] = []): FoodContext => ({
  safety: safetyCtx(),
  recentMeals,
  combatEnabled,
});
const cow = (w: MockWorld): void => {
  w.mobs = [
    {
      id: 501,
      type: 'minecraft:Cow',
      category: 'passive',
      position: { x: 6, y: 64, z: 1 },
      health: 10,
    },
  ];
};
const garden =
  (block: string, x = 1, z = 3) =>
  (w: MockWorld) => {
    w.resourceBlocks.push({
      block: block as 'harvestcraft:berrygarden',
      position: { x, y: 64, z },
    });
  };

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
  places: [],
  biomes: [
    { biome: 'Hot Desert', chunks: 24, x: -8, z: -8, distance: 11, direction: 'south_west' },
    { biome: 'Hot Forest', chunks: 16, x: -8, z: 40, distance: 40, direction: 'south' },
  ],
};

describe("the food task's route", () => {
  it('counts the food carried in hunger points, against a day of food', () => {
    const route = routeForPlanner(hungry(), undefined, food());
    expect(route?.stock).toEqual([
      {
        item: 'food (hunger points of approved food carried)',
        have: 0,
        stored: 0,
        need: 10,
        missing: 10,
      },
    ]);
    expect(route?.steps[0]).toMatch(/^food 9\/20 and too little food carried: get 10 more/);
    expect(route?.steps[0]).toContain('Spice of Life');
    // Enough carried (mixed food: Spice of Life counted): nothing to gather.
    const fed = hungry((w) => {
      w.inventory.items['minecraft:apple'] = 5;
      w.inventory.items['minecraft:carrot'] = 5;
    });
    expect(routeForPlanner(fed, undefined, food())?.steps.at(-1)).toBe(
      'enough food is carried already',
    );
  });

  it('offers each garden in view with its GATHER, nearest first; the count covers its non-food drops', () => {
    const state = hungry((w) => {
      garden('harvestcraft:desertgarden', 1, 6)(w);
      garden('harvestcraft:berrygarden', 1, 3)(w);
    });
    const steps = routeForPlanner(state, undefined, food())?.steps ?? [];
    expect(steps[1]).toMatch(
      /^1\. gather food: dig harvestcraft:berrygarden \(3 a dig, any of .*\); best: in view \(1, 64, 3\) .*: GATHER \{"block":"harvestcraft:berrygarden","count":10\}$/,
    );
    // A desert garden drops cactus fruit or cactus: half of it food, so twice the count.
    expect(steps[2]).toContain('GATHER {"block":"harvestcraft:desertgarden","count":20}');
    // Never the textile garden (cotton only).
    const cotton = hungry(garden('harvestcraft:textilegarden'));
    expect(routeForPlanner(cotton, undefined, food())?.steps.join('\n')).not.toContain(
      'textilegarden',
    );
  });

  it('offers a cow in view, with combat on and the moment fit for a fight', () => {
    const steps = routeForPlanner(hungry(cow), undefined, food())?.steps ?? [];
    // 1-3 beef and 0-2 leather a cow: 2 of every 3 drops are beef.
    expect(steps[1]).toMatch(
      /^1\. gather food: kill minecraft:Cow \(1-3 minecraft:beef each; .*\); in view: 1, nearest 5 m away: GATHER \{"animal":"minecraft:Cow","count":15\}$/,
    );
    // Combat off: no hunt is offered at all.
    const off = routeForPlanner(hungry(cow), undefined, food(false))?.steps.join('\n') ?? '';
    expect(off).not.toContain('minecraft:Cow');
  });

  it('never offers a hunt the safety policy would refuse (food below 8 here), but says why', () => {
    const starving = hungry((w) => {
      cow(w);
      w.player.hunger = 2;
      garden('harvestcraft:berrygarden')(w);
    });
    const steps = routeForPlanner(starving, undefined, food())?.steps ?? [];
    expect(steps.join('\n')).not.toContain('"animal"');
    expect(steps[1]).toContain('GATHER {"block":"harvestcraft:berrygarden"');
    expect(steps.at(-1)).toBe(
      'animals are in view, but hunting is not allowed now (LOW_HUNGER): gardens only',
    );
    // With no garden in view either, it still says where to look.
    const none = hungry((w) => {
      cow(w);
      w.player.hunger = 2;
    });
    const where = routeForPlanner(none, WORLD, food())?.steps ?? [];
    expect(where[1]).toMatch(
      /^1\. gather food: .*no known place yet: explore \(look in the Hot Forest/,
    );
    expect(where.at(-1)).toContain('hunting is not allowed now');
  });

  it('with nothing in view: a remembered garden first, else where gardens grow', () => {
    const remembered: ExplorationSummary = {
      ...WORLD,
      places: [
        {
          resource: 'garden',
          x: 20,
          y: 70,
          z: 75,
          distance: 77,
          direction: 'south',
          count: 2,
          biome: 'Hot Forest',
          seenMinutesAgo: 12,
        },
      ],
    };
    expect(routeForPlanner(hungry(), remembered, food())?.steps[1]).toMatch(
      /^1\. gather food: dig a HarvestCraft garden; best: remembered \(Hot Forest\).* \(20, 70, 75\) 77 m away.*EXPLORE toward its x and z first/,
    );
    // Nothing remembered: the nearest seen biome where gardens grow, away from here.
    expect(routeForPlanner(hungry(), WORLD, food())?.steps[1]).toContain(
      'no known place yet: explore (look in the Hot Forest at x -8, z 40, 40 m south',
    );
    // No world memory at all: where gardens grow and animals graze, in words.
    expect(routeForPlanner(hungry(), undefined, food())?.steps[1]).toContain(
      'explore (look in plains, forests, savannas',
    );
  });
});
