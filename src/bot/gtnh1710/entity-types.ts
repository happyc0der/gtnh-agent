import { specialMobsName } from './special-mobs.ts';

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
export const HOSTILE_MODS: ReadonlySet<string> = new Set(['SpecialMobs', 'EnderZoo']);
// EnderZoo 1.3.3, read in its code (javap): EnderZoo.preInit registers its MobInfo values
// (Enderminy, Concussion Creeper, Fallen Knight, Fallen Mount, Wither Witch, Wither Cat, Dire
// Wolf, Dire Slime: all monsters), and BlockConfusingCharge its primed explosive charge;
// nothing else. Their type numbers come from EntityRegistry.findGlobalUniqueEntityId() at
// load, so they depend on the other mods and are not named here. Seen live: "EnderZoo#6" by
// day in the Hot Desert stopped a walk as an unidentified entity.

export interface ModdedEntityEntry {
  modId: string;
  typeId: number;
  /** The entity's registry name, as the server saves it. */
  name: string;
  category: EntityCategory;
  /**
   * Identification evidence: matching votes / all votes (scripts/identify-entities.ts); 0 / 0
   * when the entry comes from the mod's own registration code instead (`fromCode`).
   */
  votes: number;
  total: number;
  /** Where in the mod's code the type number is registered, when read there (javap). */
  fromCode?: string;
  /** Mod version the identification was made with; the entry applies to that version only. */
  modVersion: string;
}

/**
 * Identified Forge entity types for GTNH 2.8.4, produced by scripts/identify-entities.ts:
 * live entities (mod + type number + position) matched to the names and positions the
 * server writes to its region files (test world, 2026-09-30). Type numbers are fixed by
 * each mod's code, so an entry holds for any world running the same mod version, and is
 * ignored (unclassified, fail closed) for any other version.
 *
 * Rule for `passive`: at least 10 votes, all agreeing, and an entity that does not attack.
 * `hostile` entries only add names (hostile and unclassified are treated alike).
 */
