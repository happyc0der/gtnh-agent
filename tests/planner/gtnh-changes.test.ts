import { describe, expect, it } from 'vitest';
import type { GameState } from '../../src/domain/game-state.ts';
import { MAX_GTNH_CHANGES, selectGtnhChanges } from '../../src/goals/gtnh-changes.ts';
import type { GtnhChange } from '../../src/goals/knowledge.ts';
import { planRoute, type RouteBook } from '../../src/goals/route.ts';
import { PLANNER_SYSTEM_PROMPT } from '../../src/llm/ollama-planner-provider.ts';
import { buildPlannerRequest } from '../../src/planner/planner-provider.ts';
import { makeState, safetyCtx } from '../fixtures/index.ts';

const change = (id: string, kind: GtnhChange['kind'], keys: string[]): GtnhChange => ({
  id,
  kind,
  subject: id,
  keys,
  vanilla: { value: 'v', source: 'jar' },
  gtnh: { value: 'g', source: 'dump' },
  change: `changed: ${id}`,
});

describe('choosing the GTNH changes that matter for a route', () => {
  // A tiny world: a box from planks (from logs) and a nail (from ore, dug with a pickaxe).
  const book: RouteBook = {
    recipes: [
      {
        id: 'box',
        output: { item: 'x:box', count: 1 },
        inputs: [
          { anyOf: ['x:planks'], count: 4 },
          { anyOf: ['x:nail'], count: 1 },
        ],
        station: '2x2',
      },
      {
        id: 'planks',
        output: { item: 'x:planks', count: 4 },
        inputs: [{ anyOf: ['x:log'], count: 1 }],
        station: '2x2',
      },
      {
        id: 'nail',
        output: { item: 'x:nail', count: 1 },
        inputs: [{ anyOf: ['x:ore'], count: 1 }],
        station: 'furnace',
      },
    ],
    sources: [
      { item: 'x:log', via: 'dig', blocks: ['x:tree'], perAction: 1 },
      {
        item: 'x:ore',
        via: 'dig',
        blocks: ['x:ore_block'],
        perAction: 1,
        tool: { kind: 'pickaxe', level: 0 },
      },
    ],
    tools: [{ item: 'x:pick', kind: 'pickaxe', level: 0 }],
    stationItems: { furnace: 'x:furnace' },
  };
  const route = planRoute({ 'x:box': 1 }, { 'x:pick': 1 }, book, () => [], [], ['furnace']);
  const changes = [
    change('recipe:x:stairs#1', 'recipe', ['x:stairs', 'x:planks']), // shares an input only
    change('recipe:x:planks#1', 'recipe', ['x:planks', 'x:log']), // made on the way
    change('smelting:x:ore', 'smelting', ['x:ore', 'x:nail']), // smelted on the way
    change('smelting:x:sand', 'smelting', ['x:sand', 'x:glass']), // not in the route
    change('tool:picks', 'tool', ['x:old_pick', 'pickaxe']), // the route needs a pickaxe
    change('drop:x:tree', 'drop', ['x:tree', 'x:apple']), // a dug block
    change('food:hunger', 'food', ['x:bread', 'food']), // only held
    change('recipe:x:box#1', 'recipe', ['x:box', 'x:wood']), // the goal itself
  ];

  it('keeps what the route makes, smelts, digs or needs; the goal first', () => {
    expect(selectGtnhChanges(changes, route)).toEqual([
      'changed: recipe:x:box#1',
      'changed: tool:picks',
      'changed: drop:x:tree',
      'changed: recipe:x:planks#1',
      'changed: smelting:x:ore',
    ]);
  });

  it('adds changes about what the player holds after the route, and caps the list', () => {
    expect(selectGtnhChanges(changes, route, ['x:bread']).at(-1)).toBe('changed: food:hunger');
    expect(selectGtnhChanges(changes, null, ['x:bread', 'x:sand'])).toEqual([
      'changed: smelting:x:sand',
      'changed: food:hunger',
    ]);
    const many = Array.from({ length: 20 }, (_, i) => change(`drop:${i}`, 'drop', ['x:tree']));
    expect(selectGtnhChanges(many, route)).toHaveLength(MAX_GTNH_CHANGES);
  });
});

describe('the planner request carries the GTNH changes for its task', { timeout: 30_000 }, () => {
  const withTask = (requirements: Record<string, number>): GameState => {
    const base = makeState();
    return {
      ...base,
      inventory: { known: true, value: { items: {}, usedSlots: 0, capacitySlots: 36 } },
      currentTask: {
        taskId: 'quest-test',
        goal: `have ${Object.entries(requirements)
          .map(([item, n]) => `${n} ${item}`)
          .join(', ')}`,
        subgoal: null,
        status: 'active' as const,
        requirements,
      },
    };
  };
  const request = (state: GameState) =>
    buildPlannerRequest({
      state,
      safety: safetyCtx(),
      maxPlanSteps: 8,
      recentActions: [],
      recentFailures: [],
    });

  it('a chest: GTNH recipe, flint from gravel, 2 planks per log', () => {
    const r = request(withTask({ 'minecraft:chest': 1 }));
    expect(r.gtnhChanges[0]).toBe(
      "Chest: vanilla's recipe (8 planks -> 1 (3x3)) is not in GTNH; GTNH's: 4 ore:logWood + " +
        '4 ore:plankWood + 1 flint -> 1 (3x3)',
    );
    expect(r.gtnhChanges).toContain(
      'Gravel never drops flint; craft flint from 3 gravel (shapeless, 2x2)',
    );
    expect(r.gtnhChanges).toContain(
      'Wooden Planks: the same ingredients make 2, not 4 (4 with a saw in the grid)',
    );
    // Nothing about recipes the route does not make (e.g. other wooden things).
    expect(r.gtnhChanges.some((c) => c.startsWith('Oak Fence'))).toBe(false);
    expect(r.gtnhChanges.length).toBeLessThanOrEqual(MAX_GTNH_CHANGES);
  });

  it('torches: 3 per coal, no vanilla coal ore, and the disabled vanilla pickaxes', () => {
    const r = request(withTask({ 'minecraft:torch': 8 }));
    expect(r.gtnhChanges.slice(0, 2)).toEqual([
      'Torch: the same ingredients make 3, not 4',
      'Torch: the same ingredients make 2, not 4',
    ]);
    expect(
      r.gtnhChanges.some((c) => c.startsWith('No vanilla coal_ore: mine GregTech Coal ore')),
    ).toBe(true);
    expect(r.gtnhChanges.some((c) => /iron_pickaxe.* mine nothing/.test(c))).toBe(true);
  });

  it('a task without items: only what the player holds', () => {
    // The fixture player holds bread, coal, cobblestone, iron ore and a diamond.
    const r = request(makeState());
    expect(r.route).toBeNull();
    expect(r.gtnhChanges).toContain('Healing needs food >= 8, and foods fill less than in vanilla');
    expect(r.gtnhChanges.some((c) => c.startsWith('No vanilla iron_ore'))).toBe(true);
    expect(r.gtnhChanges.some((c) => c.startsWith('Chest'))).toBe(false);
  });

  it('tells the model to trust GTNH over its memory of vanilla', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain(
      'This is GTNH, not vanilla: where request.gtnhChanges or the route says something differs ' +
        'from vanilla Minecraft, trust it over what you remember of vanilla.',
    );
    expect(PLANNER_SYSTEM_PROMPT).not.toContain('gravel gives flint');
  });
});
