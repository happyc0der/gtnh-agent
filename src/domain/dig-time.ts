import { GARDEN_BLOCKS, GT_ORE_BLOCK, type DiggableBlock } from './blocks.ts';

/**
 * How long digging one allowlisted block takes, and what harvests it, from the server's own
 * rules (verified in the test server's jars, docs/gtnh-compatibility.md "Digging" and
 * "Tools"). Pure facts and arithmetic, shared by the live client (which waits this long), the
 * safety policy (what a carried tool must be), the route book and the planner prompt (which
 * tells the model what a tool saves).
 *
 *  - Progress per server tick = dig speed / hardness / 30 when the player can harvest the
 *    block (ForgeHooks.blockStrength), and / 100 when it cannot: then nothing drops. An empty
 *    hand has speed 1; a tool has its own speed on the blocks it is made for
 *    (src/domain/tools.ts). The agent digs only what the held item harvests (a hand, for a
 *    block whose material needs no tool; else a tool of the block's kind and level), so the
 *    times below are for a harvesting dig.
 *  - The server accepts the finish once progress x (ticks since the start + 1) >= 0.7.
 *  - The agent waits the vanilla client's time x 1.25 + 2 ticks: about twice what the server
 *    needs, so a slow server still accepts it, and waiting longer is always safe (the server
 *    only checks a minimum).
 *  - Hardness 0 (HarvestCraft's gardens) breaks at once: ItemInWorldManager.onBlockClicked
 *    harvests a block whose relative hardness is at least 1 on the dig's start (C07 status 0),
 *    and a vanilla client then sends no finish (PlayerControllerMP.clickBlock destroys it
 *    itself). The client does the same for such a block (instantDig).
 */

/** A tool class, as Forge names it (Block.getHarvestTool, Item.getToolClasses). */
export type ToolKind = 'pickaxe' | 'shovel' | 'axe';

/**
 * What harvests a block whose material needs a tool: a tool of `tool`'s class whose harvest
 * level for it is at least `level` (ForgeHooks.canHarvestBlock). A lower level, another tool
 * or a hand digs it at a third of the speed and it drops nothing, so the agent never digs it.
 */
export interface HarvestRule {
  readonly tool: ToolKind;
  readonly level: number;
}

/**
 * A block's material, as the tools see it (1.7.10 Material): ItemPickaxe digs rock fast,
 * TConstruct's tools by their effective materials (HarvestTool.isEffective).
 */
export type BlockMaterial =
  'wood' | 'leaves' | 'ground' | 'grass' | 'sand' | 'clay' | 'plants' | 'rock';

/** Facts about an allowlisted block, from the jars (verified). */
export interface DiggableBlockInfo {
  /**
   * Block.setHardness value. GT ores' depends on their metadata (digFacts): this is the
   * hardest natural one, so a time computed from it alone is never too short.
   */
  hardness: number;
  /** Its material needs no tool: a bare hand digs it at 1/30 per hardness and it drops. */
  bareHandHarvests: boolean;
  /** Falls when the block below it goes (BlockFalling). */
  falls: boolean;
  material: BlockMaterial;
  /**
   * Forge's harvest tool for the block (ForgeHooks.initTools gives ItemPickaxe's, ItemSpade's
   * and ItemAxe's block sets theirs; GregTech's blocks answer their own), or null.
   */
  harvestTool: ToolKind | null;
  /** What harvests it (null: anything, a hand too). GT ores: by metadata (digFacts). */
  harvest: HarvestRule | null;
  /**
   * The metadata a natural block of this kind has (world generation's), when others exist
   * that are part of builds (chiseled sandstone, granite bricks) or unknown; absent: any.
   * The client digs only these, and reads the metadata first (none known: no dig).
   */
  naturalMeta?: readonly number[];
}

const soft = (
  hardness: number,
  material: BlockMaterial,
  harvestTool: ToolKind | null,
  falls = false,
): DiggableBlockInfo => ({
  hardness,
  bareHandHarvests: true,
  falls,
  material,
  harvestTool,
  harvest: null,
});

const pickaxe = (
  hardness: number,
  level: number,
  naturalMeta: readonly number[] | null,
  harvestTool: ToolKind | null = 'pickaxe',
): DiggableBlockInfo => ({
  hardness,
  bareHandHarvests: false,
  falls: false,
  material: 'rock',
  harvestTool,
  harvest: { tool: 'pickaxe', level },
  ...(naturalMeta === null ? {} : { naturalMeta }),
});

