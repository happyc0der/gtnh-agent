import { z } from 'zod';
import {
  CraftFlag,
  ingredientItems,
  isToolOre,
  loadKnowledge,
  type IngredientRef,
  type KnowledgeData,
  type VanillaRecipe,
} from '../goals/knowledge.ts';
import { ItemNameSchema } from './common.ts';

/**
 * The crafting-grid recipes CRAFT_ITEM makes, keyed by 1.7.10 registry names
 * (`namespace:item`, plus `@damage` when the damage value is not 0): the agent's small table
 * of hand-verified early (Age 0) recipes, and the GTNH knowledge base's crafting recipes
 * (src/goals/knowledge.ts: CraftTweaker's dump of the server's own recipes) by the ids the
 * route book gives them. Hand-verified recipes win where both exist.
 *
 * GTNH changes many vanilla recipes, so no recipe is ever trusted blindly: it only says
 * which items to put where. The live client takes a result only if the server's crafting
 * result slot shows exactly the expected item and count; otherwise it puts every ingredient
 * back and reports what the server showed (see docs/gtnh-compatibility.md, "Crafting").
 * Each entry records where its expectation comes from.
 *
 * The knowledge base is data of the goals layer (the route book reads it too); it is read
 * here, lazily, because CRAFT_ITEM's schema and postcondition are derived from the recipe.
 */

/** Largest number of crafts one CRAFT_ITEM may do. */
export const MAX_CRAFT_TIMES = 64;

/**
 * Most kinds one ingredient may accept: the postcondition lists them all, so the verifier
 * counts any mix the client used (GTNH's plankWood has 650).
 */
export const MAX_INGREDIENT_KINDS = 1024;

/** Longest recipe id: the knowledge base's are an item name, a label and an ordinal. */
export const MAX_RECIPE_ID_LENGTH = 200;

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
/** The hand-verified table's ids. */
export const RecipeIdSchema = z.enum(RECIPE_IDS);
export type RecipeId = z.infer<typeof RecipeIdSchema>;

export interface CraftingRecipe {
  /** A hand-verified id (`planks_oak`), or the route book's for a knowledge-base recipe. */
  readonly id: string;
  /**
   * The pattern, top row first. Each character is a key of `key`, or a space for an empty
   * cell. The client puts it in the grid's top-left corner: a shaped recipe's own layout,
   * empty cells included, which the server always checks (shaped recipes match anywhere
   * they fit, and vanilla's and Forge's ore recipes mirrored too, but this layout always
   * matches). A shapeless recipe's cells in reading order: one arrangement of many.
   */
  readonly pattern: readonly string[];
  /** Key -> the items (any one of them) that cell accepts. */
  readonly key: Readonly<Record<string, readonly string[]>>;
  /** Key -> the ore-dictionary entry the items come from (`ore:plankWood`), for messages. */
  readonly labels?: Readonly<Record<string, string>>;
  /** What the agent expects the server to produce for ONE craft. The server decides. */
  readonly result: { readonly item: string; readonly count: number };
  /**
   * False when the knowledge base does not know the output count (CraftTweaker's dump has
   * none): one is expected, as the route assumes, and the client takes nothing unless the
   * server shows exactly that (a wrong guess fails before anything is taken).
   */
  readonly countKnown?: boolean;
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
      'remover first). PLACE_BLOCK places it (approved 2026-09-30): 3x3 recipes are crafted there.',
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
  /** The ore-dictionary entry the items come from, when the recipe names one. */
  readonly label?: string;
}

