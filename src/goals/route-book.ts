import {
  DIGGABLE_BLOCKS,
  GARDEN_BLOCKS,
  GT_ORE_BLOCK,
  isGardenBlock,
  isToolDiggable,
  type DiggableBlock,
  type GardenBlock,
  type SOLID_DIGGABLE_BLOCKS,
  type ToolDiggableBlock,
} from '../domain/blocks.ts';
import { diggableInfo } from '../domain/dig-time.ts';
import { ANIMAL_DROPS, GARDEN_BIOMES, GARDEN_DROPS, GARDEN_FOODS } from '../domain/food.ts';
import {
  ingredientRequirements,
  knowledgeRecipeIds,
  needsCraftingTable,
  RECIPE_IDS,
  RECIPES,
} from '../domain/recipes.ts';
import { TOOL_ITEMS, TOOLS } from '../domain/tools.ts';
import {
  CraftFlag,
  ingredientItems,
  isToolOre,
  loadKnowledge,
  type IngredientRef,
  type KnowledgeData,
} from './knowledge.ts';
import {
  planRoute,
  type RouteBook,
  type RouteRecipe,
  type RouteSource,
  type RouteTool,
} from './route.ts';

/**
 * The agent's route book: GTNH's real recipes and world knowledge (the generated knowledge
 * base, src/goals/knowledge.ts) plus the hand-verified recipes the agent can craft
 * (src/domain/recipes.ts) and what digging yields. Hand-verified entries win where both
 * exist (e.g. GTNH's 1 log -> 2 planks: the dump has no output counts). The route planner
 * itself stays general: new abilities and data are new entries here.
 */

type Yields<B extends string = DiggableBlock> = Readonly<
  Record<B, ReadonlyArray<{ item: string; perDig: number }>>
>;

/**
 * Vanilla 1.7.10 (the base layer): what one bare-hand dig of each allowlisted block yields
 * on average, with no fortune. GTNH changes some of it (GTNH_DIG_CHANGES).
 */
export const VANILLA_DIG_YIELDS: Yields<(typeof SOLID_DIGGABLE_BLOCKS)[number]> = {
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
  // Biomes O' Plenty's leaves (javap: quantityDropped is 1 in 20, of the sapling of their
  // kind; apple and persimmon leaves drop their fruit only when ripe, not counted here).
  'BiomesOPlenty:leaves1': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
  'BiomesOPlenty:leaves2': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
  'BiomesOPlenty:leaves3': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
  'BiomesOPlenty:leaves4': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
  'BiomesOPlenty:colorizedLeaves1': [{ item: 'BiomesOPlenty:colorizedSaplings', perDig: 0.05 }],
  'BiomesOPlenty:colorizedLeaves2': [{ item: 'BiomesOPlenty:colorizedSaplings', perDig: 0.05 }],
  'BiomesOPlenty:appleLeaves': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
  'BiomesOPlenty:persimmonLeaves': [{ item: 'BiomesOPlenty:saplings', perDig: 0.05 }],
};

/** GTNH 2.8.4's changes to what bare-hand digs yield (each verified; see the evidence). */
export const GTNH_DIG_CHANGES: ReadonlyArray<{
  block: DiggableBlock;
  yields: ReadonlyArray<{ item: string; perDig: number }>;
  evidence: string;
}> = [
  {
    block: 'minecraft:gravel',
    yields: [{ item: 'minecraft:gravel', perDig: 1 }],
    evidence:
      'IguanaTweaks 2.6.6 FlintHandler (removeFlintDrop=true, IguanaTinkerTweaks/main.cfg) ' +
      'replaces the flint drop with gravel: gravel always drops gravel. Flint is crafted: 3 ' +
      'gravel -> 1 flint (addFlintRecipe, gravelPerFlint=3).',
  },
];

/**
 * HarvestCraft's land gardens (GTNH's own pack content): one dig drops 3 items
 * (gardendropAmount=3), each a random one of the garden's list (BlockGarden.getDropList,
 * src/domain/food.ts GARDEN_DROPS), so 3 / n of each of its n kinds on average.
 */
