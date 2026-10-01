import { describe, expect, it } from 'vitest';
import {
  chooseWeapon,
  insideFence,
  lineOfSightClear,
  listedCategory,
  lookAtPoint,
  vitalsOf,
  type HotbarSlot,
} from '../../../src/bot/gtnh1710/combat.ts';
import { classifyModded, MODDED_ENTITY_TABLE } from '../../../src/bot/gtnh1710/entity-types.ts';
import {
  SPECIAL_MOBS_NAMES,
  SPECIAL_MOBS_VERSION,
  specialMobsName,
} from '../../../src/bot/gtnh1710/special-mobs.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { hostileTactic } from '../../../src/domain/combat.ts';

describe('Special Mobs type numbers (derived from the mod registration order)', () => {
  it('agrees with every live identification of the voted table', () => {
    const voted = MODDED_ENTITY_TABLE.filter((e) => e.modId === 'SpecialMobs');
    expect(voted.length).toBeGreaterThanOrEqual(13);
    for (const e of voted) {
      expect(specialMobsName(e.typeId, e.modVersion), `#${e.typeId}`).toBe(e.name);
    }
  });

  it('numbers every mob kind and variant, creepers 16-30, then the two projectiles', () => {
    expect(SPECIAL_MOBS_NAMES).toHaveLength(108);
    const creepers = SPECIAL_MOBS_NAMES.flatMap((n, i) => (n.endsWith('Creeper') ? [i] : []));
    expect(creepers).toEqual(Array.from({ length: 15 }, (_, i) => 16 + i));
    expect(SPECIAL_MOBS_NAMES.slice(106)).toEqual(['SMFishHook', 'SMSpitball']);
    expect(specialMobsName(19, SPECIAL_MOBS_VERSION)).toBe('SpecialMobs.DeathCreeper');
    expect(specialMobsName(26, SPECIAL_MOBS_VERSION)).toBe('SpecialMobs.GravityCreeper');
  });

  it('applies only to the version it was derived from, and names hostiles for combat', () => {
    expect(specialMobsName(19, '3.6.4')).toBeNull();
    expect(specialMobsName(500, SPECIAL_MOBS_VERSION)).toBeNull();
    const death = classifyModded('SpecialMobs', 19, SPECIAL_MOBS_VERSION);
    expect(death).toEqual({ name: 'SpecialMobs.DeathCreeper', category: 'hostile' });
    expect(hostileTactic(death.name)).toBe('explodes');
    // Another version: still hostile, but unnamed, so the agent treats it as a possible creeper.
    const other = classifyModded('SpecialMobs', 19, '3.7.0');
    expect(other).toEqual({ name: 'SpecialMobs#19', category: 'hostile' });
    expect(hostileTactic(other.name)).toBe('unknown');
  });
});

describe('entity metadata', () => {
  const meta = (entries: Array<[number, number | string | null]>) => new Map(entries);

  it('reads health for any creature, owner and age for farm animals only', () => {
    expect(vitalsOf('minecraft:Zombie', meta([[6, 17.5]]))).toEqual({
      health: 17.5,
      owned: null,
      baby: null,
    });
    expect(
      vitalsOf(
        'minecraft:Cow',
        meta([
          [6, 10],
          [10, ''],
          [12, 0],
        ]),
      ),
    ).toEqual({ health: 10, owned: false, baby: false });
    expect(vitalsOf('minecraft:Cow', meta([[10, 'Bessie']])).owned).toBe(true);
    expect(vitalsOf('minecraft:Cow', meta([[12, -24000]])).baby).toBe(true);
  });

  it('fails closed: a missing entry is not known', () => {
    expect(vitalsOf('minecraft:Cow', null)).toEqual({ health: null, owned: null, baby: null });
    expect(vitalsOf('minecraft:Cow', meta([[6, 10]]))).toEqual({
      health: 10,
      owned: null,
      baby: null,
    });
    // A pig is someone's when saddled; unknown when the saddle entry was not received.
    expect(
      vitalsOf(
        'minecraft:Pig',
        meta([
          [10, ''],
          [16, 1],
        ]),
      ).owned,
    ).toBe(true);
    expect(vitalsOf('minecraft:Pig', meta([[10, '']])).owned).toBeNull();
    expect(
      vitalsOf(
        'minecraft:Pig',
        meta([
          [10, ''],
          [16, 0],
        ]),
      ).owned,
    ).toBe(false);
  });

  it('lists players as players and leaves dropped items out', () => {
    expect(listedCategory('player', { name: 'player:x', category: 'ignored' })).toBe('player');
    expect(listedCategory('object', { name: 'object#2', category: 'ignored' })).toBeNull();
    expect(listedCategory('modded', { name: 'SpecialMobs#3', category: 'hostile' })).toBe(
      'hostile',
    );
  });
});

