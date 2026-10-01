/**
 * Ore dictionary entries that Forge itself registers (OreDictionary.initVanillaEntries,
 * verified in the bytecode of forge-1.7.10-10.13.4.1614-universal.jar, obfuscated Blocks/Items
 * fields mapped to their registry names). Better Questing accepts an ore dictionary match
 * wherever a quest item names one (ItemComparison.OreDictionaryMatch).
 *
 * Mods add more members (other mods' logs are logWood too, GregTech adds dusts and plates), and
 * the agent cannot read the server's ore dictionary. So these are LOWER bounds: enough to count
 * items the agent certainly holds, never enough to say an item is NOT a member.
 */
export interface OreMember {
  /** Registry name. */
  item: string;
  /** Registered with the wildcard damage (32767): every damage value is a member. */
  anyDamage: boolean;
}

const any = (item: string): OreMember => ({ item, anyDamage: true });
const exact = (item: string): OreMember => ({ item, anyDamage: false });

export const FORGE_ORE_DICTIONARY: Readonly<Record<string, readonly OreMember[]>> = {
  logWood: [any('minecraft:log'), any('minecraft:log2')],
  plankWood: [any('minecraft:planks')],
  slabWood: [any('minecraft:wooden_slab')],
  stairWood: [
    exact('minecraft:oak_stairs'),
    exact('minecraft:spruce_stairs'),
    exact('minecraft:birch_stairs'),
    exact('minecraft:jungle_stairs'),
    exact('minecraft:acacia_stairs'),
    exact('minecraft:dark_oak_stairs'),
  ],
  stickWood: [exact('minecraft:stick')],
  treeSapling: [any('minecraft:sapling')],
  treeLeaves: [any('minecraft:leaves'), any('minecraft:leaves2')],
  sand: [any('minecraft:sand')],
  stone: [exact('minecraft:stone')],
  cobblestone: [exact('minecraft:cobblestone')],
};

const base = (item: string): string => item.replace(/@\d+$/, '');
const damageOf = (item: string): number => Number(/@(\d+)$/.exec(item)?.[1] ?? 0);

/** True when Forge itself registers `item` (inventory naming, name[@damage]) under `oreName`. */
export function isKnownOreMember(oreName: string, item: string): boolean {
  return (FORGE_ORE_DICTIONARY[oreName] ?? []).some(
    (m) => m.item === base(item) && (m.anyDamage || damageOf(item) === 0),
  );
}
