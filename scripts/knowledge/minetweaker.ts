/**
 * Parses the dumps CraftTweaker 3.4.2 (MineTweaker3) writes to the server's minetweaker.log:
 *
 *  - `/minetweaker oredict`:          "Ore entries for <ore:NAME> :" then one "    <item>" per line
 *  - `/minetweaker recipes`:          "Recipes:" then one recipes.addShaped(...) / addShapeless(...)
 *                                     per recipe, or "// unknown recipe type for <item>"
 *  - `/minetweaker recipes furnace`:  "Furnace Recipes:" then furnace.addRecipe(<out>, <in>, xp)
 *  - `/minetweaker names`:            "<mod:item>, Display Name" per registered item
 *  - `/minetweaker mods`:             "Mod: id - name - version"
 *
 * What the dumps do NOT contain (checked in CraftTweaker 3.4.2's bytecode): output stack sizes
 * (MCItemStack.toString prints no amount), and, for ShapedOreRecipe, the exact shape of
 * non-square recipes (RecipeConverter takes width = floor(sqrt(size))).
 */

/** An item reference as the dump writes it: `<mod:item>`, `<mod:item:3>`, `<mod:item:*>`. */
export interface ItemRef {
  kind: 'item';
  /** Registry name, e.g. "minecraft:log". */
  id: string;
  /** Damage value; null for the wildcard `*`. */
  damage: number | null;
  /** The NBT tag text after .withTag( ... ), if any. */
  nbt: string | null;
}

export interface OreRef {
  kind: 'ore';
  name: string;
}

export type Ingredient = ItemRef | OreRef;

export interface DumpedRecipe {
  shapeless: boolean;
  output: ItemRef;
  /** Shaped: rows of cells (null = empty cell). Shapeless: one row. */
  grid: Array<Array<Ingredient | null>>;
}

export interface MineTweakerDump {
  mods: Map<string, string>;
  oredict: Map<string, ItemRef[]>;
  recipes: DumpedRecipe[];
  /** Outputs of recipes CraftTweaker could not convert ("unknown recipe type"). */
  unknownRecipes: string[];
  /** Lines that started like a recipe but could not be parsed. */
  unparsed: string[];
  furnace: Array<{ input: ItemRef; output: ItemRef }>;
  /** Registry name -> display name (the `names` dump: one line per Item, no damage values). */
  names: Map<string, string>;
}

class Cursor {
  pos = 0;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  skipSpaces(): void {
    while (this.text[this.pos] === ' ') this.pos++;
  }
  peek(s: string): boolean {
    return this.text.startsWith(s, this.pos);
  }
  expect(s: string): void {
    if (!this.peek(s)) {
      throw new Error(
        `expected "${s}" at ${this.pos}: ${this.text.slice(this.pos, this.pos + 40)}`,
      );
    }
    this.pos += s.length;
  }
}

/** Reads a balanced (...) / {...} group with quoted strings, starting at an opening bracket. */
function readBalanced(c: Cursor): string {
  const start = c.pos;
  let depth = 0;
  let quote: string | null = null;
  for (; c.pos < c.text.length; c.pos++) {
    const ch = c.text[c.pos];
    if (quote !== null) {
      if (ch === '\\') c.pos++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        c.pos++;
        return c.text.slice(start, c.pos);
      }
    }
  }
  throw new Error(`unbalanced brackets from ${start}`);
}

/** Parses "<...>" (+ optional .withTag(...)) or "null" at the cursor. */
function readIngredient(c: Cursor): Ingredient | null {
  c.skipSpaces();
  if (c.peek('null')) {
    c.pos += 4;
    return null;
  }
  c.expect('<');
  const end = c.text.indexOf('>', c.pos);
  if (end < 0) throw new Error('unterminated <');
  const inner = c.text.slice(c.pos, end);
  c.pos = end + 1;
  let nbt: string | null = null;
  if (c.peek('.withTag(')) {
    c.pos += '.withTag'.length;
    const group = readBalanced(c);
    nbt = group.slice(1, -1);
  }
  if (inner.startsWith('ore:')) return { kind: 'ore', name: inner.slice(4) };
  return parseItemRefBody(inner, nbt);
}