export const MODDED_ENTITY_TABLE: readonly ModdedEntityEntry[] = [
  // Combined evidence of two runs (150 s + 600 s, 4,750 saved entities read, 206 matches, 0 conflicts).
  // Et Futurum rabbits never attack. (Vanilla's "killer bunny" variant only exists via commands.)
  {
    modId: 'etfuturum',
    typeId: 3,
    name: 'etfuturum.rabbit',
    category: 'passive',
    votes: 175,
    total: 175,
    modVersion: '2.6.2.25-GTNH',
  },
  // Read in the mod's code (javap, etfuturum-2.6.2.25-GTNH.jar): CommonProxy registers its
  // entities with fixed numbers. Seen live: "etfuturum#4" (a husk: a zombie that does not burn
  // by day) came at the agent in the desert, unidentified.
  {
    modId: 'etfuturum',
    typeId: 1,
    name: 'etfuturum.endermite',
    category: 'hostile',
    votes: 0,
    total: 0,
    fromCode: 'CommonProxy: registerEntity(EntityEndermite.class, "endermite", 1, ...)',
    modVersion: '2.6.2.25-GTNH',
  },
  {
    modId: 'etfuturum',
    typeId: 4,
    name: 'etfuturum.husk',
    category: 'hostile',
    votes: 0,
    total: 0,
    fromCode: 'CommonProxy: registerEntity(EntityHusk.class, "husk", 4, ...)',
    modVersion: '2.6.2.25-GTNH',
  },
  {
    modId: 'etfuturum',
    typeId: 5,
    name: 'etfuturum.stray',
    category: 'hostile',
    votes: 0,
    total: 0,
    fromCode: 'CommonProxy: registerEntity(EntityStray.class, "stray", 5, ...)',
    modVersion: '2.6.2.25-GTNH',
  },
  // EnderZoo 1.3.3 numbers its mobs with EntityRegistry.findGlobalUniqueEntityId() in its
  // MobInfo order (Enderminy, ConcussionCreeper, FallenKnight, FallenMount, WitherWitch,
  // WitherCat, DireWolf, DireSlime), so the numbers depend on the other mods' ids; on this
  // pack they start at 5. Seen live: "EnderZoo#6" at (-19, 92, 99) with health 22 was the
  // enderzoo.ConcussionCreeper the server saved there (region file, health 22), and the
  // next number, #7, met with health 22, the Fallen Knight. Hostile either way (the mod is).
  {
    modId: 'EnderZoo',
    typeId: 6,
    name: 'enderzoo.ConcussionCreeper',
    category: 'hostile',
    votes: 1,
    total: 1,
    fromCode: 'EnderZoo.preInit: MobInfo order, findGlobalUniqueEntityId (first id 5 here)',
    modVersion: '1.3.3',
  },
  {
    modId: 'EnderZoo',
    typeId: 7,
    name: 'enderzoo.FallenKnight',
    category: 'hostile',
    votes: 0,
    total: 0,
    fromCode: 'EnderZoo.preInit: MobInfo order, findGlobalUniqueEntityId (first id 5 here)',
    modVersion: '1.3.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 18,
    name: 'SpecialMobs.DarkCreeper',
    category: 'hostile',
    votes: 1,
    total: 1,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 20,
    name: 'SpecialMobs.DirtCreeper',
    category: 'hostile',
    votes: 4,
    total: 4,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 22,
    name: 'SpecialMobs.DrowningCreeper',
    category: 'hostile',
    votes: 7,
    total: 7,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 24,
    name: 'SpecialMobs.FireCreeper',
    category: 'hostile',
    votes: 2,
    total: 2,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 25,
    name: 'SpecialMobs.GravelCreeper',
    category: 'hostile',
    votes: 2,
    total: 2,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 26,
    name: 'SpecialMobs.GravityCreeper',
    category: 'hostile',
    votes: 2,
    total: 2,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 27,
    name: 'SpecialMobs.JumpingCreeper',
    category: 'hostile',
    votes: 3,
    total: 3,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 64,
    name: 'SpecialMobs.GiantSkeleton',
    category: 'hostile',
    votes: 3,
    total: 3,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 66,
    name: 'SpecialMobs.PoisonSkeleton',
    category: 'hostile',
    votes: 2,
    total: 2,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 67,
    name: 'SpecialMobs.SniperSkeleton',
    category: 'hostile',
    votes: 1,
    total: 1,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 89,
    name: 'SpecialMobs.ToughSpider',
    category: 'hostile',
    votes: 1,
    total: 1,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 102,
    name: 'SpecialMobs.FishingZombie',
    category: 'hostile',
    votes: 2,
    total: 2,
    modVersion: '3.6.3',
  },
  {
    modId: 'SpecialMobs',
    typeId: 103,
    name: 'SpecialMobs.GiantZombie',
    category: 'hostile',
    votes: 1,
    total: 1,
    modVersion: '3.6.3',
  },
];

const TABLE_BY_KEY: ReadonlyMap<string, ModdedEntityEntry> = new Map(
  MODDED_ENTITY_TABLE.map((e) => [`${e.modId}#${e.typeId}`, e]),
);

export function classifyVanillaMob(mobType: number): Classification {
  return VANILLA_MOBS.get(mobType) ?? { name: `mob#${mobType}`, category: 'unclassified' };
}

export function classifyVanillaObject(objectType: number): Classification {
  return VANILLA_OBJECTS.get(objectType) ?? { name: `object#${objectType}`, category: 'ignored' };
}

/**
 * `serverModVersion` is the version the server reports for `modId` (from its status ping).
 * A table entry applies only when it matches the version the entry was verified with.
 */
export function classifyModded(
  modId: string,
  typeId: number,
  serverModVersion: string | undefined,
): Classification {
  const key = `${modId}#${typeId}`;
  const entry = TABLE_BY_KEY.get(key);
  if (entry !== undefined && entry.modVersion === serverModVersion) {
    return { name: entry.name, category: entry.category };
  }
  if (HOSTILE_MODS.has(modId)) {
    // Special Mobs' own registration order names every type (special-mobs.ts); the combat
    // rules need the name to tell a creeper (it explodes) from a zombie.
    const derived = modId === 'SpecialMobs' ? specialMobsName(typeId, serverModVersion) : null;
    return { name: derived ?? entry?.name ?? key, category: 'hostile' };
  }
  return { name: key, category: 'unclassified' };
}
