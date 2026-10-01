import type { WalkWorld } from './walking.ts';

/**
 * Blocks the player's body may pass through, and the rule the walkers apply to every block the
 * body would touch. Pure.
 *
 * Every entry was checked in the classes the test server runs (GTNH 2.8.4: the vanilla server
 * jar, Forge's 1.7.10 patches and the mod jars, with javap on 2026-10-01; evidence in
 * docs/gtnh-compatibility.md, "Walking through plants"):
 *  - no collision box: getCollisionBoundingBoxFromPool (func_149668_a) returns null (BlockBush's,
 *    which most plants here extend, or the block's own), and nothing overrides
 *    addCollisionBoxesToList (func_149743_a), the only other source of boxes;
 *  - nothing happens on contact: onEntityCollidedWithBlock (func_149670_a), which the server
 *    calls for every block the body overlaps, is Block's empty one, or acts only on metadata
 *    not listed;
 *  - no Forge patch or mixin in the pack changes either (Forge's patches and every mod jar
 *    were searched: the mixins on these classes hook growth, drops, shearing or rendering).
 * Anything else is a wall (fail closed): every other block, an unnamed id, a variant not
 * listed, and a variant whose metadata is not known.
 */

/** Passable whatever their metadata. */
export const PASSABLE_BLOCKS: ReadonlySet<string> = new Set([
  'minecraft:air',
  // Vanilla plants, all BlockBush.
  'minecraft:tallgrass',
  'minecraft:yellow_flower',
  'minecraft:red_flower',
  'minecraft:double_plant',
  'minecraft:deadbush',
  'minecraft:sapling',
  'minecraft:brown_mushroom',
  'minecraft:red_mushroom',
  // Sugar cane (BlockReed, whose box is null too).
  'minecraft:reeds',
  // BlockVine: no box. Forge makes vines a ladder (BlockVine.isLadder), which only a client's
  // own physics use (a slower walk, a climb at a wall). The server's movement check
  // (NetHandlerPlayServer.processPlayer, as Forge patches it) re-runs moveEntity, which vines
  // do not stop, and never asks isOnLadder; no mixin on it does. So a walk through hanging
  // vines on the ground is accepted as it is sent.
  'minecraft:vine',
  // BiomesOPlenty 2.1.0.2308: its mushrooms (BlockBOPMushroom extends BlockBush), and its
  // vines (BlockIvy, BlockWillow, BlockTreeMoss, BlockFlowerVine and BlockMoss extend
  // BlockVine and add no box or contact effect: vines, as above).
  'BiomesOPlenty:mushrooms',
  'BiomesOPlenty:ivy',
  'BiomesOPlenty:willow',
  'BiomesOPlenty:treeMoss',
  'BiomesOPlenty:flowerVine',
  'BiomesOPlenty:moss',
  // Natura 2.8.9: wild barley and cotton (CropBlock extends BlockBush) and bluebells
  // (FlowerBlock extends BlockFlower).
  'Natura:N Crops',
  'Natura:Bluebells',
  // Pam's HarvestCraft 1.3.2-GTNH gardens (BlockGarden extends BlockFlower).
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
  'harvestcraft:watergarden',
]);

/** Metadata 0 .. count-1 except `refused`. */
function variantsBut(count: number, refused: readonly number[]): ReadonlySet<number> {
  return new Set(Array.from({ length: count }, (_, m) => m).filter((m) => !refused.includes(m)));
}

/**
 * Blocks whose variants share one id, passable only at the metadata listed. Every other value,
 * and an unknown one, is a wall: the harmful variants hurt only a body inside their cell, so
 * they are not hazards next to it (block-hazards.ts), only never walked into.
 */
export const PASSABLE_BY_METADATA: ReadonlyMap<string, ReadonlySet<number>> = new Map([
  // BiomesOPlenty 2.1.0.2308 BlockBOPFoliage (extends BOPBlockWorldDecor extends BlockBush):
  // duckweed, short and medium grass, flax (both halves), bush, sprout, berry bush, shrub,
  // wheat grass, damp grass, koru, clover patch, leaf piles. Not 7, poison ivy: Poison for 5 s
  // to a player missing boots or leggings (the agent wears no armour). Seen live 2026-10-01:
  // a Hot Forest hillside's foliage walled in logs 7 blocks away.
  ['BiomesOPlenty:foliage', variantsBut(16, [7])],
  // BlockBOPFlower: not 2, deadbloom (Wither for 10 s unless in leather boots and leggings).
  ['BiomesOPlenty:flowers', variantsBut(16, [2])],
  // BlockBOPFlower2 has 9 variants: not 2, burning blossom (sets the player on fire).
  ['BiomesOPlenty:flowers2', variantsBut(9, [2])],
  // BlockBOPPlant: not 5 (thorn) or 12 (cactus), which hurt like a cactus unless in leather
  // boots and leggings.
  ['BiomesOPlenty:plants', variantsBut(16, [5, 12])],
  // BlockSnow's box is (metadata & 7) eighths of a block high: one layer (0) is flat, at the
  // top of the block under it, so the feet stay there; a thicker layer would lift them.
  ['minecraft:snow_layer', new Set([0])],
]);

/** A block's name for messages: with its metadata (name@meta) where that decides passing. */
export function variantName(
  world: WalkWorld,
  x: number,
  y: number,
  z: number,
  name: string,
): string {
  if (!PASSABLE_BY_METADATA.has(name)) return name;
  const meta = world.metaAt?.(x, y, z);
  return meta === undefined ? name : `${name}@${meta}`;
}

/**
 * Why the body could not pass through block (x, y, z), or null: air, a block on
 * PASSABLE_BLOCKS, or one on PASSABLE_BY_METADATA with a listed metadata the world reports.
 */
export function passProblem(world: WalkWorld, x: number, y: number, z: number): string | null {
  const id = world.blockAt(x, y, z);
  if (id === undefined) return 'chunk not loaded';
  if (id === 0) return null;
  const name = world.blockName(id);
  if (name === undefined) return `blocked by unnamed block id ${id}`;
  if (PASSABLE_BLOCKS.has(name)) return null;
  const variants = PASSABLE_BY_METADATA.get(name);
  if (variants === undefined) return `blocked by ${name}`;
  const meta = world.metaAt?.(x, y, z);
  if (meta === undefined) return `blocked by ${name} (its metadata is not known)`;
  return variants.has(meta) ? null : `blocked by ${name}@${meta}`;
}
