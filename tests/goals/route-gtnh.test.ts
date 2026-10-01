import { describe, expect, it } from 'vitest';
import { gtnhRouteBook, knowledgeFailure, ROUTE_BOOK } from '../../src/goals/route-book.ts';
import { describeRoute, planRoute, type Route, type RouteBook } from '../../src/goals/route.ts';

const steps = (route: Route): string[] =>
  route.legs.map((l) =>
    l.kind === 'craft'
      ? `${l.station === 'furnace' ? 'smelt' : 'craft'} ${l.makes.item}`
      : `${l.kind} ${l.item}`,
  );

// Loading the book and the first routes take a moment on a busy machine.
describe('routes over the GTNH knowledge base', { timeout: 30_000 }, () => {
  it('loads the generated book (thousands of recipes, ore sources, tools)', () => {
    expect(knowledgeFailure()).toBeNull();
    const book = gtnhRouteBook();
    expect(book.recipes.length).toBeGreaterThan(50_000);
    expect(book.sources.some((s) => s.blocks.includes('gregtech:gt.blockores@500'))).toBe(true);
    expect(book.tools?.some((t) => t.item === 'minecraft:iron_pickaxe' && t.level === 3)).toBe(
      true,
    );
    // Hand-verified entries win: GTNH's 1 log -> 2 planks keeps its verified count and id.
    expect(book.recipes.find((r) => r.id === 'planks_oak')?.output).toEqual({
      item: 'minecraft:planks',
      count: 2,
    });
    // ... and replace the generated copy of the same recipe (which has no count).
    expect(
      book.recipes
        .filter(
          (r) =>
            r.output.item === 'minecraft:planks' &&
            r.inputs.length === 1 &&
            r.inputs[0]?.anyOf.length === 1 &&
            r.inputs[0].anyOf[0] === 'minecraft:log',
        )
        .map((r) => r.id),
    ).toEqual(['planks_oak']);
  });

  it('a GregTech mortar: flint, smooth stone from a furnace, a pickaxe to dig the stone', () => {
    const route = planRoute({ 'gregtech:gt.metatool.01@24': 1 }, {}, ROUTE_BOOK, () => [], [], []);
    expect(route.unresolved).toEqual({});
    expect(steps(route)).toEqual([
      'gather minecraft:gravel',
      'craft minecraft:flint',
      'gather minecraft:log',
      'craft minecraft:planks',
      'craft minecraft:stick',
      'craft minecraft:wooden_pickaxe',
      'gather minecraft:cobblestone',
      'smelt minecraft:stone',
      'craft gregtech:gt.metatool.01@24',
    ]);
    expect(route.legs.at(-1)).toMatchObject({ recipe: 'gregtech:gt.metatool.01@24[Flint]#1' });
    expect(route.tools).toEqual([
      {
        for: 'dig minecraft:stone',
        need: 'pickaxe level >= 0',
        have: null,
        get: 'minecraft:wooden_pickaxe',
      },
    ]);
    expect(route.stationNeeds.map((s) => [s.station, s.status])).toEqual([
      ['crafting_table', 'missing'],
      ['furnace', 'missing'],
    ]);
    const lines = describeRoute(route);
    // The hand-verified GTNH table recipe (2 flint above 2 logs) replaced the generated copy.
    expect(lines).toContain(
      'station: crafting_table: none known; make one: crafting_table: 2 minecraft:flint, ' +
        '2 minecraft:log (2x2), then place it',
    );
    expect(
      lines.some((l) => l.includes('smelt 5 minecraft:cobblestone -> >=5 minecraft:stone')),
    ).toBe(true);
  });

  it('a chest: the GTNH recipe, with flint made from gravel', () => {
    const route = planRoute(
      { 'minecraft:chest': 1 },
      {},
      ROUTE_BOOK,
      () => [],
      [],
      ['crafting_table'],
    );
    expect(route.unresolved).toEqual({});
    expect(route.legs.at(-1)).toMatchObject({
      kind: 'craft',
      recipe: 'chest',
      station: 'crafting_table',
    });
    expect(route.raw).toEqual({ 'minecraft:log': 6, 'minecraft:gravel': 3 });
    expect(route.stationNeeds).toEqual([
      {
        station: 'crafting_table',
        status: 'available',
        item: 'minecraft:crafting_table',
        make: null,
      },
    ]);
  });

  it('torches: the verified 3-per-coal recipe, with coal from a GT small ore', () => {
    const route = planRoute({ 'minecraft:torch': 6 }, { 'minecraft:coal': 1 }, ROUTE_BOOK);
    expect(route.unresolved).toEqual({});
    expect(route.legs.at(-1)).toMatchObject({ recipe: 'torch_coal', times: 2 });
    const coal = route.legs.find((l) => l.kind === 'gather' && l.item === 'minecraft:coal');
    expect(coal).toMatchObject({ tool: { kind: 'pickaxe', level: 0 } });
    expect(coal?.kind === 'gather' ? coal.where : null).toMatch(/^GT small ore Coal: y 120-250/);
  });

  it('an iron pickaxe from nothing: goes as far as it can, and names the missing pickaxe', () => {
    const route = planRoute({ 'minecraft:iron_pickaxe': 1 }, {}, ROUTE_BOOK);
    // A wooden pickaxe digs small copper and zinc ores: brass for the hammer and the file
    // (GTNH's early game); iron itself needs a pickaxe of level 1, which the book cannot make.
    expect(route.legs.at(-1)).toMatchObject({ kind: 'craft', recipe: 'minecraft:iron_pickaxe#1' });
    const missing = Object.keys(route.unresolved);
    expect(missing).toHaveLength(1);
    expect(route.why[missing[0] ?? '']).toMatch(
      /GT small ore Iron: y 40-100.*needs a pickaxe level >= 1: none held, none known to make/,
    );
    expect(route.tools).toContainEqual({
      for: 'dig gregtech:gt.blockores@16032',
      need: 'pickaxe level >= 1',
      have: null,
      get: null,
    });
    expect(route.tools).toContainEqual({
      for: 'dig minecraft:stone',
      need: 'pickaxe level >= 0',
      have: null,
      get: 'minecraft:wooden_pickaxe',
    });
  });

  it('an iron pickaxe with a pickaxe of unknown level: ores, smelting, then the crafting tools', () => {
    const route = planRoute(
      { 'minecraft:iron_pickaxe': 1 },
      { 'TConstruct:pickaxe': 1 },
      ROUTE_BOOK,
      () => [],
      [],
      ['crafting_table'],
    );
    expect(route.unresolved).toEqual({});
    const last = route.legs.at(-1);
    expect(last).toMatchObject({ kind: 'craft', recipe: 'minecraft:iron_pickaxe#1' });
    // The file and the hammer are tools: made once, used, not consumed.
    expect(last?.kind === 'craft' ? last.tools : []).toEqual([
      'gregtech:gt.metatool.01@18',
      'gregtech:gt.metatool.01@12',
    ]);
    expect(last?.kind === 'craft' ? Object.keys(last.uses) : []).not.toContain(
      'gregtech:gt.metatool.01@12',
    );
    expect(
      route.tools.filter((t) => t.need === 'ore:craftingToolHardHammer').length,
    ).toBeGreaterThan(0);
    // The held Tinkers' pickaxe digs the ores, but its level is not known from its name.
    expect(route.tools).toContainEqual(
      expect.objectContaining({ have: 'TConstruct:pickaxe', unverified: true }),
    );
    expect(route.stationNeeds.find((s) => s.station === 'furnace')?.status).toBe('missing');
    expect(steps(route).filter((s) => s.startsWith('smelt')).length).toBeGreaterThan(0);
  });

  it('100 diamonds with no pickaxe: both pickaxe levels, and where diamonds generate', () => {
    const route = planRoute({ 'minecraft:diamond': 100 }, {}, ROUTE_BOOK, () => [], [], []);
    expect(route.unresolved).toEqual({ 'minecraft:diamond': 100 });
    expect(route.tools).toEqual([
      { for: 'dig gregtech:gt.blockores@16500', need: 'pickaxe level >= 3', have: null, get: null },
      { for: 'dig gregtech:gt.blockores@500', need: 'pickaxe level >= 4', have: null, get: null },
    ]);
    const why = route.why['minecraft:diamond'] ?? '';
    expect(why).toContain('GT small ore Diamond: y 5-15');
    expect(why).toContain('GT vein Diamond (in-between): y 5-20');
    expect(why).toContain('furnace:gregtech:gt.metaitem.03@5500');
  });

  it('100 diamonds with an iron pickaxe: small ores (level 3), not the vein (level 4)', () => {
    const route = planRoute(
      { 'minecraft:diamond': 100 },
      { 'minecraft:iron_pickaxe@12': 1 },
      ROUTE_BOOK,
    );
    expect(route.legs).toMatchObject([
      {
        kind: 'gather',
        item: 'minecraft:diamond',
        quantity: 100,
        blocks: ['gregtech:gt.blockores@16500'],
        actions: 375,
        tool: { kind: 'pickaxe', level: 3 },
      },
    ]);
    // A worn vanilla pickaxe (damage = wear) still counts.
    expect(route.tools).toEqual([
      {
        for: 'dig gregtech:gt.blockores@16500',
        need: 'pickaxe level >= 3',
        have: 'minecraft:iron_pickaxe@12',
        get: null,
      },
    ]);
  });

  it('100 diamonds with a diamond pickaxe: the vein, raw ore smelted in a furnace', () => {
    const route = planRoute(
      { 'minecraft:diamond': 100 },
      { 'minecraft:diamond_pickaxe': 1 },
      ROUTE_BOOK,
      () => [],
      [],
      ['crafting_table'],
    );
    expect(steps(route)).toEqual([
      'gather gregtech:gt.metaitem.03@5500',
      'smelt minecraft:diamond',
    ]);
    expect(route.legs[0]).toMatchObject({
      blocks: ['gregtech:gt.blockores@500'],
      tool: { kind: 'pickaxe', level: 4 },
      where: 'GT vein Diamond (in-between): y 5-20 (Overworld)',
    });
    expect(route.stationNeeds).toEqual([
      {
        station: 'furnace',
        status: 'missing',
        item: 'minecraft:furnace',
        make: 'minecraft:furnace#1: 6 minecraft:cobblestone, 3 minecraft:flint (crafting_table)',
      },
    ]);
    const lines = describeRoute(route);
    expect(lines[lines.length - 1]).toBe(
      '2. smelt 100 gregtech:gt.metaitem.03@5500 -> >=100 minecraft:diamond (furnace; fuel for 100 items)',
    );
  });

  it('stays fast on a deep route through thousands of recipes', () => {
    const started = performance.now();
    for (let i = 0; i < 5; i++) {
      const route = planRoute(
        { 'minecraft:iron_pickaxe': 1, 'gregtech:gt.metatool.01@24': 1, 'minecraft:torch': 16 },
        { 'TConstruct:pickaxe': 1 },
        ROUTE_BOOK,
      );
      expect(route.unresolved).toEqual({});
    }
    expect((performance.now() - started) / 5).toBeLessThan(1500);
  });
});

