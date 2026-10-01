import type { DiggableBlock } from '../domain/blocks.ts';
import {
  ingredientRequirements,
  needsCraftingTable,
  RECIPE_IDS,
  RECIPES,
} from '../domain/recipes.ts';
import type { RouteBook, RouteRecipe, RouteSource } from './route.ts';

/**
 * The agent's route book: the recipes it can craft (src/domain/recipes.ts) and what digging
 * its allowlisted blocks yields (src/domain/blocks.ts). New abilities (smelting, tools,
 * mob drops, exported recipe data) add entries here; the route planner itself stays
 * general.
 */

/** What one dig of each allowlisted block yields with a bare hand (vanilla 1.7.10 averages). */
export const DIG_YIELDS: Readonly<
  Record<DiggableBlock, ReadonlyArray<{ item: string; perDig: number }>>
> = {
  'minecraft:sand': [{ item: 'minecraft:sand', perDig: 1 }],
  // BlockGravel: 10% flint instead of gravel (fortune 0).
  'minecraft:gravel': [
    { item: 'minecraft:gravel', perDig: 0.9 },
    { item: 'minecraft:flint', perDig: 0.1 },
  ],
  'minecraft:clay': [{ item: 'minecraft:clay_ball', perDig: 4 }],
  'minecraft:dirt': [{ item: 'minecraft:dirt', perDig: 1 }],
  'minecraft:grass': [{ item: 'minecraft:dirt', perDig: 1 }],
  // A log drops itself (the kind of tree decides the variant: oak, spruce, birch, jungle).
  'minecraft:log': [
    { item: 'minecraft:log', perDig: 1 },
    { item: 'minecraft:log@1', perDig: 1 },
    { item: 'minecraft:log@2', perDig: 1 },
    { item: 'minecraft:log@3', perDig: 1 },
  ],
  'minecraft:log2': [
    { item: 'minecraft:log2', perDig: 1 },
    { item: 'minecraft:log2@1', perDig: 1 },
  ],
  // BlockLeaves: a sapling 1 in 20, an apple 1 in 200 (oak leaves) with no fortune.
  'minecraft:leaves': [
    { item: 'minecraft:sapling', perDig: 0.05 },
    { item: 'minecraft:apple', perDig: 0.005 },
  ],
  'minecraft:leaves2': [{ item: 'minecraft:sapling@4', perDig: 0.05 }],
};

/**
 * Where a player looks for each block (general Minecraft knowledge, any modpack's overworld).
 */
export const FIND_HINTS: Readonly<Record<string, string>> = {
  'minecraft:sand': 'deserts, beaches, river beds and lake shores',
  'minecraft:gravel': 'river and lake beds, beaches, mountains, cave floors',
  'minecraft:clay': 'shallow water: river beds, lake bottoms, swamps',
  'minecraft:dirt': 'almost anywhere under grass',
  'minecraft:grass': 'plains, forests, hills',
  'minecraft:log': 'forests and any trees (oak, birch, spruce, jungle)',
  'minecraft:log2': 'savannas (acacia) and roofed forests (dark oak)',
  'minecraft:leaves': 'trees',
  'minecraft:leaves2': 'acacia and dark oak trees',
};

/**
 * Seconds one bare-hand dig takes, as the client digs (vanilla time x 1.25 + 2 ticks), plus
 * about a second to step to the next block and pick up the drop.
 */
function secondsPerDig(hardness: number): number {
  const ticks = Math.ceil(Math.ceil(hardness * 30 - 1e-9) * 1.25 - 1e-9) + 2;
  return ticks / 20 + 1;
}

const HARDNESS: Readonly<Record<DiggableBlock, number>> = {
  'minecraft:log': 2,
  'minecraft:log2': 2,
  'minecraft:leaves': 0.2,
  'minecraft:leaves2': 0.2,
  'minecraft:dirt': 0.5,
  'minecraft:grass': 0.6,
  'minecraft:sand': 0.5,
  'minecraft:gravel': 0.6,
  'minecraft:clay': 0.6,
};

function digSources(): RouteSource[] {
  const byItem = new Map<string, { blocks: string[]; perAction: number; seconds: number }>();
  for (const [block, yields] of Object.entries(DIG_YIELDS) as Array<
    [DiggableBlock, ReadonlyArray<{ item: string; perDig: number }>]
  >) {
    for (const y of yields) {
      const entry = byItem.get(y.item);
      const seconds = secondsPerDig(HARDNESS[block]);
      if (entry === undefined) {
        byItem.set(y.item, { blocks: [block], perAction: y.perDig, seconds });
      } else {
        entry.blocks.push(block);
        entry.seconds = Math.min(entry.seconds, seconds);
      }
    }
  }
  return [...byItem].map(([item, e]) => ({
    item,
    via: 'dig' as const,
    blocks: e.blocks,
    perAction: e.perAction,
    secondsPerAction: e.seconds,
  }));
}

function craftingRecipes(): RouteRecipe[] {
  // Every recipe in the table is verified for GTNH (e.g. the crafting table is GTNH's own
  // 2x2: two flint above two logs).
  return RECIPE_IDS.map((id) => {
    const r = RECIPES[id];
    return {
      id,
      output: { item: r.result.item, count: r.result.count },
      inputs: ingredientRequirements(r).map((q) => ({ anyOf: q.anyOf, count: q.perCraft })),
      station: needsCraftingTable(r) ? 'crafting_table' : '2x2',
    };
  });
}

export const ROUTE_BOOK: RouteBook = {
  recipes: craftingRecipes(),
  sources: digSources(),
  hints: FIND_HINTS,
};
