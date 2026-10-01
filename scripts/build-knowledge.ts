/**
 * Builds the GTNH knowledge base the route planner uses (src/goals/knowledge/gtnh-2.8.4.json.gz)
 * from the private test server: its CraftTweaker dumps, its configs and its mod jars.
 * Read-only: it only reads files in the server folder. Regenerating takes two steps:
 *
 *   1. Dump the server's recipes over RCON (read-only list commands; each appends to the
 *      server's minetweaker.log, and a full recipe dump pauses the server for a few seconds):
 *        node scripts/test-server-admin.ts rcon minetweaker oredict
 *        node scripts/test-server-admin.ts rcon minetweaker recipes          (replies "timed out":
 *        node scripts/test-server-admin.ts rcon minetweaker recipes furnace   it keeps running)
 *        node scripts/test-server-admin.ts rcon minetweaker names
 *        node scripts/test-server-admin.ts rcon minetweaker mods
 *   2. node scripts/build-knowledge.ts [--server <dir>] [--log <minetweaker.log>] [--out <file>]
 *
 * Needs TEST_SERVER_DIR (.env) or --server. Sources, and what each contributes:
 *  - minetweaker.log: crafting recipes (shaped and shapeless), furnace recipes, the ore
 *    dictionary (to expand ore ingredients), registered item names (to validate every name)
 *  - mods/gregtech-*.jar: GT ore veins and small ores (OreMixes, SmallOres), materials (ids,
 *    tool quality), GT's ore harvest rules
 *  - mods/GTNewHorizonsCoreMod-*.jar: output counts of the recipes its scripts register
 *    (the dump has no output counts)
 *  - config/GregTech/*.cfg: vanilla ore generation, ore drop behaviour, harvest-level switch
 *  - config/IguanaTinkerTweaks/*.cfg: block harvest levels, tool levels, level names, which
 *    tools mine nothing, gravel's flint
 *  - config/HungerOverhaul/HungerOverhaul.cfg: healing and food values (for the changes table)
 *  - the vanilla 1.7.10 base layer: minecraft-data 3.117.0 (PrismarineJS, MIT licence;
 *    node_modules/minecraft-data, data/pc/1.7) and the server's minecraft_server.1.7.10.jar
 *    (recipes with counts, smelting, tool materials, ore generation, block drops)
 *  - from both layers: the "changes from vanilla" table (also written to
 *    docs/gtnh-vs-vanilla.md; run prettier on it after regenerating)
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import dotenv from 'dotenv';
import { ItemNameSchema } from '../src/domain/common.ts';
import { ingredientRequirements, RECIPE_IDS, RECIPES } from '../src/domain/recipes.ts';
import {
  CraftFlag,
  KNOWLEDGE_FILE,
  KNOWLEDGE_FORMAT,
  type CountFrom,
  type CraftingRow,
  type IngredientRef,
  type KnowledgeData,
  type KnowledgeSource,
  type OreBlockInfo,
  type SmallOre,
  type VanillaLayer,
  type Vein,
} from '../src/goals/knowledge.ts';
import {
  buildChanges,
  sameIngredients as sameAsVanilla,
  type GtnhRecipeView,
} from './knowledge/changes.ts';
import { categoryAt, parseForgeConfig, type ConfigCategory } from './knowledge/forge-config.ts';
import {
  gtOreHarvestLevel,
  readMaterials,
  readOreMixes,
  readSmallOres,
  type GtMaterial,
} from './knowledge/gregtech.ts';
import { openJar } from './knowledge/jvm.ts';
import {
  parseMineTweakerLog,
  type DumpedRecipe,
  type Ingredient,
  type ItemRef,
} from './knowledge/minetweaker.ts';
import { readScriptRecipes } from './knowledge/nhcore.ts';
import { readMinecraftData, readServerJar } from './knowledge/vanilla.ts';

dotenv.config({ quiet: true });
const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    log: { type: 'string' },
    out: { type: 'string', default: join('src', 'goals', 'knowledge', KNOWLEDGE_FILE) },
  },
});
const serverDir = (values.server ?? process.env['TEST_SERVER_DIR'] ?? '').trim();
if (serverDir === '') throw new Error('Set TEST_SERVER_DIR (.env) or pass --server <dir>');

const sources: KnowledgeSource[] = [];
function readSource(path: string, detail: string, name?: string): Buffer {
  const buf = readFileSync(path);
  const rel = relative(serverDir, path).replace(/\\/g, '/');
  sources.push({
    // Inside the server folder: its path there; elsewhere (e.g. --log): the file name.
    name: name ?? (rel.startsWith('..') || /^[A-Za-z]:/.test(rel) ? basename(path) : rel),
    detail,
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
  });
  return buf;
}
function findJar(prefix: string): string {
  const name = readdirSync(join(serverDir, 'mods')).find(
    (f) => f.startsWith(prefix) && f.endsWith('.jar'),
  );
  if (name === undefined) throw new Error(`no mods/${prefix}*.jar in ${serverDir}`);
  return join(serverDir, 'mods', name);
}
const notes: string[] = [];
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

// ---------------------------------------------------------------------------
// 1. The CraftTweaker dumps
// ---------------------------------------------------------------------------

const logPath = values.log ?? join(serverDir, 'minetweaker.log');
const dump = parseMineTweakerLog(
  readSource(
    logPath,
    'CraftTweaker 3.4.2 dumps: oredict, recipes, recipes furnace, names, mods',
  ).toString('utf8'),
);
if (dump.recipes.length === 0 || dump.furnace.length === 0 || dump.oredict.size === 0) {
  throw new Error(
    `${logPath} lacks a dump (recipes ${dump.recipes.length}, furnace ${dump.furnace.length}, ` +
      `ore entries ${dump.oredict.size}): run the RCON dump commands first (see this file's header)`,
  );
}
if (dump.names.size === 0) throw new Error(`${logPath} lacks "minetweaker names": run it first`);

// ---------------------------------------------------------------------------
// 2. Item names: registered, valid agent names, wildcard variants
// ---------------------------------------------------------------------------

const registered = new Set(dump.names.keys());
const itemName = (id: string, damage: number): string => (damage === 0 ? id : `${id}@${damage}`);
const rejected = new Map<string, string>();
function valid(id: string, damage: number): boolean {
  const name = itemName(id, damage);
  if (!registered.has(id)) {
    rejected.set(name, 'not a registered item');
    return false;
  }
  if (!ItemNameSchema.safeParse(name).success) {
    rejected.set(name, 'not a valid agent item name');
    return false;
  }
  return true;
}
/** Every damage value seen for each item in the dumps (to expand `:*` wildcards). */
const variants = new Map<string, Set<number>>();
const see = (r: ItemRef): void => {
  if (r.damage === null) return;
  const set = variants.get(r.id) ?? new Set<number>([0]);
  set.add(r.damage);
  variants.set(r.id, set);
};
for (const list of dump.oredict.values()) list.forEach(see);
for (const r of dump.recipes) {
  see(r.output);
  for (const row of r.grid) for (const c of row) if (c?.kind === 'item') see(c);
}
for (const f of dump.furnace) {
  see(f.input);
  see(f.output);
}
/** Agent item names for a reference (a wildcard expands to every variant seen). */
function namesOf(r: ItemRef): string[] {
  const damages = r.damage === null ? [...(variants.get(r.id) ?? new Set([0]))] : [r.damage];
  return damages
    .sort((a, b) => a - b)
    .filter((d) => valid(r.id, d))
    .map((d) => itemName(r.id, d));
}

