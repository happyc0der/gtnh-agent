import type { Hazard } from '../../domain/game-state.ts';
import type { Registry } from './registry.ts';

export type BlockHazardKind = Exclude<Hazard['kind'], 'void'>;

/**
 * Blocks to keep away from, by registry name, for GTNH 2.8.4. Built on 2026-09-30 by
 * reviewing every block name in the pack's registry that matched burning, fluid, poison or
 * contact-damage keywords (156 + 96 candidates). Chosen conservatively: when unsure whether a
 * block hurts (e.g. IC2 hot water, campfires), it is listed. Decorative look-alikes are
 * deliberately NOT listed: Forestry "Fireproof" wood, firefly jars, lava/void-stone, lava
 * tanks, wall markings, trapdoors, cobwebs (which slow but do not damage).
 */
const EXACT: ReadonlyMap<string, BlockHazardKind> = new Map<string, BlockHazardKind>([
  // Burning liquids and hot blocks
  ['minecraft:lava', 'lava'],
  ['minecraft:flowing_lava', 'lava'],
  ['IC2:fluidPahoehoeLava', 'lava'],
  ['IC2:fluidHotCoolant', 'lava'],
  ['IC2:fluidHotWater', 'lava'],
  ['IC2:fluidSteam', 'lava'],
  ['IC2:fluidSuperheatedSteam', 'lava'],
  ['Railcraft:fluid.steam', 'lava'],
  ['BuildCraft|Energy:blockRedPlasma', 'lava'],
  ['miscutils:FluidPyrotheum', 'lava'],
  ['thaumicbases:pyrofluid', 'lava'],
  ['etfuturum:magma', 'lava'],
  ['etfuturum:lava_cauldron', 'lava'],
  // Open flames
  ['minecraft:fire', 'fire'],
  ['miscutils:blockHellFire', 'fire'],
  ['TwilightForest:tile.TFFireJet', 'fire'],
  ['ThaumicTinkerer:fireAir', 'fire'],
  ['ThaumicTinkerer:fireChaos', 'fire'],
  ['ThaumicTinkerer:fireEarth', 'fire'],
  ['ThaumicTinkerer:fireFire', 'fire'],
  ['ThaumicTinkerer:fireOrder', 'fire'],
  ['ThaumicTinkerer:fireWater', 'fire'],
  ['adventurebackpack:blockCampFire', 'fire'],
  ['thaumicbases:campfire', 'fire'],
  // Poisonous, corrosive or otherwise harmful fluids and gases
  ['Thaumcraft:blockFluxGoo', 'harmful_fluid'],
  ['Thaumcraft:blockFluxGas', 'harmful_fluid'],
  ['Thaumcraft:blockFluidDeath', 'harmful_fluid'],
  ['BiomesOPlenty:poison', 'harmful_fluid'],
  ['ToxicEverglades:fluidSludge', 'harmful_fluid'],
  ['miscutils:miscutils_fluidBlockSludge', 'harmful_fluid'],
  ['miscutils:FluidCryotheum', 'harmful_fluid'],
  ['HardcoreEnderExpansion:ender_goo', 'harmful_fluid'],
  ['dreamcraft:dreamcraft_NitricAcid', 'harmful_fluid'],
  ['gendustry:fluid.Mutagen', 'harmful_fluid'],
  ['witchery:brewliquid', 'harmful_fluid'],
  ['EMT:electricCloud', 'harmful_fluid'],
  // Blocks that hurt on contact
  ['minecraft:cactus', 'damaging_block'],
  ['witchery:cactus', 'damaging_block'],
  ['thaumicbases:rainbowCactus', 'damaging_block'],
  ['etfuturum:sweet_berry_bush', 'damaging_block'],
  ['etfuturum:wither_rose', 'damaging_block'],
  ['Natura:BerryBush', 'damaging_block'],
  ['Natura:NetherBerryBush', 'damaging_block'],
  ['Natura:Thornvines', 'damaging_block'],
  ['TwilightForest:tile.TFThorns', 'damaging_block'],
  ['TwilightForest:tile.TFBurntThorns', 'damaging_block'],
  ['witchery:bramble', 'damaging_block'],
  ['witchery:voidbramble', 'damaging_block'],
  ['ExtraUtilities:spike_base', 'damaging_block'],
  ['ExtraUtilities:spike_base_diamond', 'damaging_block'],
  ['ExtraUtilities:spike_base_gold', 'damaging_block'],
  ['ExtraUtilities:spike_base_wood', 'damaging_block'],
  ['ThaumicHorizons:spikeTH', 'damaging_block'],
  ['ThaumicHorizons:spikeToothTH', 'damaging_block'],
  ['ThaumicHorizons:spikeWoodTH', 'damaging_block'],
  ['thaumicbases:spike', 'damaging_block'],
  ['TConstruct:trap.punji', 'damaging_block'],
  ['OpenBlocks:beartrap', 'damaging_block'],
  ['witchery:beartrap', 'damaging_block'],
  ['witchery:wolftrap', 'damaging_block'],
]);

/** Families of molten-metal fluid blocks (Tinkers' Construct and addons). */
const MOLTEN_PATTERNS: readonly RegExp[] = [
  /^TConstruct:fluid\.molten\./,
  /^TConstruct:molten\./,
  /^tinkersdefense:molten/,
];

export function hazardKindOfBlock(name: string): BlockHazardKind | null {
  const exact = EXACT.get(name);
  if (exact !== undefined) return exact;
  return MOLTEN_PATTERNS.some((p) => p.test(name)) ? 'lava' : null;
}

/** Per-block-id classification codes, for fast scans over chunk data. */
export const BLOCK_CODE = {
  safe: 0,
  lava: 1,
  fire: 2,
  harmful_fluid: 3,
  damaging_block: 4,
  /** An id the registry does not name: the scan cannot vouch for it. */
  unknown: 255,
} as const;

const CODE_TO_KIND: Readonly<Record<number, BlockHazardKind>> = {
  1: 'lava',
  2: 'fire',
  3: 'harmful_fluid',
  4: 'damaging_block',
};

export function kindOfCode(code: number): BlockHazardKind | null {
  return CODE_TO_KIND[code] ?? null;
}

/** Builds the id -> code table for this world's registry (ids are per world). */
export function buildBlockCodeTable(registry: Registry): Uint8Array {
  const table = new Uint8Array(65536).fill(BLOCK_CODE.unknown);
  table[0] = BLOCK_CODE.safe; // air is always id 0 in 1.7.10
  for (const [id, name] of registry.blocks) {
    if (id < 0 || id > 65535) continue;
    const kind = hazardKindOfBlock(name);
    table[id] = kind === null ? BLOCK_CODE.safe : BLOCK_CODE[kind];
  }
  return table;
}
