import { z } from 'zod';

/**
 * What the agent knows about fighting on the GTNH 2.8.4 test server: which entities it may
 * strike, with what, from how far, and how a kill can hurt it. Pure data and functions; the
 * safety policy, System 1 and the live client all use these, so they agree.
 *
 * Every number here was checked in the server's own jars with the Forge patches applied
 * (docs/gtnh-compatibility.md, "Combat"):
 *  - vanilla: a player's bare hand deals 1 (EntityPlayer attackDamage base 1.0); a tool adds
 *    its "Tool modifier" (ItemAxe 3 + material: wood 0, stone 1, iron 2, diamond 3, gold 0);
 *    a mob takes full damage again only 10 ticks after a full hit (hurtResistantTime 20,
 *    checked against 20 / 2); the server accepts an attack within 6 blocks (feet to feet)
 *    when it can see the target, within 3 when it cannot;
 *  - Battlegear2 (backhand build) cancels a bare-hand attack farther than 2.3 blocks;
 *  - IguanaTweaks (disableRegularSwords=true) cancels ALL damage from vanilla swords, so a
 *    sword is never a weapon here;
 *  - AngerMod (KamikazeMobRevenge, 10%) makes anything a player kills explode with power 1.5
 *    unless the player holds a GT knife;
 *  - SpecialMobs creepers explode with power 3 to 5 (10 when charged).
 */

// ---------------------------------------------------------------------------
// Who may be attacked
// ---------------------------------------------------------------------------

/** How a hostile type fights, which decides whether the agent fights it at all. */
export const HOSTILE_TACTICS = ['melee', 'ranged', 'explodes', 'avoid', 'unknown'] as const;
export type HostileTactic = (typeof HOSTILE_TACTICS)[number];

/**
 * Vanilla hostiles (EntityList names, as entity-types.ts reports them). `avoid`: never
 * struck: neutral mobs that turn a whole group hostile (zombie pigmen) or teleport
 * (endermen), silverfish (a hurt one wakes the others), bosses, and things out of reach.
 */
const VANILLA_TACTICS: ReadonlyMap<string, HostileTactic> = new Map<string, HostileTactic>([
  ['minecraft:Zombie', 'melee'],
  // Et Futurum's backports (src/bot/gtnh1710/entity-types.ts): a husk is a zombie that does
  // not burn by day, a stray a skeleton, an endermite bites.
  ['etfuturum.husk', 'melee'],
  // EnderZoo (entity-types.ts): the concussion creeper explodes like a creeper (its blast
  // confuses and throws rather than breaks blocks); the fallen knight fights with a sword.
  ['enderzoo.ConcussionCreeper', 'explodes'],
  ['enderzoo.FallenKnight', 'melee'],
  ['etfuturum.stray', 'ranged'],
  ['etfuturum.endermite', 'melee'],
  ['minecraft:Spider', 'melee'],
  ['minecraft:CaveSpider', 'melee'],
  ['minecraft:Slime', 'melee'],
  ['minecraft:Skeleton', 'ranged'],
  ['minecraft:Witch', 'ranged'],
  ['minecraft:Blaze', 'ranged'],
  ['minecraft:Creeper', 'explodes'],
  ['minecraft:PrimedTnt', 'explodes'],
  ['minecraft:PigZombie', 'avoid'],
  ['minecraft:Enderman', 'avoid'],
  // Hardcore Ender Expansion's Enderman, which spawns in the vanilla one's place.
  ['HardcoreEnderExpansion.Enderman', 'avoid'],
  ['minecraft:Silverfish', 'avoid'],
  ['minecraft:Ghast', 'avoid'],
  ['minecraft:LavaSlime', 'avoid'],
  ['minecraft:Giant', 'avoid'],
  ['minecraft:EnderDragon', 'avoid'],
  ['minecraft:WitherBoss', 'avoid'],
  // Projectiles: a ghast's fireball and a wither skull explode where they hit.
  ['minecraft:Fireball', 'explodes'],
  ['minecraft:WitherSkull', 'explodes'],
  ['minecraft:SmallFireball', 'avoid'],
]);

/**
 * Special Mobs variants are named `SpecialMobs.<Variant><Mob>` after the vanilla mob they
 * replace (src/bot/gtnh1710/special-mobs.ts); they fight like it. PigZombie is listed before
 * Zombie so the longer name wins.
 */
const SPECIAL_MOB_TACTICS: ReadonlyArray<[string, HostileTactic]> = [
  ['Creeper', 'explodes'],
  ['PigZombie', 'avoid'],
  ['Enderman', 'avoid'],
  ['Silverfish', 'avoid'],
  ['Ghast', 'avoid'],
  ['Skeleton', 'ranged'],
  ['Witch', 'ranged'],
  ['Blaze', 'ranged'],
  ['CaveSpider', 'melee'],
  ['Spider', 'melee'],
  ['Slime', 'melee'],
  ['Zombie', 'melee'],
];

