import { describe, expect, it } from 'vitest';
import {
  DIG_YIELDS,
  HAND_BOOK,
  ROUTE_BOOK,
  VANILLA_DIG_YIELDS,
} from '../../src/goals/route-book.ts';
import { describeRoute, planRoute, type RouteBook } from '../../src/goals/route.ts';
import { routeForPlanner } from '../../src/planner/planner-provider.ts';
import { makeState } from '../fixtures/index.ts';

const SAND_HERE = (blocks: readonly string[]) =>
  blocks.includes('minecraft:sand')
    ? [{ where: { x: -6, y: 104, z: -8 }, distance: 2.1, amount: 64, label: 'in view' }]
    : [];

describe('routes: what a goal needs, exactly, and in which order', () => {
  it('takes stock, uses what is held, and gathers the rest at the best known place', () => {
    const route = planRoute(
      { 'minecraft:sand': 128 },
      { 'minecraft:sand': 55, 'minecraft:cobblestone': 10 },
      ROUTE_BOOK,
      SAND_HERE,
    );
    expect(route.stock).toEqual([
      { item: 'minecraft:sand', have: 55, stored: 0, need: 128, missing: 73 },
    ]);
    expect(route.fromInventory).toEqual({ 'minecraft:sand': 55 });
    expect(route.raw).toEqual({ 'minecraft:sand': 73 });
    expect(route.legs).toMatchObject([
      { kind: 'gather', item: 'minecraft:sand', quantity: 73, actions: 73, best: { amount: 64 } },
    ]);
    expect(route.unresolved).toEqual({});
  });

  it('fetches from known containers before gathering, nearest container first', () => {
    const chests = [
      {
        id: 'chest.far',
        where: { x: 30, y: 64, z: 0 },
        distance: 30,
        items: { 'minecraft:sand': 64 },
      },
      {
        id: 'chest.near',
        where: { x: 3, y: 64, z: 0 },
        distance: 3,
        items: { 'minecraft:sand': 20 },
      },
    ];
    const route = planRoute(
      { 'minecraft:sand': 128 },
      { 'minecraft:sand': 55 },
      ROUTE_BOOK,
      SAND_HERE,
      chests,
    );
    expect(route.stock).toEqual([
      { item: 'minecraft:sand', have: 55, stored: 84, need: 128, missing: 0 },
    ]);
    expect(route.legs).toMatchObject([
      { kind: 'withdraw', containerId: 'chest.near', quantity: 20 },
      { kind: 'withdraw', containerId: 'chest.far', quantity: 53 },
    ]);
    expect(route.raw).toEqual({});
    expect(describeRoute(route)[0]).toBe('stock: minecraft:sand have 55 + 84 stored / need 128');
  });

  it('expands recipes depth-first: ingredients before what they make', () => {
    const route = planRoute({ 'minecraft:stick': 4 }, {}, ROUTE_BOOK);
    expect(route.legs.map((l) => (l.kind === 'craft' ? l.recipe : `gather ${l.item}`))).toEqual([
      'gather minecraft:log',
      'planks_oak',
      'sticks',
    ]);
    // No place known: the step says where a player would look.
    const lines = describeRoute(route);
    expect(lines.some((l) => l.includes('explore (look in forests'))).toBe(true);
  });

  it('mixes kinds a recipe accepts, starting with what is held, and needs a table for 3x3', () => {
    // The hand-verified book alone (no generated GTNH data): exact, small numbers.
    const route = planRoute({ 'minecraft:chest': 1 }, { 'minecraft:planks@2': 3 }, HAND_BOOK);
    // 4 logs + 4 planks + 1 flint: 3 birch planks held, 1 more plank from a log, and the
    // flint crafted from 3 gravel (GTNH: gravel never drops flint).
    expect(route.raw).toEqual({ 'minecraft:log': 5, 'minecraft:gravel': 3 });
    expect(route.fromInventory).toEqual({ 'minecraft:planks@2': 3 });
    expect(route.stations).toEqual(['crafting_table']);
    expect(route.legs.find((l) => l.kind === 'craft' && l.recipe === 'flint')).toMatchObject({
      times: 1,
      makes: { item: 'minecraft:flint', count: 1 },
      uses: { 'minecraft:gravel': 3 },
    });
    expect(route.legs.some((l) => l.kind === 'gather' && l.item === 'minecraft:flint')).toBe(false);
  });

  it('never digs gravel for flint (GTNH), unlike vanilla', () => {
    expect(VANILLA_DIG_YIELDS['minecraft:gravel']).toContainEqual({
      item: 'minecraft:flint',
      perDig: 0.1,
    });
    expect(DIG_YIELDS['minecraft:gravel']).toEqual([{ item: 'minecraft:gravel', perDig: 1 }]);
    const flint = planRoute({ 'minecraft:flint': 3 }, {}, ROUTE_BOOK);
    expect(flint.legs).toMatchObject([
      { kind: 'gather', item: 'minecraft:gravel', quantity: 9, blocks: ['minecraft:gravel'] },
      { kind: 'craft', recipe: 'flint', times: 3, makes: { count: 3 } },
    ]);
  });

  it('reports what nothing it knows can make, and why', () => {
    const route = planRoute({ 'minecraft:torch': 6 }, { 'minecraft:coal': 1 }, HAND_BOOK);
    expect(route.unresolved).toEqual({ 'minecraft:coal': 1 });
    expect(route.why).toEqual({ 'minecraft:coal': 'no recipe or source known' });
    expect(describeRoute(route).slice(-2)).toEqual([
      'no known way to get: 1 minecraft:coal',
      '  minecraft:coal: no recipe or source known',
    ]);
  });

  it('survives a recipe loop', () => {
    const loop: RouteBook = {
      recipes: [
        {
          id: 'a',
          output: { item: 'x:a', count: 1 },
          inputs: [{ anyOf: ['x:b'], count: 1 }],
          station: '2x2',
        },
        {
          id: 'b',
          output: { item: 'x:b', count: 1 },
          inputs: [{ anyOf: ['x:a'], count: 1 }],
          station: '2x2',
        },
      ],
      sources: [],
    };
    expect(planRoute({ 'x:a': 1 }, {}, loop).unresolved).toMatchObject({ 'x:a': 1 });
  });

  it('reaches the planner when the task names items', () => {
    const base = makeState();
    const state = {
      ...base,
      currentTask: {
        taskId: 'quest-0:17',
        goal: 'Age 0 quest "Sand: The Gathering": have 128 minecraft:sand',
        subgoal: null,
        status: 'active' as const,
        requirements: { 'minecraft:stick': 4 },
      },
    };
    const route = routeForPlanner(state);
    expect(route?.stock).toEqual([
      { item: 'minecraft:stick', have: 0, stored: 0, need: 4, missing: 4 },
    ]);
    expect(route?.steps.some((s) => s.includes('craft sticks x2'))).toBe(true); // GTNH: 2 sticks per craft
    expect(routeForPlanner(base)).toBeNull();
  });
});