const itemIndex = new Map<string, number>();
const items: string[] = [];
const indexOf = (name: string): number => {
  let i = itemIndex.get(name);
  if (i === undefined) {
    i = items.length;
    items.push(name);
    itemIndex.set(name, i);
  }
  return i;
};

// ---------------------------------------------------------------------------
// 3. Ore dictionary
// ---------------------------------------------------------------------------

const oreNames = new Map<string, string[]>();
for (const [name, refs] of dump.oredict) {
  const names = [...new Set(refs.flatMap(namesOf))];
  if (names.length > 0) oreNames.set(name, names);
}
/** Is this item (exact name) in ore entry `ore`? */
const inOre = (ore: string, name: string): boolean => oreNames.get(ore)?.includes(name) ?? false;

// ---------------------------------------------------------------------------
// 4. Crafting recipes
// ---------------------------------------------------------------------------

interface BuiltRecipe {
  output: string;
  flags: number;
  pattern: string;
  inputs: Array<{ ref: IngredientRef; count: number; sig: string }>;
  label: string;
  /** Per filled cell, for matching script recipes: "ore:X", "item:ID@D" or "item:ID@*". */
  cells: string[];
  count: number;
  countFrom: CountFrom;
}

const deadRecipes = { output: 0, ingredient: 0 };
function ingredientOf(c: Ingredient): { ref: IngredientRef; sig: string; nbt: boolean } | null {
  if (c.kind === 'ore') {
    return oreNames.has(c.name) ? { ref: c.name, sig: `o:${c.name}`, nbt: false } : null;
  }
  const names = namesOf(c);
  if (names.length === 0) return null;
  const refs = names.map(indexOf);
  const ref: IngredientRef = refs.length === 1 ? (refs[0] as number) : refs;
  return { ref, sig: `i:${names.join('|')}${c.nbt === null ? '' : '+nbt'}`, nbt: c.nbt !== null };
}

function buildRecipe(r: DumpedRecipe): BuiltRecipe | null {
  if (r.output.damage === null || !valid(r.output.id, r.output.damage)) {
    deadRecipes.output++;
    return null;
  }
  const output = itemName(r.output.id, r.output.damage);
  let flags = r.shapeless ? CraftFlag.SHAPELESS : 0;
  let label = '';
  if (r.output.nbt !== null) {
    flags |= CraftFlag.NBT_OUTPUT;
    label = /PrimaryMaterial: "([^"]+)"/.exec(r.output.nbt)?.[1] ?? '';
  }
  const inputs: BuiltRecipe['inputs'] = [];
  const letters = new Map<string, string>();
  const cells: string[] = [];
  const rows: string[] = [];
  let maxRow = -1;
  let maxCol = -1;
  let filled = 0;
  for (const [y, row] of r.grid.entries()) {
    let line = '';
    for (const [x, cell] of row.entries()) {
      if (cell === null) {
        line += '.';
        continue;
      }
      const ing = ingredientOf(cell);
      if (ing === null) {
        deadRecipes.ingredient++;
        return null;
      }
      if (ing.nbt) flags |= CraftFlag.NBT_INPUT;
      let letter = letters.get(ing.sig);
      if (letter === undefined) {
        letter = String.fromCharCode(97 + letters.size);
        letters.set(ing.sig, letter);
        inputs.push({ ref: ing.ref, count: 0, sig: ing.sig });
      }
      const input = inputs[letter.charCodeAt(0) - 97];
      if (input !== undefined) input.count++;
      line += letter;
      cells.push(
        cell.kind === 'ore'
          ? `ore:${cell.name}`
          : `item:${cell.id}@${cell.damage === null ? '*' : cell.damage}`,
      );
      maxRow = Math.max(maxRow, y);
      maxCol = Math.max(maxCol, x);
      filled++;
    }
    rows.push(line);
  }
  if (filled === 0) return null;
  if (r.shapeless) {
    if (filled <= 4) flags |= CraftFlag.FITS_2X2;
  } else {
    // A 3x3 recipe padded with empty cells is matched at the grid's top-left only, so its
    // filled cells must lie in the first two rows and columns to fit the 2x2 grid.
    if (maxRow <= 1 && maxCol <= 1) flags |= CraftFlag.FITS_2X2;
    const h = r.grid.length;
    const w = Math.max(...r.grid.map((row) => row.length));
    if ((w === 1 && (h === 2 || h === 3)) || (w === 2 && h === 3)) {
      flags |= CraftFlag.SHAPE_UNCERTAIN;
    }
  }
  return {
    output,
    flags,
    pattern: r.shapeless ? '' : rows.join('/'),
    inputs,
    label,
    cells,
    count: 0,
    countFrom: '',
  };
}

