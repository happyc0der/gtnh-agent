import type { DiggableBlock } from './blocks.ts';
import {
  DIGGABLE,
  diggableInfo,
  instantDig,
  type BlockMaterial,
  type DigFacts,
  type HarvestRule,
  type ToolKind,
} from './dig-time.ts';

/**
 * The ONLY tools DIG_BLOCK may hold, with their verified speed, harvest level and wear on the
 * test server (GTNH 2.8.4; evidence in docs/gtnh-compatibility.md, "Tools"). Anything else in
 * the inventory is never used for digging: the client digs with the best usable tool here, or
 * with an empty hand where a hand harvests the block.
 *
 * What a tool does, server side (vanilla 1.7.10 with Forge's patches, checked in the jars):
 *  - Speed: ItemTool.getDigSpeed gives the tool material's efficiency on the blocks it is
 *    made for (ItemSpade's block set, ItemAxe's wood material, ItemPickaxe's rock, iron and
 *    anvil materials, or Forge's harvest tool), and 1 (an empty hand's speed) on anything
 *    else.
 *  - Harvest: a block whose material needs a tool (rock: stone, ores) drops only for a tool
 *    of its harvest tool's class whose harvest level is at least the block's
 *    (ForgeHooks.canHarvestBlock); anything else digs it at a third of the speed and the
 *    block is gone with nothing dropped. The agent never digs such a block.
 *  - Wear: ItemTool.onBlockDestroyed damages the tool by 1 for every block with a hardness
 *    above 0. The damage is the item stack's damage value. A use that takes the damage above
 *    the item's maximum breaks the tool (the stack is destroyed); the block still breaks and
 *    drops as usual.
 *  - It breaks one block. No vanilla tool or mod handler on this server breaks more
 *    (vanilla tools do not override onBlockStartBreak; no BreakEvent handler looks at them).
 *
 * The agent uses a tool only while one more use leaves its damage at or below `maxDamage`,
 * only without NBT data (enchantments or other data it cannot read), and never a protected
 * item. Tinkers' Construct's tools are the exception: their stats ARE their NBT data, which
 * the client reads (TINKERS_TOOLS).
 */

export const TOOL_ITEMS = [
  'minecraft:wooden_shovel',
  'minecraft:wooden_pickaxe',
  'minecraft:wooden_axe',
  'minecraft:stone_axe',
  'minecraft:iron_axe',
  'minecraft:golden_axe',
  'minecraft:diamond_axe',
] as const;
export type ToolItem = (typeof TOOL_ITEMS)[number];

export type { ToolKind } from './dig-time.ts';

export interface ToolInfo {
  /** The item's registry name (a vanilla tool here, or a Tinkers' tool the client read). */
  readonly item: string;
  readonly kind: ToolKind;
  /**
   * Dig speed on the blocks in `digsFaster` (an empty hand has 1). A verified lower bound:
   * the dig wait is computed from it, and a faster tool only makes the wait longer than
   * needed, which the server always accepts.
   */
  readonly speed: number;
  /**
   * Its harvest level for its kind (IguanaTweaks' ToolDefaults.cfg on the test server): it
   * harvests a block of that kind's level or lower (dig-time.ts HarvestRule).
   */
  readonly harvestLevel: number;
  /**
   * The highest damage the agent lets the tool reach: it digs with it only while
   * damage + 1 <= maxDamage, so it never makes the use that breaks it.
   */
  readonly maxDamage: number;
  /** The allowlisted blocks it digs faster than a hand. Never used on other blocks. */
  readonly digsFaster: readonly DiggableBlock[];
  /** Where the numbers come from. */
  readonly evidence: string;
}

/** ItemSpade's effective blocks (and Forge harvest tool "shovel", level 0) on the allowlist. */
const SHOVEL_BLOCKS: readonly DiggableBlock[] = [
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
];
/** ItemAxe digs material wood faster (and Forge harvest tool "axe", level 0): the logs. */
const AXE_BLOCKS: readonly DiggableBlock[] = ['minecraft:log', 'minecraft:log2'];
/**
 * ItemPickaxe digs material rock (and iron, anvil) at its efficiency (func_150893_a): every
 * allowlisted stone and ore. Which of them it harvests is its level's business (harvests).
 */