/** GT ore metadata the world generates: max(base, min(7, tool quality)), base 0 or 3. */
const GT_ORE_METAS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/**
 * The allowlist with its facts. Hardness from Block.registerBlocks (grass 0.6, dirt 0.5,
 * sand 0.5, gravel 0.6, clay 0.6, stone 1.5, cobblestone 2.0, sandstone 0.8, mossy
 * cobblestone 2.0, netherrack 0.4, emerald ore 3.0, stained and plain hardened clay 1.25) and
 * the BlockLog (2.0) / BlockLeaves (0.2) constructors; materials wood, leaves, grass, ground,
 * sand and clay do not require a tool, rock does. Harvest levels: IguanaTweaks'
 * BlockDefaults.cfg (stone, cobblestone, mossy cobblestone, sandstone, netherrack 0, emerald
 * ore 4; hardened clay has no harvest tool, and ItemPickaxe.canHarvestBlock takes any rock),
 * GregTech's own methods for its blocks (BlockStonesAbstract: hardness 3 x stone's, granites
 * level 3, marble and basalt 2; BlockOresAbstract: see gtOreHarvestLevel).
 */
export const DIGGABLE: ReadonlyMap<DiggableBlock, DiggableBlockInfo> = new Map<
  DiggableBlock,
  DiggableBlockInfo
>([
  ['minecraft:log', soft(2, 'wood', 'axe')],
  ['minecraft:log2', soft(2, 'wood', 'axe')],
  ['minecraft:leaves', soft(0.2, 'leaves', null)],
  ['minecraft:leaves2', soft(0.2, 'leaves', null)],
  // Biomes O' Plenty 2.1.0 (javap): BlockBOPLeaves, BlockBOPColorizedLeaves,
  // BlockBOPAppleLeaves and BlockBOPPersimmonLeaves all extend BlockLeavesBase with
  // Material.leaves and setHardness(0.2F), with no tile entity and no collision effect.
  ['BiomesOPlenty:leaves1', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:leaves2', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:leaves3', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:leaves4', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:colorizedLeaves1', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:colorizedLeaves2', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:appleLeaves', soft(0.2, 'leaves', null)],
  ['BiomesOPlenty:persimmonLeaves', soft(0.2, 'leaves', null)],
  ['minecraft:dirt', soft(0.5, 'ground', 'shovel')],
  ['minecraft:grass', soft(0.6, 'grass', 'shovel')],
  ['minecraft:sand', soft(0.5, 'sand', 'shovel', true)],
  ['minecraft:gravel', soft(0.6, 'sand', 'shovel', true)],
  ['minecraft:clay', soft(0.6, 'clay', 'shovel')],
  // Material rock (awt.e): a pickaxe harvests them. Natural metadata: 1.7.10 stone,
  // cobblestone, mossy cobblestone, netherrack, hardened clay and emerald ore have only 0;
  // sandstone 0 is the desert's (1 chiseled, 2 smooth: temples); stained clay is a mesa's
  // bands, every colour.
  ['minecraft:stone', pickaxe(1.5, 0, [0])],
  ['minecraft:cobblestone', pickaxe(2, 0, [0])],
  ['minecraft:mossy_cobblestone', pickaxe(2, 0, [0])],
  ['minecraft:sandstone', pickaxe(0.8, 0, [0])],
  ['minecraft:netherrack', pickaxe(0.4, 0, [0])],
  ['minecraft:hardened_clay', pickaxe(1.25, 0, [0], null)],
  ['minecraft:stained_hardened_clay', pickaxe(1.25, 0, null, null)],
  // GregTech 5.09.51.482: BlockStonesAbstract (Material.rock, harvest tool "pickaxe",
  // hardness Blocks.stone's x 3); WorldgenStone puts black granite at metadata 0, red granite
  // 8 (gt.blockgranites, level 3), marble 0 and basalt 8 (gt.blockstones, level 2).
  ['gregtech:gt.blockgranites', pickaxe(4.5, 3, [0, 8])],
  ['gregtech:gt.blockstones', pickaxe(4.5, 2, [0, 8])],
  // GT ores: the hardest natural one's hardness (metadata 7: 8) and the least level any
  // needs (metadata 0: a pickaxe of level 0), the bounds when the metadata is not known (the
  // observation's view); digFacts gives each ore its own from its metadata.
  ['gregtech:gt.blockores', pickaxe(8, 0, GT_ORE_METAS)],
  ['minecraft:emerald_ore', pickaxe(3, 4, [0])],
  // HarvestCraft's land gardens: BlockGarden (BlockFlower, Material.plants) with no hardness
  // set in BlockRegistry (javap of harvestcraft-1.3.2-GTNH), so Block's default 0.
  ...GARDEN_BLOCKS.map((b): [DiggableBlock, DiggableBlockInfo] => [b, soft(0, 'plants', null)]),
]);

export const TICK_MS = 50;
/** The server accepts a finish at this fraction of the full dig progress. */
export const SERVER_FINISH_FRACTION = 0.7;
/** The agent digs this multiple of the vanilla client's time, plus DIG_EXTRA_TICKS. */
export const DIG_TIME_FACTOR = 1.25;
export const DIG_EXTRA_TICKS = 2;
/** An empty hand's dig speed (EntityPlayer.getBreakSpeed with no item). */
export const BARE_HAND_SPEED = 1;

