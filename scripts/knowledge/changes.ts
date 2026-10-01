/**
 * The "changes from vanilla 1.7.10" table: every way GTNH 2.8.4 differs from the base game
 * that the knowledge base can show, each side with its source and how it was verified.
 *
 *  - Recipes: each vanilla crafting recipe (read from the 1.7.10 server jar) against GTNH's
 *    recipes for the same item (the CraftTweaker dump): same ingredients with another count,
 *    replaced by a different recipe, or gone.
 *  - Smelting: each vanilla furnace recipe (the jar) against GTNH's (the dump).
 *  - Mechanics read from the configs and jars: gravel's flint, which vanilla tools still dig,
 *    swords, wooden tool durability, ore generation and ore drops, hunger and healing.
 */
import {
  countVerified,
  type CountFrom,
  type GtnhChange,
  type KnowledgeData,
  type SmallOre,
  type VanillaLayer,
  type VanillaRecipe,
  type Vein,
} from '../../src/goals/knowledge.ts';
import type { VanillaDrops } from './vanilla.ts';

/** A GTNH crafting recipe with its ingredients as item names. */
export interface GtnhRecipeView {
  output: string;
  count: number;
  countFrom: CountFrom;
  shapeless: boolean;
  fits2x2: boolean;
  nbtInput: boolean;
  inputs: Array<{ names: readonly string[]; label: string; count: number; tool: boolean }>;
}

export interface ChangeInputs {
  vanilla: VanillaLayer;
  drops: VanillaDrops;
  recipes: GtnhRecipeView[];
  /** GTNH furnace recipes: [input, output] item names. */
  furnace: Array<[string, string]>;
  iguana: {
    removeFlintDrop: boolean;
    addFlintRecipe: boolean;
    gravelPerFlint: number;
    disableRegularTools: boolean;
    disableRegularSwords: boolean;
    /** Tools IguanaTweaks disables (they mine nothing). */
    disabledTools: string[];
    /** Swords IguanaTweaks disables (their hits are cancelled). */
    disabledSwords: string[];
  };
  gt: {
    disableVanillaOres: boolean;
    changedWoodenVanillaTools: boolean;
    oreDropBehavior: string;
  };
  /** config/HungerOverhaul/HungerOverhaul.cfg values by key. */
  hunger: Map<string, string>;
  veins: Vein[];
  smallOres: SmallOre[];
  harvest: KnowledgeData['harvest'];
  levelNames: string[];
}

const JAR =
  'vanilla 1.7.10 server jar (minecraft_server.1.7.10.jar), read by scripts/build-knowledge.ts';
const MCDATA = 'minecraft-data 3.117.0, data/pc/1.7 (MIT)';
const DUMP = "the test server's CraftTweaker dump (minetweaker.log)";

const base = (name: string): string => name.replace(/@\d+$/, '');
const short = (name: string): string => name.replace(/^minecraft:/, '');
/** Vanilla items whose registry name hides what they are. */
const VARIANT_NAMES: Readonly<Record<string, string>> = { 'minecraft:coal@1': 'charcoal' };
const named = (name: string): string =>
  VARIANT_NAMES[name] === undefined ? short(name) : `${short(name)} (${VARIANT_NAMES[name]})`;

/** Does a vanilla recipe fit the player's own 2x2 grid? */
const vanillaFits2x2 = (r: VanillaRecipe): boolean =>
  r.rows === null
    ? r.inputs.reduce((s, i) => s + i.count, 0) <= 4
    : r.rows.length <= 2 && r.rows.every((row) => row.length <= 2);

/** "3 iron_ingot + 2 stick", for a vanilla recipe. */
function vanillaText(r: VanillaRecipe): string {
  const parts = r.inputs.map(
    (i) =>
      `${i.count} ${short(i.item)}${i.damage === null ? '' : i.damage === 0 ? '' : `@${i.damage}`}`,
  );
  // Vanilla registers chainmail armour from fire, which no player can hold.
  const fire = r.inputs.some((i) => i.item === 'minecraft:fire')
    ? ' (uncraftable: fire is not an item)'
    : '';
  return `${parts.join(' + ')} -> ${r.count}${vanillaFits2x2(r) ? '' : ' (3x3)'}${fire}`;
}