/** What one craft consumes, grouped by pattern key, in pattern order. */
export function ingredientRequirements(recipe: CraftingRecipe): IngredientRequirement[] {
  const counts = new Map<string, number>();
  for (const row of recipe.pattern) {
    for (const cell of row) if (cell !== ' ') counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  return [...counts].map(([key, perCraft]) => {
    const label = recipe.labels?.[key];
    return {
      key,
      anyOf: recipe.key[key] ?? [],
      perCraft,
      ...(label === undefined ? {} : { label }),
    };
  });
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

/**
 * "minecraft:coal", "one of minecraft:planks, minecraft:planks@1, ...", or with an ore
 * entry's label "ore:plankWood (650 kinds: minecraft:planks, minecraft:planks@1, ...)".
 */
export function describeIngredient(anyOf: readonly string[], label?: string): string {
  if (anyOf.length === 1) return anyOf[0] ?? '';
  const shown = anyOf.slice(0, 3).join(', ');
  const more = anyOf.length > 3 ? ', ...' : '';
  if (label !== undefined) return `${label} (${anyOf.length} kinds: ${shown}${more})`;
  return `one of ${shown}${anyOf.length > 3 ? `, ... (${anyOf.length} kinds)` : ''}`;
}

/** Whether `id` is one of the hand-verified table's. */
export function isHandRecipeId(id: string): id is RecipeId {
  return (RECIPE_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// The knowledge base's crafting recipes
// ---------------------------------------------------------------------------

/**
 * Why CRAFT_ITEM leaves a knowledge-base recipe out: what the client cannot do safely yet.
 * The route still lists such a recipe (it is GTNH's), and says CRAFT_ITEM cannot make it.
 */
export const LEFT_OUT_REASONS = {
  nbtInput: 'an ingredient must carry specific NBT data, which item names cannot express',
  nbtOutput:
    "the result carries NBT data (e.g. a GregTech tool's material): the client takes only " +
    'results without it',
  craftingTool:
    'it uses a crafting tool (ore:craftingTool*, ore:tool*: GregTech tools, HarvestCraft ' +
    'cookware), which stays in the grid, worn: the client would have to predict what is left there',
  container:
    'an ingredient comes only in kinds that may leave something in the grid or the inventory ' +
    '(a bucket, a cell, a bottle, a GregTech tool...)',
  shape:
    'its shape may be scrambled in the dump (CraftTweaker reads a 2x1, 3x1 or 3x2 ore recipe as ' +
    "1x2, 1x3 or 2x3) and vanilla's own recipe does not confirm it",
  overlap:
    'two ingredients, or an ingredient and the result, share an item: the verifier could not ' +
    'tell them apart',
  unknownItem: 'an ingredient has no item the agent can name',
  tooManyKinds: `an ingredient accepts more than ${MAX_INGREDIENT_KINDS} kinds`,
} as const;
export type LeftOutReason = keyof typeof LEFT_OUT_REASONS;

/** What CRAFT_ITEM makes of the knowledge base's crafting recipes, by the route book's ids. */
export interface KnowledgeRecipes {
  /** The recipes CRAFT_ITEM makes. */
  readonly byId: ReadonlyMap<string, CraftingRecipe>;
  /** The ones it leaves out, and why. */
  readonly leftOut: ReadonlyMap<string, LeftOutReason>;
  /** The ones a hand-verified recipe replaces (the route shows the hand-verified id instead). */
  readonly replaced: ReadonlyMap<string, RecipeId>;
}

/** A crafting row's inputs as pairs: an ingredient and how many one craft uses. */
function rowInputs(
  inputs: ReadonlyArray<IngredientRef | number>,
): Array<{ ref: IngredientRef; count: number }> {
  const pairs: Array<{ ref: IngredientRef; count: number }> = [];
  for (let k = 0; k + 1 < inputs.length; k += 2) {
    pairs.push({ ref: inputs[k] as IngredientRef, count: inputs[k + 1] as number });
  }
  return pairs;
}

/**
 * The route book's id of each knowledge-base crafting row (src/goals/route-book.ts uses this
 * very function, so the ids CRAFT_ITEM takes are the ids routes write): `<item>#<n>` for the
 * n-th distinct recipe of an item, `<item>[<label>]#<n>` when its output has a label (a
 * GregTech tool's material). Null for a row whose output the data does not name, or that
 * repeats an earlier one (the same recipe is often registered twice, e.g. by GregTech and a
 * script).
 */
export function knowledgeRecipeIds(data: KnowledgeData): Array<string | null> {
  const seen = new Set<string>();
  const ordinal = new Map<string, number>();
  return data.crafting.map(([out, count, flags, , inputs, label]) => {
    const item = data.items[out];
    if (item === undefined) return null;
    const station = (flags & CraftFlag.FITS_2X2) !== 0 ? '2x2' : 'crafting_table';
    const sig = `${out}|${count}|${station}|${label}|${rowInputs(inputs)
      .map((p) => `${JSON.stringify(p.ref)}*${p.count}`)
      .sort()
      .join(',')}`;
    if (seen.has(sig)) return null;
    seen.add(sig);
    const n = (ordinal.get(item) ?? 0) + 1;
    ordinal.set(item, n);
    return `${item}${label === '' ? '' : `[${label}]`}#${n}`;
  });
}

/**
 * Items that may give something back when crafted with, by name (the dump does not say which
 * items have a container item): fluid containers (buckets, cells, bottles, jars, capsules,
 * phials, potions), GregTech's and GT++'s tools (they wear and stay in the grid), and
 * HarvestCraft's cookware (it stays in the grid). The client never uses these kinds, so a
 * recipe is left out only when an ingredient has no other kind.
 */
const CONTAINER_ITEM = new RegExp(
  [
    ...['bucket', 'cell', 'bottle', 'jar', 'capsule', 'phial', 'essence', 'potion', 'metatool'],
    `^harvestcraft:(${[
      'pot',
      'skillet',
      'saucepan',
      'bakeware',
      'cuttingboard',
      'mortarandpestle',
      'mixingbowl',
      'juicer',
    ].join('|')})Item$`,
  ].join('|'),
  'i',
);

/** An ingredient's kinds the client may use, and whether container items were left out of them. */
type Kinds = {
  readonly kinds: readonly string[];
  /** The same kinds, to look items up in. */
  readonly set: ReadonlySet<string>;
  readonly containers: boolean;
};

/** Kinds per ingredient, once per ingredient (thousands of recipes share an ore entry). */
function kindsOf(data: KnowledgeData): (ref: IngredientRef) => Kinds {
  const cache = new Map<string, Kinds>();
  const valid = new Map<string, boolean>();
  const nameable = (n: string): boolean => {
    let v = valid.get(n);
    if (v === undefined) {
      v = ItemNameSchema.safeParse(n).success;
      valid.set(n, v);
    }
    return v;
  };
  return (ref) => {
    const key = JSON.stringify(ref);
    let v = cache.get(key);
    if (v === undefined) {
      const names = [...new Set(ingredientItems(data, ref).filter(nameable))];
      const kinds = names.filter((n) => !CONTAINER_ITEM.test(n));
      v = { kinds, set: new Set(kinds), containers: kinds.length < names.length };
      cache.set(key, v);
    }
    return v;
  };
}

/** Whether two ingredients, or an ingredient and the result, share an item. */
function overlapping(groups: readonly Kinds[], result: string): boolean {
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i] as Kinds;
    if (a.set.has(result)) return true;
    for (let j = i + 1; j < groups.length; j++) {
      const b = groups[j] as Kinds;
      // The smaller list against the larger one's set (an ore entry may list hundreds).
      const [small, large] = a.kinds.length <= b.kinds.length ? [a, b] : [b, a];
      if (small.kinds.some((n) => large.set.has(n))) return true;
    }
  }
  return false;
}

/**
 * The knowledge-base recipes a hand-verified recipe replaces, exactly as the route book
 * replaces them (src/goals/route-book.ts buildRouteBook): for each hand-verified recipe, the
 * first dumped recipe of its item whose ingredients are its own (the hand-verified kinds
 * among the dump's, with the same counts: the dump's ore lists are wider), and every dumped
 * recipe with exactly those ingredients.
 */
function handReplacements(
  data: KnowledgeData,
  ids: ReadonlyArray<string | null>,
): Map<string, RecipeId> {
  const rowsOf = new Map<string, number[]>();
  ids.forEach((id, i) => {
    const out = data.crafting[i]?.[0];
    const item = out === undefined ? undefined : data.items[out];
    if (id === null || item === undefined) return;
    const rows = rowsOf.get(item) ?? [];
    rows.push(i);
    rowsOf.set(item, rows);
  });
  const pairsOf = (i: number): Array<{ ref: IngredientRef; count: number }> =>
    rowInputs(data.crafting[i]?.[4] ?? []);
  const sets = new Map<string, ReadonlySet<string>>();
  const kindsSet = (ref: IngredientRef): ReadonlySet<string> => {
    const key = JSON.stringify(ref);
    let s = sets.get(key);
    if (s === undefined) {
      s = new Set(ingredientItems(data, ref));
      sets.set(key, s);
    }
    return s;
  };
  const sig = (i: number): string =>
    pairsOf(i)
      .map((p) => `${JSON.stringify(p.ref)}*${p.count}`)
      .join(',');
  const out = new Map<string, RecipeId>();
  for (const hand of RECIPE_IDS) {
    const want = ingredientRequirements(RECIPES[hand]);
    const rows = rowsOf.get(RECIPES[hand].result.item) ?? [];
    const match = rows.find((i) => {
      const pairs = pairsOf(i);
      return (
        pairs.length === want.length &&
        want.every((w) =>
          pairs.some((p) => p.count === w.perCraft && w.anyOf.every((n) => kindsSet(p.ref).has(n))),
        )
      );
    });
    if (match === undefined) continue;
    const same = sig(match);
    for (const i of rows) {
      const id = ids[i];
      if (id != null && sig(i) === same) out.set(id, hand);
    }
  }
  return out;
}

/** A pattern's rows mirrored left to right (padded to its width first). */
function mirrorRows(rows: readonly string[]): string[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => [...r.padEnd(width, ' ')].reverse().join(''));
}

/** Same width, height and empty cells, with a one-to-one map between the two's symbols. */
function sameLayout(a: readonly string[], b: readonly string[]): boolean {
  const width = Math.max(0, ...a.map((r) => r.length));
  if (a.length !== b.length || width !== Math.max(0, ...b.map((r) => r.length))) return false;
  const ab = new Map<string, string>();
  const ba = new Map<string, string>();
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < width; x++) {
      const p = a[y]?.[x] ?? ' ';
      const q = b[y]?.[x] ?? ' ';
      if ((p === ' ') !== (q === ' ')) return false;
      if (p === ' ') continue;
      if ((ab.get(p) ?? q) !== q || (ba.get(q) ?? p) !== p) return false;
      ab.set(p, q);
      ba.set(q, p);
    }
  }
  return true;
}

