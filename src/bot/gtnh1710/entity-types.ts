/**
 * Entity classification for GTNH 1.7.10.
 *
 * Safety semantics: `hostile` and `unclassified` are BOTH treated as dangers by the safety
 * policy. Only `passive` (and `ignored`) entries reduce what counts as a threat, so passive
 * entries must be exact and justified. Anything not listed is `unclassified` (fail closed).
 */

export type EntityCategory = 'hostile' | 'passive' | 'unclassified' | 'ignored';

export interface Classification {
  name: string;
  category: EntityCategory;
}

/**
 * Vanilla 1.7.10 mobs (Spawn Mob packet, EntityList global IDs). Neutral mobs that commonly
 * turn hostile (zombie pigmen, endermen) count as hostile; wolves and iron golems, which only
 * attack when provoked, count as passive.
 */
export const VANILLA_MOBS: ReadonlyMap<number, Classification> = new Map<number, Classification>([
  [50, { name: 'minecraft:Creeper', category: 'hostile' }],
  [51, { name: 'minecraft:Skeleton', category: 'hostile' }],
  [52, { name: 'minecraft:Spider', category: 'hostile' }],
  [53, { name: 'minecraft:Giant', category: 'hostile' }],
  [54, { name: 'minecraft:Zombie', category: 'hostile' }],
  [55, { name: 'minecraft:Slime', category: 'hostile' }],
  [56, { name: 'minecraft:Ghast', category: 'hostile' }],
  [57, { name: 'minecraft:PigZombie', category: 'hostile' }],
  [58, { name: 'minecraft:Enderman', category: 'hostile' }],
  [59, { name: 'minecraft:CaveSpider', category: 'hostile' }],
  [60, { name: 'minecraft:Silverfish', category: 'hostile' }],
  [61, { name: 'minecraft:Blaze', category: 'hostile' }],
  [62, { name: 'minecraft:LavaSlime', category: 'hostile' }],
  [63, { name: 'minecraft:EnderDragon', category: 'hostile' }],
  [64, { name: 'minecraft:WitherBoss', category: 'hostile' }],
  [65, { name: 'minecraft:Bat', category: 'passive' }],
  [66, { name: 'minecraft:Witch', category: 'hostile' }],
  [90, { name: 'minecraft:Pig', category: 'passive' }],
  [91, { name: 'minecraft:Sheep', category: 'passive' }],
  [92, { name: 'minecraft:Cow', category: 'passive' }],
  [93, { name: 'minecraft:Chicken', category: 'passive' }],
  [94, { name: 'minecraft:Squid', category: 'passive' }],
  [95, { name: 'minecraft:Wolf', category: 'passive' }],
  [96, { name: 'minecraft:MushroomCow', category: 'passive' }],
  [97, { name: 'minecraft:SnowMan', category: 'passive' }],
  [98, { name: 'minecraft:Ozelot', category: 'passive' }],
  [99, { name: 'minecraft:VillagerGolem', category: 'passive' }],
  [100, { name: 'minecraft:EntityHorse', category: 'passive' }],
  [120, { name: 'minecraft:Villager', category: 'passive' }],
]);

/** Vanilla objects (Spawn Object packet). Explosives and fireballs are threats; the rest is ignored. */
export const VANILLA_OBJECTS: ReadonlyMap<number, Classification> = new Map<number, Classification>(
  [
    [50, { name: 'minecraft:PrimedTnt', category: 'hostile' }],
    [63, { name: 'minecraft:Fireball', category: 'hostile' }],
    [64, { name: 'minecraft:SmallFireball', category: 'hostile' }],
    [66, { name: 'minecraft:WitherSkull', category: 'hostile' }],
  ],
);

/**
 * Mods whose every entity is a hostile monster (or its projectile). Marking them hostile
 * does not weaken safety (unclassified is treated the same way); it only makes reports clearer.
 */
export const HOSTILE_MODS: ReadonlySet<string> = new Set(['SpecialMobs']);

/**
 * Exact (modId, modEntityTypeId) classifications, keyed "modId#typeId". Filled from
 * verified identification only (see docs/gtnh-compatibility.md); empty entries stay
 * unclassified and are treated as dangers.
 */
export const MODDED_ENTITIES: ReadonlyMap<string, Classification> = new Map<
  string,
  Classification
>();

export function classifyVanillaMob(mobType: number): Classification {
  return VANILLA_MOBS.get(mobType) ?? { name: `mob#${mobType}`, category: 'unclassified' };
}

export function classifyVanillaObject(objectType: number): Classification {
  return VANILLA_OBJECTS.get(objectType) ?? { name: `object#${objectType}`, category: 'ignored' };
}

export function classifyModded(modId: string, typeId: number): Classification {
  const key = `${modId}#${typeId}`;
  const exact = MODDED_ENTITIES.get(key);
  if (exact !== undefined) return exact;
  if (HOSTILE_MODS.has(modId)) return { name: key, category: 'hostile' };
  return { name: key, category: 'unclassified' };
}