export function diggableInfo(block: DiggableBlock): DiggableBlockInfo {
  const i = DIGGABLE.get(block);
  if (i === undefined) throw new Error(`internal: no dig facts for ${block}`);
  return i;
}

/**
 * A GT ore's pickaxe level from its world metadata: BlockOresAbstract.getHarvestLevel(meta)
 * is meta % 8, except that 5 and 6 give 2 (gregtech 5.09.51.482). The metadata itself is
 * TileEntityOres.getHarvestData: max(the stone's base level, min(7, the material's tool
 * quality, less 1 for a small ore)); the base is 3 in black and red granite, else 0.
 */
export function gtOreHarvestLevel(meta: number): number {
  return meta === 5 || meta === 6 ? 2 : meta % 8;
}

/** One block in the world, as a dig sees it: its hardness and what harvests it. */
export interface DigFacts {
  readonly hardness: number;
  readonly harvest: HarvestRule | null;
}

/**
 * The facts of `block` with world metadata `meta` (undefined: not known), or why the agent
 * does not dig it: a block told apart by its metadata whose metadata is not known, or not a
 * natural one (bricks, chiseled sandstone, a GT ore above 7, whose harvest tool would be a
 * shovel: getHarvestTool(meta) is "pickaxe" only below 8). A GT ore's level and hardness
 * come from its metadata (BlockOresAbstract: hardness 1 + level).
 */
export function digFacts(
  block: DiggableBlock,
  meta: number | undefined,
): DigFacts | { problem: string } {
  const info = diggableInfo(block);
  if (info.naturalMeta !== undefined) {
    if (meta === undefined) {
      return { problem: `the metadata of ${block} is not known (a natural one is told by it)` };
    }
    if (!info.naturalMeta.includes(meta)) {
      return { problem: `${block} with metadata ${meta} is not a natural one (part of a build?)` };
    }
  }
  if (block === GT_ORE_BLOCK && meta !== undefined) {
    const level = gtOreHarvestLevel(meta);
    return { hardness: 1 + level, harvest: { tool: 'pickaxe', level } };
  }
  return { hardness: info.hardness, harvest: info.harvest };
}

/** A block the server breaks on the dig's start (hardness 0): no finish is sent. */
export function instantDig(block: DiggableBlock): boolean {
  return diggableInfo(block).hardness === 0;
}

function checkSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`internal: bad dig speed ${speed}`);
}

/**
 * Ticks of progress per full block, at `speed`: hardness x 30 / speed for a harvesting dig
 * (x 100 for one that does not harvest, which the agent never makes). `hardness`: the
 * block's own (digFacts) when it is not the table's.
 */
function fullTicks(
  block: DiggableBlock,
  speed: number,
  hardness: number = diggableInfo(block).hardness,
): number {
  checkSpeed(speed);
  return (hardness * 30) / speed;
}

/**
 * Progress per server tick at `speed` (1 = an empty hand), harvesting, on the ground, out of
 * water, no potions. Infinity for an instant block (hardness 0), as the server's float
 * division gives.
 */
export function digProgressPerTick(
  block: DiggableBlock,
  speed: number = BARE_HAND_SPEED,
  hardness: number = diggableInfo(block).hardness,
): number {
  checkSpeed(speed);
  if (hardness === 0) return Infinity;
  return speed / hardness / 30;
}

/** Progress per server tick with an empty hand, for a block a hand harvests. */
export function bareHandProgressPerTick(block: DiggableBlock): number {
  return digProgressPerTick(block, BARE_HAND_SPEED);
}

/** Ticks a vanilla client digs before it sends the finish (progress reaches 1). */
export function vanillaDigTicks(
  block: DiggableBlock,
  speed: number = BARE_HAND_SPEED,
  hardness?: number,
): number {
  return Math.ceil(fullTicks(block, speed, hardness) - 1e-9);
}

/** The fewest ticks after the start at which the server accepts the finish. */
export function serverMinimumTicks(
  block: DiggableBlock,
  speed: number = BARE_HAND_SPEED,
  hardness?: number,
): number {
  return Math.max(
    0,
    Math.ceil(SERVER_FINISH_FRACTION * fullTicks(block, speed, hardness) - 1 - 1e-9),
  );
}

/**
 * How long the agent digs before sending the finish, in ticks (vanilla time x 1.25 + 2), at
 * `speed`, for the block's own `hardness` when given (a GT ore's depends on its metadata:
 * digFacts), else the table's.
 */
export function digWaitTicks(
  block: DiggableBlock,
  speed: number = BARE_HAND_SPEED,
  hardness?: number,
): number {
  return (
    Math.ceil(vanillaDigTicks(block, speed, hardness) * DIG_TIME_FACTOR - 1e-9) + DIG_EXTRA_TICKS
  );
}