/** How a hostile entity type fights; `unknown` for anything not identified (it might explode). */
export function hostileTactic(type: string): HostileTactic {
  const vanilla = VANILLA_TACTICS.get(type);
  if (vanilla !== undefined) return vanilla;
  const special = /^SpecialMobs\.([A-Za-z]+)$/.exec(type)?.[1];
  if (special !== undefined) {
    // Projectiles (SMFishHook, SMSpitball) and the lava monster are not mobs to fight.
    if (special.startsWith('SM') || special === 'LavaMonster') return 'avoid';
    for (const [mob, tactic] of SPECIAL_MOB_TACTICS) if (special.endsWith(mob)) return tactic;
  }
  return 'unknown';
}

/**
 * Explodes, or might: an unidentified hostile could be a creeper variant, and an entity of
 * any unidentified kind (category `unclassified`) could be a modded exploding mob.
 */
export function mayExplode(type: string, category: EntityCategory = 'hostile'): boolean {
  if (category === 'unclassified') return true;
  if (category !== 'hostile') return false;
  const tactic = hostileTactic(type);
  return tactic === 'explodes' || tactic === 'unknown';
}

/**
 * The only passive animals the agent may kill (for quests and food), by vanilla name
 * (VANILLA_MOBS in src/bot/gtnh1710/entity-types.ts: 90 pig, 91 sheep, 92 cow, 93 chicken).
 * Never villagers, golems, horses, wolves, cats, mooshrooms, squid, bats or modded animals.
 */
export const FARM_ANIMALS: ReadonlySet<string> = new Set([
  'minecraft:Cow',
  'minecraft:Pig',
  'minecraft:Sheep',
  'minecraft:Chicken',
]);

export const ENTITY_CATEGORIES = ['hostile', 'passive', 'unclassified', 'player'] as const;
export type EntityCategory = (typeof ENTITY_CATEGORIES)[number];

/** What the attack rules need to know about an entity. */
export interface AttackCandidate {
  type: string;
  category: EntityCategory;
  /** `object`: not a creature (TNT, fireballs, projectiles). */
  kind: 'mob' | 'player' | 'object';
  /** Someone's animal (a name tag, a saddle); null when not known. */
  owned: boolean | null;
  /** A baby animal; null when not known. */
  baby: boolean | null;
  /** A calm spider (see LIGHT_SHY_SPIDERS); absent or null: not calm. */
  calm?: boolean | null;
}

/**
 * Why this entity may NEVER be attacked, or null when it may be (if everything else about
 * the moment is safe): only identified hostiles that fight in melee or at range, and
 * unowned, grown farm animals whose metadata says so.
 */
export function attackRefusal(e: AttackCandidate): string | null {
  if (e.kind === 'player') return 'it is a player';
  if (e.kind === 'object') return `${e.type} is not a creature`;
  switch (e.category) {
    case 'player':
      return 'it is a player';
    case 'unclassified':
      return `${e.type} is not identified (unidentified entities are never attacked)`;
    case 'passive':
      if (!FARM_ANIMALS.has(e.type)) {
        return `${e.type} is not a farm animal (only cows, pigs, sheep and chickens)`;
      }
      if (e.owned !== false) {
        return e.owned === null
          ? `whether the ${e.type} belongs to someone is not known (no metadata yet)`
          : `the ${e.type} belongs to someone (a name tag or a saddle)`;
      }
      if (e.baby !== false) {
        return e.baby === null
          ? `the age of the ${e.type} is not known (no metadata yet)`
          : `the ${e.type} is a baby (it drops nothing)`;
      }
      return null;
    case 'hostile':
      switch (hostileTactic(e.type)) {
        case 'melee':
        case 'ranged':
          return null;
        case 'explodes':
          return `${e.type} explodes: the agent backs off and never strikes it`;
        case 'avoid':
          return `${e.type} is never attacked (it is neutral, a boss, calls others or is out of reach)`;
        case 'unknown':
          return `${e.type} is a hostile of unknown kind (it might explode)`;
      }
  }
}

/**
 * Why this entity may not be attacked NOW although it may be at other times, or null: a calm
 * spider leaves the player alone, and a blow would make it fight (EntityMob.attackEntityFrom
 * makes the attacker its target, in any light).
 */
export function calmRefusal(e: Pick<AttackCandidate, 'type' | 'calm'>): string | null {
  return e.calm === true
    ? `the ${e.type} is calm (a spider in the light leaves a player alone): striking it would provoke it`
    : null;
}

// ---------------------------------------------------------------------------
// Spiders in the light
// ---------------------------------------------------------------------------