describe('routes: tools and stations, in general', () => {
  // A tiny world: ore needs a level-1 pickaxe, the pickaxe needs ore; rubble gives ore slowly
  // without a tool. A hammer is a crafting tool for plates.
  const book: RouteBook = {
    recipes: [
      {
        id: 'pick',
        output: { item: 'x:pick', count: 1 },
        inputs: [{ anyOf: ['x:ore'], count: 3 }],
        station: '2x2',
      },
      {
        id: 'hammer',
        output: { item: 'x:hammer', count: 1 },
        inputs: [{ anyOf: ['x:ore'], count: 2 }],
        station: '2x2',
      },
      {
        id: 'plate',
        output: { item: 'x:plate', count: 1 },
        inputs: [
          { anyOf: ['x:hammer'], count: 1, tool: true },
          { anyOf: ['x:ore'], count: 1 },
        ],
        station: 'crafting_table',
      },
      {
        id: 'machine-only',
        output: { item: 'x:gear', count: 1 },
        inputs: [{ anyOf: ['x:ore'], count: 1 }],
        station: 'gt:lathe',
      },
    ],
    sources: [
      {
        item: 'x:ore',
        via: 'dig',
        blocks: ['x:ore_block'],
        perAction: 1,
        secondsPerAction: 2,
        tool: { kind: 'pickaxe', level: 1 },
        where: 'veins',
      },
      { item: 'x:ore', via: 'dig', blocks: ['x:rubble'], perAction: 0.1, secondsPerAction: 2 },
    ],
    tools: [{ item: 'x:pick', kind: 'pickaxe', level: 1 }],
    stationItems: { crafting_table: 'x:table' },
  };

  it('gets the tool a dig needs first, even when the tool needs what it will dig', () => {
    const route = planRoute({ 'x:ore': 50 }, {}, book);
    expect(route.unresolved).toEqual({});
    expect(route.legs).toMatchObject([
      {
        kind: 'gather',
        item: 'x:ore',
        quantity: 3,
        blocks: ['x:rubble'],
        purpose: 'tool: pickaxe level >= 1 to dig x:ore_block',
      },
      { kind: 'craft', recipe: 'pick', purpose: 'tool: pickaxe level >= 1 to dig x:ore_block' },
      {
        kind: 'gather',
        item: 'x:ore',
        quantity: 50,
        blocks: ['x:ore_block'],
        tool: { kind: 'pickaxe', level: 1 },
      },
    ]);
    expect(route.tools).toEqual([
      { for: 'dig x:ore_block', need: 'pickaxe level >= 1', have: null, get: 'x:pick' },
    ]);
    expect(describeRoute(route)).toContain(
      'tool: pickaxe level >= 1 for dig x:ore_block: get x:pick first (steps marked "for: tool")',
    );
  });

  it('digs the slow way when a few items do not pay for the tool', () => {
    const route = planRoute({ 'x:ore': 1 }, {}, book);
    expect(route.legs).toMatchObject([{ kind: 'gather', blocks: ['x:rubble'], actions: 10 }]);
    expect(route.tools).toEqual([]);
  });

  it('uses a crafting tool without consuming it, and gets it once', () => {
    const route = planRoute(
      { 'x:plate': 3 },
      { 'x:pick': 1 },
      book,
      () => [],
      [],
      ['crafting_table'],
    );
    const crafts = route.legs.filter((l) => l.kind === 'craft');
    expect(crafts).toMatchObject([
      { recipe: 'hammer', times: 1, purpose: 'tool for plate' },
      { recipe: 'plate', times: 3, uses: { 'x:ore': 3 }, tools: ['x:hammer'] },
    ]);
    expect(route.raw).toEqual({ 'x:ore': 5 });
  });

  it('skips machine recipes and says why nothing else makes the item', () => {
    const route = planRoute({ 'x:gear': 1 }, {}, book);
    expect(route.unresolved).toEqual({ 'x:gear': 1 });
    expect(route.why['x:gear']).toBe('made only in machines the agent cannot use');
  });

  it('lists a station the caller lacks, with how to make it', () => {
    const withTable: RouteBook = {
      ...book,
      recipes: [
        ...book.recipes,
        {
          id: 'table',
          output: { item: 'x:table', count: 1 },
          inputs: [{ anyOf: ['x:ore'], count: 4 }],
          station: '2x2',
        },
      ],
    };
    const route = planRoute(
      { 'x:plate': 1 },
      { 'x:hammer': 1, 'x:ore': 1 },
      withTable,
      () => [],
      [],
      [],
    );
    expect(route.stationNeeds).toEqual([
      {
        station: 'crafting_table',
        status: 'missing',
        item: 'x:table',
        make: 'table: 4 x:ore (2x2)',
      },
    ]);
    // Holding the station's item: place it.
    const held = planRoute(
      { 'x:plate': 1 },
      { 'x:hammer': 1, 'x:ore': 1, 'x:table': 1 },
      withTable,
      () => [],
      [],
      [],
    );
    expect(held.stationNeeds[0]?.status).toBe('held');
  });
});