/** Whether a vanilla ingredient (an item, and its damage or null for any) is one of `kinds`. */
function vanillaKindIn(
  v: { item: string; damage: number | null },
  kinds: readonly string[],
): boolean {
  return kinds.some((k) => {
    const at = k.lastIndexOf('@');
    const name = at === -1 ? k : k.slice(0, at);
    return (
      name === v.item &&
      (v.damage === null || v.damage === (at === -1 ? 0 : Number(k.slice(at + 1))))
    );
  });
}

/**
 * Whether vanilla 1.7.10's own recipe for the item (the knowledge base's vanilla layer, read
 * from the server jar) has the dumped layout, or its mirror image (vanilla's shaped recipes
 * match mirrored), with the same ingredients: then the dumped recipe is that recipe with
 * ore-dictionary ingredients (Forge's OreDictionary swaps vanilla's planks and sticks for
 * plankWood and stickWood, keeping its width and height), and the dumped shape is exact.
 * CraftTweaker's misread width (floor of the square root of the cell count) is right for
 * vanilla's 1x2, 1x3 and 2x3 shapes, the wooden tools' among them.
 */
function confirmedByVanilla(
  rows: readonly string[],
  groups: ReadonlyArray<readonly string[]>,
  counts: readonly number[],
  candidates: readonly VanillaRecipe[],
): boolean {
  return candidates.some(
    (v) =>
      v.shaped &&
      v.rows !== null &&
      v.inputs.length === groups.length &&
      [v.rows, mirrorRows(v.rows)].some((vr) => sameLayout(rows, vr)) &&
      groups.every((kinds, j) =>
        v.inputs.some((vi) => vi.count === counts[j] && vanillaKindIn(vi, kinds)),
      ),
  );
}