describe('line of sight', () => {
  // Air everywhere except a wall at x = 3 (y 64-65) and an unloaded column at z = 9.
  const world: WalkWorld = {
    blockAt: (x, y, z) => (z === 9 ? undefined : x === 3 && y >= 64 && y <= 65 ? 1 : 0),
    blockName: () => 'minecraft:stone',
    hazardCode: () => 0,
  };

  it('is clear only through loaded air', () => {
    expect(lineOfSightClear(world, { x: 0.5, y: 65.6, z: 0.5 }, { x: 2.5, y: 65.5, z: 0.5 })).toBe(
      true,
    );
    expect(lineOfSightClear(world, { x: 0.5, y: 65.6, z: 0.5 }, { x: 5.5, y: 65.5, z: 0.5 })).toBe(
      false,
    );
    // Over the wall.
    expect(lineOfSightClear(world, { x: 0.5, y: 67.6, z: 0.5 }, { x: 5.5, y: 67.5, z: 0.5 })).toBe(
      true,
    );
    // Through a column the client has not received: not clear.
    expect(lineOfSightClear(world, { x: 0.5, y: 65.6, z: 7.5 }, { x: 0.5, y: 65.5, z: 10.5 })).toBe(
      false,
    );
    // Diagonals and steps in every axis.
    expect(lineOfSightClear(world, { x: 0.5, y: 65.6, z: 0.5 }, { x: -3.2, y: 63.1, z: 4.7 })).toBe(
      true,
    );
  });
});

describe('aiming and the fence', () => {
  it('looks at the target like a player', () => {
    // East (+x) is yaw -90; straight down is pitch 90.
    expect(lookAtPoint({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }).yaw).toBeCloseTo(-90);
    expect(lookAtPoint({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }).yaw).toBeCloseTo(0);
    expect(lookAtPoint({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }).pitch).toBeCloseTo(90);
  });

  it('keeps targets in the fence columns, from one level below to two above', () => {
    const fence = { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 106, z: -4 } };
    expect(insideFence({ x: -8.5, y: 106, z: -11.5 }, fence)).toBe(true);
    expect(insideFence({ x: -0.5, y: 106, z: -5 }, fence)).toBe(true); // in the max column
    expect(insideFence({ x: 0.01, y: 106, z: -5 }, fence)).toBe(false);
    expect(insideFence({ x: -5, y: 104.9, z: -5 }, fence)).toBe(false);
    expect(insideFence({ x: -5, y: 108.9, z: -5 }, fence)).toBe(true);
  });
});

describe('weapon choice', () => {
  const slot = (s: number, name: string | null, hasNbt = false): HotbarSlot => ({
    slot: s,
    name,
    hasNbt,
  });

  it('the best allowlisted axe; never a sword, a stack with NBT, or anything else', () => {
    const hotbar = [
      slot(0, 'minecraft:bread'),
      slot(1, 'minecraft:stone_axe'),
      slot(2, 'minecraft:iron_sword'),
      slot(3, 'minecraft:diamond_axe', true), // enchanted or named: never used
      slot(4, 'minecraft:iron_axe'),
      slot(5, null),
    ];
    expect(chooseWeapon(hotbar, 0)).toEqual({
      slot: 4,
      weapon: { item: 'minecraft:iron_axe', damage: 6 },
    });
    expect(chooseWeapon([slot(0, 'minecraft:iron_sword'), slot(1, null)], 0)).toBeNull();
  });

  it('prefers the held slot on a tie', () => {
    const hotbar = [slot(2, 'minecraft:stone_axe'), slot(7, 'minecraft:stone_axe')];
    expect(chooseWeapon(hotbar, 7)?.slot).toBe(7);
    expect(chooseWeapon(hotbar, 0)?.slot).toBe(2);
  });
});
