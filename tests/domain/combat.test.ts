import { describe, expect, it } from 'vitest';
import {
  attackRefusal,
  BARE_HAND,
  BLIND_STRIKE_REACH,
  explosionDamage,
  FARM_ANIMALS,
  HAND_STRIKE_REACH,
  hitsToKill,
  hostileTactic,
  KILL_EXPLOSION_POWER,
  killStrikeAllowed,
  mayExplode,
  mayKill,
  SIGHT_STRIKE_REACH,
  strikeReach,
  WEAPON_DAMAGE,
  type AttackCandidate,
} from '../../src/domain/combat.ts';

const mob = (type: string, over: Partial<AttackCandidate> = {}): AttackCandidate => ({
  type,
  category: 'hostile',
  kind: 'mob',
  owned: null,
  baby: null,
  ...over,
});
const animal = (type: string, over: Partial<AttackCandidate> = {}): AttackCandidate =>
  mob(type, { category: 'passive', owned: false, baby: false, ...over });

describe('hostile tactics', () => {
  it.each([
    ['minecraft:Zombie', 'melee'],
    ['minecraft:Spider', 'melee'],
    ['minecraft:Skeleton', 'ranged'],
    ['minecraft:Witch', 'ranged'],
    ['minecraft:Creeper', 'explodes'],
    ['minecraft:PrimedTnt', 'explodes'],
    ['minecraft:PigZombie', 'avoid'],
    ['minecraft:Enderman', 'avoid'],
    ['minecraft:Silverfish', 'avoid'],
    ['minecraft:WitherBoss', 'avoid'],
    ['SpecialMobs.DeathCreeper', 'explodes'],
    ['SpecialMobs.SpecialCreeper', 'explodes'],
    ['SpecialMobs.GiantSkeleton', 'ranged'],
    ['SpecialMobs.FishingZombie', 'melee'],
    ['SpecialMobs.BrutishPigZombie', 'avoid'],
    ['SpecialMobs.ToughSpider', 'melee'],
    ['SpecialMobs.WebCaveSpider', 'melee'],
    ['SpecialMobs.SMFishHook', 'avoid'],
    ['etfuturum.husk', 'melee'],
    ['etfuturum.stray', 'ranged'],
    ['etfuturum.endermite', 'melee'],
    ['SpecialMobs#200', 'unknown'],
    ['mob#120', 'unknown'],
    ['minecraft:Cow', 'unknown'],
  ])('%s fights %s', (type, tactic) => {
    expect(hostileTactic(type)).toBe(tactic);
  });

  it('anything that explodes, or might (unidentified), is never fought', () => {
    expect(mayExplode('SpecialMobs.GravityCreeper')).toBe(true);
    expect(mayExplode('SpecialMobs#200')).toBe(true);
    expect(mayExplode('minecraft:Fireball')).toBe(true);
    expect(mayExplode('minecraft:Zombie')).toBe(false);
    // Any unidentified entity might be a modded exploding mob; a known animal is not.
    expect(mayExplode('etfuturum#3', 'unclassified')).toBe(true);
    expect(mayExplode('minecraft:Cow', 'passive')).toBe(false);
    expect(mayExplode('player', 'player')).toBe(false);
  });
});

describe('who may be attacked', () => {
  it('identified melee and ranged hostiles', () => {
    expect(attackRefusal(mob('minecraft:Zombie'))).toBeNull();
    expect(attackRefusal(mob('SpecialMobs.SniperSkeleton'))).toBeNull();
  });

  it.each<[string, AttackCandidate, RegExp]>([
    ['a player', mob('player', { category: 'player', kind: 'player' }), /is a player/],
    ['a player listed as a mob', mob('player', { category: 'player' }), /is a player/],
    ['primed TNT', mob('minecraft:PrimedTnt', { kind: 'object' }), /not a creature/],
    ['an unidentified mob', mob('mob#120', { category: 'unclassified' }), /not identified/],
    ['a creeper', mob('minecraft:Creeper'), /explodes/],
    ['a Special Mobs creeper', mob('SpecialMobs.DeathCreeper'), /explodes/],
    ['an enderman', mob('minecraft:Enderman'), /never attacked/],
    ['an unidentified hostile', mob('SpecialMobs#200'), /unknown kind/],
    ['a villager', animal('minecraft:Villager'), /not a farm animal/],
    ['an iron golem', animal('minecraft:VillagerGolem'), /not a farm animal/],
    ['a wolf', animal('minecraft:Wolf'), /not a farm animal/],
    ['a horse', animal('minecraft:EntityHorse'), /not a farm animal/],
    ['a modded rabbit', animal('etfuturum.rabbit'), /not a farm animal/],
    ['a named cow', animal('minecraft:Cow', { owned: true }), /belongs to someone/],
    ['a cow of unknown owner', animal('minecraft:Cow', { owned: null }), /not known/],
    ['a calf', animal('minecraft:Cow', { baby: true }), /baby/],
    ['a cow of unknown age', animal('minecraft:Cow', { baby: null }), /age .* not known/],
  ])('never %s', (_what, candidate, reason) => {
    expect(attackRefusal(candidate)).toMatch(reason);
  });

  it('grown, unowned farm animals (cows, pigs, sheep, chickens) only', () => {
    expect([...FARM_ANIMALS].sort()).toEqual([
      'minecraft:Chicken',
      'minecraft:Cow',
      'minecraft:Pig',
      'minecraft:Sheep',
    ]);
    for (const type of FARM_ANIMALS) expect(attackRefusal(animal(type))).toBeNull();
    expect(attackRefusal(animal('minecraft:MushroomCow'))).toMatch(/not a farm animal/);
  });
});