const PICKAXE_BLOCKS: readonly DiggableBlock[] = [...DIGGABLE]
  .filter(([, info]) => info.material === 'rock')
  .map(([block]) => block);

const WOODEN =
  'Vanilla 1.7.10 ToolMaterial.WOOD: efficiency 2, 59 uses. GregTech changedWoodenVanillaTools=true ' +
  '(test server GregTech.cfg) raises the maximum damage to 64 (GTPostLoad.changeWoodenVanillaTools; ' +
  'GregTech.log "Updating Vanilla Wooden Tools"); its mixin that would raise the speed to 4 is not ' +
  'loaded on this server (fml-server-latest.log: "Not loading ... minecraft.ItemToolMaterialMixin"). ' +
  'The agent assumes the lower values (speed 2, 59), which hold either way. Usable: not on ' +
  "IguanaTweaks' disabled-tool list (IguanaTinkerTweaks/main.cfg); harvest level 0 " +
  '(IguanaTinkerTweaks/ToolDefaults.cfg).';
const AXE = (material: string, speed: number, uses: number, level: number): string =>
  `Vanilla 1.7.10 ToolMaterial.${material}: efficiency ${speed}, ${uses} uses; no mod changes ` +
  "either. Usable: axes are not on IguanaTweaks' disabled-tool list (IguanaTinkerTweaks/main.cfg); " +
  `harvest level ${level} (ToolDefaults.cfg).`;

export const TOOLS: Readonly<Record<ToolItem, ToolInfo>> = {
  'minecraft:wooden_shovel': {
    item: 'minecraft:wooden_shovel',
    kind: 'shovel',
    speed: 2,
    harvestLevel: 0,
    maxDamage: 59,
    digsFaster: SHOVEL_BLOCKS,
    evidence: WOODEN,
  },
  'minecraft:wooden_pickaxe': {
    item: 'minecraft:wooden_pickaxe',
    kind: 'pickaxe',
    speed: 2,
    harvestLevel: 0,
    maxDamage: 59,
    digsFaster: PICKAXE_BLOCKS,
    evidence:
      `${WOODEN} ItemPickaxe (adn): efficiency on material rock, iron and anvil; harvests ` +
      'stone, cobblestone, mossy cobblestone, sandstone, netherrack, hardened and stained clay ' +
      'and level-0 GT ores, nothing above (GregTech granite, marble, basalt and emerald ore not).',
  },
  'minecraft:wooden_axe': {
    item: 'minecraft:wooden_axe',
    kind: 'axe',
    speed: 2,
    harvestLevel: 0,
    maxDamage: 59,
    digsFaster: AXE_BLOCKS,
    evidence: WOODEN,
  },
  'minecraft:stone_axe': {
    item: 'minecraft:stone_axe',
    kind: 'axe',
    speed: 4,
    harvestLevel: 0,
    maxDamage: 131,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('STONE', 4, 131, 0),
  },
  'minecraft:iron_axe': {
    item: 'minecraft:iron_axe',
    kind: 'axe',
    speed: 6,
    harvestLevel: 3,
    maxDamage: 250,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('IRON', 6, 250, 3),
  },
  'minecraft:golden_axe': {
    item: 'minecraft:golden_axe',
    kind: 'axe',
    speed: 12,
    harvestLevel: 0,
    maxDamage: 32,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('GOLD', 12, 32, 0),
  },
  'minecraft:diamond_axe': {
    item: 'minecraft:diamond_axe',
    kind: 'axe',
    speed: 8,
    harvestLevel: 5,
    maxDamage: 1561,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('EMERALD (diamond)', 8, 1561, 5),
  },
};

/**
 * Vanilla tools that dig NOTHING on this server, so the agent never holds one: IguanaTweaks'
 * disableRegularTools=true with the stone, iron, golden and diamond shovels and pickaxes on
 * its blacklist (IguanaTinkerTweaks/main.cfg); VanillaToolNerfHandler.breakSpeed sets their
 * speed to 0 on every block. (NewHorizonsCoreMod also removes the stone and diamond tool
 * recipes.) The wooden pickaxe and shovel and every axe are not listed.
 */
