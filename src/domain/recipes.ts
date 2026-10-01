import { z } from 'zod';

/**
 * The agent's small table of early (Age 0) crafting-grid recipes, keyed by 1.7.10 registry
 * names (`namespace:item`, plus `@damage` when the damage value is not 0).
 *
 * GTNH changes many vanilla recipes, so this table is NEVER trusted blindly: it only says
 * which items to put where. The live client takes a result only if the server's crafting
 * result slot shows exactly the expected item and count; otherwise it puts every ingredient
 * back and reports what the server showed (see docs/gtnh-compatibility.md, "Crafting").
 * Each entry records where its expectation comes from.
 */

/** Largest number of crafts one CRAFT_ITEM may do. */
export const MAX_CRAFT_TIMES = 64;

/** Vanilla wood variants: logs (log@0-3, log2@0-1) and the planks they give (planks@0-5). */
const LOGS = [
  'minecraft:log',
  'minecraft:log@1',
  'minecraft:log@2',
  'minecraft:log@3',
  'minecraft:log2',
  'minecraft:log2@1',
] as const;
const PLANKS = [
  'minecraft:planks',
  'minecraft:planks@1',
  'minecraft:planks@2',
  'minecraft:planks@3',
  'minecraft:planks@4',
  'minecraft:planks@5',
] as const;

export const RECIPE_IDS = [
  'planks_oak',
  'planks_spruce',
  'planks_birch',
  'planks_jungle',
  'planks_acacia',
  'planks_dark_oak',
  'sticks',
  'torch_coal',
  'torch_charcoal',
  'crafting_table',
  'chest',
  'wooden_shovel',
  'wooden_axe',
  'flint',
] as const;
export const RecipeIdSchema = z.enum(RECIPE_IDS);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

export interface CraftingRecipe {
  readonly id: RecipeId;
  /**
   * The pattern, top row first. Each character is a key of `key`, or a space for an empty
   * cell. The client puts it in the grid's top-left corner (shaped recipes match anywhere).
   */
  readonly pattern: readonly string[];
  /** Key -> the items (any one of them) that cell accepts. */
  readonly key: Readonly<Record<string, readonly string[]>>;
  /** What the agent expects the server to produce for ONE craft. The server decides. */
  readonly result: { readonly item: string; readonly count: number };
  /** Where the expectation comes from: verified in GTNH 2.8.4's jars, or a vanilla assumption. */
  readonly evidence: string;
}

const GT_PLANKS =
  'GTNH 2.8.4, verified: GregTech 5.09.51.482 ProcessingLog replaces the vanilla recipe with a ' +
  'shapeless 1 log -> 2 planks while nerfedWoodPlank=true (the test server GregTech.cfg); vanilla gives 4.';

/** The vanilla wooden tool recipes, kept on GTNH 2.8.4 (verified). */
const WOODEN_TOOL = (pattern: string): string =>
  `GTNH 2.8.4, verified: vanilla 1.7.10 RecipesTools (${pattern}, X = any planks, # = stick), ` +
  'a 3x3 recipe that no mod removes: NewHorizonsCoreMod removes only the stone and diamond tool ' +
  'recipes, TConstruct only with "Remove Vanilla Tool Recipes" (false on the test server), and ' +
  'the other jars naming the item use it as an ingredient or a loot drop, or change its ' +
  'durability (GregTech). The quest "Tools" asks for it.';

function planks(id: RecipeId, log: string, plank: string): CraftingRecipe {
  return {
    id,
    pattern: ['L'],
    key: { L: [log] },
    result: { item: plank, count: 2 },
    evidence: GT_PLANKS,
  };
}

