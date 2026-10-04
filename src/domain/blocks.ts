import { z } from 'zod';

/**
 * Natural blocks that a bare hand harvests (their material needs no tool): vanilla's, and
 * modded ones read in their mod's code to be the same (Biomes O' Plenty's leaves). Full
 * blocks, with no tile entity, never part of a build. With TOOL_DIGGABLE_BLOCKS, the dig
 * allowlist's solid part: what may touch a dug block (DIG_NEIGHBOURS in
 * src/bot/gtnh1710/digging.ts) is these, never a garden (a plant on a dug block drops).
 */
export const SOLID_DIGGABLE_BLOCKS = [
  'minecraft:log',
  'minecraft:log2',
  'minecraft:leaves',
  'minecraft:leaves2',
  'BiomesOPlenty:leaves1',
  'BiomesOPlenty:leaves2',
  'BiomesOPlenty:leaves3',
  'BiomesOPlenty:leaves4',
  'BiomesOPlenty:colorizedLeaves1',
  'BiomesOPlenty:colorizedLeaves2',
  'BiomesOPlenty:appleLeaves',
  'BiomesOPlenty:persimmonLeaves',
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
] as const;

/**
 * Natural stone that only a pickaxe harvests (material rock: anything else digs it at a third
 * of the speed and it drops nothing), checked in the test server's jars (src/domain/dig-time.ts
 * keeps each one's hardness, harvest level and natural metadata; docs/gtnh-compatibility.md,
 * "Tools"): vanilla stone (it drops cobblestone), cobblestone, mossy cobblestone, sandstone,
 * netherrack, hardened clay and the stained hardened clay of mesas, and the four stones
 * GregTech generates in the Overworld (GTStones: black and red granite, gt.blockgranites
 * metadata 0 and 8; marble and basalt, gt.blockstones 0 and 8). Full blocks with no tile
 * entity; the client digs only a natural block's metadata (never bricks or chiseled stone).
 * Never minecraft:monster_egg, which looks like stone and hides a silverfish.
 */
export const STONE_DIGGABLE_BLOCKS = [
  'minecraft:stone',
  'minecraft:cobblestone',
  'minecraft:mossy_cobblestone',
  'minecraft:sandstone',
  'minecraft:netherrack',
  'minecraft:hardened_clay',
  'minecraft:stained_hardened_clay',
  'gregtech:gt.blockgranites',
  'gregtech:gt.blockstones',
] as const;

/**
 * Ores a pickaxe of the ore's level harvests: GregTech's ores (gt.blockores, vein and small
 * ores alike: the world metadata is the harvest level, the material is in its tile entity,
 * BlockOresAbstract and TileEntityOres in gregtech 5.09.51.482), and the one vanilla ore that
 * still generates in GTNH 2.8.4: emerald ore, which vanilla's Extreme Hills and Biomes O'
 * Plenty's mountains place directly (no OreGenEvent for GT's disableVanillaOres to deny; the
 * others are denied: GTProxy.PREVENTED_ORES).
 */
export const ORE_DIGGABLE_BLOCKS = ['gregtech:gt.blockores', 'minecraft:emerald_ore'] as const;

/** The allowlisted blocks only a tool harvests: stone and ores. */
export const TOOL_DIGGABLE_BLOCKS = [...STONE_DIGGABLE_BLOCKS, ...ORE_DIGGABLE_BLOCKS] as const;
export type ToolDiggableBlock = (typeof TOOL_DIGGABLE_BLOCKS)[number];

/** GregTech's ore block: vein and small ores of every material share it. */
export const GT_ORE_BLOCK = 'gregtech:gt.blockores';

/**
 * Pam's HarvestCraft gardens on land (harvestcraft-1.3.2-GTNH, approved 2026-10-01 for food:
 * GTNH's quest "Sticks 'n Stones" sends a new player to them). Read in the mod's code
 * (javap; docs/gtnh-compatibility.md, "Food"): BlockGarden extends BlockFlower, so a garden
 * is a plant with no collision box and no tile entity; its registration sets no hardness, so
 * a hand breaks it at once (hardness 0: the server breaks it on the dig's start), and it
 * drops `gardendropAmount` (3, harvestcraft.cfg) of its produce, each a random one of its
 * kind's list (BlockGarden.getDropList). A right-click instead picks the garden up as a block
 * (onBlockActivated): the agent never right-clicks one. The water garden is left out: it
 * floats on water (BlockPamWaterGarden.canPlaceBlockOn), where its drop would fall into the
 * water the walker never enters.
 */
export const GARDEN_BLOCKS = [
  'harvestcraft:berrygarden',
  'harvestcraft:desertgarden',
  'harvestcraft:grassgarden',
  'harvestcraft:gourdgarden',
  'harvestcraft:groundgarden',
  'harvestcraft:herbgarden',
  'harvestcraft:leafygarden',
  'harvestcraft:mushroomgarden',
  'harvestcraft:stalkgarden',
  'harvestcraft:textilegarden',
  'harvestcraft:tropicalgarden',
] as const;
export type GardenBlock = (typeof GARDEN_BLOCKS)[number];

/**
 * The ONLY blocks DIG_BLOCK may break, by 1.7.10 registry name: the solid vanilla ones a hand
 * harvests, natural stone and ores (only with a tool that harvests them: src/domain/tools.ts),
 * and HarvestCraft's land gardens. Nothing else modded, nothing with a tile entity but a GT
 * ore, nothing that is part of a build. Each block's hardness, harvest rule, natural metadata
 * and falling behaviour are kept next to this list (src/domain/dig-time.ts); a test keeps the
 * two identical.
 */
