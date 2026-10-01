import type { DiggableBlock } from './blocks.ts';

/**
 * The ONLY tools DIG_BLOCK may hold, with their verified speed and wear on the test server
 * (GTNH 2.8.4; evidence in docs/gtnh-compatibility.md, "Tools"). Anything else in the
 * inventory is never used for digging: the client digs with the best usable tool here, or
 * with an empty hand.
 *
 * What a tool does, server side (vanilla 1.7.10 with Forge's patches, checked in the jars):
 *  - Speed: ItemTool.getDigSpeed gives the tool material's efficiency on the blocks it is
 *    made for (ItemSpade's block set, ItemAxe's wood material, or Forge's harvest tool), and
 *    1 (an empty hand's speed) on anything else.
 *  - Wear: ItemTool.onBlockDestroyed damages the tool by 1 for every block with a hardness
 *    above 0 (all allowlisted blocks). The damage is the item stack's damage value. A use
 *    that takes the damage above the item's maximum breaks the tool (the stack is
 *    destroyed); the block still breaks and drops as usual.
 *  - It breaks one block. No vanilla tool or mod handler on this server breaks more
 *    (vanilla tools do not override onBlockStartBreak; no BreakEvent handler looks at them).
 *
 * The agent uses a tool only while one more use leaves its damage at or below `maxDamage`,
 * only without NBT data (enchantments or other data it cannot read), and never a protected
 * item.
 */

export const TOOL_ITEMS = [
  'minecraft:wooden_shovel',
  'minecraft:wooden_axe',
  'minecraft:stone_axe',
  'minecraft:iron_axe',
  'minecraft:golden_axe',
  'minecraft:diamond_axe',
] as const;
export type ToolItem = (typeof TOOL_ITEMS)[number];

export interface ToolInfo {
  readonly item: ToolItem;
  readonly kind: 'shovel' | 'axe';
  /**
   * Dig speed on the blocks in `digsFaster` (an empty hand has 1). A verified lower bound:
   * the dig wait is computed from it, and a faster tool only makes the wait longer than
   * needed, which the server always accepts.
   */
  readonly speed: number;
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

const WOODEN =
  'Vanilla 1.7.10 ToolMaterial.WOOD: efficiency 2, 59 uses. GregTech changedWoodenVanillaTools=true ' +
  '(test server GregTech.cfg) raises the maximum damage to 64 (GTPostLoad.changeWoodenVanillaTools; ' +
  'GregTech.log "Updating Vanilla Wooden Tools"); its mixin that would raise the speed to 4 is not ' +
  'loaded on this server (fml-server-latest.log: "Not loading ... minecraft.ItemToolMaterialMixin"). ' +
  'The agent assumes the lower values (speed 2, 59), which hold either way. Usable: not on ' +
  "IguanaTweaks' disabled-tool list (IguanaTinkerTweaks/main.cfg).";
const AXE = (material: string, speed: number, uses: number): string =>
  `Vanilla 1.7.10 ToolMaterial.${material}: efficiency ${speed}, ${uses} uses; no mod changes ` +
  "either. Usable: axes are not on IguanaTweaks' disabled-tool list (IguanaTinkerTweaks/main.cfg).";

export const TOOLS: Readonly<Record<ToolItem, ToolInfo>> = {
  'minecraft:wooden_shovel': {
    item: 'minecraft:wooden_shovel',
    kind: 'shovel',
    speed: 2,
    maxDamage: 59,
    digsFaster: SHOVEL_BLOCKS,
    evidence: WOODEN,
  },
  'minecraft:wooden_axe': {
    item: 'minecraft:wooden_axe',
    kind: 'axe',
    speed: 2,
    maxDamage: 59,
    digsFaster: AXE_BLOCKS,
    evidence: WOODEN,
  },
  'minecraft:stone_axe': {
    item: 'minecraft:stone_axe',
    kind: 'axe',
    speed: 4,
    maxDamage: 131,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('STONE', 4, 131),
  },
  'minecraft:iron_axe': {
    item: 'minecraft:iron_axe',
    kind: 'axe',
    speed: 6,
    maxDamage: 250,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('IRON', 6, 250),
  },
  'minecraft:golden_axe': {
    item: 'minecraft:golden_axe',
    kind: 'axe',
    speed: 12,
    maxDamage: 32,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('GOLD', 12, 32),
  },
  'minecraft:diamond_axe': {
    item: 'minecraft:diamond_axe',
    kind: 'axe',
    speed: 8,
    maxDamage: 1561,
    digsFaster: AXE_BLOCKS,
    evidence: AXE('EMERALD (diamond)', 8, 1561),
  },
};

/** The tool facts for a registry name (without `@damage`), or null when it is not a tool here. */
export function toolInfo(item: string): ToolInfo | null {
  return (TOOL_ITEMS as readonly string[]).includes(item) ? TOOLS[item as ToolItem] : null;
}

/** The tool's speed on `block`, or null when it does not dig that block faster than a hand. */
export function toolSpeedOn(tool: ToolInfo, block: DiggableBlock): number | null {
  return tool.digsFaster.includes(block) ? tool.speed : null;
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
 * the agent cannot read).
 */
export function toolProblem(
  stack: ToolStack & { readonly count: number; readonly hasNbt: boolean },
  block: DiggableBlock,
): string | null {
  const { tool, damage } = stack;
  if (toolSpeedOn(tool, block) === null) return `${tool.item} does not dig ${block} faster`;
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
