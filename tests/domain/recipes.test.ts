import { describe, expect, it } from 'vitest';
import { ItemNameSchema } from '../../src/domain/common.ts';
import { expectedPostconditionFor } from '../../src/domain/actions.ts';
import {
  ingredientRequirements,
  needsCraftingTable,
  patternSize,
  RECIPE_IDS,
  RECIPES,
} from '../../src/domain/recipes.ts';
import { mintValidatedAction } from '../../src/domain/validated-action.ts';
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
    expect(RECIPE_IDS.filter((id) => needsCraftingTable(RECIPES[id]))).toEqual(['chest']);
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
    expect(RECIPES.sticks.evidence).toMatch(/NOT verified/);
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
      'minecraft:stick': 8,
    });
  });

  it("crafts nothing when the server's recipe differs, or a 3x3 recipe has no table", async () => {
    const { world, client } = makeWorld((w) => {
      Object.assign(w.inventory.items, { 'minecraft:planks': 4 });
      w.craftingResults.sticks = { item: 'minecraft:stick', count: 2 };
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
    expect(differs.message).toMatch(/is 2 x minecraft:stick, not the expected 4 x minecraft:stick/);
    expect(world.inventory.items['minecraft:planks']).toBe(4);
    expect(await perform('chest')).toMatchObject({ ok: false, code: 'REFUSED' });
  });
});
