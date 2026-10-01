import { z } from 'zod';

/**
 * The ONLY blocks DIG_BLOCK may break, by 1.7.10 registry name: vanilla natural blocks
 * that a bare hand harvests (their material needs no tool). Nothing modded, nothing with a
 * tile entity, nothing that is part of a build. The live client keeps each block's hardness
 * and falling behaviour next to this list (src/bot/gtnh1710/digging.ts); a test keeps the
 * two identical.
 */
export const DIGGABLE_BLOCKS = [
  'minecraft:log',
  'minecraft:log2',
  'minecraft:leaves',
  'minecraft:leaves2',
  'minecraft:dirt',
  'minecraft:grass',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
] as const;

export const DiggableBlockSchema = z.enum(DIGGABLE_BLOCKS);
export type DiggableBlock = z.infer<typeof DiggableBlockSchema>;

/** Blocks that fall when the block under them is removed (1.7.10 BlockFalling). */
export const FALLING_DIGGABLE_BLOCKS: ReadonlySet<DiggableBlock> = new Set<DiggableBlock>([
  'minecraft:sand',
  'minecraft:gravel',
]);

export function isDiggableBlock(name: string): name is DiggableBlock {
  return (DIGGABLE_BLOCKS as readonly string[]).includes(name);
}

/**
 * The ONLY items PLACE_BLOCK may place, by the name the inventory reports (`@damage` for the
 * wood types): plain full vanilla blocks a bare player gets early. Nothing modded, nothing
 * with a tile entity, a GUI or a redstone function. Each becomes the block of the same
 * registry name (placedBlockOf); the live client keeps the rules for where they may go in
 * src/bot/gtnh1710/placing.ts.
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
