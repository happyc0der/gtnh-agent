import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * The GTNH knowledge base: crafting and furnace recipes, ore generation, harvest levels and
 * tools, generated from the test server (GTNH 2.8.4) by scripts/build-knowledge.ts and stored
 * gzipped next to this file (knowledge/gtnh-2.8.4.json.gz). See docs/architecture.md
 * ("Knowledge base") for where each part comes from and how to regenerate it.
 *
 * Item names follow the agent's inventory naming: registry name, plus "@damage" when the
 * damage value is not 0 (e.g. "minecraft:log@2", "gregtech:gt.metaitem.01@11035").
 */

export const KNOWLEDGE_FORMAT = 1;
export const KNOWLEDGE_FILE = 'gtnh-2.8.4.json.gz';

/** An ingredient in the data: an item (index), an ore-dictionary name, or alternatives. */
export type IngredientRef = number | string | number[];

/** Bits of a crafting row's flags. */
export const CraftFlag = {
  /** Shapeless (any arrangement). */
  SHAPELESS: 1,
  /** Fits the player's own 2x2 grid (else it needs a crafting table). */
  FITS_2X2: 2,
  /** The output carries NBT data (the item name does not show it, e.g. a GT tool's material). */
  NBT_OUTPUT: 4,
  /** An input must carry specific NBT data, which the agent's item names cannot express. */
  NBT_INPUT: 8,
  /**
   * The dumped shape may be scrambled: CraftTweaker reads a ShapedOreRecipe's width as
   * floor(sqrt(size)), so 2x1, 3x1 and 3x2 recipes appear as 1x2, 1x3 and 2x3. The ingredients
   * and the 2x2/3x3 decision are still right.
   */
  SHAPE_UNCERTAIN: 16,
} as const;

/**
 * [output item, output count (0 = not known: the dump has no counts), flags, pattern
 *  (shaped: rows of input letters a, b, ... and "." for empty cells, joined by "/"; "" when
 *  shapeless), inputs (flat pairs: ingredient, count per craft), label (e.g. a GT tool's
 *  material) or "" ]
 */
export type CraftingRow = [number, number, number, string, Array<IngredientRef | number>, string];

export interface OreBlockInfo {
  /** GT material key (e.g. "Diamond"). */
  material: string;
  /** The ore block as an item: "gregtech:gt.blockores@<material id>" (stone variant). */
  block: string | null;
  /** What one dig drops without fortune (ore drop behaviour FortuneItem: the raw ore). */
  drop: string | null;
  /** Pickaxe harvest level the block needs (GT's rule; see docs). */
  level: number;
}

export interface Vein {
  /** GT's name, e.g. "ore.mix.diamond". */
  name: string;
  /** OreMixes constant, e.g. "Diamond". */
  key: string;
  minY: number;
  maxY: number;
  weight: number;
  density: number;
  size: number;
  /** "Overworld", "Nether", "TheEnd", "Twilight Forest", or "<body> (space)". */
  dims: string[];
  primary: OreBlockInfo | null;
  secondary: OreBlockInfo | null;
  between: OreBlockInfo | null;
  sporadic: OreBlockInfo | null;
}

export interface SmallOre {
  name: string;
  key: string;
  minY: number;
  maxY: number;
  /** Small ores attempted per chunk. */
  amount: number;
  dims: string[];
  material: string;
  /** "gregtech:gt.blockores@<16000 + id>". */
  block: string | null;
  level: number;
  /** Average items per dig (natural ore, no fortune). */
  drops: Array<[string, number]>;
}

export interface KnowledgeSource {
  name: string;
  detail: string;
  bytes: number;
  sha256: string;
}

export interface KnowledgeData {
  format: number;
  pack: string;
  generatedAt: string;
  sources: KnowledgeSource[];
  notes: string[];
  items: string[];
  ores: Record<string, number[]>;
  crafting: CraftingRow[];
  /** [input item, output item]; the output count is not in the dump (1 assumed). */
  furnace: Array<[number, number]>;
  /** GT materials: key -> [id, tool quality, ore multiplier, name]. */
  materials: Record<string, [number, number, number, string]>;
  veins: Vein[];
  smallOres: SmallOre[];
  /** Block ("mod:block" or "mod:block@meta") -> [tool kind, minimum level]. */
  harvest: Record<string, [string, number]>;
  /** Items that work as a tool: [item, kind, level]; level -1 = depends on its NBT material. */
  tools: Array<[string, string, number]>;
  /** Tinkers' Construct head material -> harvest level (IguanaTweaks). */
  ticLevels: Record<string, number>;
  /** IguanaTweaks' names of the harvest levels (index = level). */
  levelNames: string[];
  config: Record<string, string | number | boolean>;
}

let cached: KnowledgeData | null = null;

/** Parses gzipped knowledge data (and checks its format). */
export function parseKnowledge(gz: Buffer): KnowledgeData {
  const data = JSON.parse(gunzipSync(gz).toString('utf8')) as KnowledgeData;
  if (data.format !== KNOWLEDGE_FORMAT) {
    throw new Error(`knowledge data format ${data.format}, expected ${KNOWLEDGE_FORMAT}`);
  }
  return data;
}

/** The generated GTNH knowledge (loaded once, on first use). */
export function loadKnowledge(): KnowledgeData {
  if (cached === null) {
    const file = new URL(`./knowledge/${KNOWLEDGE_FILE}`, import.meta.url);
    cached = parseKnowledge(readFileSync(file));
  }
  return cached;
}

/** An ingredient as item names (ore names expanded through the ore dictionary). */
export function ingredientItems(data: KnowledgeData, ref: IngredientRef): string[] {
  const name = (i: number): string => data.items[i] ?? `?${i}`;
  if (typeof ref === 'number') return [name(ref)];
  if (typeof ref === 'string') return (data.ores[ref] ?? []).map(name);
  return ref.map(name);
}

/** Ore-dictionary names that mark a crafting tool (used, not consumed, by a craft). */
export function isToolOre(ref: IngredientRef): boolean {
  return typeof ref === 'string' && ref.startsWith('craftingTool');
}