describe('weapons and reach', () => {
  it('only vanilla axes (IguanaTweaks makes vanilla swords deal nothing)', () => {
    expect([...WEAPON_DAMAGE.keys()].every((k) => k.endsWith('_axe'))).toBe(true);
    // 1 (player) + 3 (ItemAxe) + material: wood 0, stone 1, iron 2, diamond 3, gold 0.
    expect(WEAPON_DAMAGE.get('minecraft:stone_axe')).toBe(5);
    expect(WEAPON_DAMAGE.get('minecraft:diamond_axe')).toBe(7);
    expect(WEAPON_DAMAGE.has('minecraft:iron_sword')).toBe(false);
  });

  it('a bare hand reaches 2.2 (Battlegear2 cancels beyond 2.3); a weapon 2.9, or 4.5 in sight', () => {
    expect(strikeReach(BARE_HAND, true)).toBe(HAND_STRIKE_REACH);
    expect(strikeReach(BARE_HAND, true)).toBeLessThan(2.3);
    const axe = { item: 'minecraft:iron_axe', damage: 6 };
    expect(strikeReach(axe, false)).toBe(BLIND_STRIKE_REACH);
    expect(BLIND_STRIKE_REACH).toBeLessThan(3);
    expect(strikeReach(axe, true)).toBe(SIGHT_STRIKE_REACH);
    expect(SIGHT_STRIKE_REACH).toBeLessThan(6);
  });

  it('counts hits to kill', () => {
    expect(hitsToKill(20, BARE_HAND)).toBe(20);
    expect(hitsToKill(20, { item: 'minecraft:iron_axe', damage: 6 })).toBe(4);
    expect(hitsToKill(0.5, BARE_HAND)).toBe(1);
  });
});

describe('explosions', () => {
  it("matches 1.7.10's Explosion on Hard, nothing beyond 2 x power", () => {
    // Point blank: floor((1 + 1) / 2 x 8 x 3 + 1) = 25, x 1.5 on Hard.
    expect(explosionDamage(KILL_EXPLOSION_POWER, 0)).toBe(37.5);
    // Half way (1.5 of 3): impact 0.5 -> floor(0.375 x 24 + 1) = 10 -> 15.
    expect(explosionDamage(KILL_EXPLOSION_POWER, 1.5)).toBe(15);
    expect(explosionDamage(KILL_EXPLOSION_POWER, 3)).toBe(1.5);
    expect(explosionDamage(KILL_EXPLOSION_POWER, 3.01)).toBe(0);
    // A Death creeper (power 5) still hurts at 8 blocks.
    expect(explosionDamage(5, 8)).toBeGreaterThan(0);
    let last = Infinity;
    for (let d = 0; d <= 3; d += 0.25) {
      const dmg = explosionDamage(KILL_EXPLOSION_POWER, d);
      expect(dmg).toBeLessThanOrEqual(last);
      last = dmg;
    }
  });

  it('a blow that may kill waits until the kill explosion is survivable', () => {
    expect(mayKill(null, BARE_HAND)).toBe(true); // health unknown: assume it may
    expect(mayKill(1, BARE_HAND)).toBe(true);
    expect(mayKill(2, BARE_HAND)).toBe(false);
    expect(killStrikeAllowed(20, 1.5)).toBe(true); // 20 - 15 = 5 left
    expect(killStrikeAllowed(18, 1.5)).toBe(false); // 3 left: below the margin of 4
    expect(killStrikeAllowed(20, 1)).toBe(false); // 21 damage
    expect(killStrikeAllowed(5, 3.5)).toBe(true); // out of the blast
  });
});