export const GARDEN_DIG_YIELDS: Yields<GardenBlock> = (() => {
  const out = {} as Record<GardenBlock, ReadonlyArray<{ item: string; perDig: number }>>;
  for (const g of GARDEN_BLOCKS) {
    const drops = GARDEN_DROPS[g];
    out[g] = drops.map((item) => ({ item, perDig: Number((3 / drops.length).toFixed(3)) }));
  }
  return out;
})();

/** The 16 colours of stained hardened clay: damageDropped is the block's metadata (BlockColored). */
const STAINED_CLAY = Array.from({ length: 16 }, (_, m) => ({
  item: m === 0 ? 'minecraft:stained_hardened_clay' : `minecraft:stained_hardened_clay@${m}`,
  perDig: 1,
}));

/**
 * What one dig of each allowlisted stone yields, with a tool that harvests it (with any other
 * the block drops nothing, and the agent never digs it). Checked in the jars:
 *  - vanilla 1.7.10: BlockStone.getItemDropped is cobblestone; cobblestone, mossy cobblestone,
 *    netherrack and hardened clay drop themselves; sandstone and stained clay keep their
 *    metadata (damageDropped); BlockOre gives emerald ore's emerald (1, no fortune);
 *  - GregTech 5.09.51.482: BlockStonesAbstract.damageDropped turns a smooth stone (metadata
 *    0 or 8) into its cobblestone (1 or 9);
 *  - no harvest-drop handler on this server changes them for a vanilla wooden pickaxe or a
 *    plain Tinkers' one: of the 48 classes in the 210 mod jars that refer to
 *    HarvestDropsEvent (each read), the ones that act on any block need their own tool,
 *    enchantment, potion or modifier (GT's tools and Fire Aspect, Thaumcraft's foci,
 *    auto-smelt enchantments, Avaritia's Tinkers' materials), and Et Futurum's raw ores are
 *    off (enableRawOres=false).
 */
export const STONE_DIG_YIELDS: Yields<Exclude<ToolDiggableBlock, typeof GT_ORE_BLOCK>> = {
  'minecraft:stone': [{ item: 'minecraft:cobblestone', perDig: 1 }],
  'minecraft:cobblestone': [{ item: 'minecraft:cobblestone', perDig: 1 }],
  'minecraft:mossy_cobblestone': [{ item: 'minecraft:mossy_cobblestone', perDig: 1 }],
  'minecraft:sandstone': [{ item: 'minecraft:sandstone', perDig: 1 }],
  'minecraft:netherrack': [{ item: 'minecraft:netherrack', perDig: 1 }],
  'minecraft:hardened_clay': [{ item: 'minecraft:hardened_clay', perDig: 1 }],
  'minecraft:stained_hardened_clay': STAINED_CLAY,
  // Black granite (0) drops black granite cobblestone (1), red granite (8) red's (9).
  'gregtech:gt.blockgranites': [
    { item: 'gregtech:gt.blockgranites@1', perDig: 1 },
    { item: 'gregtech:gt.blockgranites@9', perDig: 1 },
  ],
  // Marble (0) drops marble cobblestone (1), basalt (8) basalt cobblestone (9).
  'gregtech:gt.blockstones': [
    { item: 'gregtech:gt.blockstones@1', perDig: 1 },
    { item: 'gregtech:gt.blockstones@9', perDig: 1 },
  ],
  'minecraft:emerald_ore': [{ item: 'minecraft:emerald', perDig: 1 }],
};

let gtOreYieldsCache: ReadonlyArray<{ item: string; perDig: number }> | null = null;

/**
 * What a dig of a GT ore in the Overworld can drop (the knowledge base, loaded on first use):
 * a vein ore its raw ore (oredropbehavior=FortuneItem, 1 without fortune; TileEntityOres.
 * getDrops), a small ore the weighted mix of gems, crushed ore and impure dust (per dig on
 * average). The block does not say which material it is (the tile entity does), so a dig of
 * an ore can give any of them. Empty without the knowledge base.
 */