/**
 * Being hurt this recently (ms) with a hostile about counts as being attacked (the safety
 * policy), and makes no spider count as calm: the bite may have been a spider's.
 */
export const HURT_DANGER_MS = 15_000;

/**
 * How long ago (ms) the player was last hurt, when that was at most HURT_DANGER_MS before
 * `at` (the observation's time), else null.
 */
/**
 * How long ago (ms) the player was last struck, when within HURT_DANGER_MS of `at`: a loss of
 * health at food 0 (GameState player.lastHurtStarving) was starving, no blow, and does not count
 * (an independent review, 2026-10-05: one bite after starving, a hostile anywhere in the scan
 * made it an attack).
 */
export function recentBlowMs(
  player: { lastHurtAt: string | null; lastHurtStarving?: boolean },
  at: string | Date,
): number | null {
  return player.lastHurtStarving === true ? null : recentHurtMs(player.lastHurtAt, at);
}

export function recentHurtMs(lastHurtAt: string | null, at: string | Date): number | null {
  if (lastHurtAt === null) return null;
  const ago = (typeof at === 'string' ? Date.parse(at) : at.getTime()) - Date.parse(lastHurtAt);
  return ago >= 0 && ago <= HURT_DANGER_MS ? ago : null;
}

/**
 * Vanilla spiders, which look for a player only in the dark, by type, with their height
 * (Entity.setSize: EntitySpider 1.4 x 0.9, EntityCaveSpider 0.7 x 0.5). Verified in the 1.7.10
 * server jar with Forge's patches (docs/gtnh-compatibility.md, "Spiders in the light"):
 * EntitySpider.findPlayerToAttack targets the closest player within 16 blocks only while
 * getBrightness(1.0F) < 0.5F, and EntityCaveSpider overrides neither that nor attackEntity.
 * Special Mobs' spiders are NOT here: they roll "hostile" at spawn (10% of spiders, every cave
 * spider on this server) and then fake darkness to target in any light, which the client
 * cannot see; other mods' spiders were not checked.
 */
export const LIGHT_SHY_SPIDERS: ReadonlyMap<string, { height: number }> = new Map([
  ['minecraft:Spider', { height: 0.9 }],
  ['minecraft:CaveSpider', { height: 0.5 }],
]);

/**
 * From this light level a spider does not look for a player: the overworld's brightness
 * table (WorldProvider.generateLightBrightnessTable) gives 0.41 for level 11 and 0.50000006
 * for 12, and the spider targets only below 0.5.
 */
export const SPIDER_CALM_LIGHT = 12;

/** EntitySpider.findPlayerToAttack takes the closest player within 16 blocks. */
export const SPIDER_TARGET_RANGE = 16;

/**
 * Within this distance (feet to feet) a spider counts as a threat whatever the light. One
 * that has the player as its target keeps it in the light (it drops it with a 1% chance per
 * tick, and only while it can see the player: EntitySpider.attackEntity), and from 2 to 6
 * blocks it leaps at the player (one chance in 10 per tick): the client cannot see a target,
 * so a spider within its leap counts as attacking.
 */
export const CALM_SPIDER_MIN_DISTANCE = 6;

/**
 * Why an entity cannot count as a calm spider now, whatever the light, or null: it is not a
 * vanilla spider (LIGHT_SHY_SPIDERS, a hostile mob), it is within CALM_SPIDER_MIN_DISTANCE,
 * or the player was hurt in the last HURT_DANGER_MS (`hurtMsAgo`, from recentHurtMs). The
 * rest of the rule (the light at the spider) only the adapter can judge. Shared by the live
 * client, the mock and the safety policy's consistency check, so all three agree.
 */