export const DISABLED_VANILLA_TOOLS: readonly string[] = [
  'minecraft:stone_pickaxe',
  'minecraft:iron_pickaxe',
  'minecraft:golden_pickaxe',
  'minecraft:diamond_pickaxe',
  'minecraft:stone_shovel',
  'minecraft:iron_shovel',
  'minecraft:golden_shovel',
  'minecraft:diamond_shovel',
];

/** The tool facts for a registry name (without `@damage`), or null when it is not a tool here. */
export function toolInfo(item: string): ToolInfo | null {
  return (TOOL_ITEMS as readonly string[]).includes(item) ? TOOLS[item as ToolItem] : null;
}

/** The tool's speed on `block`, or null when it does not dig that block faster than a hand. */
export function toolSpeedOn(tool: ToolInfo, block: DiggableBlock): number | null {
  return tool.digsFaster.includes(block) ? tool.speed : null;
}

/**
 * Whether a tool of `kind` at harvest level `level` harvests a block with rule `rule` (null:
 * anything does, a hand too).
 */
export function harvests(
  tool: { readonly kind: ToolKind; readonly harvestLevel: number },
  rule: HarvestRule | null,
): boolean {
  return rule === null || (tool.kind === rule.tool && tool.harvestLevel >= rule.level);
}

/** "a pickaxe of level 2 or more" */
export function describeHarvest(rule: HarvestRule): string {
  return `a ${rule.tool} of level ${rule.level} or more`;
}

/** Digs the agent may still make with a tool at `damage` (0 when it must not be used). */
export function usesLeft(tool: ToolInfo, damage: number): number {
  if (!Number.isInteger(damage) || damage < 0) return 0;
  return Math.max(0, tool.maxDamage - damage);
}

/** A tool somewhere in the inventory, as the client or the planner sees it. */
export interface ToolStack {
  readonly tool: ToolInfo;
  /** The item stack's damage value (its wear). */
  readonly damage: number;
}

/**
 * Why this stack must not be used to dig `block`, or null when it may. `count` and `hasNbt`
 * describe the stack (a tool never stacks; NBT data could hold enchantments or anything else
 * the agent cannot read). `harvest`: what harvests this very block (a GT ore's depends on its
 * metadata: dig-time.ts digFacts), the table's by default.
 */
export function toolProblem(
  stack: ToolStack & { readonly count: number; readonly hasNbt: boolean },
  block: DiggableBlock,
  harvest: HarvestRule | null = diggableInfo(block).harvest,
): string | null {
  const { tool, damage } = stack;
  if (toolSpeedOn(tool, block) === null) return `${tool.item} does not dig ${block} faster`;
  if (harvest !== null && !harvests(tool, harvest)) {
    return `${tool.item} (a level-${tool.harvestLevel} ${tool.kind}) does not harvest ${block}: it needs ${describeHarvest(harvest)}`;
  }
  if (stack.hasNbt) return `${tool.item} has NBT data (enchantments or other data)`;
  if (stack.count !== 1) return `${stack.count} x ${tool.item} in one stack`;
  if (usesLeft(tool, damage) < 1) {
    return `${tool.item} is worn out (damage ${damage}, the agent stops at ${tool.maxDamage})`;
  }
  return null;
}

/**
 * The tool to dig `block` with: the fastest of the candidates that may be used. Ties keep the
 * candidates' order (the caller lists them in its order of preference). Null: an empty hand.
 */
export function bestTool<T extends ToolStack>(
  block: DiggableBlock,
  candidates: readonly T[],
  usable: (candidate: T) => boolean,
): T | null {
  let best: { c: T; speed: number } | null = null;
  for (const c of candidates) {
    const speed = toolSpeedOn(c.tool, block);
    if (speed === null || !usable(c)) continue;
    if (best === null || speed > best.speed) best = { c, speed };
  }
  return best?.c ?? null;
}

/**
 * An agent-facing inventory name ("minecraft:wooden_shovel" or "minecraft:wooden_shovel@12",
 * the damage appended as in GameState inventories) as a tool, or null when it is not one.
 */