export function gtOreYields(): ReadonlyArray<{ item: string; perDig: number }> {
  if (gtOreYieldsCache !== null) return gtOreYieldsCache;
  const out = new Map<string, number>();
  try {
    const data = loadKnowledge();
    for (const v of data.veins) {
      if (!v.dims.includes('Overworld')) continue;
      for (const o of [v.primary, v.secondary, v.between, v.sporadic]) {
        if (o?.drop != null && o.level >= 0) out.set(o.drop, 1);
      }
    }
    for (const s of data.smallOres) {
      if (!s.dims.includes('Overworld') || s.level < 0) continue;
      for (const [item, perDig] of s.drops) {
        if (perDig > 0) out.set(item, Math.max(out.get(item) ?? 0, perDig));
      }
    }
  } catch {
    // No knowledge base (e.g. a build that did not copy it): no ore drops are known.
  }
  gtOreYieldsCache = [...out].map(([item, perDig]) => ({ item, perDig }));
  return gtOreYieldsCache;
}

/**
 * What one dig yields on this server, with a hand or a tool that harvests the block: vanilla,
 * with GTNH's changes applied, the gardens, stone, and GT ores. The GT ores' entry is read
 * from the knowledge base on first use (gtOreYields), so importing this module reads no data.
 */
export const DIG_YIELDS: Yields = Object.defineProperty(
  {
    ...VANILLA_DIG_YIELDS,
    ...Object.fromEntries(GTNH_DIG_CHANGES.map((c) => [c.block, c.yields])),
    ...GARDEN_DIG_YIELDS,
    ...STONE_DIG_YIELDS,
  },
  GT_ORE_BLOCK,
  { enumerable: true, get: gtOreYields },
) as Yields;

/**
 * Health of the farm animals (applyEntityAttributes in the vanilla jar: EntityCow and EntityPig
 * 10, EntitySheep 8, EntityChicken 4). A bare hand deals 1 a hit, and a struck animal runs
 * off for a few seconds (EntityAIPanic), so every hit costs a walk after it: about 5 s a hit.
 */
const ANIMAL_HEALTH: Readonly<Record<string, number>> = {
  'minecraft:Cow': 10,
  'minecraft:Pig': 10,
  'minecraft:Sheep': 8,
  'minecraft:Chicken': 4,
};
const SECONDS_PER_HIT = 5;

/**
 * Mob drops as route sources (via 'kill'): what killing a farm animal yields on average, from
 * food.ts ANIMAL_DROPS (the vanilla jar's dropFewItems, HarvestCraft's mutton). Only the
 * animals ATTACK_ENTITY may strike for a task (src/domain/combat.ts FARM_ANIMALS).
 */
function killSources(): RouteSource[] {
  return Object.entries(ANIMAL_DROPS).flatMap(([animal, drops]) =>
    drops.map((d) => ({
      item: d.item,
      via: 'kill' as const,
      blocks: [animal],
      perAction: (d.min + d.max) / 2,
      secondsPerAction: (ANIMAL_HEALTH[animal] ?? 10) * SECONDS_PER_HIT,
    })),
  );
}

/**
 * Where a player looks for each block (general Minecraft knowledge, any modpack's overworld,
 * and GTNH's own generation where it says so).
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
  'minecraft:stone': 'under the surface almost everywhere: cliffs, hillsides, caves',
  'minecraft:cobblestone': 'dungeons and villages (or dig stone)',
  'minecraft:mossy_cobblestone': 'dungeons',
  'minecraft:sandstone': 'under desert sand',
  'minecraft:netherrack': 'the Nether',
  'minecraft:hardened_clay': 'mesa biomes',
  'minecraft:stained_hardened_clay': 'the coloured bands of mesa biomes',
  // GTStones: blobs in the Overworld's stone, y 0-180 (GregTech 5.09.51.482 WorldgenStone).
  'gregtech:gt.blockgranites': 'blobs in the stone underground (y 0-180): cliffs and caves',
  'gregtech:gt.blockstones': 'blobs in the stone underground (y 0-180): cliffs and caves',
  'gregtech:gt.blockores': 'GT ore veins in the stone (by height: see generates)',
  // BiomeGenHills.decorate (and Biomes O' Plenty's mountains): single blocks in stone.
  'minecraft:emerald_ore': 'Extreme Hills and mountains, single blocks in stone at y 4-31',
  // HarvestCraft's gardens, by where its generator puts them (food.ts GARDEN_BIOMES), and the
  // farm animals (they spawn on grass, in grassy biomes).
  ...Object.fromEntries(GARDEN_BLOCKS.map((g) => [g, `HarvestCraft gardens: ${GARDEN_BIOMES[g]}`])),
  'minecraft:Cow': 'grassy biomes: plains, forests, hills',
  'minecraft:Pig': 'grassy biomes: plains, forests, hills',
  'minecraft:Sheep': 'grassy biomes: plains, forests, hills',
  'minecraft:Chicken': 'grassy biomes: plains, forests, hills',
};

/** The item that provides each station. */
export const STATION_ITEMS: Readonly<Record<string, string>> = {
  crafting_table: 'minecraft:crafting_table',
  furnace: 'minecraft:furnace',
};