const TOOL_WORDS: Readonly<Record<string, string>> = {
  HardHammer: 'hammer',
  SoftHammer: 'soft mallet',
  SoftMallet: 'soft mallet',
  WireCutter: 'wire cutter',
};
type ViewInput = GtnhRecipeView['inputs'][number];
const hasTools = (r: GtnhRecipeView): boolean => r.inputs.some((i) => i.tool);
const inputName = (i: ViewInput): string => (i.label !== '' ? i.label : short(i.names[0] ?? '?'));
/** "saw", "hammer and screwdriver": the crafting tools a GTNH recipe needs in the grid. */
function toolsText(r: GtnhRecipeView): string {
  const words = r.inputs
    .filter((i) => i.tool)
    .map((i) => {
      const t = inputName(i).replace(/^ore:craftingTool/, '');
      return TOOL_WORDS[t] ?? t.toLowerCase();
    });
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/** "1 plateIron + 2 ingotIron (tools: file, hammer) -> 1", for a GTNH recipe. */
function gtnhText(r: GtnhRecipeView): string {
  const used = r.inputs.filter((i) => !i.tool).map((i) => `${i.count} ${inputName(i)}`);
  const count = r.count > 0 ? String(r.count) : '?';
  return (
    `${used.join(' + ')}${hasTools(r) ? ` (tools: ${toolsText(r)})` : ''} -> ${count}` +
    (r.fits2x2 ? '' : ' (3x3)')
  );
}

const verified = (r: GtnhRecipeView): boolean => r.count > 0 && countVerified(r.countFrom);

const countSource = (r: GtnhRecipeView): string =>
  r.countFrom === 'hand'
    ? "count hand-verified in the agent's recipe table (src/domain/recipes.ts)"
    : r.countFrom === 'script'
      ? "count from GTNewHorizonsCoreMod's recipe scripts (jar)"
      : r.countFrom === 'gt'
        ? "count from GregTech's code (ProcessingLog, CraftingRecipeLoader; checked with javap)"
        : r.countFrom === 'vanilla'
          ? 'count as vanilla (not confirmed for GTNH)'
          : 'count not known (the dump has none)';

/** Do a GTNH recipe's consumed ingredients equal a vanilla recipe's (as multisets)? */
export function sameIngredients(v: VanillaRecipe, r: GtnhRecipeView): boolean {
  const consumed = r.inputs.filter((i) => !i.tool);
  if (consumed.length !== v.inputs.length) return false;
  const used = new Array<boolean>(consumed.length).fill(false);
  return v.inputs.every((vi) => {
    const want = vi.damage === null ? null : vi.damage === 0 ? vi.item : `${vi.item}@${vi.damage}`;
    const j = consumed.findIndex(
      (gi, k) =>
        !used[k] &&
        gi.count === vi.count &&
        gi.names.some((n) => (want === null ? base(n) === vi.item : n === want)),
    );
    if (j < 0) return false;
    used[j] = true;
    return true;
  });
}

export function buildChanges(x: ChangeInputs): GtnhChange[] {
  const out: GtnhChange[] = [];
  const display = (name: string): string =>
    x.vanilla.items[base(name)]?.name ?? x.vanilla.blocks[base(name)]?.name ?? short(name);

  // --- Recipes -------------------------------------------------------------------------
  const byOutput = new Map<string, GtnhRecipeView[]>();
  for (const r of x.recipes) {
    const list = byOutput.get(r.output) ?? [];
    list.push(r);
    byOutput.set(r.output, list);
  }
  const ordinal = new Map<string, number>();
  for (const v of x.vanilla.crafting) {
    const k = (ordinal.get(v.output) ?? 0) + 1;
    ordinal.set(v.output, k);
    const gtnh = byOutput.get(v.output) ?? [];
    const same = gtnh.filter((r) => sameIngredients(v, r));
    const subject = `${display(v.output)}${v.output.includes('@') ? ` (${v.output})` : ''}`;
    const keys = [v.output, ...v.inputs.map((i) => i.item)];
    const vanilla = { value: vanillaText(v), source: `${JAR}: ${v.from}` };
    const id = `recipe:${v.output}#${k}`;
    // The same ingredients: without a crafting tool (vanilla's grid), or with one (GT adds a
    // saw, hammer... that is used, not consumed).
    const plain = same.filter((r) => !hasTools(r));
    const tooled = same.filter(hasTools);
    const withTool = tooled.find(verified) ?? tooled[0];
    if (plain.length > 0) {
      const known = plain.find(verified);
      const toolNote =
        withTool !== undefined && verified(withTool) && withTool.count !== known?.count
          ? ` (${withTool.count} with a ${toolsText(withTool)} in the grid)`
          : '';
      if (known !== undefined && known.count !== v.count) {
        out.push({
          id,
          kind: 'recipe',
          subject,
          keys,
          vanilla,
          gtnh: {
            value: `${gtnhText(known)}${withTool === undefined ? '' : `; ${gtnhText(withTool)}`}`,
            source:
              `${DUMP}; ${countSource(known)}` +
              (withTool === undefined
                ? ''
                : `; with the ${toolsText(withTool)}: ${countSource(withTool)}`),
          },
          change: `${subject}: the same ingredients make ${known.count}, not ${v.count}${toolNote}`,
        });
      } else if (vanillaFits2x2(v) && !plain.some((r) => r.fits2x2)) {
        const r = known ?? plain[0];
        out.push({
          id,
          kind: 'recipe',
          subject,
          keys,
          vanilla,
          gtnh: { value: r === undefined ? '?' : gtnhText(r), source: DUMP },
          change: `${subject}: the same recipe needs a crafting table (3x3); vanilla's fits the 2x2 grid`,
        });
      }
      continue;
    }
    if (withTool !== undefined) {
      const count =
        verified(withTool) && withTool.count !== v.count
          ? `, and makes ${withTool.count}, not ${v.count}`
          : '';
      out.push({
        id,
        kind: 'recipe',
        subject,
        keys,
        vanilla,
        gtnh: { value: gtnhText(withTool), source: `${DUMP}; ${countSource(withTool)}` },
        change:
          `${subject}: the same ingredients, but it needs a ${toolsText(withTool)} in the grid ` +
          `(used, not consumed)${count}`,
      });
      continue;
    }
    // A GTNH recipe to show: no NBT inputs, most of vanilla's ingredients, a confirmed count,
    // few tools, few ingredients.
    const vanillaItems = new Set(v.inputs.map((i) => i.item));
    const overlap = (r: GtnhRecipeView): number =>
      r.inputs.filter((i) => !i.tool && i.names.some((n) => vanillaItems.has(base(n)))).length;
    const best = [...gtnh].sort(
      (a, b) =>
        Number(a.nbtInput) - Number(b.nbtInput) ||
        overlap(b) - overlap(a) ||
        Number(verified(b)) - Number(verified(a)) ||
        a.inputs.filter((i) => i.tool).length - b.inputs.filter((i) => i.tool).length ||
        a.inputs.length - b.inputs.length,
    )[0];
    if (best === undefined) {
      out.push({
        id,
        kind: 'recipe',
        subject,
        keys,
        vanilla,
        gtnh: { value: 'no crafting recipe', source: `${DUMP}: no recipe makes ${v.output}` },
        change: `${subject}: no crafting recipe in GTNH (vanilla: ${vanilla.value})`,
      });
      continue;
    }
    const more =
      gtnh.length > 2
        ? ` (and ${gtnh.length - 1} other recipes)`
        : gtnh.length === 2
          ? ' (and 1 other recipe)'
          : '';
    out.push({
      id,
      kind: 'recipe',
      subject,
      keys: [...keys, ...best.inputs.flatMap((i) => i.names.slice(0, 4))],
      vanilla,
      gtnh: { value: `${gtnhText(best)}${more}`, source: `${DUMP}; ${countSource(best)}` },
      change:
        `${subject}: vanilla's recipe (${vanilla.value}) is not in GTNH; ` +
        `${gtnh.length === 1 ? "GTNH's" : `one of GTNH's ${gtnh.length}`}: ${gtnhText(best)}`,
    });
  }

  // --- Smelting --------------------------------------------------------------------------
  for (const s of x.vanilla.smelting) {
    const inputs = x.furnace.filter(([i]) =>
      s.inputAnyDamage ? base(i) === base(s.input) : i === s.input,
    );
    if (inputs.some(([, o]) => o === s.output)) continue;
    const subject = `Smelting ${display(s.input)}`;
    const vanilla = {
      value: `${short(s.input)} -> ${s.count} ${short(s.output)}`,
      source: `${JAR}: FurnaceRecipes`,
    };
    const others = [...new Set(inputs.map(([, o]) => o))];
    out.push({
      id: `smelting:${s.input}`,
      kind: 'smelting',
      subject,
      keys: [s.input, s.output],
      vanilla,
      gtnh:
        others.length === 0
          ? { value: 'no furnace recipe', source: `${DUMP} (furnace): none for ${s.input}` }
          : { value: `smelts into ${others.map(short).join(' or ')}`, source: `${DUMP} (furnace)` },
      change:
        others.length === 0
          ? `${subject}: a furnace no longer makes ${named(s.output)} from ${short(s.input)}`
          : `${subject}: ${short(s.input)} gives ${others.map(named).join(' or ')}, not ${named(s.output)}`,
    });
  }

  // --- Gravel and flint ------------------------------------------------------------------
  const gravel = x.drops['minecraft:gravel'];
  if (
    x.iguana.removeFlintDrop &&
    gravel !== undefined &&
    gravel.items.includes('minecraft:flint')
  ) {
    out.push({
      id: 'drop:minecraft:gravel',
      kind: 'drop',
      subject: 'Gravel',
      keys: ['minecraft:gravel', 'minecraft:flint'],
      vanilla: {
        value: 'drops flint 1 time in 10 (1 in 7, 4, 1 with Fortune I-III), else gravel',
        source:
          `${JAR}: BlockGravel.getItemDropped (class ${gravel.cls}) returns flint when ` +
          'rand.nextInt(10 - 3 x fortune) == 0, else the gravel block',
      },
      gtnh: {
        value: `always drops gravel; flint is crafted from ${x.iguana.gravelPerFlint} gravel (1 flint)`,
        source:
          'IguanaTweaks 2.6.6: FlintHandler removes the flint drop (removeFlintDrop=true) and ' +
          `flintTweaks adds ${x.iguana.gravelPerFlint} gravel -> new ItemStack(flint) ` +
          `(addFlintRecipe=${String(x.iguana.addFlintRecipe)}, gravelPerFlint=${x.iguana.gravelPerFlint}; ` +
          'IguanaTinkerTweaks/main.cfg and the jar); the CraftTweaker dump lists the recipe',
      },
      change: `Gravel never drops flint; craft flint from ${x.iguana.gravelPerFlint} gravel (shapeless, 2x2)`,
    });
  }

  // --- Vanilla tools ---------------------------------------------------------------------
  const vt = new Map(x.vanilla.tools.map((t) => [t.item, t]));
  const disabled = x.iguana.disabledTools.filter((t) => vt.has(t));
  if (x.iguana.disableRegularTools && disabled.length > 0) {
    const levels = disabled
      .map((t) => {
        const tool = vt.get(t);
        const m = tool === undefined ? undefined : x.vanilla.toolMaterials[tool.material];
        return `${short(t)} ${m === undefined ? '' : `(level ${m.level}, ${m.uses} uses)`}`.trim();
      })
      .join(', ');
    const working = x.vanilla.tools
      .filter(
        (t) =>
          (t.kind === 'pickaxe' || t.kind === 'shovel' || t.kind === 'axe') &&
          !disabled.includes(t.item),
      )
      .map((t) => short(t.item));
    out.push({
      id: 'tool:vanilla-disabled',
      kind: 'tool',
      subject: 'Vanilla pickaxes and shovels',
      keys: [...disabled, 'pickaxe', 'shovel'],
      vanilla: {
        value: `dig by their material: ${levels}`,
        source: `${JAR}: Item.ToolMaterial and Item.registerItems`,
      },
      gtnh: {
        value:
          `mine nothing (dig speed 0); still working: ${working.join(', ')}, and every tool that ` +
          "is not an ItemTool (Tinkers' Construct, GregTech)",
        source:
          'IguanaTweaks 2.6.6: disableRegularTools=true with exclusionType=blacklist and these ' +
          'items on the tools list (IguanaTinkerTweaks/main.cfg); VanillaToolNerfHandler sets the ' +
          'break speed of a listed ItemTool to 0 (isUselessTool, read with javap); items that are not ' +
          'ItemTools are never affected, even when listed (gregtech:gt.metatool.01)',
      },
      change:
        `The ${disabled.map(short).join(', ')} mine nothing; use a Tinkers' Construct or GregTech tool ` +
        `(or the ${working.filter((w) => w.startsWith('wooden')).join(', ')} for level 0)`,
    });
  }
  // disableRegularSwords cancels the hits of the listed swords only: on this server's lists
  // (blacklist mode) no vanilla sword is, so vanilla swords keep their damage and no entry
  // is made unless the configs list one.
  const swords = x.vanilla.tools.filter(
    (t) => t.kind === 'sword' && x.iguana.disabledSwords.includes(t.item),
  );
  if (x.iguana.disableRegularSwords && swords.length > 0) {
    out.push({
      id: 'tool:vanilla-swords',
      kind: 'tool',
      subject: 'Vanilla swords',
      keys: [...swords.map((t) => t.item), 'sword'],
      vanilla: {
        value: swords
          .map(
            (t) =>
              `${short(t.item)} ${4 + (x.vanilla.toolMaterials[t.material]?.damage ?? 0)} damage`,
          )
          .join(', '),
        source: `${JAR}: ItemSword damage = 4 + ToolMaterial damage`,
      },
      gtnh: {
        value: 'no damage: the hit is cancelled',
        source:
          'IguanaTweaks 2.6.6: disableRegularSwords=true and these swords listed ' +
          '(IguanaTinkerTweaks/main.cfg); VanillaSwordNerfHandler cancels the LivingHurtEvent of ' +
          'a listed ItemSword (isUselessWeapon, read with javap)',
      },
      change: `The ${swords.map((t) => short(t.item)).join(', ')} do no damage; fight with another weapon`,
    });
  }
  const wood = x.vanilla.toolMaterials['WOOD'];
  if (x.gt.changedWoodenVanillaTools && wood !== undefined) {
    const wooden = x.vanilla.tools.filter((t) => t.material === 'WOOD').map((t) => t.item);
    out.push({
      id: 'tool:wooden-durability',
      kind: 'tool',
      subject: 'Wooden tools',
      keys: wooden,
      vanilla: {
        value: `${wood.uses} uses, efficiency ${wood.efficiency}`,
        source: `${JAR}: ToolMaterial.WOOD`,
      },
      gtnh: {
        value: '64 uses (efficiency unchanged)',
        source:
          'GregTech.cfg changedWoodenVanillaTools=true (GTPostLoad.changeWoodenVanillaTools; ' +
          'its efficiency mixin is not loaded: see docs/gtnh-compatibility.md, "Tools")',
      },
      change: `Wooden tools last 64 uses, not ${wood.uses}`,
    });
  }

  // --- Ores ------------------------------------------------------------------------------
  const ORES: ReadonlyArray<[string, string, string]> = [
    ['minecraft:coal_ore', 'Coal', 'minecraft:coal'],
    ['minecraft:iron_ore', 'Iron', 'minecraft:iron_ingot'],
    ['minecraft:gold_ore', 'Gold', 'minecraft:gold_ingot'],
    ['minecraft:diamond_ore', 'Diamond', 'minecraft:diamond'],
    ['minecraft:redstone_ore', 'Redstone', 'minecraft:redstone'],
    ['minecraft:lapis_ore', 'Lapis', 'minecraft:dye@4'],
  ];
  if (x.gt.disableVanillaOres) {
    for (const [ore, material, product] of ORES) {
      const gen = x.vanilla.oreGen.find((g) => g.block === ore);
      const tools = x.vanilla.blocks[ore]?.tools ?? [];
      // The weakest pickaxe minecraft-data lists for the block (gold digs like wood).
      const weakest = ['wooden', 'stone', 'iron', 'diamond']
        .map((m) => tools.find((t) => t === `minecraft:${m}_pickaxe`))
        .find((t) => t !== undefined);
      const tier =
        tools.length === 0 ? 'any pickaxe' : `${short(weakest ?? tools[0] ?? '')} or better`;
      const veins = x.veins.filter(
        (v) =>
          v.dims.includes('Overworld') &&
          [v.primary, v.secondary, v.between, v.sporadic].some((o) => o?.material === material),
      );
      const veinOre = veins
        .flatMap((v) => [v.primary, v.secondary, v.between, v.sporadic])
        .find((o) => o?.material === material);
      const small = x.smallOres.find(
        (s) => s.material === material && s.dims.includes('Overworld'),
      );
      const where = [
        ...veins.slice(0, 3).map((v) => `vein ${v.key} y ${v.minY}-${v.maxY}`),
        ...(small === undefined ? [] : [`small ore y ${small.minY}-${small.maxY}`]),
      ].join('; ');
      const levels = [
        veinOre === undefined || veinOre === null
          ? null
          : `vein ore needs a pickaxe of level ${veinOre.level}`,
        small === undefined ? null : `small ore level ${small.level}`,
      ]
        .filter((s): s is string => s !== null)
        .join(', ');
      out.push({
        id: `ores:${ore}`,
        kind: 'ores',
        subject: display(ore),
        keys: [
          ore,
          product,
          ...(veinOre?.block == null ? [] : [veinOre.block]),
          ...(veinOre?.drop == null ? [] : [veinOre.drop]),
          ...(small?.block == null ? [] : [small.block]),
        ],
        vanilla: {
          value:
            gen === undefined
              ? 'generates in the Overworld'
              : `${gen.perChunk} vein${gen.perChunk === 1 ? '' : 's'} of ${gen.veinSize} per chunk at y ${gen.minY}-${gen.maxY}; needs ${tier}`,
          source: `${JAR}: BiomeDecorator; harvest tools from ${MCDATA}`,
        },
        gtnh: {
          value:
            `does not generate; GregTech ${material} ore instead (${where || 'no Overworld vein'}; ` +
            `${levels || 'level unknown'}; drops raw ore to smelt)`,
          source:
            `config/GregTech/WorldGeneration.cfg disableVanillaOres=true; veins from GregTech's ` +
            `OreMixes/SmallOres (jar); oredropbehavior=${x.gt.oreDropBehavior} (GregTech.cfg)`,
        },
        change:
          `No vanilla ${short(ore)}: mine GregTech ${material} ore (${where || 'not in the Overworld'}); ` +
          `${levels || 'pickaxe level unknown'}`,
      });
    }
  }

  // --- Hunger ----------------------------------------------------------------------------
  const h = (k: string): string | undefined => x.hunger.get(k);
  if (h('minHungerToHeal') !== undefined) {
    const foods = Object.keys(x.vanilla.foods);
    out.push({
      id: 'food:hunger-overhaul',
      kind: 'food',
      subject: 'Hunger and healing',
      keys: [...foods, 'food', 'health'],
      vanilla: {
        value: 'health regenerates while food >= 18; food values as in vanilla',
        source: `Hunger Overhaul's own notes in HungerOverhaul.cfg ([vanilla: 18]); food values from ${MCDATA}`,
      },
      gtnh: {
        value:
          `health regenerates only while food >= ${h('minHungerToHeal') ?? '?'}, slower at low health ` +
          `(modifyRegenRateOnLowHealth=${h('modifyRegenRateOnLowHealth') ?? '?'}); food values ` +
          `${h('modifyFoodValues') === 'true' ? `changed: hunger divided by ${h('foodHungerDivider') ?? '?'} unless Hunger Overhaul sets them` : 'unchanged'}`,
        source: 'config/HungerOverhaul/HungerOverhaul.cfg (Hunger Overhaul 1.0.0.jenkins104)',
      },
      change: `Healing needs food >= ${h('minHungerToHeal') ?? '?'}, and foods fill less than in vanilla`,
    });
  }
  return out;
}