/** A dumped pattern without its trailing empty rows and columns (leading ones are its shape). */
function trimPattern(rows: readonly string[]): string[] {
  const filled = rows.map((r) => r.trimEnd());
  while (filled.length > 0 && filled[filled.length - 1] === '') filled.pop();
  const width = Math.max(0, ...filled.map((r) => r.length));
  return filled.map((r) => r.padEnd(width, ' '));
}

/** One dumped crafting row as a recipe CRAFT_ITEM makes, or why it is left out. */
function recipeOfRow(
  data: KnowledgeData,
  row: KnowledgeData['crafting'][number],
  id: string,
  kinds: (ref: IngredientRef) => Kinds,
  vanilla: ReadonlyMap<string, readonly VanillaRecipe[]>,
): CraftingRecipe | LeftOutReason {
  const [out, count, flags, dumped, inputs, , countFrom] = row;
  const item = data.items[out];
  if (item === undefined) return 'unknownItem';
  if ((flags & CraftFlag.NBT_INPUT) !== 0) return 'nbtInput';
  if ((flags & CraftFlag.NBT_OUTPUT) !== 0) return 'nbtOutput';
  const pairs = rowInputs(inputs);
  if (
    pairs.some((p) => isToolOre(p.ref) || (typeof p.ref === 'string' && p.ref.startsWith('tool')))
  ) {
    return 'craftingTool';
  }
  const found: Kinds[] = [];
  for (const p of pairs) {
    const k = kinds(p.ref);
    if (k.kinds.length === 0) return k.containers ? 'container' : 'unknownItem';
    if (k.kinds.length > MAX_INGREDIENT_KINDS) return 'tooManyKinds';
    found.push(k);
  }
  // The verifier counts each ingredient's kinds together: no item may be in two of them.
  if (overlapping(found, item)) return 'overlap';
  const groups = found.map((k) => k.kinds);
  const letters = pairs.map((_, j) => String.fromCharCode(97 + j));
  const shapeless = (flags & CraftFlag.SHAPELESS) !== 0;
  let pattern: string[];
  if (shapeless) {
    // One arrangement: reading order, two columns while it fits the 2x2 grid.
    const cells = pairs.flatMap((p, j) => Array.from({ length: p.count }, () => letters[j] ?? ''));
    const width = cells.length <= 4 ? 2 : 3;
    pattern = [];
    for (let r = 0; r < cells.length; r += width) {
      pattern.push(
        cells
          .slice(r, r + width)
          .join('')
          .padEnd(width, ' '),
      );
    }
  } else {
    const rows = dumped.split('/').map((r) => r.replace(/\./g, ' '));
    const counted = pairs.every(
      (p, j) => [...rows.join('')].filter((c) => c === letters[j]).length === p.count,
    );
    if (!counted) return 'shape';
    if (
      (flags & CraftFlag.SHAPE_UNCERTAIN) !== 0 &&
      !confirmedByVanilla(
        rows,
        groups,
        pairs.map((p) => p.count),
        vanilla.get(item) ?? [],
      )
    ) {
      return 'shape';
    }
    pattern = trimPattern(rows);
  }
  const key: Record<string, readonly string[]> = {};
  const labels: Record<string, string> = {};
  pairs.forEach((p, j) => {
    const letter = letters[j] ?? '';
    key[letter] = groups[j] ?? [];
    if (typeof p.ref === 'string') labels[letter] = `ore:${p.ref}`;
  });
  return {
    id,
    pattern,
    key,
    ...(Object.keys(labels).length > 0 ? { labels } : {}),
    result: { item, count: count > 0 ? count : 1 },
    ...(count > 0 ? {} : { countKnown: false }),
    evidence:
      `GTNH 2.8.4 knowledge base: the server's own ${shapeless ? 'shapeless' : 'shaped'} recipe ` +
      `(CraftTweaker's dump); output count ` +
      (count > 0
        ? `${count} (${countFrom === '' ? 'source not recorded' : countFrom})`
        : 'not dumped, 1 expected'),
  };
}

