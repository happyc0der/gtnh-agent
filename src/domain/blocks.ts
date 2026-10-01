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
