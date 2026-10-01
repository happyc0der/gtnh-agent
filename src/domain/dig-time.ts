import type { DiggableBlock } from './blocks.ts';

/**
 * How long digging one allowlisted block takes, from the server's own rules (verified in the
 * test server's jars, docs/gtnh-compatibility.md "Digging" and "Tools"). Pure facts and
 * arithmetic, shared by the live client (which waits this long) and the planner prompt
 * (which tells the model what a tool saves).
 *
 *  - Progress per server tick = dig speed / hardness / 30 when the block can be harvested
 *    (1/100 when it cannot, and then nothing drops). An empty hand has speed 1; a tool has
 *    its own speed on the blocks it is made for (src/domain/tools.ts).
 *  - The server accepts the finish once progress x (ticks since the start + 1) >= 0.7.
 *  - The agent waits the vanilla client's time x 1.25 + 2 ticks: about twice what the server
 *    needs, so a slow server still accepts it, and waiting longer is always safe (the server
 *    only checks a minimum).
 */

/** Facts about an allowlisted block, from minecraft_server.1.7.10.jar (verified). */
export interface DiggableBlockInfo {
  /** Block.setHardness value. */
  hardness: number;
  /** Its material needs no tool: a bare hand digs it at 1/30 per hardness and it drops. */
  bareHandHarvests: boolean;
  /** Falls when the block below it goes (BlockFalling). */
  falls: boolean;
}

/**
 * The allowlist with its hardness. Hardness from Block.registerBlocks (grass 0.6, dirt 0.5,
 * sand 0.5, gravel 0.6, clay 0.6) and the BlockLog (2.0) / BlockLeaves (0.2) constructors;
 * materials wood, leaves, grass, ground, sand and clay do not require a tool.
 */
export const DIGGABLE: ReadonlyMap<DiggableBlock, DiggableBlockInfo> = new Map<
  DiggableBlock,
  DiggableBlockInfo
>([
  ['minecraft:log', { hardness: 2, bareHandHarvests: true, falls: false }],
  ['minecraft:log2', { hardness: 2, bareHandHarvests: true, falls: false }],
  ['minecraft:leaves', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['minecraft:leaves2', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  // Biomes O' Plenty 2.1.0 (javap): BlockBOPLeaves, BlockBOPColorizedLeaves,
  // BlockBOPAppleLeaves and BlockBOPPersimmonLeaves all extend BlockLeavesBase with
  // Material.leaves and setHardness(0.2F), with no tile entity and no collision effect.
  ['BiomesOPlenty:leaves1', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:leaves2', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:leaves3', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:leaves4', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:colorizedLeaves1', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:colorizedLeaves2', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:appleLeaves', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['BiomesOPlenty:persimmonLeaves', { hardness: 0.2, bareHandHarvests: true, falls: false }],
  ['minecraft:dirt', { hardness: 0.5, bareHandHarvests: true, falls: false }],
  ['minecraft:grass', { hardness: 0.6, bareHandHarvests: true, falls: false }],
  ['minecraft:sand', { hardness: 0.5, bareHandHarvests: true, falls: true }],
  ['minecraft:gravel', { hardness: 0.6, bareHandHarvests: true, falls: true }],
  ['minecraft:clay', { hardness: 0.6, bareHandHarvests: true, falls: false }],
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

function checkSpeed(speed: number): void {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error(`internal: bad dig speed ${speed}`);
}

/** Ticks of progress per full block, at `speed`: hardness x 30 (or x 100) / speed. */
function fullTicks(block: DiggableBlock, speed: number): number {
  checkSpeed(speed);
  const i = diggableInfo(block);
  return (i.hardness * (i.bareHandHarvests ? 30 : 100)) / speed;
}

/** Progress per server tick at `speed` (1 = an empty hand), on the ground, out of water, no potions. */
export function digProgressPerTick(block: DiggableBlock, speed: number = BARE_HAND_SPEED): number {
  checkSpeed(speed);
  const i = diggableInfo(block);
  return speed / i.hardness / (i.bareHandHarvests ? 30 : 100);
}

/** Progress per server tick with an empty hand. */
export function bareHandProgressPerTick(block: DiggableBlock): number {
  return digProgressPerTick(block, BARE_HAND_SPEED);
}

/** Ticks a vanilla client digs before it sends the finish (progress reaches 1). */
export function vanillaDigTicks(block: DiggableBlock, speed: number = BARE_HAND_SPEED): number {
  return Math.ceil(fullTicks(block, speed) - 1e-9);
}

/** The fewest ticks after the start at which the server accepts the finish. */
export function serverMinimumTicks(block: DiggableBlock, speed: number = BARE_HAND_SPEED): number {
  return Math.max(0, Math.ceil(SERVER_FINISH_FRACTION * fullTicks(block, speed) - 1 - 1e-9));
}

/** How long the agent digs before sending the finish, in ticks (vanilla time x 1.25 + 2). */
export function digWaitTicks(block: DiggableBlock, speed: number = BARE_HAND_SPEED): number {
  return Math.ceil(vanillaDigTicks(block, speed) * DIG_TIME_FACTOR - 1e-9) + DIG_EXTRA_TICKS;
}
