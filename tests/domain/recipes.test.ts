import { describe, expect, it } from 'vitest';
import { ItemNameSchema } from '../../src/domain/common.ts';
import { expectedPostconditionFor } from '../../src/domain/actions.ts';
import {
  buildKnowledgeRecipes,
  craftableFrom,
  CraftRecipeIdSchema,
  craftingRecipe,
  describeIngredient,
  ingredientRequirements,
  knowledgeRecipeIds,
  knowledgeRecipes,
  needsCraftingTable,
  patternSize,
  RECIPE_IDS,
  RECIPES,
  whyNotCraftable,
} from '../../src/domain/recipes.ts';
import { mintValidatedAction } from '../../src/domain/validated-action.ts';
import { CraftFlag, type KnowledgeData } from '../../src/goals/knowledge.ts';
import { BASE_ABILITIES } from '../../src/goals/quest-goals.ts';
import { ROUTE_BOOK } from '../../src/goals/route-book.ts';
import { action, makeWorld } from '../fixtures/index.ts';

describe('the recipe table', () => {
  it.each(RECIPE_IDS.map((id) => [id, RECIPES[id]] as const))('%s is well formed', (id, r) => {
    expect(r.id).toBe(id);
    const { width, height } = patternSize(r);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(3);
    expect(height).toBeLessThanOrEqual(3);
    // Rectangular, and every key used is defined (and every defined key used).
    expect(r.pattern.every((row) => row.length === width)).toBe(true);
    const used = new Set(r.pattern.join('').replace(/ /g, ''));
    expect(new Set(Object.keys(r.key))).toEqual(used);
    for (const names of Object.values(r.key)) {
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(ItemNameSchema.safeParse(n).success, n).toBe(true);
    }
    expect(ItemNameSchema.safeParse(r.result.item).success).toBe(true);
    expect(r.result.count).toBeGreaterThan(0);
    // The result is never an ingredient, so the verifier's deltas are exact.
    const ingredients = new Set(Object.values(r.key).flat());
    expect(ingredients.has(r.result.item)).toBe(false);
    // Damage values are explicit: no name ends in @0 (that is the bare name).
    expect([...ingredients, r.result.item].some((n) => n.endsWith('@0'))).toBe(false);
    expect(r.evidence.length).toBeGreaterThan(20);
  });

  it('knows which recipes need a crafting table', () => {
    expect(RECIPE_IDS.filter((id) => needsCraftingTable(RECIPES[id]))).toEqual([
      'chest',
      'wooden_shovel',
      'wooden_axe',
    ]);
  });

  it('records GTNH 2.8.4 results where they were verified', () => {
    expect(RECIPES.planks_oak.result).toEqual({ item: 'minecraft:planks', count: 2 });
    expect(RECIPES.planks_dark_oak).toMatchObject({
      key: { L: ['minecraft:log2@1'] },
      result: { item: 'minecraft:planks@5', count: 2 },
    });
    expect(RECIPES.torch_coal.result.count).toBe(3);
    expect(RECIPES.torch_charcoal.key['C']).toEqual(['minecraft:coal@1']);
    expect(RECIPES.chest.evidence).toMatch(/verified/);
    // GregTech's nerfed sticks: two planks give 2, not vanilla's 4.
    expect(RECIPES.sticks.result).toEqual({ item: 'minecraft:stick', count: 2 });
    expect(RECIPES.sticks.evidence).toMatch(/verified.*nerfedWoodPlank/);
    // NewHorizonsCoreMod's crafting table: flint above logs, in the 2x2 grid.
    expect(RECIPES.crafting_table).toMatchObject({
      pattern: ['FF', 'LL'],
      key: { F: ['minecraft:flint'] },
      result: { item: 'minecraft:crafting_table', count: 1 },
    });
    expect(needsCraftingTable(RECIPES.crafting_table)).toBe(false);
    // The vanilla wooden tools are kept (3x3, so at a crafting table).
    expect(RECIPES.wooden_shovel).toMatchObject({
      pattern: ['P', 'S', 'S'],
      key: { S: ['minecraft:stick'] },
      result: { item: 'minecraft:wooden_shovel', count: 1 },
    });
    expect(RECIPES.wooden_axe.pattern).toEqual(['PP', 'PS', ' S']);
    expect(RECIPES.wooden_shovel.key['P']).toEqual(RECIPES.sticks.key['P']);
    expect(RECIPES.wooden_axe.evidence).toMatch(/verified.*RecipesTools/);
  });

  it('derives what a craft uses and makes', () => {
    expect(ingredientRequirements(RECIPES.chest).map((r) => [r.key, r.perCraft])).toEqual([
      ['L', 4],
      ['P', 4],
      ['F', 1],
    ]);
    expect(
      expectedPostconditionFor({
        type: 'CRAFT_ITEM',
        args: { recipe: 'torch_coal', times: 3, craftingTableId: null },
      }),
    ).toEqual({
      kind: 'ITEMS_CRAFTED',
      recipe: 'torch_coal',
      result: 'minecraft:torch',
      quantity: 9,
      ingredients: [
        { anyOf: ['minecraft:coal'], quantity: 3 },
        { anyOf: ['minecraft:stick'], quantity: 3 },
      ],
    });
  });
});

