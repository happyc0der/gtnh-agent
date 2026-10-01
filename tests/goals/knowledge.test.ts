import { describe, expect, it } from 'vitest';
import { ItemNameSchema } from '../../src/domain/common.ts';
import {
  CraftFlag,
  ingredientItems,
  loadKnowledge,
  type CraftingRow,
  type GtnhChange,
  type KnowledgeData,
} from '../../src/goals/knowledge.ts';

const data: KnowledgeData = loadKnowledge();
const index = new Map(data.items.map((name, i) => [name, i]));
const id = (name: string): number => {
  const i = index.get(name);
  if (i === undefined) throw new Error(`${name} is not in the knowledge base`);
  return i;
};
/** A recipe as readable inputs: "2 ore:logWood", "1 minecraft:flint", ... */
const inputsOf = (row: CraftingRow): string[] => {
  const out: string[] = [];
  for (let k = 0; k + 1 < row[4].length; k += 2) {
    const ref = row[4][k];
    const label =
      typeof ref === 'string' ? `ore:${ref}` : ingredientItems(data, ref ?? -1).join('|');
    out.push(`${String(row[4][k + 1])} ${label}`);
  }
  return out.sort();
};
const recipesFor = (item: string): CraftingRow[] => data.crafting.filter((r) => r[0] === id(item));