const built = dump.recipes.flatMap((r) => {
  const b = buildRecipe(r);
  return b === null ? [] : [b];
});

// Output counts from GTNewHorizonsCoreMod's recipe scripts.
const nhJarPath = findJar('GTNewHorizonsCoreMod');
const gtJarPath = findJar('gregtech-');
const nhJar = openJar(nhJarPath);
const gtJar = openJar(gtJarPath);
readSource(nhJarPath, 'recipe scripts (com/dreammaster/scripts): output counts');
readSource(gtJarPath, 'OreMixes, SmallOres, materials, ore harvest rules, GT tool letters');
const scriptRecipes = readScriptRecipes(nhJar, gtJar);

function cellMatches(script: string, cell: string): boolean {
  if (script === '?' || script === cell) return true;
  if (script.startsWith('ore:')) {
    const ore = script.slice(4);
    if (cell.startsWith('item:')) {
      const [id, d] = cell.slice(5).split(/@(?=[^@]*$)/);
      if (d === '*') return (oreNames.get(ore) ?? []).some((n) => n.split('@')[0] === id);
      return inOre(ore, itemName(id ?? '', Number(d)));
    }
    return false;
  }
  if (script.startsWith('item:')) {
    const [id, d] = script.slice(5).split(/@(?=[^@]*$)/);
    if (cell === `item:${id}@*`) return true;
    if (cell.startsWith('ore:')) return inOre(cell.slice(4), itemName(id ?? '', Number(d)));
  }
  return false;
}
/** Can the script's inputs be paired one-to-one with the dumped cells? */
function sameIngredients(script: readonly string[], cells: readonly string[]): boolean {
  if (script.length !== cells.length) return false;
  const used = new Array<boolean>(cells.length).fill(false);
  // Most specific first, so wildcards do not take a cell a named ingredient needs.
  const order = [...script].sort((a, b) => Number(a === '?') - Number(b === '?'));
  const place = (i: number): boolean => {
    if (i === order.length) return true;
    const s = order[i] ?? '?';
    for (let j = 0; j < cells.length; j++) {
      if (used[j] || !cellMatches(s, cells[j] ?? '')) continue;
      used[j] = true;
      if (place(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return place(0);
}
const byOutput = new Map<string, BuiltRecipe[]>();
for (const b of built) {
  const list = byOutput.get(b.output) ?? [];
  list.push(b);
  byOutput.set(b.output, list);
}
const countVotes = new Map<BuiltRecipe, Set<number>>();
let scriptMatched = 0;
for (const s of scriptRecipes) {
  if (!valid(s.output.id, s.output.damage)) continue;
  const candidates = (byOutput.get(itemName(s.output.id, s.output.damage)) ?? []).filter(
    (b) => ((b.flags & CraftFlag.SHAPELESS) !== 0) === s.shapeless,
  );
  const hits = candidates.filter((b) => sameIngredients(s.inputs, b.cells));
  if (hits.length > 0) scriptMatched++;
  for (const b of hits) {
    const votes = countVotes.get(b) ?? new Set<number>();
    votes.add(s.output.count);
    countVotes.set(b, votes);
  }
}
let counted = 0;
for (const [b, votes] of countVotes) {
  if (votes.size === 1) {
    b.count = [...votes][0] ?? 0;
    b.countFrom = 'script';
    counted++;
  }
}

/** A built recipe's ingredients as item names (ore names expanded). */
const namesOfRef = (ref: IngredientRef): string[] =>
  typeof ref === 'number'
    ? [items[ref] ?? '?']
    : typeof ref === 'string'
      ? (oreNames.get(ref) ?? [])
      : ref.map((i) => items[i] ?? '?');
const views = new Map<BuiltRecipe, GtnhRecipeView>();
const viewOf = (b: BuiltRecipe): GtnhRecipeView => {
  let v = views.get(b);
  if (v === undefined) {
    v = {
      output: b.output,
      count: b.count,
      countFrom: b.countFrom,
      shapeless: (b.flags & CraftFlag.SHAPELESS) !== 0,
      fits2x2: (b.flags & CraftFlag.FITS_2X2) !== 0,
      nbtInput: (b.flags & CraftFlag.NBT_INPUT) !== 0,
      inputs: b.inputs.map((i) => ({
        names: namesOfRef(i.ref),
        label: typeof i.ref === 'string' ? `ore:${i.ref}` : '',
        count: i.count,
        tool: typeof i.ref === 'string' && i.ref.startsWith('craftingTool'),
      })),
    };
    views.set(b, v);
  }
  return v;
};

// Counts the agent verified by hand (src/domain/recipes.ts) win over every other source.
// Those recipes use no crafting tool, so a dumped recipe that needs one (GT's saw variants
// of the plank and stick recipes) is a different recipe with its own count.
let handCounted = 0;
for (const id of RECIPE_IDS) {
  const h = RECIPES[id];
  const want = ingredientRequirements(h);
  for (const b of byOutput.get(h.result.item) ?? []) {
    const v = viewOf(b);
    const fits =
      v.inputs.length === want.length &&
      want.every((w) =>
        v.inputs.some(
          (c) => !c.tool && c.count === w.perCraft && w.anyOf.every((n) => c.names.includes(n)),
        ),
      );
    if (fits) {
      b.count = h.result.count;
      b.countFrom = 'hand';
      v.count = b.count;
      v.countFrom = 'hand';
      handCounted++;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Furnace recipes
// ---------------------------------------------------------------------------

const furnaceSeen = new Set<string>();
const furnace: Array<[number, number]> = [];
for (const f of dump.furnace) {
  if (f.output.damage === null || !valid(f.output.id, f.output.damage)) continue;
  const out = itemName(f.output.id, f.output.damage);
  for (const input of namesOf(f.input)) {
    const key = `${input}>${out}`;
    if (furnaceSeen.has(key)) continue;
    furnaceSeen.add(key);
    furnace.push([indexOf(input), indexOf(out)]);
  }
}

// ---------------------------------------------------------------------------
// 6. Configs
// ---------------------------------------------------------------------------

const config = (path: string, detail: string): ConfigCategory =>
  parseForgeConfig(readSource(join(serverDir, 'config', path), detail).toString('utf8'));
function findValue(cat: ConfigCategory, key: string): string | null {
  const own = cat.values.get(key);
  if (own !== undefined) return own;
  for (const child of cat.children.values()) {
    const v = findValue(child, key);
    if (v !== null) return v;
  }
  return null;
}
const worldGen = config('GregTech/WorldGeneration.cfg', 'GT world generation switches');
const gtConfig = config(
  'GregTech/GregTech.cfg',
  'GT ore drop behaviour, harvest-level change switch, plank nerf',
);
const disableVanillaOres = findValue(worldGen, 'disableVanillaOres') === 'true';
const oreDropBehavior =
  categoryAt(gtConfig, 'gregtech', 'oredropbehavior')?.values.get('setting') ??
  findValue(gtConfig, 'setting') ??
  'unknown';
const harvestLevelChange = findValue(gtConfig, 'activateHarvestLevelChange') === 'true';
const nerfedWoodPlank = findValue(gtConfig, 'nerfedWoodPlank') === 'true';
if (oreDropBehavior !== 'FortuneItem') {
  notes.push(`GT ore drop behaviour is ${oreDropBehavior}: ore drops below assume FortuneItem`);
}
if (harvestLevelChange) {
  notes.push('GT activateHarvestLevelChange=true: ore harvest levels below may be wrong');
}

// IguanaTweaks: block harvest levels, tool levels, level names.
const iguana = (file: string, detail: string): ConfigCategory =>
  config(`IguanaTinkerTweaks/${file}`, detail);
const blockDefaults = iguana('BlockDefaults.cfg', 'harvest tool and level of every block');
const blockOverride = iguana('BlockOverride.cfg', 'harvest level overrides');
const toolDefaults = iguana('ToolDefaults.cfg', 'tool levels of vanilla and mod tools');
const toolOverride = iguana('ToolOverride.cfg', 'tool level overrides');
const levelNamesCfg = iguana('HarvestLevelNamesDefaults.cfg', 'names of the harvest levels');
const materialDefaults = iguana('MaterialDefaults.cfg', "Tinkers' tool material levels");
const materialOverride = iguana('MaterialOverride.cfg', "Tinkers' material overrides");
const iguanaMain = iguana(
  'main.cfg',
  'which tools and swords are disabled (disableRegularTools), gravel and flint',
);
const iguanaTweaks = categoryAt(iguanaMain, 'tweaks')?.values ?? new Map<string, string>();
const allowedTools = categoryAt(iguanaMain, 'allowedtools');
const iguanaFlags = {
  removeFlintDrop: iguanaTweaks.get('removeFlintDrop') === 'true',
  addFlintRecipe: iguanaTweaks.get('addFlintRecipe') !== 'false',
  gravelPerFlint: Number(iguanaTweaks.get('gravelPerFlint') ?? '3'),
  disableRegularTools: iguanaTweaks.get('disableRegularTools') === 'true',
  disableRegularSwords: iguanaTweaks.get('disableRegularSwords') === 'true',
};
/**
 * With disableRegularTools and the blacklist mode, the listed tools (and every tool of a
 * listed mod) mine nothing. IguanaTweaks 2.6.6 (javap, 2026-09-30): findToolsFromConfig
 * whitelists every ItemTool/ItemHoe/ItemSword/ItemBow that is neither listed nor of a listed
 * mod, and VanillaToolNerfHandler.isUselessTool is "an ItemTool that is not whitelisted"
 * (its break speed becomes 0). So only ItemTool subclasses (pickaxes, shovels, axes) can be
 * useless: a listed item that is not one keeps working. A listed mod's tools are found by
 * name (pick, shovel, spade, axe, hatchet): the build cannot see an item's class.
 */
const NOT_ITEM_TOOL: Readonly<Record<string, string>> = {
  'gregtech:gt.metatool.01':
    "listed, but GregTech's MetaGeneratedTool extends MetaBaseItem -> GTGenericItem -> Item, " +
    'not ItemTool (javap, gregtech 5.09.51.482), so IguanaTweaks never disables it',
};
const disabledTools: Record<string, string> = {};
if (iguanaFlags.disableRegularTools && allowedTools?.values.get('exclusionType') === 'blacklist') {
  for (const t of allowedTools.lists.get('tools') ?? []) {
    if (registered.has(t) && NOT_ITEM_TOOL[t] === undefined) {
      disabledTools[t] = 'IguanaTweaks disableRegularTools: on the tools blacklist (main.cfg)';
    }
  }
  const mods = new Set(allowedTools.lists.get('mods') ?? []);
  for (const name of registered) {
    const mod = name.split(':')[0] ?? '';
    if (mods.has(mod) && /pick|shovel|spade|axe|hatchet/i.test(name)) {
      disabledTools[name] =
        `IguanaTweaks disableRegularTools: mod ${mod} is blacklisted (main.cfg)`;
    }
  }
  for (const [t, why] of Object.entries(NOT_ITEM_TOOL)) {
    if (allowedTools.lists.get('tools')?.includes(t) === true) notes.push(`${t}: ${why}`);
  }
}
/**
 * With disableRegularSwords, VanillaSwordNerfHandler cancels the hit (LivingHurtEvent) of a
 * player holding an ItemSword that is not whitelisted (isUselessWeapon, javap): in blacklist
 * mode, a sword on any of the lists (tools, swords, bows, hoes) or of a listed mod. Vanilla
 * swords are disabled only if listed (or "minecraft" is a listed mod).
 */
const disabledSwords: Record<string, string> = {};
if (iguanaFlags.disableRegularSwords && allowedTools?.values.get('exclusionType') === 'blacklist') {
  const listed = new Set(
    ['tools', 'swords', 'bows', 'hoes'].flatMap((k) => allowedTools.lists.get(k) ?? []),
  );
  const mods = new Set(allowedTools.lists.get('mods') ?? []);
  for (const t of allowedTools.lists.get('swords') ?? []) {
    if (registered.has(t))
      disabledSwords[t] = 'IguanaTweaks disableRegularSwords: on the swords list';
  }
  for (const name of registered) {
    const mod = name.split(':')[0] ?? '';
    if (!/sword/i.test(name)) continue;
    if (listed.has(name)) disabledSwords[name] = 'IguanaTweaks disableRegularSwords: listed';
    else if (mods.has(mod)) {
      disabledSwords[name] = `IguanaTweaks disableRegularSwords: mod ${mod} is blacklisted`;
    }
  }
}
const hungerCfg = config(
  'HungerOverhaul/HungerOverhaul.cfg',
  'Hunger Overhaul: healing threshold, regeneration, food value dividers',
);
const hunger = new Map<string, string>();
const collect = (cat: ConfigCategory): void => {
  for (const [k, v] of cat.values) hunger.set(k, v);
  for (const child of cat.children.values()) collect(child);
};
collect(hungerCfg);

/** "mod:block:meta" -> [tool, level], overrides applied. */
const blockLevels = new Map<string, [string, number]>();
for (const [section, tool] of [
  ['blocks_pickaxe', 'pickaxe'],
  ['blocks_shovel', 'shovel'],
  ['blocks_axe', 'axe'],
] as const) {
  for (const cfg of [blockDefaults, blockOverride]) {
    for (const [key, v] of categoryAt(cfg, section)?.values ?? []) {
      blockLevels.set(key, [tool, Number(v)]);
    }
  }
}
// Keep vanilla blocks and GT's stone blocks; one entry per block when every meta agrees.
// GT ore blocks are left out: IguanaTweaks' file says metas 5 and 6 need levels 5 and 6,
// but GT's own BlockOresAbstract.getHarvestLevel (what Forge asks) answers 2 for them; the
// veins and small ores below carry GT's rule.
const harvest: Record<string, [string, number]> = {};
const perBlock = new Map<string, Array<[number, string, number]>>();
for (const [key, [tool, level]] of blockLevels) {
  const m = /^(.*):(\d+)$/.exec(key);
  if (m === null) continue;
  const block = m[1] ?? '';
  if (!/^(minecraft:|gregtech:gt\.block(granites|stones))/.test(block)) continue;
  const list = perBlock.get(block) ?? [];
  list.push([Number(m[2]), tool, level]);
  perBlock.set(block, list);
}
for (const [block, metas] of [...perBlock].sort(([a], [b]) => (a < b ? -1 : 1))) {
  // A shovel or axe level 0 is no requirement (any hand digs it); a pickaxe block needs one.
  const req = metas.filter(([, tool, level]) => tool === 'pickaxe' || level > 0);
  if (req.length === 0) continue;
  const first = req[0];
  const uniform =
    first !== undefined &&
    req.length === metas.length &&
    req.every(([, t, l]) => t === first[1] && l === first[2]);
  // "mod:block" covers every meta; otherwise "mod:block@meta" for each meta (0 included).
  if (uniform && first !== undefined) harvest[block] = [first[1], first[2]];
  else for (const [meta, tool, level] of req) harvest[`${block}@${meta}`] = [tool, level];
}

/** Tools: IguanaTweaks lists them as `modid { itemname { I:pickaxe=N } }` (lower case). */
const tools: Array<[string, string, number]> = [];
const byIguanaName = new Map<string, string>();
for (const name of registered) {
  const [mod, ...rest] = name.split(':');
  byIguanaName.set(
    `${(mod ?? '').toLowerCase()}:${rest.join(':').toLowerCase().replace(/\./g, '_')}`,
    name,
  );
}
const toolLevels = new Map<string, Map<string, number>>();
for (const cfg of [toolDefaults, toolOverride]) {
  for (const [mod, modCat] of cfg.children) {
    for (const [item, itemCat] of modCat.children) {
      const name = byIguanaName.get(`${mod.toLowerCase()}:${item.toLowerCase()}`);
      if (name === undefined) continue;
      const kinds = toolLevels.get(name) ?? new Map<string, number>();
      for (const [kind, level] of itemCat.values) kinds.set(kind, Number(level));
      toolLevels.set(name, kinds);
    }
  }
}
for (const [name, kinds] of [...toolLevels].sort(([a], [b]) => (a < b ? -1 : 1))) {
  for (const [kind, level] of kinds) {
    if (kind === 'pickaxe' || kind === 'shovel' || kind === 'axe') tools.push([name, kind, level]);
  }
}
// Tinkers' Construct tools take their level from the head material (NBT): level unknown.
for (const [name, kind] of [
  ['TConstruct:pickaxe', 'pickaxe'],
  ['TConstruct:hammer', 'pickaxe'],
  ['TConstruct:shovel', 'shovel'],
  ['TConstruct:excavator', 'shovel'],
  ['TConstruct:hatchet', 'axe'],
  ['TConstruct:lumberaxe', 'axe'],
  ['TConstruct:mattock', 'axe'],
  ['TConstruct:mattock', 'shovel'],
] as const) {
  if (registered.has(name)) tools.push([name, kind, -1]);
}
const ticLevels: Record<string, number> = {};
for (const cfg of [materialDefaults, materialOverride]) {
  for (const [mat, cat] of categoryAt(cfg, 'materials')?.children ?? []) {
    const level = cat.values.get('harvestLevel');
    if (level !== undefined) ticLevels[mat] = Number(level);
  }
}
const levelNames: string[] = [];
for (const [key, v] of categoryAt(levelNamesCfg, 'harvestlevelnames')?.values ?? []) {
  const m = /^Level(\d+)$/.exec(key);
  if (m !== null) levelNames[Number(m[1])] = v;
}

// ---------------------------------------------------------------------------
// 7. Ore veins and small ores (GT jar)
// ---------------------------------------------------------------------------

const materials = readMaterials(gtJar);
const oreMixes = readOreMixes(gtJar);
const smallOreDefs = readSmallOres(gtJar);
const firstInOre = (ore: string): string | null => oreNames.get(ore)?.[0] ?? null;
function oreBlockInfo(key: string | null): OreBlockInfo | null {
  if (key === null) return null;
  const m = materials.get(key);
  if (m === undefined) return { material: key, block: null, drop: null, level: -1 };
  const block = `gregtech:gt.blockores@${m.id}`;
  return {
    material: key,
    block: inOre(`ore${m.name}`, block) ? block : null,
    drop: firstInOre(`rawOre${m.name}`),
    level: gtOreHarvestLevel(m.toolQuality, false),
  };
}
const veins: Vein[] = oreMixes
  .filter((v) => v.enabled)
  .map((v) => ({
    name: v.name,
    key: v.key,
    minY: v.minY,
    maxY: v.maxY,
    weight: v.weight,
    density: v.density,
    size: v.size,
    dims: v.dims,
    primary: oreBlockInfo(v.primary),
    secondary: oreBlockInfo(v.secondary),
    between: oreBlockInfo(v.between),
    sporadic: oreBlockInfo(v.sporadic),
  }));

/** What one natural small ore drops on average (TileEntityOres.getDrops, fortune 0). */
function smallOreDrops(m: GtMaterial): Array<[string, number]> {
  const item = (prefix: string): string | null => firstInOre(`${prefix}${m.name}`);
  const gem = item('gem');
  const crushed = item('crushed');
  const impure = item('dustImpure');
  const weighted: Array<[string | null, number]> = [
    [item('gemExquisite') ?? gem, 1],
    [item('gemFlawless') ?? gem, 2],
    [gem, 12],
    [item('gemFlawed') ?? crushed, 5],
    [crushed, 10],
    [item('gemChipped') ?? impure, 5],
    [impure, 10],
  ];
  const total = weighted.reduce((s, [i, w]) => s + (i === null ? 0 : w), 0);
  if (total === 0) return [];
  // Drops per break: max(1, mult + rand(1 + mult) / 2) for a natural ore (fortune 0 -> 1).
  const mult = Math.max(1, m.oreMultiplier);
  let sum = 0;
  for (let r = 0; r <= mult; r++) sum += Math.max(1, mult + Math.floor(r / 2));
  const perBreak = sum / (mult + 1);
  const out = new Map<string, number>();
  for (const [i, w] of weighted) if (i !== null) out.set(i, (out.get(i) ?? 0) + w / total);
  return [...out].map(([i, p]) => [i, Number((p * perBreak).toFixed(4))]);
}
const smallOres: SmallOre[] = smallOreDefs
  .filter((s) => s.enabled && s.material !== null)
  .map((s) => {
    const m = materials.get(s.material ?? '');
    const block = m === undefined ? null : `gregtech:gt.blockores@${16000 + m.id}`;
    return {
      name: s.name,
      key: s.key,
      minY: s.minY,
      maxY: s.maxY,
      amount: s.amount,
      dims: s.dims,
      material: s.material ?? '',
      block: block !== null && valid('gregtech:gt.blockores', 16000 + (m?.id ?? 0)) ? block : null,
      level: m === undefined ? -1 : gtOreHarvestLevel(m.toolQuality, true),
      drops: m === undefined ? [] : smallOreDrops(m),
    };
  });

// Make sure every name the world data mentions is in the item table.
for (const v of veins) {
  for (const o of [v.primary, v.secondary, v.between, v.sporadic]) {
    if (o?.block != null) indexOf(o.block);
    if (o?.drop != null) indexOf(o.drop);
  }
}
for (const s of smallOres) for (const [i] of s.drops) indexOf(i);

// ---------------------------------------------------------------------------
// 8. The vanilla 1.7.10 base layer, vanilla counts, and the changes table
// ---------------------------------------------------------------------------

const mcDataDir = join('node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '1.7');
const mcDataVersion = (
  JSON.parse(readFileSync(join('node_modules', 'minecraft-data', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const mcJson = <T>(file: string): T =>
  JSON.parse(
    readSource(
      join(mcDataDir, file),
      `minecraft-data ${mcDataVersion} (PrismarineJS, MIT): pc/1.7/${file}`,
      `node_modules/minecraft-data/minecraft-data/data/pc/1.7/${file}`,
    ).toString('utf8'),
  ) as T;
type Json = Record<string, unknown>;
const mcData = readMinecraftData({
  items: mcJson<Json[]>('items.json'),
  blocks: mcJson<Json[]>('blocks.json'),
  foods: mcJson<Json[]>('foods.json'),
  materials: mcJson<Record<string, Record<string, number>>>('materials.json'),
  entities: mcJson<Json[]>('entities.json'),
  biomes: mcJson<Json[]>('biomes.json'),
  enchantments: mcJson<Json[]>('enchantments.json'),
  effects: mcJson<Json[]>('effects.json'),
});
const serverJarPath = join(serverDir, 'minecraft_server.1.7.10.jar');
readSource(
  serverJarPath,
  'vanilla 1.7.10: crafting and furnace recipes, tool materials, ore generation, block drops',
);
const fromJar = readServerJar(openJar(serverJarPath));
const vanilla: VanillaLayer = {
  ...mcData,
  toolMaterials: fromJar.toolMaterials,
  tools: fromJar.tools,
  crafting: fromJar.crafting,
  smelting: fromJar.smelting,
  oreGen: fromJar.oreGen,
};
// Every vanilla name is a registered item on this server.
const unknownVanilla = [
  ...vanilla.crafting.flatMap((r) => [r.output, ...r.inputs.map((i) => i.item)]),
  ...vanilla.smelting.flatMap((s) => [s.input, s.output]),
].filter((n) => !registered.has(n.replace(/@\d+$/, '')));
if (unknownVanilla.length > 0)
  notes.push(`vanilla names not registered: ${unknownVanilla.join(', ')}`);

// GregTech's saw recipes for planks and sticks (read with javap from GregTech 5.09.51.482,
// 2026-09-30). Both take the count of the vanilla recipe they replace, n:
//  - ProcessingLog: "s / L" (a saw above a log) makes n planks while nerfedWoodPlank is on,
//    else n * 5 / 4; the shapeless log alone makes n / 2 (on) or n (off).
//  - CraftingRecipeLoader: "s / P / P" (a saw above two plankWood) makes n sticks (on), else
//    n * 5 / 4; "P / P" alone makes n / 2 (on) or n (off).
let gtCounted = 0;
for (const v of vanilla.crafting) {
  if (!/^minecraft:(planks(@\d+)?|stick)$/.test(v.output)) continue;
  for (const b of byOutput.get(v.output) ?? []) {
    if (b.countFrom !== '') continue;
    const view = viewOf(b);
    const tools = view.inputs.filter((i) => i.tool);
    if (tools.length !== 1 || tools[0]?.label !== 'ore:craftingToolSaw') continue;
    if (!sameAsVanilla(v, view)) continue;
    b.count = nerfedWoodPlank ? v.count : Math.floor((v.count * 5) / 4);
    b.countFrom = 'gt';
    view.count = b.count;
    view.countFrom = 'gt';
    gtCounted++;
  }
}

// A dumped recipe with vanilla's exact grid (the same ingredients, no crafting tool) and no
// count of its own takes vanilla's count (labelled: GTNH may have changed it).
let vanillaCounted = 0;
for (const v of vanilla.crafting) {
  for (const b of byOutput.get(v.output) ?? []) {
    if (b.countFrom !== '') continue;
    const view = viewOf(b);
    if (view.inputs.some((i) => i.tool) || !sameAsVanilla(v, view)) continue;
    b.count = v.count;
    b.countFrom = 'vanilla';
    view.count = v.count;
    view.countFrom = 'vanilla';
    vanillaCounted++;
  }
}

const changes = buildChanges({
  vanilla,
  drops: fromJar.drops,
  recipes: built.map(viewOf),
  furnace: furnace.map(([i, o]) => [items[i] ?? '?', items[o] ?? '?']),
  iguana: {
    ...iguanaFlags,
    disabledTools: Object.keys(disabledTools),
    disabledSwords: Object.keys(disabledSwords),
  },
  gt: {
    disableVanillaOres,
    changedWoodenVanillaTools: findValue(gtConfig, 'changedWoodenVanillaTools') === 'true',
    oreDropBehavior,
  },
  hunger,
  veins,
  smallOres,
  harvest,
  levelNames,
});

const crafting: CraftingRow[] = built.map((b) => [
  indexOf(b.output),
  b.count,
  b.flags,
  b.pattern,
  b.inputs.flatMap((i) => [i.ref, i.count]),
  b.label,
  b.countFrom,
]);

// ---------------------------------------------------------------------------
// 9. Write
// ---------------------------------------------------------------------------

// Stable item indices: sort the table and renumber everything.
const order = items.map((name, i) => ({ name, i })).sort((a, b) => (a.name < b.name ? -1 : 1));
const renumber = new Map(order.map((o, j) => [o.i, j]));
const re = (i: number): number => renumber.get(i) ?? -1;
const reRef = (r: IngredientRef): IngredientRef =>
  typeof r === 'number' ? re(r) : typeof r === 'string' ? r : r.map(re);
const ores: Record<string, number[]> = {};
for (const [name, list] of [...oreNames].sort(([a], [b]) => (a < b ? -1 : 1))) {
  ores[name] = list.map((n) => re(indexOf(n)));
}
const materialTable: KnowledgeData['materials'] = {};
for (const m of [...materials.values()].sort((a, b) => a.id - b.id)) {
  materialTable[m.key] = [m.id, m.toolQuality, m.oreMultiplier, m.name];
}
notes.push(
  'Crafting output counts are not in the CraftTweaker dump: count 0 means unknown (the route ' +
    'assumes 1, a lower bound). Known counts come from GTNewHorizonsCoreMod recipe scripts.',
  'Furnace output counts are not in the dump: 1 is assumed.',
  'Shapes of non-square ShapedOreRecipes may be scrambled in the dump (flag 16); the ' +
    'ingredients and the 2x2/3x3 decision are right.',
  `Vanilla ore generation is ${disableVanillaOres ? 'disabled' : 'enabled'} ` +
    '(config/GregTech/WorldGeneration.cfg disableVanillaOres).',
);
const data: KnowledgeData = {
  format: KNOWLEDGE_FORMAT,
  pack: 'GTNH 2.8.4',
  generatedAt: new Date().toISOString(),
  sources,
  notes,
  items: order.map((o) => o.name),
  ores,
  crafting: crafting.map(([out, count, flags, pattern, inputs, label, from]) => [
    re(out),
    count,
    flags,
    pattern,
    inputs.map((x, k) => (k % 2 === 0 ? reRef(x) : x)),
    label,
    from,
  ]),
  furnace: furnace.map(([i, o]) => [re(i), re(o)]),
  materials: materialTable,
  veins,
  smallOres,
  harvest,
  tools,
  ticLevels,
  levelNames,
  disabledTools,
  disabledSwords,
  config: {
    disableVanillaOres,
    oreDropBehavior,
    activateHarvestLevelChange: harvestLevelChange,
    nerfedWoodPlank,
    ...iguanaFlags,
  },
  vanilla,
  changes,
};
const json = JSON.stringify(data);
const gz = gzipSync(json, { level: 9 });
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(values.out, gz);

// The changes table as a document (prettier formats it: run it on the file afterwards).
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const section = (title: string, kinds: readonly string[], intro: string): string[] => {
  const rows = changes.filter((c) => kinds.includes(c.kind));
  if (rows.length === 0) return [];
  return [
    `## ${title}`,
    '',
    intro,
    '',
    '| What | Vanilla 1.7.10 | GTNH 2.8.4 | What changed | Sources |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (c) =>
        `| ${cell(c.subject)} | ${cell(c.vanilla.value)} | ${cell(c.gtnh.value)} | ${cell(c.change)} | ` +
        `vanilla: ${cell(c.vanilla.source)}; GTNH: ${cell(c.gtnh.source)} |`,
    ),
    '',
  ];
};
const doc = [
  '# GTNH 2.8.4 vs vanilla Minecraft 1.7.10',
  '',
  'Every way GTNH 2.8.4 (the test server) differs from vanilla 1.7.10 that the knowledge base can ' +
    'show, each side with its source. Generated by `scripts/build-knowledge.ts` from ' +
    '`src/goals/knowledge/gtnh-2.8.4.json.gz` (`changes`); do not edit by hand. The planner gets the ' +
    'entries that concern its current route as `gtnhChanges` ' +
    '([architecture: knowledge base](architecture.md#knowledge-base)).',
  '',
  '- **Vanilla side:** the 1.7.10 server jar (recipes with counts, smelting, tool materials, ore ' +
    `generation, block drops), read by the build script, and minecraft-data ${mcDataVersion} ` +
    '(PrismarineJS, MIT; items, blocks, foods, harvest tools).',
  "- **GTNH side:** the test server's CraftTweaker dump (recipes, smelting), GregTech's and " +
    "GTNewHorizonsCoreMod's jars (ore veins, output counts), the agent's hand-verified recipe table, " +
    'and the configs (IguanaTweaks, GregTech, Hunger Overhaul).',
  "- A recipe counts as unchanged when GTNH has one with exactly vanilla's ingredients; when its " +
    'count is not known it is not listed (the knowledge base then uses the vanilla count, marked as ' +
    'such).',
  '',
  ...section(
    'Mechanics',
    ['drop', 'tool', 'food', 'mechanic'],
    'Drops, tools and hunger: values read from the configs and jars.',
  ),
  ...section(
    'Ores',
    ['ores'],
    'Vanilla ore generation is off (`disableVanillaOres=true`); GregTech ore veins replace it.',
  ),
  ...section('Smelting', ['smelting'], 'Vanilla furnace recipes that GTNH removes or changes.'),
  ...section(
    'Crafting recipes',
    ['recipe'],
    'Vanilla crafting recipes that GTNH changes: other counts, other ingredients, or no recipe. ' +
      '`ore:` names are ore-dictionary entries (any of their items); tools are used, not consumed.',
  ),
].join('\n');
writeFileSync(join('docs', 'gtnh-vs-vanilla.md'), `${doc}\n`);

say(
  `wrote ${values.out}: ${(gz.length / 1024).toFixed(0)} KiB gzipped (${(json.length / 1024 / 1024).toFixed(1)} MiB JSON)`,
);
say(
  JSON.stringify(
    {
      items: data.items.length,
      oreEntries: Object.keys(ores).length,
      crafting: crafting.length,
      craftingDumped: dump.recipes.length,
      craftingUnknownType: dump.unknownRecipes.length,
      craftingDropped: deadRecipes,
      unparsedLines: dump.unparsed.length,
      counts: {
        scriptRecipes: scriptRecipes.length,
        matched: scriptMatched,
        fromScripts: counted,
        fromHand: handCounted,
        fromGt: gtCounted,
        fromVanilla: vanillaCounted,
      },
      vanilla: {
        crafting: vanilla.crafting.length,
        smelting: vanilla.smelting.length,
        tools: vanilla.tools.length,
        oreGen: vanilla.oreGen.length,
        items: Object.keys(vanilla.items).length,
        blocks: Object.keys(vanilla.blocks).length,
        foods: Object.keys(vanilla.foods).length,
        jarClasses: fromJar.classes,
      },
      changes: changes.length,
      changesByKind: Object.fromEntries(
        [...new Set(changes.map((c) => c.kind))].map((k) => [
          k,
          changes.filter((c) => c.kind === k).length,
        ]),
      ),
      disabledTools: Object.keys(disabledTools).length,
      disabledSwords: Object.keys(disabledSwords),
      furnace: furnace.length,
      furnaceDumped: dump.furnace.length,
      materials: materials.size,
      veins: veins.length,
      smallOres: smallOres.length,
      harvestEntries: Object.keys(harvest).length,
      tools: tools.length,
      rejectedNames: rejected.size,
      rejectedSample: [...rejected].slice(0, 8),
      config: data.config,
      sourceFiles: sources.map((s) => `${s.name} (${s.bytes} bytes)`),
      outBytes: statSync(values.out).size,
    },
    null,
    2,
  ),
);
