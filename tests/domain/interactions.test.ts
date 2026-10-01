import { describe, expect, it } from 'vitest';
import { ActionTypeSchema } from '../../src/domain/actions.ts';
import { EntityIdSchema, ItemNameSchema } from '../../src/domain/common.ts';
import {
  blockUse,
  estimateFurnace,
  furnaceFuelTicks,
  INTERACTION_PROFILES,
  IRON_CHEST_TYPES,
  isObserveOnlyAllowed,
  matchWindowVariant,
  NEVER_OPEN_BLOCKS,
  ObservePatternSchema,
  observedStorageId,
  parseObservedStorageId,
  PROFILE_IDS,
  profileForBlock,
  STORAGE_PROFILES,
} from '../../src/domain/interactions.ts';

const profiles = Object.values(INTERACTION_PROFILES);

describe('interaction profiles (data)', () => {
  it('every profile is keyed by its id and names valid, unique blocks', () => {
    expect(Object.keys(INTERACTION_PROFILES).sort()).toEqual([...PROFILE_IDS].sort());
    const blocks = profiles.flatMap((p) => p.blocks);
    expect(new Set(blocks).size).toBe(blocks.length);
    for (const p of profiles) {
      expect(p.id).toBe(INTERACTION_PROFILES[p.id].id);
      for (const b of p.blocks) expect(ItemNameSchema.safeParse(b).success, b).toBe(true);
      for (const a of p.usedBy) expect(ActionTypeSchema.safeParse(a).success, a).toBe(true);
      expect(p.evidence.length, p.id).toBeGreaterThan(0);
      expect(p.modPayloads).toEqual([]);
    }
  });

  it("every window layout covers each container slot exactly once, with the player's 36 after", () => {
    for (const p of profiles) {
      expect(p.window.variants.length, p.id).toBeGreaterThan(0);
      for (const v of p.window.variants) {
        const covered = new Array<number>(v.layout.containerSlots).fill(0);
        for (const g of v.layout.groups) {
          expect(g.first, p.id).toBeLessThanOrEqual(g.last);
          for (let s = g.first; s <= g.last; s++) covered[s] = (covered[s] ?? 0) + 1;
        }
        expect(covered.length, p.id).toBe(v.layout.containerSlots);
        expect(
          covered.every((c) => c === 1),
          `${p.id} ${v.note ?? ''}`,
        ).toBe(true);
      }
    }
  });

  it('storage profiles are plain storage in every slot; the others are not listed as storage', () => {
    expect([...STORAGE_PROFILES].sort()).toEqual(['chest', 'hungry_chest', 'iron_chest']);
    for (const id of STORAGE_PROFILES) {
      for (const v of INTERACTION_PROFILES[id].window.variants) {
        expect(v.layout.groups.every((g) => g.role === 'storage' && g.take)).toBe(true);
      }
    }
  });

  it('the furnace: input and fuel take items, the output only gives, and the furnace keeps them', () => {
    const furnace = INTERACTION_PROFILES.furnace;
    expect(furnace.blocks).toEqual(['minecraft:furnace', 'minecraft:lit_furnace']);
    expect(furnace.itemsOnClose).toBe('kept');
    expect(furnace.result).toEqual({ how: 'output-slot', slot: 2 });
    const [variant] = furnace.window.variants;
    expect(variant?.opener).toEqual({
      kind: 'vanilla',
      inventoryType: 2,
      title: 'container.furnace',
      announcedSlots: 3,
    });
    expect(variant?.layout.groups.map((g) => [g.role, g.put, g.take])).toEqual([
      ['input', true, true],
      ['fuel', true, true],
      ['output', false, true],
    ]);
    expect(furnace.properties.map((p) => [p.id, p.name])).toEqual([
      [0, 'cookTicks'],
      [1, 'burnTicksLeft'],
      [2, 'fuelItemTicks'],
    ]);
  });

  it('a crafting table drops its grid; a crafting station keeps it and is looked at only', () => {
    expect(INTERACTION_PROFILES.crafting_table.itemsOnClose).toBe('dropped');
    expect(INTERACTION_PROFILES.crafting_table.usedBy).toContain('CRAFT_ITEM');
    expect(INTERACTION_PROFILES.crafting_station.itemsOnClose).toBe('kept');
    expect(INTERACTION_PROFILES.crafting_station.usedBy).toEqual(['INTERACT_BLOCK']);
  });

  it('Iron Chests: one FML GUI id per chest type, its size verified; the dirt chest takes nothing', () => {
    const variants = INTERACTION_PROFILES.iron_chest.window.variants;
    expect(variants.map((v) => [v.opener, v.layout.containerSlots])).toEqual(
      IRON_CHEST_TYPES.map((t) => [{ kind: 'fml', modId: 'IronChest', guiId: t.guiId }, t.slots]),
    );
    expect(IRON_CHEST_TYPES.map((t) => t.slots)).toEqual([
      54, 81, 108, 45, 72, 108, 108, 1, 135, 135, 72,
    ]);
    const dirt = variants.find((v) => v.note === 'DIRTCHEST9000');
    expect(dirt?.layout.groups).toEqual([
      { role: 'storage', first: 0, last: 0, put: false, take: true },
    ]);
  });

  it('matches only the exact window a profile knows', () => {
    const chest = INTERACTION_PROFILES.chest;
    expect(
      matchWindowVariant(chest, { kind: 'vanilla', inventoryType: 0, announcedSlots: 54 }, 90),
    ).toMatchObject({ note: 'double chest' });
    // Wrong size, wrong type, or a mod GUI: not a chest window.
    expect(
      matchWindowVariant(chest, { kind: 'vanilla', inventoryType: 0, announcedSlots: 27 }, 64),
    ).toBeNull();
    expect(
      matchWindowVariant(chest, { kind: 'vanilla', inventoryType: 2, announcedSlots: 27 }, 63),
    ).toBeNull();
    expect(matchWindowVariant(chest, { kind: 'fml', modId: 'IronChest', guiId: 0 }, 90)).toBeNull();
    const iron = INTERACTION_PROFILES.iron_chest;
    expect(
      matchWindowVariant(iron, { kind: 'fml', modId: 'IronChest', guiId: 1 }, 81 + 36)?.note,
    ).toBe('GOLD');
    // A crafting station may show an adjacent chest's slots after the player's.
    const station = INTERACTION_PROFILES.crafting_station;
    expect(
      matchWindowVariant(station, { kind: 'fml', modId: 'TConstruct', guiId: 11 }, 46 + 27),
    ).not.toBeNull();
  });
});