export function calmSpiderBlocker(
  e: { type: string; category: EntityCategory; kind: AttackCandidate['kind']; distance: number },
  hurtMsAgo: number | null,
): string | null {
  if (e.kind !== 'mob' || e.category !== 'hostile' || !LIGHT_SHY_SPIDERS.has(e.type)) {
    return `${e.type} is not a vanilla spider (only those leave a player alone in the light)`;
  }
  if (e.distance <= CALM_SPIDER_MIN_DISTANCE) {
    return `the ${e.type} is ${e.distance.toFixed(1)} blocks away, within its leap (${CALM_SPIDER_MIN_DISTANCE})`;
  }
  if (hurtMsAgo !== null) {
    return `the player was hurt ${(hurtMsAgo / 1000).toFixed(0)} s ago (it may have been a spider)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Weapons and reach
// ---------------------------------------------------------------------------

/** A bare hand: EntityPlayer's attackDamage base value. */
export const HAND_DAMAGE = 1;

/**
 * The only weapons the agent strikes with, and the damage of one full hit (1 + the axe's
 * "Tool modifier": 3 + material). Vanilla swords are NOT here: IguanaTweaks cancels all their
 * damage on this server. GregTech and Tinkers' tools run their own attack code and keep
 * their stats in NBT: not used. Stacks with NBT data (enchanted, named) are never used.
 */
export const WEAPON_DAMAGE: ReadonlyMap<string, number> = new Map([
  ['minecraft:wooden_axe', 4],
  ['minecraft:stone_axe', 5],
  ['minecraft:iron_axe', 6],
  ['minecraft:golden_axe', 4],
  ['minecraft:diamond_axe', 7],
]);

export const WeaponSchema = z.strictObject({
  /** The allowlisted weapon in the hotbar, or null for an empty hand. */
  item: z.string().min(1).max(128).nullable(),
  /** Damage of one full hit. */
  damage: z.number().min(0).max(1000),
});
export type Weapon = z.infer<typeof WeaponSchema>;

export const BARE_HAND: Weapon = { item: null, damage: HAND_DAMAGE };

/** Battlegear2 cancels a bare-hand attack farther than 2.3 blocks (feet to feet). */
export const HAND_STRIKE_REACH = 2.2;
/** The server accepts an attack within 3 blocks when it cannot see the target. */
export const BLIND_STRIKE_REACH = 2.9;
/**
 * ...and within 6 when it can (a ray from the eyes to the target's eyes hits no block). The
 * client strikes that far only when its own, stricter ray finds nothing but air.
 */
export const SIGHT_STRIKE_REACH = 4.5;

/** How far the agent may strike now, feet to feet, as the server measures it. */
export function strikeReach(weapon: Weapon, lineOfSight: boolean): number {
  if (weapon.item === null) return HAND_STRIKE_REACH;
  return lineOfSight ? SIGHT_STRIKE_REACH : BLIND_STRIKE_REACH;
}

/**
 * ATTACK_ENTITY engages a target at most this far away: the player does not move, it strikes
 * whenever the target is within strike reach during the burst (a hostile walks up to it).
 */
export const ENGAGE_RADIUS = 8;

/** A mob takes full damage again 10 ticks after a full hit; 12 leaves room for packet timing. */
export const SWING_INTERVAL_TICKS = 12;
/** Most swings in one ATTACK_ENTITY burst. */
export const MAX_SWINGS_PER_BURST = 8;
/** Longest ATTACK_ENTITY burst, including waiting for the target to come within reach. */
export const MAX_BURST_MS = 5_000;
/** System 1 fights back while it could retreat only when this many hits kill the target. */
export const QUICK_FIGHT_HITS = 3;

/** Full hits (each 12 ticks apart) to kill a target with this much health. */
export function hitsToKill(targetHealth: number, weapon: Weapon): number {
  return weapon.damage <= 0 ? Infinity : Math.max(1, Math.ceil(targetHealth / weapon.damage));
}

// ---------------------------------------------------------------------------
// Explosions: creepers, and the kill explosions of GTNH's AngerMod
// ---------------------------------------------------------------------------

/** Damage to players is scaled x 3/2 on Hard (the test server's difficulty=3). */
export const HARD_DIFFICULTY_SCALE = 1.5;

/**
 * Damage an explosion of `power` deals a player `distance` blocks (feet) from its centre, as
 * 1.7.10's Explosion computes it, at full exposure (nothing in between) and without armor:
 * nothing beyond 2 x power; else floor(((1 - d)^2 + (1 - d)) / 2 x 8 x 2 x power + 1) with
 * d = distance / (2 x power), then x 3/2 on Hard. Power 1.5 deals 37.5 at point blank.
 */
export function explosionDamage(power: number, distance: number): number {
  const radius = 2 * power;
  const d = distance / radius;
  if (d > 1) return 0;
  const impact = 1 - d;
  return Math.floor(((impact * impact + impact) / 2) * 8 * radius + 1) * HARD_DIFFICULTY_SCALE;
}

/** AngerMod: anything a player kills explodes (one kill in ten) with this power, at the body. */
export const KILL_EXPLOSION_POWER = 1.5;
/** Health the player keeps after the worst-case kill explosion for a blow that may kill. */
export const KILL_EXPLOSION_MARGIN = 4;

/** Whether this strike may kill: always when the target's health is not known. */
export function mayKill(targetHealth: number | null, weapon: Weapon): boolean {
  return targetHealth === null || targetHealth <= weapon.damage;
}

/**
 * Whether the player would survive the kill explosion of a blow struck from `distance`,
 * with KILL_EXPLOSION_MARGIN to spare. From 3 blocks away it does no damage at all.
 */
export function killStrikeAllowed(playerHealth: number, distance: number): boolean {
  return playerHealth - explosionDamage(KILL_EXPLOSION_POWER, distance) >= KILL_EXPLOSION_MARGIN;
}
