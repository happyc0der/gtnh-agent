/**
 * Special Mobs' entity type numbers, derived from the mod's own registration code.
 *
 * Forge sends a modded entity as (mod id, type number); Special Mobs assigns the numbers in
 * `_SpecialMobs.registerMobs` (SpecialMobs-3.6.3.jar, disassembled with javap): a counter
 * from 0, over the 12 mob kinds of `MONSTER_KEY` in order, each registering "Special<Mob>"
 * and then every variant of `MONSTER_TYPES` for it ("<Variant><Mob>"), then the two
 * projectiles. The server saves them as `SpecialMobs.<name>`.
 *
 * Checked against the live identifications (scripts/identify-entities.ts, the voted entries
 * of MODDED_ENTITY_TABLE in entity-types.ts): all 13 match, from 18 (DarkCreeper) to 103
 * (GiantZombie), so nothing in between was skipped or reordered. The table applies only to
 * the version it was derived from.
 */
export const SPECIAL_MOBS_VERSION = '3.6.3';

/** MONSTER_KEY and MONSTER_TYPES of _SpecialMobs (3.6.3), in registration order. */
const MOB_VARIANTS: ReadonlyArray<[string, readonly string[]]> = [
  [
    'Blaze',
    ['Cinder', 'Conflagration', 'Ember', 'Hellfire', 'Inferno', 'Jolt', 'Smolder', 'Wildfire'],
  ],
  ['CaveSpider', ['Baby', 'Flying', 'Mother', 'Tough', 'Web', 'Witch']],
  [
    'Creeper',
    [
      'Armor',
      'Dark',
      'Death',
      'Dirt',
      'Doom',
      'Drowning',
      'Ender',
      'Fire',
      'Gravel',
      'Gravity',
      'Jumping',
      'Lightning',
      'Mini',
      'Splitting',
    ],
  ],
  ['Enderman', ['Blinding', 'Cursed', 'Icy', 'Lightning', 'Mini', 'Mirage', 'Thief']],
  ['Ghast', ['Baby', 'Faint', 'Fighter', 'King', 'Mini', 'Queen', 'Unholy']],
  ['PigZombie', ['Brutish', 'Fishing', 'Giant', 'Hungry', 'Plague', 'Vampire']],
  ['Silverfish', ['Blinding', 'Fishing', 'Flying', 'Poison', 'Tough']],
  [
    'Skeleton',
    ['Brutish', 'Fire', 'Gatling', 'Giant', 'Ninja', 'Poison', 'Sniper', 'Spitfire', 'Thief'],
  ],
  ['Slime', ['Blackberry', 'Blueberry', 'Caramel', 'Grape', 'Lemon', 'Strawberry', 'Watermelon']],
  [
    'Spider',
    [
      'Baby',
      'Desert',
      'Flying',
      'Ghost',
      'Giant',
      'Hungry',
      'Mother',
      'Pale',
      'Poison',
      'Small',
      'Tough',
      'Web',
      'Witch',
    ],
  ],
  ['Witch', ['Domination', 'Rage', 'Shadows', 'Undead', 'Wilds', 'Wind']],
  ['Zombie', ['Brutish', 'Fire', 'Fishing', 'Giant', 'Hungry', 'Plague']],
];

function buildNames(): readonly string[] {
  const names: string[] = [];
  for (const [mob, variants] of MOB_VARIANTS) {
    names.push(`Special${mob}`, ...variants.map((v) => `${v}${mob}`));
  }
  // Registered right after the mobs (EntitySpecialFishHook, EntitySpecialSpitball).
  names.push('SMFishHook', 'SMSpitball');
  return names;
}

/** Type number -> registered name (without the mod prefix), for SPECIAL_MOBS_VERSION. */
export const SPECIAL_MOBS_NAMES: readonly string[] = buildNames();

/** `SpecialMobs.<name>` for a type number, when the server runs the version it was derived from. */
export function specialMobsName(typeId: number, modVersion: string | undefined): string | null {
  if (modVersion !== SPECIAL_MOBS_VERSION) return null;
  const name = SPECIAL_MOBS_NAMES[typeId];
  return name === undefined ? null : `SpecialMobs.${name}`;
}