describe('which blocks may be opened', () => {
  it('a profile decides; never-opened profiles and world-changing vanilla blocks are refused', () => {
    expect(blockUse('minecraft:furnace', [])).toMatchObject({ kind: 'profile' });
    expect(blockUse('minecraft:trapped_chest', ['minecraft:*'])).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/redstone/) as unknown,
    });
    for (const b of NEVER_OPEN_BLOCKS) {
      expect(blockUse(b, ['minecraft:*', b]).kind, b).toBe('refused');
    }
  });

  it('observe-only needs an exact name or a whole mod on the allowlist', () => {
    const patterns = ['appliedenergistics2:*', 'BiblioCraft:BiblioShelf'];
    expect(isObserveOnlyAllowed('appliedenergistics2:tile.BlockDrive', patterns)).toBe(true);
    expect(isObserveOnlyAllowed('BiblioCraft:BiblioShelf', patterns)).toBe(true);
    expect(isObserveOnlyAllowed('BiblioCraft:BiblioRack', patterns)).toBe(false);
    expect(isObserveOnlyAllowed('appliedenergistics2x:tile.BlockDrive', patterns)).toBe(false);
    // A block with a profile is never "observe-only": its profile applies.
    expect(isObserveOnlyAllowed('minecraft:furnace', ['minecraft:*'])).toBe(false);
    expect(blockUse('irontank:ironTank', patterns)).toMatchObject({
      kind: 'refused',
      reason: expect.stringMatching(/not on the observe-only allowlist/) as unknown,
    });
  });

  it('drawers, barrels and ender chests are never right-clicked, even when allowlisted', () => {
    const patterns = ['JABBA:*', 'StorageDrawers:*', 'StorageDrawersMisc:*', 'EnderStorage:*'];
    for (const block of [
      'JABBA:barrel',
      'StorageDrawers:fullDrawers4',
      'StorageDrawers:controller',
      'StorageDrawersMisc:fullDrawers1_0',
      'EnderStorage:enderChest',
    ]) {
      expect(isObserveOnlyAllowed(block, patterns), block).toBe(false);
      expect(blockUse(block, patterns).kind, block).toBe('refused');
    }
    expect(blockUse('JABBA:barrel', patterns)).toMatchObject({
      reason: expect.stringMatching(/puts items from the player's inventory/) as unknown,
    });
    expect(blockUse('StorageDrawers:halfDrawers2', [])).toMatchObject({
      reason: expect.stringMatching(/within 10 ticks/) as unknown,
    });
  });

  it('patterns are exact names or a whole mod, nothing looser', () => {
    for (const ok of [
      'IronChest:*',
      'IronChest:BlockIronChest',
      'Natura:N Crops',
      'BuildCraft|Core:*',
    ]) {
      expect(ObservePatternSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['*', '*:*', 'IronChest', 'IronChest:Block*', 'minecraft:chest@1', '']) {
      expect(ObservePatternSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('profileForBlock covers every listed block', () => {
    expect(profileForBlock('IronChest:BlockIronChest')?.id).toBe('iron_chest');
    expect(profileForBlock('minecraft:lit_furnace')?.id).toBe('furnace');
    expect(profileForBlock('minecraft:stone')).toBeNull();
  });
});

describe('observed storage ids', () => {
  it('are entity ids made of the profile and the position, and parse back', () => {
    const id = observedStorageId('iron_chest', { x: -3, y: 106, z: -8 });
    expect(id).toBe('iron_chest:-3.106.-8');
    expect(EntityIdSchema.safeParse(id).success).toBe(true);
    expect(parseObservedStorageId(id)).toEqual({
      profile: 'iron_chest',
      position: { x: -3, y: 106, z: -8 },
    });
    // Only storage profiles: a furnace or a crafting table is not storage.
    expect(parseObservedStorageId('furnace:1.2.3')).toBeNull();
    expect(parseObservedStorageId('crafting_table:1.2.3')).toBeNull();
    expect(parseObservedStorageId('chest.main')).toBeNull();
  });
});

describe('furnace fuel and timing', () => {
  it('burn ticks of the vanilla fuels, as the GTNH server computes them', () => {
    expect(furnaceFuelTicks('minecraft:coal')).toBe(1600);
    expect(furnaceFuelTicks('minecraft:coal@1')).toBe(1600); // charcoal
    expect(furnaceFuelTicks('minecraft:planks@3')).toBe(300);
    expect(furnaceFuelTicks('minecraft:log2@1')).toBe(300);
    expect(furnaceFuelTicks('minecraft:wooden_slab@2')).toBe(150);
    expect(furnaceFuelTicks('minecraft:stick')).toBe(100);
    expect(furnaceFuelTicks('minecraft:sapling@5')).toBe(100);
    expect(furnaceFuelTicks('minecraft:coal_block')).toBe(16000);
    // Never lava; nothing unknown.
    expect(furnaceFuelTicks('minecraft:lava_bucket')).toBeNull();
    expect(furnaceFuelTicks('minecraft:cobblestone')).toBeNull();
    expect(furnaceFuelTicks('minecraft:coal@2')).toBeNull();
  });

  it('estimates the time to finish from contents and timers, and when the fuel runs short', () => {
    const view = (
      input: number,
      fuel: number,
      cookTicks: number,
      burnTicksLeft: number,
      fuelItem = 'minecraft:planks',
    ) => ({
      input: input === 0 ? null : { item: 'minecraft:cobblestone', count: input },
      fuel: fuel === 0 ? null : { item: fuelItem, count: fuel },
      cookTicks,
      burnTicksLeft,
    });
    // 8 items, 4 planks (1200 ticks) + 100 burning: 1600 ticks needed, not enough.
    expect(estimateFurnace(view(8, 4, 0, 100))).toEqual({
      secondsToFinish: null,
      fuelEnoughForItems: 6,
    });
    // 3 items, half of the first done, 1 coal: (600 - 100) ticks = 25 s.
    expect(estimateFurnace(view(3, 1, 100, 0, 'minecraft:coal'))).toEqual({
      secondsToFinish: 25,
      fuelEnoughForItems: 3,
    });
    expect(estimateFurnace(view(0, 2, 0, 0))).toEqual({
      secondsToFinish: 0,
      fuelEnoughForItems: 0,
    });
    expect(estimateFurnace(view(2, 1, 0, 0, 'minecraft:cobblestone'))).toEqual({
      secondsToFinish: null,
      fuelEnoughForItems: null,
    });
  });
});