/**
 * Seconds one bare-hand dig takes, as the client digs (vanilla time x 1.25 + 2 ticks), plus
 * about a second to step to the next block and pick up the drop.
 */
function secondsPerDig(hardness: number): number {
  const ticks = Math.ceil(Math.ceil(hardness * 30 - 1e-9) * 1.25 - 1e-9) + 2;
  return ticks / 20 + 1;
}

/** Rough seconds per dig with a fitting tool (speed ~4-6): hardness x 0.4 plus a step. */
function secondsPerToolDig(hardness: number): number {
  return Number((hardness * 0.4 + 1).toFixed(2));
}
/** GT ores: a dig in a found vein, and a small ore (scattered: mostly searching). */
const VEIN_ORE_SECONDS = 4;
const SMALL_ORE_SECONDS = 30;
/**
 * A garden breaks at once, but gardens are scattered (a few per chunk of the biomes they grow
 * in, none elsewhere): like a GT small ore, a dig is mostly looking for one.
 */
const GARDEN_SECONDS = 30;

/**
 * Bare-hand digs as route sources. A garden counts only for its food: its other drops (cactus,
 * pumpkins, mushrooms, cotton) are left out, so no route reaches for a garden to make
 * something else (seen in a test: 4 clay blocks routed through Natura water drops from cactus).
 */