export function parseToolName(name: string): ToolStack | null {
  const m = /^(.*)@(\d{1,5})$/.exec(name);
  const tool = toolInfo(m === null ? name : (m[1] ?? ''));
  if (tool === null) return null;
  return { tool, damage: m === null ? 0 : Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Tinkers' Construct tools: their stats are their NBT data (InfiTool)

/**
 * The Tinkers' Construct tools the agent may dig with (TConstruct-1.13.57-GTNH, javap): the
 * single-block harvest tools. Never the hammer, excavator or lumber axe: they break a whole
 * area or tree from one dig (AOEHarvestTool, LumberAxe.onBlockStartBreak).
 *  - `kinds`: HarvestTool.getHarvestType() (the mattock, a DualHarvestTool, has a second:
 *    getSecondHarvestType(), with its own HarvestLevel2 and MiningSpeed2);
 *  - `materials`, per kind: getEffectiveMaterials() (and getEffectiveSecondaryMaterials()),
 *    the ones the allowlist has (the pickaxe also digs iron, ice, glass, piston, anvil and
 *    circuits; the shovel snow and crafted snow; the hatchet vine, circuits, cactus and
 *    gourd; the mattock's axe side cactus, vine and gourd).
 */
export const TINKERS_TOOLS = {
  'TConstruct:pickaxe': { kinds: ['pickaxe'], materials: [['rock']] },
  'TConstruct:shovel': { kinds: ['shovel'], materials: [['grass', 'ground', 'sand', 'clay']] },
  'TConstruct:hatchet': { kinds: ['axe'], materials: [['wood', 'leaves']] },
  'TConstruct:mattock': {
    kinds: ['axe', 'shovel'],
    materials: [
      ['wood', 'plants'],
      ['grass', 'ground', 'clay'],
    ],
  },
} as const satisfies Readonly<
  Record<string, { kinds: readonly ToolKind[]; materials: ReadonlyArray<readonly BlockMaterial[]> }>
>;
export type TinkersToolItem = keyof typeof TINKERS_TOOLS;

export function isTinkersTool(item: string): item is TinkersToolItem {
  return Object.hasOwn(TINKERS_TOOLS, item);
}

/** Enchantment id of Silk Touch (1.7.10 Enchantment.silkTouch). */
const SILK_TOUCH = 33;

/** A Tinkers' tool's stats, as its NBT data says (InfiTool, and the stack's `ench`). */
export interface TinkersStats {
  readonly item: TinkersToolItem;
  /**
   * InfiTool.HarvestLevel: its level for its first kind. IguanaTweaks (pickaxeBoostRequired)
   * writes a new pickaxe's as its head material's level less 1, and raises it once the
   * pickaxe levels up (LevelingLogic.addBoostTags): the NBT data is the level that counts.
   */
  readonly harvestLevel: number;
  /** InfiTool.HarvestLevel2: the mattock's shovel side. */
  readonly harvestLevel2: number;
  readonly miningSpeed: number;
  /** MiningSpeed2, MiningSpeedHandle, MiningSpeedExtra when present (averaged in). */
  readonly extraSpeeds: {
    readonly speed2: number | null;
    readonly handle: number | null;
    readonly extra: number | null;
  };
  /** InfiTool.Shoddy: the Stonebound (positive) or Jagged (negative) trait. */
  readonly shoddy: number;
  readonly damage: number;
  readonly totalDurability: number;
  readonly broken: boolean;
  /** InfiTool.Lava: the auto-smelt modifier (TActiveOmniMod.autoSmelt) changes the drops. */
  readonly autoSmelt: boolean;
  /** Silk Touch in the stack's enchantments: the block itself drops. */
  readonly silkTouch: boolean;
}

/** An NBT compound as nbt.ts readNbt gives it (numbers, bigints, strings, lists, compounds). */
export type NbtData = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is NbtData =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v);

/**
 * A Tinkers' tool's stats from its stack's NBT root, or why they cannot be trusted. Fail
 * closed: InfiTool must be a compound, and TotalDurability and MiningSpeed positive integers;
 * a number TConstruct reads with getInteger/getBoolean/getFloat is 0 (false) when absent, as
 * there.
 */
export function readTinkersTool(
  item: string,
  root: NbtData,
): { ok: true; stats: TinkersStats } | { ok: false; reason: string } {
  if (!isTinkersTool(item)) {
    return { ok: false, reason: `${item} is not a Tinkers' tool the agent uses` };
  }
  const tags = root['InfiTool'];
  if (!isRecord(tags)) return { ok: false, reason: `${item} has no InfiTool data` };
  const int = (key: string): number | null => {
    const v = tags[key];
    if (v === undefined) return 0;
    return typeof v === 'number' && Number.isInteger(v) ? v : null;
  };
  const opt = (key: string): number | null | 'bad' => {
    if (tags[key] === undefined) return null;
    const v = int(key);
    return v === null ? 'bad' : v;
  };
  const harvestLevel = int('HarvestLevel');
  const harvestLevel2 = int('HarvestLevel2');
  const miningSpeed = int('MiningSpeed');
  const damage = int('Damage');
  const totalDurability = int('TotalDurability');
  const broken = int('Broken');
  const lava = int('Lava');
  const speed2 = opt('MiningSpeed2');
  const handle = opt('MiningSpeedHandle');
  const extra = opt('MiningSpeedExtra');
  const shoddy = tags['Shoddy'] ?? 0;
  if (
    harvestLevel === null ||
    harvestLevel2 === null ||
    miningSpeed === null ||
    damage === null ||
    totalDurability === null ||
    broken === null ||
    lava === null ||
    speed2 === 'bad' ||
    handle === 'bad' ||
    extra === 'bad' ||
    typeof shoddy !== 'number' ||
    !Number.isFinite(shoddy)
  ) {
    return { ok: false, reason: `${item}: its InfiTool data has a value of an unexpected type` };
  }
  if (totalDurability <= 0 || miningSpeed <= 0 || damage < 0) {
    return {
      ok: false,
      reason: `${item}: its InfiTool data gives no durability or speed (TotalDurability ${totalDurability}, MiningSpeed ${miningSpeed}, Damage ${damage})`,
    };
  }
  const ench = root['ench'];
  const silkTouch = Array.isArray(ench) && ench.some((e) => isRecord(e) && e['id'] === SILK_TOUCH);
  return {
    ok: true,
    stats: {
      item,
      harvestLevel,
      harvestLevel2,
      miningSpeed,
      extraSpeeds: { speed2, handle, extra },
      shoddy,
      damage,
      totalDurability,
      broken: broken !== 0,
      autoSmelt: lava !== 0,
      silkTouch,
    },
  };
}

/** Digs the agent may still make with the tool: the one that would break it is never made. */
export function tinkersUsesLeft(stats: TinkersStats): number {
  return Math.max(0, stats.totalDurability - stats.damage);
}

const f = Math.fround;

/**
 * AbilityHelper.calcStoneboundBonus, in Java's float arithmetic: log(Damage / 72 + 1) x 2 x
 * Shoddy (72: HarvestTool.stoneboundModifier of the pickaxe, shovel, hatchet and mattock).
 */
function stoneboundBonus(stats: TinkersStats): number {
  const ratio = f(f(stats.damage / f(72)) + 1);
  return f(f(f(Math.log(ratio)) * 2) * f(stats.shoddy));
}

/**
 * AbilityHelper.calcToolSpeed: the mean of MiningSpeed and those of MiningSpeed2,
 * MiningSpeedHandle and MiningSpeedExtra present, / 100, x the tool's break speed modifier
 * (1 for the four tools), plus the Stonebound bonus; in Java's float arithmetic.
 */
function calcToolSpeed(stats: TinkersStats): number {
  let sum = f(stats.miningSpeed);
  let n = 1;
  for (const v of [stats.extraSpeeds.speed2, stats.extraSpeeds.handle, stats.extraSpeeds.extra]) {
    if (v === null) continue;
    sum = f(sum + f(v));
    n += 1;
  }
  return f(f(sum / f(n * 100)) + stoneboundBonus(stats));
}

/** AbilityHelper.calcDualToolSpeed: MiningSpeed (or MiningSpeed2) / 100 plus the bonus. */
function calcDualToolSpeed(stats: TinkersStats, secondary: boolean): number {
  const speed = secondary ? (stats.extraSpeeds.speed2 ?? 0) : stats.miningSpeed;
  return f(f(f(speed) / f(100)) + stoneboundBonus(stats));
}

/** Why a Tinkers' tool is not held for a block; `notForBlock`: it is not made for it at all. */
export interface TinkersRefusal {
  readonly ok: false;
  readonly reason: string;
  readonly notForBlock: boolean;
}

/** A Tinkers' tool's level for a tool class (HarvestTool / DualHarvestTool.getHarvestLevel). */
function tinkersLevel(stats: TinkersStats, kind: ToolKind): number | null {
  const spec = TINKERS_TOOLS[stats.item];
  const i = (spec.kinds as readonly ToolKind[]).indexOf(kind);
  if (i < 0) return null;
  return i === 0 ? stats.harvestLevel : stats.harvestLevel2;
}

/**
 * The Tinkers' tool, as DIG_BLOCK would hold it for one block (`facts`: that very block's,
 * dig-time.ts digFacts), or why not. Replicates the server (TConstruct-1.13.57-GTNH, javap):
 *  - harvest: ForgeHooks.canHarvestBlock with HarvestTool.getHarvestLevel (InfiTool.HarvestLevel
 *    for its kind, 0 once Broken) or, for a block with no harvest tool (hardened clay),
 *    func_150897_b (an effective material);
 *  - speed: HarvestTool.getDigSpeed: 0.1 once Broken; on an effective block (its harvest tool
 *    is the tool's kind, or its material is one the tool digs) calcToolSpeed, but 0.1 when
 *    the block's level is above the tool's (calculateStrength); elsewhere 1, a hand's. The
 *    mattock (DualHarvestTool) by material only: its axe side with HarvestLevel and
 *    MiningSpeed, its shovel side with HarvestLevel2 and MiningSpeed2.
 *  - wear: AbilityHelper.damageTool adds 1 to InfiTool.Damage per dug block (hardness > 0;
 *    the hatchet also on hardness 0, never on leaves), less often with Reinforced; a use
 *    that takes Damage above TotalDurability breaks it (Broken: it then digs at 0.1 and
 *    harvests nothing until repaired).
 * The agent holds it only when it harvests the block, digs it faster than a hand, is not
 * broken, one more use leaves Damage at or below TotalDurability, and it neither auto-smelts
 * nor has Silk Touch (either would change what the dig drops). Never for a block that breaks
 * at once (hardness 0): a hand does as well. The speed is a lower bound (the server's float,
 * rounded down to 1/1000).
 */
export function tinkersTool(
  stats: TinkersStats,
  block: DiggableBlock,
  facts: DigFacts,
): { ok: true; tool: ToolInfo; damage: number } | TinkersRefusal {
  const refuse = (reason: string, notForBlock = false): TinkersRefusal => ({
    ok: false,
    reason: `${stats.item} ${reason}`,
    notForBlock,
  });
  const info = diggableInfo(block);
  const spec = TINKERS_TOOLS[stats.item];
  const kinds: readonly ToolKind[] = spec.kinds;
  // Which side digs the block: by material (the mattock only so, DualHarvestTool.getDigSpeed),
  // or, for the others, by Forge's harvest tool too (HarvestTool.isEffective).
  const side = spec.materials.findIndex((m) =>
    (m as readonly BlockMaterial[]).includes(info.material),
  );
  const effective =
    side >= 0 || (kinds.length === 1 && info.harvestTool !== null && kinds[0] === info.harvestTool);
  if (!effective) return refuse(`does not dig ${block} faster than a hand`, true);
  if (instantDig(block)) return refuse(`is not needed for ${block} (it breaks at once)`, true);
  if (stats.broken) return refuse('is broken (InfiTool.Broken)');
  if (stats.autoSmelt) return refuse('auto-smelts what it digs (the Lava modifier)');
  if (stats.silkTouch) return refuse('has Silk Touch: the block itself would drop');
  const rule = facts.harvest;
  if (rule !== null) {
    const level = tinkersLevel(stats, rule.tool);
    if (level === null || level < rule.level) {
      return refuse(
        `(${kinds.join(' and ')}, level ${level ?? stats.harvestLevel}) does not harvest ${block}: it needs ${describeHarvest(rule)}`,
      );
    }
  }
  // calculateStrength: a block above the tool's level digs at 0.1 (never reached for a block
  // whose rule the level met above; kept for the ground's level 0).
  const blockLevel = rule?.level ?? 0;
  const level = kinds.length === 2 && side === 1 ? stats.harvestLevel2 : stats.harvestLevel;
  if (blockLevel > level) return refuse(`(level ${level}) is too low for ${block}`);
  const speed = kinds.length === 2 ? calcDualToolSpeed(stats, side === 1) : calcToolSpeed(stats);
  const lower = Math.floor(speed * 1000) / 1000;
  if (!Number.isFinite(lower) || lower <= 1) {
    return refuse(`digs ${block} no faster than a hand (speed ${speed.toFixed(3)})`);
  }
  if (tinkersUsesLeft(stats) < 1) {
    return refuse(
      `is worn out (Damage ${stats.damage} of TotalDurability ${stats.totalDurability}: one more use breaks it)`,
    );
  }
  return {
    ok: true,
    damage: stats.damage,
    tool: {
      item: stats.item,
      kind: rule?.tool ?? kinds[Math.max(0, side)] ?? 'pickaxe',
      speed: lower,
      harvestLevel: rule === null ? level : (tinkersLevel(stats, rule.tool) ?? level),
      maxDamage: stats.totalDurability,
      digsFaster: [block],
      evidence:
        'Read from its NBT data (InfiTool: HarvestLevel, MiningSpeed, Damage, TotalDurability), ' +
        'as TConstruct-1.13.57-GTNH computes it (HarvestTool, AbilityHelper).',
    },
  };
}

/** A Tinkers' tool's wear after a dig, from its new NBT data: uses left, or null if unreadable. */
export function tinkersWear(item: string, root: NbtData): number | null {
  const read = readTinkersTool(item, root);
  return read.ok ? tinkersUsesLeft(read.stats) : null;
}

/**
 * Whether the carried items (inventory names, a worn vanilla tool with its damage appended)
 * include a tool that may harvest a block with rule `rule`, or why not: a vanilla tool of the
 * kind, level and wear (by its name); or a Tinkers' tool of the kind, whose level only its
 * NBT data shows (the client reads it, and refuses a dig the tool cannot harvest). `exclude`:
 * names never used (protected items).
 */
export function carriedHarvester(
  items: Readonly<Record<string, number>>,
  rule: HarvestRule,
  exclude: (name: string) => boolean = () => false,
): { ok: true; tool: string; levelKnown: boolean } | { ok: false; reason: string } {
  const lower: string[] = [];
  let unknownLevel: string | null = null;
  for (const [name, count] of Object.entries(items)) {
    if (count <= 0 || exclude(name)) continue;
    const vanilla = parseToolName(name);
    if (vanilla !== null) {
      if (vanilla.tool.kind !== rule.tool || usesLeft(vanilla.tool, vanilla.damage) < 1) continue;
      if (vanilla.tool.harvestLevel >= rule.level)
        return { ok: true, tool: name, levelKnown: true };
      lower.push(`${name} (level ${vanilla.tool.harvestLevel})`);
      continue;
    }
    const base = name.replace(/@\d+$/, '');
    if (
      isTinkersTool(base) &&
      (TINKERS_TOOLS[base].kinds as readonly ToolKind[]).includes(rule.tool)
    ) {
      unknownLevel ??= name;
    }
  }
  if (unknownLevel !== null) return { ok: true, tool: unknownLevel, levelKnown: false };
  return {
    ok: false,
    reason:
      `it needs ${describeHarvest(rule)}, and the player carries none` +
      (lower.length === 0 ? '' : ` (too low: ${lower.slice(0, 3).join(', ')})`),
  };
}