/**
 * CRAFT_ITEM's knowledge-base recipes from the data (exported for tests, which may pass
 * smaller data): every crafting recipe the route book lists, by its id, unless a
 * hand-verified recipe replaces it or the client cannot make it safely yet (LEFT_OUT_REASONS).
 */
export function buildKnowledgeRecipes(data: KnowledgeData): KnowledgeRecipes {
  const ids = knowledgeRecipeIds(data);
  const replaced = handReplacements(data, ids);
  const vanilla = new Map<string, VanillaRecipe[]>();
  for (const v of data.vanilla?.crafting ?? []) {
    const list = vanilla.get(v.output) ?? [];
    list.push(v);
    vanilla.set(v.output, list);
  }
  const kinds = kindsOf(data);
  const byId = new Map<string, CraftingRecipe>();
  const leftOut = new Map<string, LeftOutReason>();
  data.crafting.forEach((row, i) => {
    const id = ids[i];
    if (id == null || replaced.has(id)) return;
    const made = recipeOfRow(data, row, id, kinds, vanilla);
    if (typeof made === 'string') leftOut.set(id, made);
    else byId.set(id, made);
  });
  return { byId, leftOut, replaced };
}

let knowledge: KnowledgeRecipes | null = null;

/**
 * The knowledge base's recipes, built once on first use (importing this module reads no
 * data). Without the data (e.g. a build that did not copy it), none: CRAFT_ITEM then makes
 * the hand-verified recipes only, as the route book then routes with them only.
 */