// Loading and indexing the knowledge base takes a moment on a busy machine.
describe("the knowledge base's crafting recipes", { timeout: 30_000 }, () => {
  it("makes GTNH's wooden pickaxe, hoe and sword with their exact layouts and ore entries", () => {
    const pickaxe = craftingRecipe('minecraft:wooden_pickaxe#1');
    expect(pickaxe).toMatchObject({
      pattern: ['aaa', ' b ', ' b '],
      labels: { a: 'ore:plankWood', b: 'ore:stickWood' },
      result: { item: 'minecraft:wooden_pickaxe', count: 1 },
    });
    if (pickaxe === null) throw new Error('no pickaxe');
    expect(needsCraftingTable(pickaxe)).toBe(true);
    // Any of GTNH's 650 planks and 16 sticks, the vanilla ones among them.
    expect(pickaxe.key['a']).toContain('minecraft:planks@3');
    expect(pickaxe.key['a']?.length).toBe(650);
    expect(pickaxe.key['b']).toContain('minecraft:stick');
    expect(pickaxe.evidence).toMatch(/count 1 \(vanilla\)/);
    // CraftTweaker may misread a 2x3 or 1x3 ore recipe's width; vanilla's jar confirms these.
    expect(craftingRecipe('minecraft:wooden_hoe#1')?.pattern).toEqual(['aa', ' b', ' b']);
    expect(craftingRecipe('minecraft:wooden_sword#1')?.pattern).toEqual(['a', 'a', 'b']);
    // GTNH's furnace: cobblestone around three flint, its count from the coremod's scripts.
    expect(craftingRecipe('minecraft:furnace#1')).toMatchObject({
      pattern: ['aaa', 'bbb', 'aaa'],
      key: { b: ['minecraft:flint'] },
      result: { item: 'minecraft:furnace', count: 1 },
    });
    expect(describeIngredient(pickaxe.key['b'] ?? [], 'ore:stickWood')).toMatch(
      /^ore:stickWood \(16 kinds: minecraft:stick, /,
    );
  });

  it('postconditions list every kind an ore ingredient may be (the verifier counts any mix)', () => {
    const post = expectedPostconditionFor({
      type: 'CRAFT_ITEM',
      args: { recipe: 'minecraft:wooden_pickaxe#1', times: 2, craftingTableId: 'table.main' },
    });
    expect(post).toMatchObject({
      kind: 'ITEMS_CRAFTED',
      recipe: 'minecraft:wooden_pickaxe#1',
      result: 'minecraft:wooden_pickaxe',
      quantity: 2,
    });
    if (post.kind !== 'ITEMS_CRAFTED') throw new Error(post.kind);
    expect(post.ingredients.map((g) => [g.anyOf.length, g.quantity])).toEqual([
      [650, 6],
      [16, 4],
    ]);
  });

  it('takes ids as the route writes them; hand-verified recipes win where both exist', () => {
    expect(CraftRecipeIdSchema.safeParse('planks_oak').success).toBe(true);
    expect(CraftRecipeIdSchema.safeParse('minecraft:wooden_pickaxe#1').success).toBe(true);
    // The dump's copy of the hand-verified axe is that recipe: the route shows wooden_axe.
    expect(whyNotCraftable('minecraft:wooden_axe#1')).toBe(
      'the hand-verified recipe wooden_axe is the same recipe',
    );
    expect(craftingRecipe('wooden_axe')).toBe(RECIPES.wooden_axe);
    expect(knowledgeRecipes().replaced.size).toBe(RECIPE_IDS.length);
    for (const id of ['minecraft:wooden_axe#1', 'minecraft:wooden_pickaxe#99', 'oak', '']) {
      expect(CraftRecipeIdSchema.safeParse(id).success, id).toBe(false);
    }
  });

  it('leaves out what the client cannot do safely yet, and says why', () => {
    // GregTech's saw recipe for sticks: the worn saw would stay in the grid.
    expect(whyNotCraftable('minecraft:stick#1')).toMatch(/crafting tool .* stays in the grid/);
    // A GregTech tool: its material is NBT data on the result.
    expect(whyNotCraftable('gregtech:gt.metatool.01@24[Flint]#1')).toMatch(/NBT data/);
    const reasons = new Set(knowledgeRecipes().leftOut.values());
    for (const r of ['nbtInput', 'nbtOutput', 'craftingTool', 'container', 'shape', 'overlap']) {
      expect(reasons.has(r as never), r).toBe(true);
    }
    // Still thousands of recipes, with sound data.
    const made = [...knowledgeRecipes().byId.values()];
    expect(made.length).toBeGreaterThan(15_000);
    for (const r of made.slice(0, 2000)) {
      const groups = ingredientRequirements(r);
      expect(groups.length).toBeGreaterThan(0);
      for (const g of groups) expect(g.anyOf.includes(r.result.item)).toBe(false);
      expect(patternSize(r).width).toBeLessThanOrEqual(3);
      expect(patternSize(r).height).toBeLessThanOrEqual(3);
    }
  });

  it("names every crafting recipe as the route book does, and makes the route's recipes", () => {
    const kb = knowledgeRecipes();
    const route = ROUTE_BOOK.recipes.filter((r) => r.station !== 'furnace' && r.id.includes('#'));
    // The same ids: each one the route book has is made or left out, and no other.
    const known = new Set([...kb.byId.keys(), ...kb.leftOut.keys()]);
    expect(route.length).toBe(known.size);
    expect(route.every((r) => known.has(r.id))).toBe(true);
    // A recipe CRAFT_ITEM makes is the route's: its output, and what one craft uses.
    for (const r of route.filter((x) => kb.byId.has(x.id)).slice(0, 3000)) {
      const made = kb.byId.get(r.id);
      if (made === undefined) throw new Error(r.id);
      expect(made.result.item).toBe(r.output.item);
      expect(needsCraftingTable(made)).toBe(r.station === 'crafting_table');
      expect(ingredientRequirements(made).map((g) => g.perCraft)).toEqual(
        r.inputs.map((i) => i.count),
      );
    }
  });

  it('what the agent can craft from what it gathers: wooden tools need a table', () => {
    const grid = craftableFrom(BASE_ABILITIES.gather, { table: false });
    expect([...grid].sort()).toEqual([
      'minecraft:crafting_table',
      'minecraft:flint',
      'minecraft:planks',
      'minecraft:stick',
    ]);
    const table = craftableFrom(BASE_ABILITIES.gather, { table: true });
    for (const tool of ['pickaxe', 'shovel', 'axe', 'hoe', 'sword']) {
      expect(table.has(`minecraft:wooden_${tool}`), tool).toBe(true);
    }
    // Coal is not gathered: no torches; nor is cobblestone (stone needs a pickaxe): no furnace.
    expect(table.has('minecraft:torch')).toBe(false);
    expect(table.has('minecraft:furnace')).toBe(false);
  });
});

describe('knowledge-base recipes from small data', () => {
  const ITEMS = [
    'minecraft:planks',
    'minecraft:planks@1',
    'minecraft:stick',
    'x:tool',
    'minecraft:water_bucket',
    'x:dough',
    'x:block',
    'x:bar',
    'x:thing',
    'minecraft:flint',
  ];
  const at = (name: string): number => ITEMS.indexOf(name);
  /** A crafting row: output, count, flags, pattern, inputs as [ingredient, count] pairs. */
  const row = (
    out: string,
    count: number,
    flags: number,
    pattern: string,
    inputs: Array<[number | string | number[], number]>,
    label = '',
  ): KnowledgeData['crafting'][number] => [
    at(out),
    count,
    flags,
    pattern,
    inputs.flat(),
    label,
    '',
  ];
  const data = (
    crafting: KnowledgeData['crafting'],
    vanilla: KnowledgeData['vanilla']['crafting'] = [],
  ): KnowledgeData =>
    ({
      items: ITEMS,
      ores: {
        plankWood: [at('minecraft:planks'), at('minecraft:planks@1')],
        listAllwater: [at('minecraft:water_bucket'), at('x:dough')],
        craftingToolSaw: [at('x:tool')],
      },
      crafting,
      vanilla: { crafting: vanilla },
    }) as unknown as KnowledgeData;
  const S = CraftFlag;

  it('ids: the n-th distinct recipe of an item, its label, repeats left out', () => {
    const rows = [
      row('x:bar', 0, S.FITS_2X2, 'a', [['plankWood', 1]]),
      row('x:bar', 0, S.FITS_2X2, 'a', [['plankWood', 1]]), // registered twice
      row('x:bar', 2, S.FITS_2X2, 'a/a', [['plankWood', 2]]),
      row('x:thing', 1, S.NBT_OUTPUT, 'aaa', [['plankWood', 3]], 'Iron'),
    ];
    expect(knowledgeRecipeIds(data(rows))).toEqual(['x:bar#1', null, 'x:bar#2', 'x:thing[Iron]#1']);
  });

  it('lays shapeless recipes out in reading order, and trims a padded shaped one', () => {
    const kb = buildKnowledgeRecipes(
      data([
        row('x:block', 4, S.SHAPELESS | S.FITS_2X2, '', [
          ['plankWood', 2],
          [at('minecraft:flint'), 1],
        ]),
        row('x:thing', 1, S.SHAPELESS, '', [['plankWood', 5]]),
        row('x:bar', 0, S.FITS_2X2, 'aa./b../...', [
          ['plankWood', 2],
          [at('minecraft:flint'), 1],
        ]),
      ]),
    );
    expect(kb.byId.get('x:block#1')).toMatchObject({
      pattern: ['aa', 'b '],
      key: { a: ['minecraft:planks', 'minecraft:planks@1'], b: ['minecraft:flint'] },
      labels: { a: 'ore:plankWood' },
      result: { item: 'x:block', count: 4 },
    });
    expect(kb.byId.get('x:thing#1')?.pattern).toEqual(['aaa', 'aa ']);
    // Padded to 3x3 in the dump, it fits the 2x2 grid; its count is not known: 1 expected.
    expect(kb.byId.get('x:bar#1')).toMatchObject({
      pattern: ['aa', 'b '],
      result: { count: 1 },
      countKnown: false,
    });
  });

  it('a shape the dump may have scrambled only when vanilla has the same layout (or its mirror)', () => {
    const tall = row('x:bar', 1, S.SHAPE_UNCERTAIN, 'aa/.b/.b', [
      ['plankWood', 2],
      [at('minecraft:stick'), 2],
    ]);
    expect(buildKnowledgeRecipes(data([tall])).leftOut.get('x:bar#1')).toBe('shape');
    const vanilla = (rows: string[]): KnowledgeData['vanilla']['crafting'][number] => ({
      output: 'x:bar',
      count: 1,
      shaped: true,
      rows,
      inputs: [
        { item: 'minecraft:planks', damage: null, count: 2 },
        { item: 'minecraft:stick', damage: 0, count: 2 },
      ],
      from: 'test',
    });
    expect(
      buildKnowledgeRecipes(data([tall], [vanilla(['XX', ' #', ' #'])])).byId.get('x:bar#1')
        ?.pattern,
    ).toEqual(['aa', ' b', ' b']);
    expect(
      buildKnowledgeRecipes(data([tall], [vanilla(['XX', '# ', '# '])])).byId.has('x:bar#1'),
    ).toBe(true);
    // Another layout (the 3x2 it may really be) confirms nothing.
    expect(
      buildKnowledgeRecipes(data([tall], [vanilla(['XX#', '  #'])])).leftOut.get('x:bar#1'),
    ).toBe('shape');
  });

  it('leaves out crafting tools, container items, NBT and shared items', () => {
    const kb = buildKnowledgeRecipes(
      data([
        row('x:bar', 1, S.FITS_2X2, 'a/b', [
          ['craftingToolSaw', 1],
          ['plankWood', 1],
        ]),
        row('x:block', 1, S.SHAPELESS | S.FITS_2X2, '', [[at('minecraft:water_bucket'), 1]]),
        // A bucket among other kinds: only the others are used.
        row('x:thing', 1, S.SHAPELESS | S.FITS_2X2, '', [['listAllwater', 1]]),
        row('x:dough', 1, S.NBT_INPUT | S.FITS_2X2, 'a', [['plankWood', 1]]),
        row('x:bar', 1, S.FITS_2X2, 'ab', [
          ['plankWood', 1],
          [at('minecraft:planks'), 1],
        ]),
      ]),
    );
    expect(Object.fromEntries(kb.leftOut)).toEqual({
      'x:bar#1': 'craftingTool',
      'x:block#1': 'container',
      'x:dough#1': 'nbtInput',
      'x:bar#2': 'overlap',
    });
    expect(kb.byId.get('x:thing#1')?.key['a']).toEqual(['x:dough']);
  });
});

describe('the mock client crafts like the live one', () => {
  it('uses any mix of accepted kinds and adds the result', async () => {
    const { world, client } = makeWorld((w) => {
      Object.assign(w.inventory.items, { 'minecraft:planks': 1, 'minecraft:planks@4': 3 });
    });
    await client.connect();
    const r = await client.perform(
      mintValidatedAction(
        action({ type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 2, craftingTableId: null } }),
        null,
        new Date(),
      ),
    );
    expect(r).toMatchObject({ ok: true, data: { crafts: 2 } });
    expect(world.inventory.items).toMatchObject({
      'minecraft:planks': 0,
      'minecraft:planks@4': 0,
      'minecraft:stick': 4,
    });
  });

  it("crafts nothing when the server's recipe differs, or a 3x3 recipe has no table", async () => {
    const { world, client } = makeWorld((w) => {
      Object.assign(w.inventory.items, { 'minecraft:planks': 4 });
      // A server without GregTech's nerf (vanilla sticks).
      w.craftingResults.sticks = { item: 'minecraft:stick', count: 4 };
    });
    await client.connect();
    const perform = (recipe: 'sticks' | 'chest') =>
      client.perform(
        mintValidatedAction(
          action({ type: 'CRAFT_ITEM', args: { recipe, times: 1, craftingTableId: null } }),
          null,
          new Date(),
        ),
      );
    const differs = await perform('sticks');
    expect(differs).toMatchObject({ ok: false });
    expect(differs.message).toMatch(/is 4 x minecraft:stick, not the expected 2 x minecraft:stick/);
    expect(world.inventory.items['minecraft:planks']).toBe(4);
    expect(await perform('chest')).toMatchObject({ ok: false, code: 'REFUSED' });
  });
});