/** "mod:item", "mod:item:3", "mod:item:*" (item names may contain spaces and dots). */
export function parseItemRefBody(inner: string, nbt: string | null = null): ItemRef {
  const parts = inner.split(':');
  if (parts.length < 2) throw new Error(`bad item reference <${inner}>`);
  const last = parts[parts.length - 1] ?? '';
  if (parts.length >= 3 && (last === '*' || /^\d+$/.test(last))) {
    return {
      kind: 'item',
      id: parts.slice(0, -1).join(':'),
      damage: last === '*' ? null : Number(last),
      nbt,
    };
  }
  return { kind: 'item', id: inner, damage: 0, nbt };
}

function readList<T>(c: Cursor, item: (c: Cursor) => T): T[] {
  c.skipSpaces();
  c.expect('[');
  const out: T[] = [];
  c.skipSpaces();
  if (c.peek(']')) {
    c.pos++;
    return out;
  }
  for (;;) {
    out.push(item(c));
    c.skipSpaces();
    if (c.peek(',')) {
      c.pos++;
      continue;
    }
    c.expect(']');
    return out;
  }
}

export function parseRecipeLine(line: string): DumpedRecipe {
  const shapeless = line.startsWith('recipes.addShapeless(');
  const c = new Cursor(line);
  c.expect(shapeless ? 'recipes.addShapeless(' : 'recipes.addShaped(');
  const output = readIngredient(c);
  if (output === null || output.kind !== 'item') throw new Error('recipe output is not an item');
  c.skipSpaces();
  c.expect(',');
  const grid = shapeless
    ? [readList(c, readIngredient)]
    : readList(c, (cc) => readList(cc, readIngredient));
  c.skipSpaces();
  c.expect(')');
  return { shapeless, output, grid };
}

export function parseFurnaceLine(line: string): { input: ItemRef; output: ItemRef } {
  const c = new Cursor(line);
  c.expect('furnace.addRecipe(');
  const output = readIngredient(c);
  c.skipSpaces();
  c.expect(',');
  const input = readIngredient(c);
  if (output?.kind !== 'item' || input?.kind !== 'item') {
    throw new Error('furnace recipe without item input and output');
  }
  return { input, output };
}

export function parseMineTweakerLog(text: string): MineTweakerDump {
  const dump: MineTweakerDump = {
    mods: new Map(),
    oredict: new Map(),
    recipes: [],
    unknownRecipes: [],
    unparsed: [],
    furnace: [],
    names: new Map(),
  };
  let ore: ItemRef[] | null = null;
  const nameLine = /^<([^>]+)>,(?: (.*))?$/;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (ore !== null) {
      if (line.startsWith('    <')) {
        try {
          const c = new Cursor(line.trim());
          const ing = readIngredient(c);
          if (ing?.kind === 'item') ore.push(ing);
        } catch {
          dump.unparsed.push(line);
        }
        continue;
      }
      ore = null;
    }
    if (line.startsWith('Ore entries for <ore:')) {
      const m = /^Ore entries for <ore:(.*)> :$/.exec(line);
      if (m?.[1] !== undefined) {
        ore = [];
        dump.oredict.set(m[1], ore);
      }
    } else if (line === 'Recipes:') {
      // A newer dump replaces an older one in the same log.
      dump.recipes = [];
      dump.unknownRecipes = [];
    } else if (line === 'Furnace Recipes:') {
      dump.furnace = [];
    } else if (line.startsWith('recipes.add')) {
      try {
        dump.recipes.push(parseRecipeLine(line));
      } catch {
        dump.unparsed.push(line);
      }
    } else if (line.startsWith('// unknown recipe type for ')) {
      dump.unknownRecipes.push(line.slice('// unknown recipe type for '.length));
    } else if (line.startsWith('furnace.addRecipe(')) {
      try {
        dump.furnace.push(parseFurnaceLine(line));
      } catch {
        dump.unparsed.push(line);
      }
    } else if (line.startsWith('Mod: ')) {
      const parts = line.slice(5).split(' - ');
      if (parts.length >= 3) dump.mods.set(parts[0] ?? '', parts[parts.length - 1] ?? '');
    } else {
      const m = nameLine.exec(line);
      if (m?.[1] !== undefined && !m[1].startsWith('ore:')) dump.names.set(m[1], m[2] ?? '');
    }
  }
  return dump;
}