export function knowledgeRecipes(): KnowledgeRecipes {
  if (knowledge === null) {
    try {
      knowledge = buildKnowledgeRecipes(loadKnowledge());
    } catch {
      knowledge = { byId: new Map(), leftOut: new Map(), replaced: new Map() };
    }
  }
  return knowledge;
}

/** The recipe CRAFT_ITEM makes by this id (hand-verified first), or null for none. */
export function craftingRecipe(id: string): CraftingRecipe | null {
  if (isHandRecipeId(id)) return RECIPES[id];
  // The knowledge base's ids end in "#<n>": nothing else is looked up (or loads the data).
  if (!/#\d+$/.test(id)) return null;
  return knowledgeRecipes().byId.get(id) ?? null;
}

/** The recipe of an id CRAFT_ITEM's schema accepted; throws for any other id. */
export function recipeById(id: string): CraftingRecipe {
  const recipe = craftingRecipe(id);
  if (recipe === null) throw new Error(`${id} is not a recipe CRAFT_ITEM can make`);
  return recipe;
}

/** Why CRAFT_ITEM does not make the recipe with this id, or null when it does. */
export function whyNotCraftable(id: string): string | null {
  if (craftingRecipe(id) !== null) return null;
  if (!/#\d+$/.test(id)) return 'it is not a recipe id';
  const kb = knowledgeRecipes();
  const hand = kb.replaced.get(id);
  if (hand !== undefined) return `the hand-verified recipe ${hand} is the same recipe`;
  const reason = kb.leftOut.get(id);
  return reason === undefined ? 'no such recipe' : LEFT_OUT_REASONS[reason];
}

/**
 * Every recipe id CRAFT_ITEM accepts: the hand-verified table's, and the knowledge base's
 * crafting recipes the client can make, by the ids the route book gives them (a route step
 * names them: "craft minecraft:wooden_pickaxe#1 x1 ...").
 */
export const CraftRecipeIdSchema = z
  .string()
  .min(1)
  .max(MAX_RECIPE_ID_LENGTH)
  .refine(
    (id) => craftingRecipe(id) !== null,
    'not a recipe CRAFT_ITEM can make: a hand-verified recipe id, or a recipe id from a route step',
  );
export type CraftRecipeId = z.infer<typeof CraftRecipeIdSchema>;

/**
 * What can be crafted, step by step, from items that can be had (`have`): a recipe counts
 * once each of its ingredients can be had, and what it makes can be had from then on. Only
 * recipes CRAFT_ITEM makes whose output count is known (a guessed count may fail), and 3x3
 * ones only with `table`. Names without `@damage`, like quest goals' abilities.
 */
export function craftableFrom(have: Iterable<string>, opts: { table: boolean }): Set<string> {
  const base = (name: string): string => name.replace(/@\d+$/, '');
  const obtainable = new Set([...have].map(base));
  // Each ingredient list's base names, once per list (thousands of recipes share one).
  const bases = new Map<readonly string[], readonly string[]>();
  const basesOf = (list: readonly string[]): readonly string[] => {
    let b = bases.get(list);
    if (b === undefined) {
      b = [...new Set(list.map(base))];
      bases.set(list, b);
    }
    return b;
  };
  let open = [...RECIPE_IDS.map((id) => RECIPES[id]), ...knowledgeRecipes().byId.values()]
    .filter((r) => r.countKnown !== false && (opts.table || !needsCraftingTable(r)))
    .map((r) => ({
      makes: base(r.result.item),
      needs: ingredientRequirements(r).map((q) => basesOf(q.anyOf)),
    }));
  const made = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    open = open.filter((r) => {
      if (made.has(r.makes)) return false;
      if (!r.needs.every((list) => list.some((b) => obtainable.has(b)))) return true;
      made.add(r.makes);
      obtainable.add(r.makes);
      grew = true;
      return false;
    });
  }
  return made;
}