describe('the GTNH knowledge base (generated from the test server)', { timeout: 30_000 }, () => {
  it('loads, says where it came from, and has plausible sizes', () => {
    expect(data.pack).toBe('GTNH 2.8.4');
    const sources = data.sources.map((s) => s.name);
    expect(sources).toContain('minetweaker.log');
    expect(sources.some((s) => /^mods\/gregtech-5\.09\.51\.482\.jar$/.test(s))).toBe(true);
    expect(sources.some((s) => s.startsWith('mods/GTNewHorizonsCoreMod-'))).toBe(true);
    expect(sources).toContain('config/GregTech/WorldGeneration.cfg');
    expect(sources).toContain('config/IguanaTinkerTweaks/BlockDefaults.cfg');
    for (const s of data.sources) expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.crafting.length).toBeGreaterThan(40_000);
    expect(data.furnace.length).toBeGreaterThan(5_000);
    expect(data.veins.length).toBeGreaterThanOrEqual(70);
    expect(data.smallOres.length).toBeGreaterThanOrEqual(50);
    expect(Object.keys(data.ores).length).toBeGreaterThan(10_000);
    expect(data.notes.join(' ')).toMatch(/output counts are not in the CraftTweaker dump/);
  });

  it('names every item the way the inventory does, once', () => {
    expect(new Set(data.items).size).toBe(data.items.length);
    const bad = data.items.filter((n) => !ItemNameSchema.safeParse(n).success);
    expect(bad).toEqual([]);
    // Damage 0 is never written out ("minecraft:log", not "minecraft:log@0").
    expect(data.items.filter((n) => n.endsWith('@0'))).toEqual([]);
    expect(data.items).toContain('minecraft:log@2');
    expect(data.items).toContain('gregtech:gt.metaitem.01@17032');
  });

  it('keeps every crafting row consistent: indices, counts, pattern letters', () => {
    const inRange = (i: unknown): boolean =>
      typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < data.items.length;
    // Problems are collected and checked once (tens of thousands of rows).
    const problems: string[] = [];
    const check = (ok: boolean, row: number, what: string): void => {
      if (!ok && problems.length < 20) problems.push(`row ${row}: ${what}`);
    };
    data.crafting.forEach((row, r) => {
      const [out, count, flags, pattern, inputs] = row;
      check(inRange(out), r, 'output index');
      check(count >= 0 && count <= 64, r, `count ${count}`);
      check(flags >= 0 && flags < 32, r, `flags ${flags}`);
      check(inputs.length % 2 === 0, r, 'inputs are not pairs');
      let total = 0;
      for (let k = 0; k < inputs.length; k += 2) {
        const ref = inputs[k];
        const n = inputs[k + 1] as number;
        check(n >= 1 && n <= 9, r, `input count ${n}`);
        total += n;
        if (typeof ref === 'string') check((data.ores[ref]?.length ?? 0) > 0, r, `ore ${ref}`);
        else if (typeof ref === 'number') check(inRange(ref), r, 'input index');
        else check(Array.isArray(ref) && ref.length > 0 && ref.every(inRange), r, 'input list');
      }
      check(total <= 9, r, `${total} items per craft`);
      if ((flags & CraftFlag.SHAPELESS) === 0) {
        const letters = pattern.replace(/[./]/g, '');
        check(letters.length === total, r, 'pattern cells != input counts');
        check(new Set(letters).size === inputs.length / 2, r, 'pattern letters != inputs');
      } else {
        check(pattern === '', r, 'shapeless with a pattern');
        check((flags & CraftFlag.FITS_2X2) === 0 || total <= 4, r, 'shapeless 2x2 with >4 items');
      }
    });
    data.furnace.forEach(([i, o], r) => check(inRange(i) && inRange(o), r, 'furnace index'));
    expect(problems).toEqual([]);
  });

  it("has GTNH's own early recipes, with the counts the coremod scripts give", () => {
    // Crafting table: 2 flint over 2 logs, in the player's own grid (GTNH removes vanilla's).
    expect(
      recipesFor('minecraft:crafting_table').map((r) => [
        r[1],
        r[2] & CraftFlag.FITS_2X2,
        inputsOf(r),
      ]),
    ).toContainEqual([1, CraftFlag.FITS_2X2, ['2 minecraft:flint', '2 ore:logWood']]);
    // Torches: 3 from coal, 2 from charcoal (counts read from GTNewHorizonsCoreMod's script).
    const torches = recipesFor('minecraft:torch').map((r) => [r[1], inputsOf(r)]);
    expect(torches).toContainEqual([3, ['1 ore:gemCoal', '1 ore:stickWood']]);
    expect(torches).toContainEqual([2, ['1 ore:gemCharcoal', '1 ore:stickWood']]);
    expect(recipesFor('minecraft:chest').map((r) => [r[1], inputsOf(r)])).toContainEqual([
      1,
      ['1 minecraft:flint', '4 ore:logWood', '4 ore:plankWood'],
    ]);
    expect(recipesFor('minecraft:furnace').map((r) => [r[1], inputsOf(r)])).toContainEqual([
      1,
      ['3 minecraft:flint', '6 ore:cobblestone'],
    ]);
    // GTNH's iron pickaxe: a plate and two ingots, a file and a hammer (tools), two sticks.
    expect(recipesFor('minecraft:iron_pickaxe').map(inputsOf)).toContainEqual([
      '1 ore:craftingToolFile',
      '1 ore:craftingToolHardHammer',
      '1 ore:plateIron',
      '2 ore:ingotIron',
      '2 ore:stickWood',
    ]);
    // GT's flint mortar (its material is NBT: the label keeps it).
    const mortar = recipesFor('gregtech:gt.metatool.01@24').find((r) => r[5] === 'Flint');
    expect(mortar === undefined ? null : inputsOf(mortar)).toEqual([
      '2 minecraft:flint',
      '5 ore:stone',
    ]);
    // Planks from a log: the dump has no count (GT's nerf makes it 2: hand-verified instead).
    expect(
      recipesFor('minecraft:planks').some(
        (r) => (r[2] & CraftFlag.SHAPELESS) !== 0 && inputsOf(r).join() === '1 minecraft:log',
      ),
    ).toBe(true);
  });

  it('has the furnace recipes for raw ores and stone', () => {
    const smelt = (from: string): string[] =>
      data.furnace.filter(([i]) => i === id(from)).map(([, o]) => data.items[o] ?? '?');
    expect(smelt('gregtech:gt.metaitem.03@5500')).toEqual(['minecraft:diamond']);
    expect(smelt('gregtech:gt.metaitem.03@5032')).toEqual(['minecraft:iron_ingot']);
    expect(smelt('minecraft:cobblestone')).toEqual(['minecraft:stone']);
  });

  it('knows where GT ores generate, what they drop and what they need', () => {
    const diamond = data.veins.find((v) => v.key === 'Diamond');
    expect(diamond).toMatchObject({
      name: 'ore.mix.diamond',
      minY: 5,
      maxY: 20,
      between: {
        material: 'Diamond',
        block: 'gregtech:gt.blockores@500',
        drop: 'gregtech:gt.metaitem.03@5500',
        level: 4,
      },
    });
    expect(diamond?.dims).toContain('Overworld');
    expect(data.veins.find((v) => v.key === 'Iron')).toMatchObject({
      minY: 10,
      maxY: 40,
      primary: { material: 'BrownLimonite', level: 1 },
    });
    const small = data.smallOres.find((s) => s.key === 'Diamond');
    expect(small).toMatchObject({
      block: 'gregtech:gt.blockores@16500',
      minY: 5,
      maxY: 15,
      level: 3,
    });
    // 12 of the 45 weighted small-ore drops are a plain diamond.
    expect(small?.drops.find(([i]) => i === 'minecraft:diamond')?.[1]).toBeCloseTo(12 / 45, 3);
    // Every vein ore names a block and a drop that are known items.
    for (const v of data.veins) {
      for (const o of [v.primary, v.secondary, v.between, v.sporadic]) {
        if (o?.block != null) expect(index.has(o.block)).toBe(true);
        if (o?.drop != null) expect(index.has(o.drop)).toBe(true);
      }
    }
  });

  it('knows harvest levels and tool levels, and the server switches they depend on', () => {
    expect(data.harvest['minecraft:stone']).toEqual(['pickaxe', 0]);
    expect(data.harvest['minecraft:obsidian']).toEqual(['pickaxe', 5]);
    const tool = (item: string): number | undefined =>
      data.tools.find(([i, k]) => i === item && k === 'pickaxe')?.[2];
    expect(tool('minecraft:wooden_pickaxe')).toBe(0);
    expect(tool('minecraft:iron_pickaxe')).toBe(3);
    expect(tool('minecraft:diamond_pickaxe')).toBe(5);
    expect(tool('TConstruct:pickaxe')).toBe(-1);
    expect(data.ticLevels['bronze']).toBe(4);
    expect(data.levelNames.slice(0, 5)).toEqual(['Stone', 'Copper', 'Iron', 'Bronze', 'Steel']);
    expect(data.config).toMatchObject({
      disableVanillaOres: true,
      oreDropBehavior: 'FortuneItem',
      activateHarvestLevelChange: false,
      nerfedWoodPlank: true,
    });
    expect(data.materials['Diamond']).toEqual([500, 4, 1, 'Diamond']);
  });

  it('knows which tools IguanaTweaks disables: listed ItemTools only', () => {
    // Vanilla stone, iron, gold and diamond pickaxes and shovels are listed: they mine nothing.
    for (const t of [
      'minecraft:iron_pickaxe',
      'minecraft:diamond_pickaxe',
      'minecraft:stone_shovel',
    ]) {
      expect(data.disabledTools[t]).toMatch(/disableRegularTools/);
    }
    // Wooden tools and every vanilla axe are not listed.
    for (const t of ['minecraft:wooden_pickaxe', 'minecraft:wooden_shovel', 'minecraft:iron_axe']) {
      expect(data.disabledTools[t]).toBeUndefined();
    }
    // GregTech's tools are listed too, but are not ItemTools, so they keep working.
    expect(data.disabledTools['gregtech:gt.metatool.01']).toBeUndefined();
    expect(data.notes.join(' ')).toMatch(/gt\.metatool\.01: listed, but .* not ItemTool/);
    // No vanilla sword is listed: vanilla swords keep their damage here.
    expect(Object.keys(data.disabledSwords).filter((s) => s.startsWith('minecraft:'))).toEqual([]);
  });

  it('says where each crafting count comes from', () => {
    const counts = (item: string): Array<[number, string, string]> =>
      recipesFor(item).map((r) => [r[1], r[6], inputsOf(r).join(', ')]);
    // GT's nerfed planks: 2 from a log (hand-verified), 4 with a saw (GregTech's code).
    expect(counts('minecraft:planks')).toEqual(
      expect.arrayContaining([
        [2, 'hand', '1 minecraft:log'],
        [4, 'gt', '1 minecraft:log, 1 ore:craftingToolSaw'],
      ]),
    );
    expect(counts('minecraft:stick')).toContainEqual([
      4,
      'gt',
      '1 ore:craftingToolSaw, 2 ore:plankWood',
    ]);
    // Torches: GTNewHorizonsCoreMod's script (and the agent's own table) say 3 per coal.
    expect(
      counts('minecraft:torch').find(([, , i]) => i === '1 ore:gemCoal, 1 ore:stickWood'),
    ).toEqual([3, 'hand', '1 ore:gemCoal, 1 ore:stickWood']);
    // Vanilla's own recipe kept by GTNH: vanilla's count, marked as such.
    expect(counts('minecraft:oak_stairs')).toContainEqual([4, 'vanilla', '6 minecraft:planks']);
    const sources = new Set(['', 'hand', 'script', 'gt', 'vanilla']);
    const bad = data.crafting.filter((r) => !sources.has(r[6]) || (r[6] === '') !== (r[1] === 0));
    expect(bad.length).toBe(0);
  });

  it('holds vanilla 1.7.10 as the base layer, from the server jar and minecraft-data', () => {
    const v = data.vanilla;
    expect(v.version).toBe('1.7.10');
    const sources = data.sources.map((s) => s.name);
    expect(sources).toContain('minecraft_server.1.7.10.jar');
    expect(sources).toContain('node_modules/minecraft-data/minecraft-data/data/pc/1.7/items.json');
    // Recipes with their counts (the jar), e.g. 1 log -> 4 planks, coal over a stick -> 4 torches.
    expect(v.crafting.length).toBeGreaterThan(300);
    expect(v.crafting).toContainEqual(
      expect.objectContaining({
        output: 'minecraft:planks',
        count: 4,
        inputs: [{ item: 'minecraft:log', damage: 0, count: 1 }],
      }),
    );
    expect(v.crafting.filter((r) => r.output === 'minecraft:torch').map((r) => r.count)).toEqual([
      4, 4,
    ]);
    // Smelting, including what GTNH removes (logs -> charcoal).
    expect(v.smelting).toContainEqual(
      expect.objectContaining({ input: 'minecraft:log', output: 'minecraft:coal@1' }),
    );
    // Tool materials and tools, ore generation.
    expect(v.toolMaterials['IRON']).toMatchObject({ level: 2, uses: 250 });
    expect(v.toolMaterials['WOOD']).toMatchObject({ level: 0, uses: 59 });
    expect(v.tools).toContainEqual({
      item: 'minecraft:iron_pickaxe',
      kind: 'pickaxe',
      material: 'IRON',
    });
    expect(v.oreGen).toContainEqual({
      block: 'minecraft:diamond_ore',
      veinSize: 7,
      perChunk: 1,
      minY: 0,
      maxY: 16,
      how: 'uniform',
    });
    // minecraft-data: items, blocks (hardness, harvest tools), foods, mobs, biomes.
    expect(v.items['minecraft:iron_pickaxe']).toEqual({
      name: 'Iron Pickaxe',
      stack: 1,
      durability: 250,
    });
    expect(v.blocks['minecraft:diamond_ore']?.tools).toEqual([
      'minecraft:diamond_pickaxe',
      'minecraft:iron_pickaxe',
    ]);
    expect(v.foods['minecraft:bread']).toEqual({ food: 5, saturation: 6 });
    expect(v.entities.map((e) => e.name)).toContain('Creeper');
    expect(v.biomes.length).toBeGreaterThan(30);
  });

  it('lists what GTNH changes from vanilla, each side with its source', () => {
    const change = (id: string): GtnhChange | undefined => data.changes.find((c) => c.id === id);
    for (const c of data.changes) {
      expect(c.vanilla.source).not.toBe('');
      expect(c.gtnh.source).not.toBe('');
      expect(c.change.length).toBeLessThanOrEqual(300);
      expect(c.keys.length).toBeGreaterThan(0);
    }
    const gravel = change('drop:minecraft:gravel');
    expect(gravel?.vanilla.value).toMatch(/^drops flint 1 time in 10/);
    expect(gravel?.change).toBe(
      'Gravel never drops flint; craft flint from 3 gravel (shapeless, 2x2)',
    );
    expect(change('smelting:minecraft:log')?.change).toBe(
      'Smelting Wood: a furnace no longer makes coal@1 (charcoal) from log',
    );
    expect(change('recipe:minecraft:planks#1')?.change).toBe(
      'Wooden Planks: the same ingredients make 2, not 4 (4 with a saw in the grid)',
    );
    expect(change('recipe:minecraft:torch#1')?.change).toBe(
      'Torch: the same ingredients make 3, not 4',
    );
    expect(change('recipe:minecraft:crafting_table#1')?.change).toMatch(
      /vanilla's recipe \(4 planks -> 1\) is not in GTNH; GTNH's: 2 flint \+ 2 ore:logWood -> 1$/,
    );
    expect(change('recipe:minecraft:furnace#1')?.gtnh.value).toMatch(
      /^6 ore:cobblestone \+ 3 flint/,
    );
    expect(change('tool:vanilla-disabled')?.change).toMatch(/iron_pickaxe.* mine nothing/);
    expect(change('tool:vanilla-swords')).toBeUndefined();
    expect(change('tool:wooden-durability')?.change).toBe('Wooden tools last 64 uses, not 59');
    expect(change('ores:minecraft:diamond_ore')?.change).toMatch(
      /^No vanilla diamond_ore: mine GregTech Diamond ore \(vein Diamond y 5-20; small ore y 5-15\)/,
    );
    expect(change('food:hunger-overhaul')?.change).toMatch(/^Healing needs food >= 8/);
    // A recipe GTNH keeps exactly (the same grid, no count of its own) is not a change.
    expect(data.changes.some((c) => c.id.startsWith('recipe:minecraft:oak_stairs'))).toBe(false);
  });
});