export const RECIPES: Readonly<Record<RecipeId, CraftingRecipe>> = {
  planks_oak: planks('planks_oak', 'minecraft:log', 'minecraft:planks'),
  planks_spruce: planks('planks_spruce', 'minecraft:log@1', 'minecraft:planks@1'),
  planks_birch: planks('planks_birch', 'minecraft:log@2', 'minecraft:planks@2'),
  planks_jungle: planks('planks_jungle', 'minecraft:log@3', 'minecraft:planks@3'),
  planks_acacia: planks('planks_acacia', 'minecraft:log2', 'minecraft:planks@4'),
  planks_dark_oak: planks('planks_dark_oak', 'minecraft:log2@1', 'minecraft:planks@5'),
  sticks: {
    id: 'sticks',
    pattern: ['P', 'P'],
    key: { P: PLANKS },
    result: { item: 'minecraft:stick', count: 2 },
    evidence:
      'GTNH 2.8.4, verified: GregTech 5.09.51.482 CraftingRecipeLoader removes the vanilla recipe ' +
      '(4 sticks) and adds plankWood above plankWood -> 2 sticks while nerfedWoodPlank=true (the ' +
      'test server GregTech.cfg); a saw above the planks gives 4.',
  },
  torch_coal: {
    id: 'torch_coal',
    pattern: ['C', 'S'],
    key: { C: ['minecraft:coal'], S: ['minecraft:stick'] },
    result: { item: 'minecraft:torch', count: 3 },
    evidence:
      'GTNH 2.8.4, verified: NewHorizonsCoreMod 2.7.268 ScriptMinecraft adds ' +
      'ShapedUniversalRecipe(3 torches: gemCoal above stickWood); vanilla gives 4.',
  },
  torch_charcoal: {
    id: 'torch_charcoal',
    pattern: ['C', 'S'],
    key: { C: ['minecraft:coal@1'], S: ['minecraft:stick'] },
    result: { item: 'minecraft:torch', count: 2 },
    evidence:
      'GTNH 2.8.4, verified: ScriptMinecraft adds ShapedUniversalRecipe(2 torches: ' +
      'gemCharcoal above stickWood).',
  },
  crafting_table: {
    id: 'crafting_table',
    pattern: ['FF', 'LL'],
    key: { F: ['minecraft:flint'], L: LOGS },
    result: { item: 'minecraft:crafting_table', count: 1 },
    evidence:
      'GTNH 2.8.4, verified: NewHorizonsCoreMod 2.7.268 RecipeRemover removes every recipe whose ' +
      'output is minecraft:crafting_table, then ScriptMinecraft adds ShapedUniversalRecipe(' +
      'crafting_table: flint flint / logWood logWood), a 2x2 recipe (both in CompleteLoad, the ' +
      'remover first). The agent cannot place blocks: it crafts 3x3 only at tables an operator placed.',
  },
  chest: {
    id: 'chest',
    pattern: ['LPL', 'PFP', 'LPL'],
    key: { L: LOGS, P: PLANKS, F: ['minecraft:flint'] },
    result: { item: 'minecraft:chest', count: 1 },
    evidence:
      'GTNH 2.8.4, verified: ScriptMinecraft adds ShapedUniversalRecipe(chest: logWood ' +
      'plankWood logWood / plankWood flint plankWood / logWood plankWood logWood).',
  },
  wooden_shovel: {
    id: 'wooden_shovel',
    pattern: ['P', 'S', 'S'],
    key: { P: PLANKS, S: ['minecraft:stick'] },
    result: { item: 'minecraft:wooden_shovel', count: 1 },
    evidence: WOODEN_TOOL('X / # / #'),
  },
  wooden_axe: {
    id: 'wooden_axe',
    pattern: ['PP', 'PS', ' S'],
    key: { P: PLANKS, S: ['minecraft:stick'] },
    result: { item: 'minecraft:wooden_axe', count: 1 },
    evidence: WOODEN_TOOL('XX / X# / _#'),
  },
  flint: {
    id: 'flint',
    // Shapeless: any three cells of the 2x2 grid.
    pattern: ['GG', 'G '],
    key: { G: ['minecraft:gravel'] },
    result: { item: 'minecraft:flint', count: 1 },
    evidence:
      'GTNH 2.8.4, verified: IguanaTweaks 2.6.6 IguanaTweaks.flintTweaks adds a shapeless ' +
      'new ItemStack(Items.flint) from gravelPerFlint=3 gravel (addFlintRecipe=true in ' +
      'IguanaTinkerTweaks/main.cfg); the CraftTweaker dump lists it. Gravel never drops flint here: ' +
      'FlintHandler (removeFlintDrop=true) swaps the flint drop for gravel. Vanilla: no recipe.',
  },
};

export interface IngredientRequirement {
  /** The pattern key. */
  readonly key: string;
  /** The items (any mix of them) that fill this key's cells. */
  readonly anyOf: readonly string[];
  /** Cells with this key, i.e. items used by one craft. */
  readonly perCraft: number;
}

/** What one craft consumes, grouped by pattern key, in pattern order. */
export function ingredientRequirements(recipe: CraftingRecipe): IngredientRequirement[] {
  const counts = new Map<string, number>();
  for (const row of recipe.pattern) {
    for (const cell of row) if (cell !== ' ') counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts].map(([key, perCraft]) => ({
    key,
    anyOf: recipe.key[key] ?? [],
    perCraft,
  }));
}

export function patternSize(recipe: CraftingRecipe): { width: number; height: number } {
  return {
    width: Math.max(0, ...recipe.pattern.map((row) => row.length)),
    height: recipe.pattern.length,
  };
}

/** True when the pattern does not fit the player's own 2x2 grid. */
export function needsCraftingTable(recipe: CraftingRecipe): boolean {
  const { width, height } = patternSize(recipe);
  return width > 2 || height > 2;
}

/** "minecraft:coal", or "one of minecraft:planks, minecraft:planks@1, ...". */
export function describeIngredient(anyOf: readonly string[]): string {
  if (anyOf.length === 1) return anyOf[0] ?? '';
  const shown = anyOf.slice(0, 3).join(', ');
  return `one of ${shown}${anyOf.length > 3 ? `, ... (${anyOf.length} kinds)` : ''}`;
}
