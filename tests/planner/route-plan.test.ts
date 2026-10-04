import { describe, expect, it } from 'vitest';
import { PlanSchema } from '../../src/planner/plan-schema.ts';
import { planFromRoute, routeActions } from '../../src/planner/route-plan.ts';

/** The live route of 2026-10-04: 7 planks and 2 sticks held, the axe and the hoe to make. */
const CRAFTS = {
  stock: [
    { item: 'minecraft:wooden_axe', have: 0, stored: 0, need: 1, missing: 1 },
    { item: 'minecraft:wooden_hoe', have: 0, stored: 0, need: 1, missing: 1 },
  ],
  steps: [
    'stock: minecraft:wooden_axe have 0 / need 1; minecraft:wooden_hoe have 0 / need 1',
    'already held for this: 7 minecraft:planks, 2 minecraft:stick',
    '1. craft wooden_axe x1 -> 1 minecraft:wooden_axe (crafting_table; uses 3 minecraft:planks, 2 minecraft:stick) => CRAFT_ITEM {"recipe":"wooden_axe","times":1,"craftingTableId":"crafting_table:29.107.109"}',
    '2. craft sticks x1 -> 2 minecraft:stick (2x2; uses 2 minecraft:planks) => CRAFT_ITEM {"recipe":"sticks","times":1,"craftingTableId":null}',
    '3. craft minecraft:wooden_hoe#1 x1 -> 1 minecraft:wooden_hoe (crafting_table; uses 2 minecraft:planks, 2 minecraft:stick) => CRAFT_ITEM {"recipe":"minecraft:wooden_hoe#1","times":1,"craftingTableId":"crafting_table:29.107.109"}',
  ],
};

describe('plans code makes from the route alone (route-plan.ts)', () => {
  it('follows a route of exact actions: the crafts in order, a valid plan', () => {
    const plan = planFromRoute(CRAFTS, 12);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(plan?.steps.map((s) => s.action)).toEqual(routeActions(CRAFTS.steps));
    expect(plan?.steps.map((s) => s.action.type)).toEqual([
      'CRAFT_ITEM',
      'CRAFT_ITEM',
      'CRAFT_ITEM',
    ]);
    expect(plan?.goal).toBe('make 1 minecraft:wooden_axe, 1 minecraft:wooden_hoe');
    // At most the plan's length: the rest next time.
    expect(planFromRoute(CRAFTS, 2)?.steps).toHaveLength(2);
  });

  it('follows a route of gathers too: each a GATHER, the plan "gather ..."', () => {
    const route = {
      stock: [{ item: 'minecraft:cobblestone', have: 0, stored: 0, need: 8, missing: 8 }],
      steps: [
        'stock: minecraft:cobblestone have 0 / need 8',
        '1. gather 8 minecraft:cobblestone: dig minecraft:stone or minecraft:cobblestone (~8 digs, ~0.5 min); best: (3, 63, 0) 3 m away, ~12 seen => GATHER {"block":"minecraft:stone","count":8}',
      ],
    };
    const plan = planFromRoute(route, 12);
    expect(PlanSchema.safeParse(plan).success).toBe(true);
    expect(plan?.steps.map((s) => s.action)).toEqual([
      { type: 'GATHER', args: { block: 'minecraft:stone', count: 8 } },
    ]);
    expect(plan?.goal).toBe('gather 8 minecraft:cobblestone');
  });

  it('leaves the plan to the model when a step is not an exact action, or there is no route', () => {
    const gather = {
      ...CRAFTS,
      steps: [
        ...CRAFTS.steps,
        '4. gather 2 minecraft:log: dig minecraft:log (~2 digs, ~0.2 min); no known place yet: explore',
      ],
    };
    expect(planFromRoute(gather, 12)).toBeNull();
    expect(planFromRoute(null, 12)).toBeNull();
    expect(planFromRoute({ stock: [], steps: ['stock: nothing missing'] }, 12)).toBeNull();
  });
});
