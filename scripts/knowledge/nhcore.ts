/**
 * Output counts for crafting recipes, read from the code that registers them.
 *
 * CraftTweaker's recipe dump has no output stack sizes, so counts come from the registering
 * code where it is straight-line and names its output with a literal count:
 *
 *  - GTNewHorizonsCoreMod's recipe scripts (com/dreammaster/scripts/Script*.class), which
 *    define most of GTNH's changed vanilla and mod recipes:
 *      addShapedRecipe(getModItem(mod, name, COUNT, meta, ...), cells...)
 *      addShapelessRecipe(getModItem(...), ingredients...)
 *      GTModHandler.addCraftingRecipe(getModItem(...), bits, pattern + char/ingredient pairs)
 *      GTModHandler.addShapelessCraftingRecipe(getModItem(...), bits, ingredients)
 *
 * A script recipe confirms a dumped recipe's count when the output item matches and the
 * ingredients match as multisets (an ingredient the script names in a way that cannot be
 * resolved here, e.g. a GT ItemList constant, matches any one ingredient).
 */
import { chainRoot, interpretAll, parseClass, type Jar, type Value } from './jvm.ts';

export interface ScriptRecipe {
  /** Class that registers it, e.g. "ScriptMinecraft". */
  script: string;
  shapeless: boolean;
  output: { id: string; damage: number; count: number };
  /** One per filled cell or ingredient: "ore:NAME", "item:ID@DAMAGE" or "?" (unresolved). */
  inputs: string[];
}

/** GTModHandler.addCraftingRecipe's built-in tool letters (5.09.51.482, verified in its code). */
const GT_TOOL_LETTERS: Readonly<Record<string, string>> = {
  b: 'craftingToolBlade',
  c: 'craftingToolCrowbar',
  d: 'craftingToolScrewdriver',
  f: 'craftingToolFile',
  h: 'craftingToolHardHammer',
  i: 'craftingToolSolderingIron',
  j: 'craftingToolSolderingMetal',
  k: 'craftingToolKnife',
  m: 'craftingToolMortar',
  p: 'craftingToolDrawplate',
  r: 'craftingToolSoftMallet',
  s: 'craftingToolSaw',
  w: 'craftingToolWrench',
  x: 'craftingToolWireCutter',
};

const GT_MOD_HANDLER = 'gregtech/api/util/GTModHandler';
const MODS = 'gregtech/api/enums/Mods';

/** Mods.X -> mod id, from the enum's constructors: new Mods(name, ordinal, modId, ...). */
export function readModIds(gtJar: Jar): Map<string, string> {
  const buf = gtJar.read(`${MODS}.class`);
  if (buf === null) throw new Error('gregtech/api/enums/Mods.class not found');
  const out = new Map<string, string>();
  for (const put of interpretAll(parseClass(buf)).puts) {
    if (put.owner !== MODS || put.value.t !== 'new') continue;
    const id = put.value.args?.[2];
    if (id?.t === 'str') out.set(put.name, id.v);
  }
  return out;
}

const int = (v: Value | undefined): number | null => (v?.t === 'int' ? v.v : null);

export function readScriptRecipes(nhJar: Jar, gtJar: Jar): ScriptRecipe[] {
  const modIds = readModIds(gtJar);
  const modId = (v: Value | undefined): string | null => {
    if (v?.t === 'str') return v.v;
    if (v?.t === 'field' && v.name === 'ID' && v.recv.t === 'static' && v.recv.owner === MODS) {
      return modIds.get(v.recv.name) ?? null;
    }
    return null;
  };
  /** getModItem(mod, name, count[, meta][, missing]) -> the stack it names. */
  const modItem = (v: Value | undefined): ScriptRecipe['output'] | null => {
    if (v?.t !== 'call' || v.name !== 'getModItem' || v.owner !== GT_MOD_HANDLER) return null;
    const [mod, name, count, meta] = v.args;
    const m = modId(mod);
    if (m === null || name?.t !== 'str') return null;
    return { id: `${m}:${name.v}`, damage: int(meta) ?? 0, count: int(count) ?? 1 };
  };
  /** An ingredient's signature (see ScriptRecipe.inputs), or null for an empty cell. */
  const ingredient = (v: Value | undefined): string | null => {
    if (v === undefined || v.t === 'null') return null;
    if (v.t === 'str') return `ore:${v.v}`;
    const item = modItem(v);
    if (item !== null) return `item:${item.id}@${item.damage}`;
    // GTOreDictUnificator.get(OrePrefixes.X, Materials.Y, n): the unified item of oreXY.
    if (v.t === 'call' && v.name === 'get' && v.owner.endsWith('GTOreDictUnificator')) {
      const [prefix, mat] = v.args;
      if (prefix?.t === 'static' && mat?.t === 'static' && mat.owner.endsWith('/Materials')) {
        return `ore:${prefix.name}${mat.name}`;
      }
    }
    return '?';
  };
  const out: ScriptRecipe[] = [];
  for (const name of nhJar.names()) {
    if (!/^com\/dreammaster\/scripts\/Script[^/$]*\.class$/.test(name)) continue;
    const buf = nhJar.read(name);
    if (buf === null) continue;
    const script = name.slice(name.lastIndexOf('/') + 1, -'.class'.length);
    for (const call of interpretAll(parseClass(buf)).calls) {
      const gtStyle =
        call.owner === GT_MOD_HANDLER &&
        (call.name === 'addCraftingRecipe' || call.name === 'addShapelessCraftingRecipe');
      const scriptStyle = call.name === 'addShapedRecipe' || call.name === 'addShapelessRecipe';
      if (!gtStyle && !scriptStyle) continue;
      const output = modItem(chainRoot(call.args[0] ?? { t: 'unknown' }));
      if (output === null) continue;
      const shapeless =
        call.name === 'addShapelessRecipe' || call.name === 'addShapelessCraftingRecipe';
      const arr = call.args[call.args.length - 1];
      if (arr?.t !== 'array') continue;
      let inputs: string[];
      if (gtStyle && !shapeless) {
        // Pattern rows first, then (Character, ingredient) pairs.
        const rows: string[] = [];
        let i = 0;
        for (let cell = arr.items[i]; cell?.t === 'str'; cell = arr.items[++i]) rows.push(cell.v);
        const key = new Map<string, string>();
        for (; i + 1 < arr.items.length; i += 2) {
          const ch = arr.items[i];
          const code = ch?.t === 'call' && ch.name === 'valueOf' ? int(ch.args[0]) : null;
          if (code === null) continue;
          key.set(String.fromCharCode(code), ingredient(arr.items[i + 1]) ?? '?');
        }
        inputs = rows
          .join('')
          .split('')
          .filter((c) => c !== ' ')
          .map((c) => key.get(c) ?? (GT_TOOL_LETTERS[c] ? `ore:${GT_TOOL_LETTERS[c]}` : '?'));
      } else {
        inputs = arr.items.map(ingredient).filter((x): x is string => x !== null);
      }
      if (inputs.length === 0) continue;
      out.push({ script, shapeless, output, inputs });
    }
  }
  return out;
}
