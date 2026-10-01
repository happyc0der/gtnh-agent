/**
 * The vanilla Minecraft 1.7.10 base layer of the knowledge base.
 *
 * Two sources:
 *  - minecraft-data 3.117.0 (PrismarineJS, MIT licence; installed with mineflayer under
 *    node_modules/minecraft-data, data/pc/1.7): items (stack size, durability), blocks
 *    (hardness, material, which tools harvest them), foods, tool speeds per material,
 *    entities, biomes, enchantments and effects. Its 1.7 block drops are empty and its stone
 *    lists 1.8's granite and friends, so drops and recipes come from the jar instead.
 *  - the 1.7.10 server jar (minecraft_server.1.7.10.jar in the test server folder), read with
 *    scripts/knowledge/jvm.ts: crafting recipes with output counts (CraftingManager and its
 *    recipe helper classes), furnace recipes (FurnaceRecipes), tool materials
 *    (Item.ToolMaterial), the vanilla tools and their materials (Item.registerItems) and ore
 *    generation (BiomeDecorator). The jar is obfuscated: its classes are found by what they
 *    contain (registry names, method shapes), never by hard-coded names.
 */
import {
  chainRoot,
  execute,
  intConstants,
  interpret,
  parseClass,
  type ClassFile,
  type Jar,
  type Value,
} from './jvm.ts';
import type { VanillaLayer, VanillaRecipe } from '../../src/goals/knowledge.ts';

type Json = Record<string, unknown>;

/** The minecraft-data part (pass the parsed JSON files of data/pc/1.7). */
export function readMinecraftData(files: {
  items: Json[];
  blocks: Json[];
  foods: Json[];
  materials: Record<string, Record<string, number>>;
  entities: Json[];
  biomes: Json[];
  enchantments: Json[];
  effects: Json[];
}): Omit<VanillaLayer, 'toolMaterials' | 'tools' | 'crafting' | 'smelting' | 'oreGen'> {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const itemById = new Map<number, string>();
  for (const i of files.items) {
    const id = num(i['id']);
    if (id !== null) itemById.set(id, `minecraft:${str(i['name'])}`);
  }
  const items: VanillaLayer['items'] = {};
  for (const i of files.items) {
    const durability = num(i['maxDurability']);
    items[`minecraft:${str(i['name'])}`] = {
      name: str(i['displayName']),
      stack: num(i['stackSize']) ?? 64,
      ...(durability === null ? {} : { durability }),
    };
  }
  const blocks: VanillaLayer['blocks'] = {};
  for (const b of files.blocks) {
    const tools = Object.keys((b['harvestTools'] as Json | undefined) ?? {})
      .map((id) => itemById.get(Number(id)) ?? `#${id}`)
      .sort();
    blocks[`minecraft:${str(b['name'])}`] = {
      name: str(b['displayName']),
      hardness: num(b['hardness']),
      material: str(b['material']) || null,
      tools,
      diggable: b['diggable'] === true,
    };
  }
  const foods: VanillaLayer['foods'] = {};
  for (const f of files.foods) {
    foods[`minecraft:${str(f['name'])}`] = {
      food: num(f['foodPoints']) ?? 0,
      saturation: num(f['saturation']) ?? 0,
    };
  }
  const toolSpeeds: VanillaLayer['toolSpeeds'] = {};
  for (const [material, speeds] of Object.entries(files.materials)) {
    toolSpeeds[material] = Object.fromEntries(
      Object.entries(speeds).map(([id, s]) => [itemById.get(Number(id)) ?? `#${id}`, s]),
    );
  }
  return {
    version: '1.7.10',
    items,
    blocks,
    foods,
    toolSpeeds,
    entities: files.entities.map((e) => ({
      name: str(e['name']),
      displayName: str(e['displayName']),
      type: str(e['type']),
      category: str(e['category']) || null,
    })),
    biomes: files.biomes.map((b) => ({
      name: str(b['name']),
      category: str(b['category']),
      temperature: num(b['temperature']) ?? 0,
      rainfall: num(b['rainfall']) ?? 0,
    })),
    enchantments: files.enchantments.map((e) => ({
      name: str(e['name']),
      maxLevel: num(e['maxLevel']) ?? 1,
    })),
    effects: files.effects.map((e) => ({ name: str(e['name']), type: str(e['type']) })),
  };
}