function digSources(): RouteSource[] {
  const byItem = new Map<string, { blocks: string[]; perAction: number; seconds: number }>();
  // Stone and ores are tool digs (toolDigSources, oreSources): never by hand.
  for (const block of DIGGABLE_BLOCKS.filter((b) => !isToolDiggable(b))) {
    const yields = DIG_YIELDS[block];
    const garden = isGardenBlock(block);
    for (const y of yields) {
      if (garden && !GARDEN_FOODS.includes(y.item)) continue;
      const entry = byItem.get(y.item);
      const seconds = garden ? GARDEN_SECONDS : secondsPerDig(diggableInfo(block).hardness);
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

/** The hand-verified crafting recipes (src/domain/recipes.ts), as route recipes. */
function handRecipes(): RouteRecipe[] {
  // Every recipe in the table is verified for GTNH (e.g. the crafting table is GTNH's own
  // 2x2: two flint above two logs).
  return RECIPE_IDS.map((id) => {
    const r = RECIPES[id];
    return {
      id,
      output: { item: r.result.item, count: r.result.count },
      inputs: ingredientRequirements(r).map((q) => ({ anyOf: q.anyOf, count: q.perCraft })),
      station: needsCraftingTable(r) ? 'crafting_table' : '2x2',
      rank: 0,
    };
  });
}

/**
 * A book of only the hand-verified recipes, bare-hand digging and the farm animals' drops (no
 * generated data).
 */
export const HAND_BOOK: RouteBook = {
  recipes: handRecipes(),
  sources: [...digSources(), ...killSources()],
  hints: FIND_HINTS,
  stationItems: STATION_ITEMS,
};

const sameSet = (a: readonly string[], b: ReadonlySet<string>): boolean => a.every((x) => b.has(x));

/**
 * Builds the full book from knowledge data. Exported for tests (which may pass smaller data).
 */
export function buildRouteBook(data: KnowledgeData): RouteBook {
  // One shared array per ore name (or alternatives list): thousands of recipes reuse them.
  const lists = new Map<string, readonly string[]>();
  const expand = (ref: IngredientRef): readonly string[] => {
    const key =
      typeof ref === 'string'
        ? `o:${ref}`
        : typeof ref === 'number'
          ? `i:${ref}`
          : `l:${ref.join(',')}`;
    let list = lists.get(key);
    if (list === undefined) {
      list = ingredientItems(data, ref);
      lists.set(key, list);
    }
    return list;
  };
  const generated: RouteRecipe[] = [];
  // The same recipe is often registered twice (e.g. by GT and a script): one id, one recipe.
  // CRAFT_ITEM takes the same ids (one function names them both).
  const ids = knowledgeRecipeIds(data);
  for (const [i, [out, count, flags, , inputs, label]] of data.crafting.entries()) {
    const item = data.items[out];
    const id = ids[i];
    if (item === undefined || id == null) continue;
    const pairs: Array<{ ref: IngredientRef; count: number }> = [];
    for (let k = 0; k + 1 < inputs.length; k += 2) {
      pairs.push({ ref: inputs[k] as IngredientRef, count: inputs[k + 1] as number });
    }
    const station = (flags & CraftFlag.FITS_2X2) !== 0 ? '2x2' : 'crafting_table';
    generated.push({
      id,
      output: { item, count: Math.max(1, count) },
      inputs: pairs.map((p) => ({
        anyOf: expand(p.ref),
        count: p.count,
        ...(isToolOre(p.ref) ? { tool: true } : {}),
        ...(typeof p.ref === 'string' ? { label: `ore:${p.ref}` } : {}),
      })),
      station,
      countKnown: count > 0,
      rank: (flags & CraftFlag.NBT_INPUT) !== 0 ? 3 : 1,
      ...(label === '' ? {} : { label }),
    });
  }
  for (const [input, output] of data.furnace) {
    const from = data.items[input];
    const to = data.items[output];
    if (from === undefined || to === undefined) continue;
    generated.push({
      id: `furnace:${from}`,
      output: { item: to, count: 1 },
      inputs: [{ anyOf: [from], count: 1 }],
      station: 'furnace',
      countKnown: false,
      rank: 1,
    });
  }

  // Hand-verified recipes win: each replaces the generated recipe it matches (same output,
  // the same inputs as sets with the same counts), taking that recipe's wider ingredient
  // lists (ore-dictionary entries) but keeping its own verified count.
  const replaced = new Set<RouteRecipe>();
  const byOutput = new Map<string, RouteRecipe[]>();
  for (const r of generated) {
    const list = byOutput.get(r.output.item) ?? [];
    list.push(r);
    byOutput.set(r.output.item, list);
  }
  const hand = handRecipes().map((h) => {
    const match = (byOutput.get(h.output.item) ?? []).find(
      (g) =>
        g.station !== 'furnace' &&
        g.inputs.length === h.inputs.length &&
        h.inputs.every((hi) =>
          g.inputs.some((gi) => gi.count === hi.count && sameSet(hi.anyOf, new Set(gi.anyOf))),
        ),
    );
    if (match === undefined) return h;
    for (const g of byOutput.get(h.output.item) ?? []) {
      if (
        g.inputs.length === match.inputs.length &&
        g.inputs.every(
          (gi, i) => gi.anyOf === match.inputs[i]?.anyOf && gi.count === match.inputs[i]?.count,
        )
      ) {
        replaced.add(g);
      }
    }
    return {
      ...h,
      inputs: h.inputs.map((hi) => {
        const gi = match.inputs.find(
          (x) => x.count === hi.count && sameSet(hi.anyOf, new Set(x.anyOf)),
        );
        return gi === undefined
          ? hi
          : { ...hi, anyOf: gi.anyOf, ...(gi.label === undefined ? {} : { label: gi.label }) };
      }),
    };
  });

  return {
    recipes: [...hand, ...generated.filter((g) => !replaced.has(g))],
    sources: [...digSources(), ...killSources(), ...toolDigSources(), ...oreSources(data)],
    hints: FIND_HINTS,
    tools: toolsOf(data),
    stationItems: STATION_ITEMS,
  };
}

/** A block's tool requirement from the harvest table ("mod:block@meta", then "mod:block"). */
export function harvestRequirement(
  data: KnowledgeData,
  block: string,
): { kind: string; level: number } | null {
  const exact =
    data.harvest[block.includes('@') ? block : `${block}@0`] ??
    data.harvest[block.replace(/@\d+$/, '')];
  return exact === undefined ? null : { kind: exact[0], level: exact[1] };
}

/**
 * Stone and the vanilla ore as dig sources: what one dig drops (STONE_DIG_YIELDS) and the
 * tool that harvests the block (its harvest rule, src/domain/dig-time.ts, verified in the
 * jars and IguanaTweaks' configs; a test keeps it equal to the knowledge base's harvest
 * table). Only blocks DIG_BLOCK may dig: a route never sends the agent to one it cannot.
 */
function toolDigSources(): RouteSource[] {
  const out: RouteSource[] = [];
  for (const [block, drops] of Object.entries(STONE_DIG_YIELDS) as Array<
    [ToolDiggableBlock, ReadonlyArray<{ item: string; perDig: number }>]
  >) {
    const info = diggableInfo(block);
    const rule = info.harvest;
    for (const d of drops) {
      out.push({
        item: d.item,
        via: 'dig',
        blocks: [block],
        perAction: d.perDig,
        secondsPerAction: secondsPerToolDig(info.hardness),
        ...(rule === null ? {} : { tool: { kind: rule.tool, level: rule.level } }),
      });
    }
  }
  return out;
}

/** Longest "generates" text of a GT ore source (a route line holds at most 500 characters). */
const MAX_ORE_WHERE = 260;

/**
 * GT ores that generate in the Overworld: vein ores (raw ore drops) and small ores. Each is
 * dug as gregtech:gt.blockores, the block the observation and world memory see: an ore's
 * material is in its tile entity, so the block does not say which ore it is, only its level
 * (its metadata). The source names the ore item (gregtech:gt.blockores@<material>) and where
 * it generates; a GATHER of the block with `item` digs ores until enough of that one drop is
 * held.
 */
function oreSources(data: KnowledgeData): RouteSource[] {
  // drop|block -> the veins (and their roles in each) that hold the ore.
  type VeinRoles = Map<string, { roles: string[]; y: string }>;
  const veinOres = new Map<
    string,
    { block: string; material: string; level: number; veins: VeinRoles }
  >();
  for (const v of data.veins) {
    if (!v.dims.includes('Overworld')) continue;
    for (const [role, o] of [
      ['primary', v.primary],
      ['secondary', v.secondary],
      ['in-between', v.between],
      ['sporadic', v.sporadic],
    ] as const) {
      if (o === null || o.block === null || o.drop === null || o.level < 0) continue;
      const key = `${o.drop}|${o.block}`;
      const entry = veinOres.get(key) ?? {
        block: o.block,
        material: o.material,
        level: o.level,
        veins: new Map() as VeinRoles,
      };
      const vein = entry.veins.get(v.key) ?? { roles: [], y: `y ${v.minY}-${v.maxY}` };
      vein.roles.push(role);
      entry.veins.set(v.key, vein);
      veinOres.set(key, entry);
    }
  }
  const out: RouteSource[] = [];
  for (const [key, e] of veinOres) {
    const drop = key.slice(0, key.indexOf('|'));
    const veins = [...e.veins].map(
      ([name, v]) => `GT vein ${name} (${v.roles.join(', ')}): ${v.y}`,
    );
    const head = `${e.material} ore (${e.block}): `;
    const gather = `; GATHER {"block":"${GT_ORE_BLOCK}","item":"${drop}"}`;
    const generates = (shown: number): string =>
      veins.slice(0, shown).join('; ') +
      (veins.length > shown ? `; and ${veins.length - shown} more veins` : '') +
      ' (Overworld)';
    // Up to three veins, fewer when they would not fit: the GATHER is never cut.
    let shown = Math.min(3, veins.length);
    while (shown > 1 && (head + generates(shown) + gather).length > MAX_ORE_WHERE) shown -= 1;
    out.push({
      item: drop,
      via: 'dig',
      blocks: [GT_ORE_BLOCK],
      perAction: 1,
      secondsPerAction: VEIN_ORE_SECONDS,
      tool: { kind: 'pickaxe', level: e.level },
      where: head + generates(shown) + gather,
    });
  }
  for (const s of data.smallOres) {
    if (!s.dims.includes('Overworld') || s.block === null || s.level < 0) continue;
    for (const [item, perDig] of s.drops) {
      if (perDig <= 0) continue;
      out.push({
        item,
        via: 'dig',
        blocks: [GT_ORE_BLOCK],
        perAction: perDig,
        secondsPerAction: SMALL_ORE_SECONDS,
        tool: { kind: 'pickaxe', level: s.level },
        where:
          `GT small ore ${s.key} (${s.block}): y ${s.minY}-${s.maxY}, ~${s.amount} per chunk ` +
          `(Overworld); GATHER {"block":"${GT_ORE_BLOCK}","item":"${item}"}`,
      });
    }
  }
  return out;
}

/** The kind of a worn-out tool: no requirement asks for it, so it never counts as held. */
export const WORN_OUT_TOOL = 'worn out';

/**
 * Items that work as tools on this server. Tools IguanaTweaks disables (vanilla stone, iron,
 * gold and diamond pickaxes and shovels, and a few mods' tools) mine nothing, so they are
 * not tools here: a route never makes one to dig, and one in the inventory does not count.
 * Nor does a vanilla tool the agent has worn to its limit (src/domain/tools.ts: it stops one
 * use before the tool breaks, at damage maxDamage): listed by that worn name as a worn-out
 * tool, it never covers a dig, so the route gets a new one (seen in a mock run: the route
 * counted "minecraft:wooden_pickaxe@59" as held, and the next GATHER of stone had nothing to
 * dig with).
 */
function toolsOf(data: KnowledgeData): RouteTool[] {
  const tools = data.tools
    .filter(([item]) => data.disabledTools[item] === undefined)
    .map(([item, kind, level]) => ({ item, kind, level }));
  const worn = TOOL_ITEMS.filter((t) => tools.some((x) => x.item === t)).map((t) => ({
    item: `${t}@${TOOLS[t].maxDamage}`,
    kind: WORN_OUT_TOOL,
    level: 0,
  }));
  return [...tools, ...worn];
}

let full: RouteBook | null = null;
let failure: string | null = null;

/** The full GTNH book (knowledge base + hand-verified), built once on first use. */
export function gtnhRouteBook(): RouteBook {
  if (full === null) {
    try {
      full = buildRouteBook(loadKnowledge());
    } catch (error) {
      // Without the data (e.g. a build that did not copy it), plan from what is verified.
      failure = error instanceof Error ? error.message : String(error);
      process.emitWarning(
        `GTNH knowledge base unavailable, using hand-verified recipes only: ${failure}`,
      );
      full = HAND_BOOK;
    }
  }
  return full;
}

/** Null when the knowledge base loaded; otherwise why it did not. */
export function knowledgeFailure(): string | null {
  gtnhRouteBook();
  return failure;
}

/**
 * Why `count` of `item` cannot be got at all from `inventory`, by the book's route: an item
 * it knows no way to get, or one that needs a tool none held is and none can be made (a
 * GregTech ore and its pickaxe level); `anyKind`: every kind of it counts. Null when the
 * route gets it, and when the knowledge base did not load (nothing is known then).
 */
export function cannotGet(
  item: string,
  count: number,
  inventory: Readonly<Record<string, number>>,
  anyKind = false,
): string | null {
  if (knowledgeFailure() !== null) return null;
  const route = planRoute(
    { [item]: count },
    inventory,
    ROUTE_BOOK,
    () => [],
    [],
    undefined,
    new Set(anyKind ? [item] : []),
  );
  const missing = Object.entries(route.unresolved)[0];
  if (missing === undefined) return null;
  const [what, n] = missing;
  // The GATHER the route would plan says nothing to a person.
  const why = (route.why[what] ?? 'no way to get it is known').replace(/; GATHER \{[^}]*\}/, '');
  return what === item ? why : `it takes ${n} ${what}, and ${why}`;
}

/** The agent's route book (loaded lazily: importing this module reads no data). */
export const ROUTE_BOOK: RouteBook = {
  get recipes() {
    return gtnhRouteBook().recipes;
  },
  get sources() {
    return gtnhRouteBook().sources;
  },
  get hints() {
    return gtnhRouteBook().hints ?? FIND_HINTS;
  },
  get tools() {
    return gtnhRouteBook().tools ?? [];
  },
  get stationItems() {
    return gtnhRouteBook().stationItems ?? STATION_ITEMS;
  },
};
