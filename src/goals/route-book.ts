import {
  GARDEN_BLOCKS,
  isGardenBlock,
  type DiggableBlock,
  type GardenBlock,
  type SOLID_DIGGABLE_BLOCKS,
} from '../domain/blocks.ts';
import { diggableInfo } from '../domain/dig-time.ts';
import { ANIMAL_DROPS, GARDEN_BIOMES, GARDEN_DROPS, GARDEN_FOODS } from '../domain/food.ts';
import {
  ingredientRequirements,
  needsCraftingTable,
  RECIPE_IDS,
  RECIPES,
} from '../domain/recipes.ts';
import {
  CraftFlag,
  ingredientItems,
  isToolOre,
  loadKnowledge,
  type IngredientRef,
  type KnowledgeData,
} from './knowledge.ts';
import type { RouteBook, RouteRecipe, RouteSource, RouteTool } from './route.ts';

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

/**
 * What one bare-hand dig yields on this server: vanilla, with GTNH's changes applied, and the
 * gardens.
 */
export const DIG_YIELDS: Yields = {
  ...VANILLA_DIG_YIELDS,
  ...Object.fromEntries(GTNH_DIG_CHANGES.map((c) => [c.block, c.yields])),
  ...GARDEN_DIG_YIELDS,
};

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
 * Blocks that need a tool, with what one dig drops (vanilla 1.7.10: stone drops cobblestone,
 * the others drop themselves; NOT checked against GTNH's drop handlers). The tool and level
 * come from the knowledge base's harvest table (IguanaTweaks), so they stay data.
 */
export const TOOL_DIG_YIELDS: ReadonlyArray<{
  block: string;
  hardness: number;
  drops: ReadonlyArray<{ item: string; perDig: number }>;
}> = [
  {
    block: 'minecraft:stone',
    hardness: 1.5,
    drops: [{ item: 'minecraft:cobblestone', perDig: 1 }],
  },
  {
    block: 'minecraft:cobblestone',
    hardness: 2,
    drops: [{ item: 'minecraft:cobblestone', perDig: 1 }],
  },
  {
    block: 'minecraft:mossy_cobblestone',
    hardness: 2,
    drops: [{ item: 'minecraft:mossy_cobblestone', perDig: 1 }],
  },
  {
    block: 'minecraft:sandstone',
    hardness: 0.8,
    drops: [{ item: 'minecraft:sandstone', perDig: 1 }],
  },
  { block: 'minecraft:obsidian', hardness: 50, drops: [{ item: 'minecraft:obsidian', perDig: 1 }] },
];

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
  'minecraft:stone': 'under the surface almost everywhere, cliffs and caves',
  'minecraft:cobblestone': 'dungeons and villages (or dig stone)',
  'minecraft:sandstone': 'under desert sand',
  'minecraft:obsidian': 'where lava meets water, deep underground',
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
  for (const [block, yields] of Object.entries(DIG_YIELDS) as Array<
    [DiggableBlock, ReadonlyArray<{ item: string; perDig: number }>]
  >) {
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
  const seen = new Set<string>();
  const ordinal = new Map<string, number>();
  for (const [out, count, flags, , inputs, label] of data.crafting) {
    const item = data.items[out];
    if (item === undefined) continue;
    const pairs: Array<{ ref: IngredientRef; count: number }> = [];
    for (let k = 0; k + 1 < inputs.length; k += 2) {
      pairs.push({ ref: inputs[k] as IngredientRef, count: inputs[k + 1] as number });
    }
    const station = (flags & CraftFlag.FITS_2X2) !== 0 ? '2x2' : 'crafting_table';
    // The same recipe is often registered twice (e.g. by GT and a script): keep one.
    const sig = `${out}|${count}|${station}|${label}|${pairs
      .map((p) => `${JSON.stringify(p.ref)}*${p.count}`)
      .sort()
      .join(',')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const n = (ordinal.get(item) ?? 0) + 1;
    ordinal.set(item, n);
    generated.push({
      id: `${item}${label === '' ? '' : `[${label}]`}#${n}`,
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
    sources: [...digSources(), ...killSources(), ...toolDigSources(data), ...oreSources(data)],
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

function toolDigSources(data: KnowledgeData): RouteSource[] {
  const out: RouteSource[] = [];
  for (const t of TOOL_DIG_YIELDS) {
    const tool = harvestRequirement(data, t.block);
    for (const d of t.drops) {
      out.push({
        item: d.item,
        via: 'dig',
        blocks: [t.block],
        perAction: d.perDig,
        secondsPerAction: secondsPerToolDig(t.hardness),
        ...(tool === null ? {} : { tool }),
      });
    }
  }
  return out;
}

/** GT ores that generate in the Overworld: vein ores (raw ore drops) and small ores. */
function oreSources(data: KnowledgeData): RouteSource[] {
  // drop|block -> the veins (and their roles in each) that hold the ore.
  type VeinRoles = Map<string, { roles: string[]; y: string }>;
  const veinOres = new Map<string, { block: string; level: number; veins: VeinRoles }>();
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
    const veins = [...e.veins];
    const shown = veins
      .slice(0, 3)
      .map(([name, v]) => `GT vein ${name} (${v.roles.join(', ')}): ${v.y}`);
    const more = veins.length > 3 ? `; and ${veins.length - 3} more veins` : '';
    out.push({
      item: key.slice(0, key.indexOf('|')),
      via: 'dig',
      blocks: [e.block],
      perAction: 1,
      secondsPerAction: VEIN_ORE_SECONDS,
      tool: { kind: 'pickaxe', level: e.level },
      where: `${shown.join('; ')}${more} (Overworld)`,
    });
  }
  for (const s of data.smallOres) {
    if (!s.dims.includes('Overworld') || s.block === null || s.level < 0) continue;
    for (const [item, perDig] of s.drops) {
      if (perDig <= 0) continue;
      out.push({
        item,
        via: 'dig',
        blocks: [s.block],
        perAction: perDig,
        secondsPerAction: SMALL_ORE_SECONDS,
        tool: { kind: 'pickaxe', level: s.level },
        where: `GT small ore ${s.key}: y ${s.minY}-${s.maxY}, ~${s.amount} per chunk (Overworld)`,
      });
    }
  }
  return out;
}

/**
 * Items that work as tools on this server. Tools IguanaTweaks disables (vanilla stone, iron,
 * gold and diamond pickaxes and shovels, and a few mods' tools) mine nothing, so they are
 * not tools here: a route never makes one to dig, and one in the inventory does not count.
 */
function toolsOf(data: KnowledgeData): RouteTool[] {
  return data.tools
    .filter(([item]) => data.disabledTools[item] === undefined)
    .map(([item, kind, level]) => ({ item, kind, level }));
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