export const DIGGABLE_BLOCKS = [
  ...SOLID_DIGGABLE_BLOCKS,
  ...TOOL_DIGGABLE_BLOCKS,
  ...GARDEN_BLOCKS,
] as const;

export const DiggableBlockSchema = z.enum(DIGGABLE_BLOCKS);
export type DiggableBlock = z.infer<typeof DiggableBlockSchema>;

export function isGardenBlock(name: string): name is GardenBlock {
  return (GARDEN_BLOCKS as readonly string[]).includes(name);
}

/** Stone or an ore: only a tool of the right kind and level harvests it. */
export function isToolDiggable(name: string): name is ToolDiggableBlock {
  return (TOOL_DIGGABLE_BLOCKS as readonly string[]).includes(name);
}

/** Blocks that fall when the block under them is removed (1.7.10 BlockFalling). */
export const FALLING_DIGGABLE_BLOCKS: ReadonlySet<DiggableBlock> = new Set<DiggableBlock>([
  'minecraft:sand',
  'minecraft:gravel',
]);

export function isDiggableBlock(name: string): name is DiggableBlock {
  return (DIGGABLE_BLOCKS as readonly string[]).includes(name);
}

/**
 * At most `max` of `nearestFirst`, shared fairly between kinds: every kind's nearest before
 * any kind's second nearest, and so on. The result stays nearest first. Seen live: on a
 * grassy hillside the 64 nearest blocks were 31 grass, 27 sand and 6 leaves, so the logs a
 * GATHER wanted were never listed. Only when there are more kinds than `max` is a kind left
 * out, the one whose nearest is farthest.
 */
export function nearestOfEachKind<T>(
  nearestFirst: readonly T[],
  kindOf: (item: T) => string,
  max: number,
): T[] {
  if (nearestFirst.length <= max) return [...nearestFirst];
  const seen = new Map<string, number>();
  return nearestFirst
    .map((item, order) => {
      const kind = kindOf(item);
      const rank = seen.get(kind) ?? 0;
      seen.set(kind, rank + 1);
      return { item, order, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.order - b.order)
    .map((r) => r.item);
}

/**
 * Stations the agent places to use them (approved 2026-09-30): GTNH's crafting table (3x3
 * recipes are crafted there) and the vanilla furnace. Vanilla blocks with a GUI: the
 * table's right-click opens its window and nothing else (BlockWorkbench, no tile entity);
 * the furnace's keeps its items in a tile entity. Each stands on a solid floor beside the
 * player, never where it walks (src/bot/gtnh1710/placing.ts checkStation); once placed it is
 * one the agent sees and uses like any other (`crafting_table:<x>.<y>.<z>`, a furnace in
 * the interactables).
 */
export const STATION_ITEMS = ['minecraft:crafting_table', 'minecraft:furnace'] as const;

/**
 * The ONLY items PLACE_BLOCK may place, by the name the inventory reports (`@damage` for the
 * wood types): plain full vanilla blocks a bare player gets early, and the two stations
 * (STATION_ITEMS). Nothing modded, nothing with a redstone function, no other block with a
 * tile entity or a GUI. Each becomes the block of the same registry name (placedBlockOf);
 * the live client keeps the rules for where they may go in src/bot/gtnh1710/placing.ts.
 */
export const PLACEABLE_ITEMS = [
  'minecraft:dirt',
  'minecraft:cobblestone',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:sandstone',
  'minecraft:planks',
  'minecraft:planks@1',
  'minecraft:planks@2',
  'minecraft:planks@3',
  'minecraft:planks@4',
  'minecraft:planks@5',
  'minecraft:log',
  'minecraft:log@1',
  'minecraft:log@2',
  'minecraft:log@3',
  'minecraft:log2',
  'minecraft:log2@1',
  ...STATION_ITEMS,
] as const;

export const PlaceableItemSchema = z.enum(PLACEABLE_ITEMS);
export type PlaceableItem = z.infer<typeof PlaceableItemSchema>;

/** The blocks the placeable items become, by 1.7.10 registry name. */
export const PLACEABLE_BLOCKS = [
  'minecraft:dirt',
  'minecraft:cobblestone',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:sandstone',
  'minecraft:planks',
  'minecraft:log',
  'minecraft:log2',
  ...STATION_ITEMS,
] as const;

export const PlaceableBlockSchema = z.enum(PLACEABLE_BLOCKS);
export type PlaceableBlock = z.infer<typeof PlaceableBlockSchema>;

/** Placeable blocks that fall when nothing holds them up (1.7.10 BlockFalling). */
export const FALLING_PLACEABLE_BLOCKS: ReadonlySet<PlaceableBlock> = new Set<PlaceableBlock>([
  'minecraft:sand',
  'minecraft:gravel',
]);

export function isPlaceableItem(name: string): name is PlaceableItem {
  return (PLACEABLE_ITEMS as readonly string[]).includes(name);
}

export function isPlaceableBlock(name: string): name is PlaceableBlock {
  return (PLACEABLE_BLOCKS as readonly string[]).includes(name);
}

/** The block a placeable item becomes: its name without the `@damage` (the wood type). */
export function placedBlockOf(item: PlaceableItem): PlaceableBlock {
  return PlaceableBlockSchema.parse(item.replace(/@\d+$/, ''));
}

/** Sand and gravel: they fall unless a full block holds them up. */
export function fallsWhenPlaced(item: PlaceableItem): boolean {
  return FALLING_PLACEABLE_BLOCKS.has(placedBlockOf(item));
}

/** A crafting table or a furnace (STATION_ITEMS): placed to be used, on a solid floor. */
export function isStationItem(item: string): boolean {
  return (STATION_ITEMS as readonly string[]).includes(item);
}