/** Natural blocks whose vanilla drop method is read (for the vanilla-vs-GTNH comparison). */
const DROP_BLOCKS = [
  'minecraft:stone',
  'minecraft:grass',
  'minecraft:gravel',
  'minecraft:clay',
  'minecraft:tallgrass',
  'minecraft:coal_ore',
  'minecraft:diamond_ore',
  'minecraft:redstone_ore',
  'minecraft:glowstone',
] as const;

/** A block's vanilla getItemDropped: the items it can return, and whether chance decides. */
export type VanillaDrops = Record<
  string,
  { items: string[]; random: boolean; ints: number[]; cls: string }
>;

/** The jar part: recipes, smelting, tool materials and tools, ore generation, drops. */
export function readServerJar(jar: Jar): Pick<
  VanillaLayer,
  'toolMaterials' | 'tools' | 'crafting' | 'smelting' | 'oreGen'
> & {
  drops: VanillaDrops;
  classes: Record<string, string>;
} {
  const cache = new Map<string, ClassFile | null>();
  const load = (name: string): ClassFile | null => {
    if (!cache.has(name)) {
      const buf = jar.read(`${name}.class`);
      cache.set(name, buf === null ? null : parseClass(buf));
    }
    return cache.get(name) ?? null;
  };
  const top = jar
    .names()
    .filter((n) => n.endsWith('.class') && !n.includes('/'))
    .map((n) => n.slice(0, -'.class'.length));
  const find = (what: string, test: (c: ClassFile) => boolean): ClassFile => {
    const hits = top.flatMap((n) => {
      const c = load(n);
      return c !== null && test(c) ? [c] : [];
    });
    if (hits.length !== 1) throw new Error(`server jar: ${hits.length} classes look like ${what}`);
    return hits[0] as ClassFile;
  };
  const has = (c: ClassFile, ...s: string[]): boolean => {
    const all = new Set(c.strings());
    return s.every((x) => all.has(x));
  };
  const onlyClinit = (c: ClassFile): boolean => c.methods.every((m) => m.name === '<clinit>');

  // Items and Blocks: their static initializers look every field up by registry name.
  const itemsCls = find('Items', (c) => onlyClinit(c) && has(c, 'iron_shovel', 'stick'));
  const blocksCls = find('Blocks', (c) => onlyClinit(c) && has(c, 'stone', 'bedrock'));
  const fieldNames = new Map<string, string>();
  for (const cls of [itemsCls, blocksCls]) {
    for (const p of interpret(cls, '<clinit>').puts) {
      if (p.value.t === 'call' && p.value.args[0]?.t === 'str') {
        fieldNames.set(`${cls.name}.${p.name}`, `minecraft:${p.value.args[0].v}`);
      }
    }
  }
  const toolMaterialCls = find('Item.ToolMaterial', (c) =>
    has(c, 'WOOD', 'STONE', 'IRON', 'EMERALD', 'GOLD'),
  );
  const craftingCls = find(
    'CraftingManager',
    (c) =>
      has(c, '###') &&
      c.methods.some((m) => /^\(L\w+;\[Ljava\/lang\/Object;\)V$/.test(m.desc)) &&
      c.methods.some((m) => m.name === '<clinit>'),
  );
  const stackCls = /^\(L(\w+);/.exec(
    craftingCls.methods.find((m) => /^\(L\w+;\[Ljava\/lang\/Object;\)V$/.test(m.desc))?.desc ?? '',
  )?.[1];
  if (stackCls === undefined) throw new Error('server jar: no ItemStack class');
  const itemCls = find(
    'Item',
    (c) => !onlyClinit(c) && has(c, 'iron_shovel', 'golden_apple') && c.name !== itemsCls.name,
  );
  const furnaceCls = find(
    'FurnaceRecipes',
    (c) =>
      c.methods.some((m) => new RegExp(`^\\(L\\w+;L${stackCls};F\\)V$`).test(m.desc)) &&
      c.methods.filter((m) => /;F\)V$/.test(m.desc)).length >= 3,
  );

  // Tool materials: new ToolMaterial(name, ordinal, harvestLevel, uses, efficiency, damage,
  // enchantability).
  const toolMaterials: VanillaLayer['toolMaterials'] = {};
  const materialOfField = new Map<string, string>();
  for (const p of interpret(toolMaterialCls, '<clinit>').puts) {
    const v = p.value;
    if (v.t !== 'new' || v.cls !== toolMaterialCls.name || v.args === null) continue;
    const [name, , level, uses, efficiency, damage, enchant] = v.args;
    if (name?.t !== 'str') continue;
    materialOfField.set(p.name, name.v);
    const n = (x: Value | undefined): number => (x?.t === 'int' || x?.t === 'float' ? x.v : 0);
    toolMaterials[name.v] = {
      level: n(level),
      uses: n(uses),
      efficiency: Number(n(efficiency).toFixed(3)),
      damage: Number(n(damage).toFixed(3)),
      enchantability: n(enchant),
    };
  }

  // Tools: Item.registerItems adds each item under its registry name; a tool's constructor
  // takes its ToolMaterial.
  const tools: VanillaLayer['tools'] = [];
  const registerItems = itemCls.methods.find(
    (m) =>
      m.code !== null &&
      m.name !== '<clinit>' &&
      m.desc === '()V' &&
      interpret(itemCls, m).calls.some((c) =>
        c.args.some((a) => a.t === 'str' && a.v === 'iron_shovel'),
      ),
  );
  if (registerItems === undefined) throw new Error('server jar: no Item.registerItems');
  for (const call of interpret(itemCls, registerItems).calls) {
    const name = call.args.find((a) => a.t === 'str');
    const obj = call.args[call.args.length - 1];
    if (name?.t !== 'str' || obj === undefined) continue;
    const root = chainRoot(obj);
    const mat = root.t === 'new' ? root.args?.[0] : undefined;
    if (mat?.t !== 'static' || mat.owner !== toolMaterialCls.name) continue;
    const kind = /_(pickaxe|shovel|axe|sword|hoe)$/.exec(name.v)?.[1];
    const material = materialOfField.get(mat.name);
    if (kind !== undefined && material !== undefined) {
      tools.push({ item: `minecraft:${name.v}`, kind, material });
    }
  }

  // Item references in recipes.
  type Ref = { item: string; damage: number | null; count: number };
  const named = (v: Value | undefined): string | null => {
    if (v?.t === 'static') return fieldNames.get(`${v.owner}.${v.name}`) ?? null;
    // Item.getItemFromBlock(block): the block's item has the block's name.
    if (v?.t === 'call' && v.owner === itemCls.name && v.args.length === 1) return named(v.args[0]);
    return null;
  };
  const isBlock = (v: Value | undefined): boolean =>
    v?.t === 'static' && v.owner === blocksCls.name;
  /** An ingredient or output: an Item, a Block or an ItemStack. Blocks match any damage. */
  const ref = (v: Value | undefined, blockIsAny: boolean): Ref | null => {
    if (v?.t === 'new' && v.cls === stackCls) {
      const [what, count, meta] = v.args ?? [];
      const item = named(what);
      if (item === null) return null;
      const d = meta?.t === 'int' ? meta.v : 0;
      return { item, damage: d === 32767 ? null : d, count: count?.t === 'int' ? count.v : 1 };
    }
    const item = named(v);
    if (item === null) return null;
    return { item, damage: blockIsAny && isBlock(v) ? null : 0, count: 1 };
  };
  const crafting: VanillaRecipe[] = [];
  const unread: string[] = [];
  const record = (calls: ReturnType<typeof interpret>['calls'], from: string): void => {
    for (const c of calls) {
      if (
        c.owner !== craftingCls.name ||
        !c.desc.startsWith(`(L${stackCls};[Ljava/lang/Object;)`)
      ) {
        continue;
      }
      const shaped = !c.desc.endsWith(')V');
      const out = ref(c.args[0], false);
      const arr = c.args[1];
      if (out === null || arr?.t !== 'array') {
        unread.push(from);
        continue;
      }
      const recipe = shaped ? shapedRecipe(arr.items) : shapelessRecipe(arr.items);
      if (recipe === null) {
        unread.push(`${from}: ${out.item}`);
        continue;
      }
      crafting.push({
        output: out.damage === null || out.damage === 0 ? out.item : `${out.item}@${out.damage}`,
        count: out.count,
        shaped,
        rows: recipe.rows,
        inputs: recipe.inputs,
        from,
      });
    }
  };
  const shapedRecipe = (
    items: Value[],
  ): { rows: string[]; inputs: VanillaRecipe['inputs'] } | null => {
    const rows: string[] = [];
    let i = 0;
    for (; i < items.length; i++) {
      const v = items[i];
      if (v?.t === 'str') rows.push(v.v);
      else if (v?.t === 'array' && v.items.every((x) => x.t === 'str')) {
        for (const x of v.items) if (x.t === 'str') rows.push(x.v);
      } else break;
    }
    const key = new Map<string, Ref>();
    for (; i + 1 < items.length; i += 2) {
      const ch = items[i];
      const code =
        ch?.t === 'call' && ch.name === 'valueOf' && ch.args[0]?.t === 'int' ? ch.args[0].v : null;
      const r = ref(items[i + 1], true);
      if (code === null || r === null) return null;
      key.set(String.fromCharCode(code), r);
    }
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const ch of row) {
        if (ch === ' ') continue;
        if (!key.has(ch)) return null;
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    return {
      rows,
      inputs: [...counts].map(([ch, count]) => {
        const r = key.get(ch) as Ref;
        return { item: r.item, damage: r.damage, count };
      }),
    };
  };
  const shapelessRecipe = (
    items: Value[],
  ): { rows: null; inputs: VanillaRecipe['inputs'] } | null => {
    const counts = new Map<string, { item: string; damage: number | null; count: number }>();
    for (const v of items) {
      const r = ref(v, false);
      if (r === null) return null;
      const k = `${r.item}@${String(r.damage)}`;
      const cur = counts.get(k);
      if (cur === undefined) counts.set(k, { item: r.item, damage: r.damage, count: 1 });
      else cur.count++;
    }
    return { rows: null, inputs: [...counts.values()] };
  };
  const pure = (owner: string): boolean => owner !== craftingCls.name;
  // CraftingManager's own recipes, then each helper class (constructed, then run).
  const init = craftingCls.methods.find((m) => m.name === '<init>');
  if (init === undefined) throw new Error('server jar: CraftingManager has no constructor');
  record(interpret(craftingCls, init).calls, 'CraftingManager');
  const helpers = top.filter((n) => {
    const c = load(n);
    return (
      c !== null &&
      c.methods.some((m) => m.desc === `(L${craftingCls.name};)V`) &&
      c.methods.some((m) => m.name === '<init>' && m.desc === '()V')
    );
  });
  for (const n of helpers) {
    const c = load(n) as ClassFile;
    const self: Value = { t: 'new', cls: n, args: [], fields: new Map() };
    const opts = { load, pure };
    const ctor = c.methods.find((m) => m.name === '<init>' && m.desc === '()V');
    const add = c.methods.find((m) => m.desc === `(L${craftingCls.name};)V`);
    if (ctor === undefined || add === undefined) continue;
    execute(c, ctor, self, [], opts);
    record(execute(c, add, self, [{ t: 'unknown' }], opts).trace.calls, `recipe class ${n}`);
  }

  // Furnace: smelting(Block|Item|ItemStack input, ItemStack output, float xp); Block and Item
  // inputs match any damage.
  const smelting: VanillaLayer['smelting'] = [];
  const furnaceInit = furnaceCls.methods.find((m) => m.name === '<init>');
  if (furnaceInit !== undefined) {
    const self: Value = { t: 'new', cls: furnaceCls.name, args: [], fields: new Map() };
    for (const c of execute(furnaceCls, furnaceInit, self, [], { load, pure }).trace.calls) {
      if (c.owner !== furnaceCls.name || c.args.length !== 3 || !c.desc.endsWith('F)V')) continue;
      const input =
        c.args[0]?.t === 'new'
          ? ref(c.args[0], false)
          : ((): Ref | null => {
              const r = ref(c.args[0], false);
              return r === null ? null : { ...r, damage: null };
            })();
      const output = ref(c.args[1], false);
      const xp = c.args[2]?.t === 'float' ? c.args[2].v : 0;
      if (input === null || output === null) continue;
      smelting.push({
        input:
          input.damage === null || input.damage === 0
            ? input.item
            : `${input.item}@${input.damage}`,
        inputAnyDamage: input.damage === null,
        output:
          output.damage === null || output.damage === 0
            ? output.item
            : `${output.item}@${output.damage}`,
        count: output.count,
        xp: Number(xp.toFixed(2)),
      });
    }
  }

  // Ore generation: BiomeDecorator's constructor makes a WorldGenMinable(block, vein size) per
  // ore; its ore method calls genStandardOre1(count, generator, minY, maxY) (uniform) and
  // genStandardOre2(count, generator, centre, spread).
  const oreGen: VanillaLayer['oreGen'] = [];
  for (const n of top) {
    const c = load(n);
    const ctor = c?.methods.find((m) => m.name === '<init>' && m.desc === '()V');
    // Only classes that name the Blocks class can make block generators.
    if (
      c == null ||
      ctor === undefined ||
      jar.read(`${n}.class`)?.includes(blocksCls.name) !== true
    ) {
      continue;
    }
    const self: Value = { t: 'new', cls: n, args: [], fields: new Map() };
    execute(c, ctor, self, [], { load, budget: { left: 20_000 } });
    const gens = [...(self.fields ?? new Map<string, Value>()).values()].filter(
      (v) => v.t === 'new' && (named(v.args?.[0]) ?? '').endsWith('_ore'),
    );
    if (gens.length < 3) continue;
    for (const m of c.methods) {
      if (m.code === null || m.name === '<init>' || m.desc !== '()V') continue;
      const calls = execute(c, m, self, [], { load, budget: { left: 50_000 } }).trace.calls;
      const ores = calls.filter(
        (k) => k.owner === n && k.args.length === 4 && k.args[1]?.t === 'new',
      );
      if (ores.length < 3) continue;
      const methods = [...new Set(ores.map((k) => k.name + k.desc))];
      for (const k of ores) {
        const gen = k.args[1];
        const block = gen?.t === 'new' ? named(gen.args?.[0]) : null;
        const size = gen?.t === 'new' && gen.args?.[1]?.t === 'int' ? gen.args[1].v : null;
        const [count, a, , b] = [k.args[0], k.args[2], undefined, k.args[3]];
        if (
          block === null ||
          size === null ||
          count?.t !== 'int' ||
          a?.t !== 'int' ||
          b?.t !== 'int'
        )
          continue;
        const centred = methods.indexOf(k.name + k.desc) === 1;
        oreGen.push({
          block,
          veinSize: size,
          perChunk: count.v,
          minY: centred ? a.v - b.v : a.v,
          maxY: centred ? a.v + b.v : b.v,
          how: centred ? 'centred' : 'uniform',
        });
      }
    }
    if (oreGen.length > 0) break;
  }

  // What a few natural blocks drop: Block.registerBlocks names each block's class; the class's
  // getItemDropped(meta, random, fortune) shows the items it can return.
  const blockCls = find(
    'Block',
    (c) => !onlyClinit(c) && has(c, 'stone', 'gravel', 'bedrock') && c.name !== blocksCls.name,
  );
  const registerBlocks = blockCls.methods.find(
    (m) =>
      m.code !== null &&
      m.desc === '()V' &&
      m.name !== '<clinit>' &&
      interpret(blockCls, m).calls.some((c) =>
        c.args.some((a) => a.t === 'str' && a.v === 'gravel'),
      ),
  );
  const blockClass = new Map<string, string>();
  if (registerBlocks !== undefined) {
    for (const call of interpret(blockCls, registerBlocks).calls) {
      const name = call.args.find((a) => a.t === 'str');
      const obj = call.args[call.args.length - 1];
      const root = obj === undefined ? null : chainRoot(obj);
      if (name?.t === 'str' && root?.t === 'new') blockClass.set(`minecraft:${name.v}`, root.cls);
    }
  }
  const dropDesc = `(ILjava/util/Random;I)L${itemCls.name};`;
  const drops: VanillaDrops = {};
  for (const block of DROP_BLOCKS) {
    const c = load(blockClass.get(block) ?? '');
    const m = c?.methods.find((x) => x.desc === dropDesc);
    if (c == null || m?.code == null) continue;
    const t = interpret(c, m);
    const items = new Set<string>();
    for (const k of t.calls)
      for (const a of k.args) if (named(a) !== null) items.add(named(a) as string);
    // Direct "getstatic Items.X; areturn" returns: scan the bytes for getstatic of Items.
    const code = m.code;
    for (let i = 0; i + 3 < code.length; i++) {
      if (code[i] !== 0xb2 || code[i + 3] !== 0xb0) continue;
      try {
        const r = c.ref(code.readUInt16BE(i + 1));
        const n = fieldNames.get(`${r.owner}.${r.name}`);
        if (n !== undefined && r.owner === itemsCls.name) items.add(n);
      } catch {
        // not an instruction boundary
      }
    }
    const usesThis = t.calls.some((k) => k.owner === itemCls.name && k.args[0]?.t === 'unknown');
    if (usesThis) items.add(block);
    drops[block] = {
      items: [...items].sort(),
      random: t.calls.some((k) => k.owner === 'java/util/Random'),
      ints: [...new Set(intConstants(code))],
      cls: c.name,
    };
  }

  return {
    toolMaterials,
    tools,
    crafting,
    smelting,
    oreGen,
    drops,
    classes: {
      items: itemsCls.name,
      blocks: blocksCls.name,
      item: itemCls.name,
      itemStack: stackCls,
      toolMaterial: toolMaterialCls.name,
      craftingManager: craftingCls.name,
      furnaceRecipes: furnaceCls.name,
      recipeHelpers: helpers.join(' '),
      unreadRecipes: String(unread.length),
    },
  };
}
