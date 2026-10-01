import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import {
  PASSABLE_BLOCKS,
  PASSABLE_BY_METADATA,
  passProblem,
  variantName,
} from '../../../src/bot/gtnh1710/passable.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

const NAMES = new Map<number, string>([
  [1, 'minecraft:stone'],
  [31, 'minecraft:tallgrass'],
  [78, 'minecraft:snow_layer'],
  [83, 'minecraft:reeds'],
  [106, 'minecraft:vine'],
  [1102, 'BiomesOPlenty:foliage'],
  [1103, 'BiomesOPlenty:flowers'],
  [1104, 'BiomesOPlenty:flowers2'],
  [1105, 'BiomesOPlenty:plants'],
  [1106, 'BiomesOPlenty:bamboo'],
  [1107, 'BiomesOPlenty:willow'],
  [1108, 'BiomesOPlenty:mushrooms'],
  [2201, 'harvestcraft:berrygarden'],
  [2301, 'Natura:N Crops'],
]);
const idOf = (name: string): number => {
  const found = [...NAMES].find(([, n]) => n === name);
  if (found === undefined) throw new Error(`no test id for ${name}`);
  return found[0];
};

/**
 * One block at (0, 0, 0), air elsewhere. `meta`: its metadata (undefined: the world does not
 * know it); with `noMetadata` the world cannot report any (no metaAt).
 */
function one(name: string, meta: number | undefined, noMetadata = false): WalkWorld {
  const id = idOf(name);
  const world: WalkWorld = {
    blockAt: (x, y, z) => (x === 0 && y === 0 && z === 0 ? id : 0),
    blockName: (i) => NAMES.get(i),
    hazardCode: () => BLOCK_CODE.safe,
  };
  return noMetadata ? world : { ...world, metaAt: () => meta };
}
const pass = (name: string, meta: number | undefined): string | null =>
  passProblem(one(name, meta), 0, 0, 0);
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('what the body passes through (passable.ts)', () => {
  it('BOP foliage: every variant but poison ivy (7), and only with its metadata known', () => {
    for (const m of range(16)) {
      expect(pass('BiomesOPlenty:foliage', m), `foliage@${m}`).toBe(
        m === 7 ? 'blocked by BiomesOPlenty:foliage@7' : null,
      );
    }
    // Fail closed: metadata the world does not know, or a world that reports none.
    expect(pass('BiomesOPlenty:foliage', undefined)).toBe(
      'blocked by BiomesOPlenty:foliage (its metadata is not known)',
    );
    expect(passProblem(one('BiomesOPlenty:foliage', 1, true), 0, 0, 0)).toMatch(
      /metadata is not known/,
    );
  });

  it('BOP flowers and plants: the variants that hurt on contact are walls', () => {
    const blocked = (name: string, count: number): number[] =>
      range(count).filter((m) => pass(name, m) !== null);
    expect(blocked('BiomesOPlenty:flowers', 16)).toEqual([2]); // deadbloom (Wither)
    expect(blocked('BiomesOPlenty:flowers2', 16)).toEqual([2, 9, 10, 11, 12, 13, 14, 15]); // burning blossom; 9+ do not exist
    expect(blocked('BiomesOPlenty:plants', 16)).toEqual([5, 12]); // thorn, cactus
  });

  it('a snow layer only when flat (one layer, metadata 0)', () => {
    expect(pass('minecraft:snow_layer', 0)).toBeNull();
    for (const m of range(15).map((i) => i + 1)) {
      expect(pass('minecraft:snow_layer', m)).toBe(`blocked by minecraft:snow_layer@${m}`);
    }
  });

  it('vines, sugar cane, mushrooms, gardens and wild crops at any metadata; other blocks never', () => {
    for (const name of [
      'minecraft:tallgrass',
      'minecraft:vine',
      'minecraft:reeds',
      'BiomesOPlenty:willow',
      'BiomesOPlenty:mushrooms',
      'harvestcraft:berrygarden',
      'Natura:N Crops',
    ]) {
      expect(pass(name, 9), name).toBeNull();
      expect(pass(name, undefined), name).toBeNull();
    }
    expect(pass('minecraft:stone', 0)).toBe('blocked by minecraft:stone');
    expect(pass('BiomesOPlenty:bamboo', 0)).toBe('blocked by BiomesOPlenty:bamboo'); // not checked
    const strange: WalkWorld = { ...one('minecraft:stone', 0), blockAt: () => 4242 };
    expect(passProblem(strange, 0, 0, 0)).toBe('blocked by unnamed block id 4242');
    const unloaded: WalkWorld = { ...one('minecraft:stone', 0), blockAt: () => undefined };
    expect(passProblem(unloaded, 0, 0, 0)).toBe('chunk not loaded');
    expect(passProblem(one('minecraft:stone', 0), 1, 0, 0)).toBeNull(); // air
  });

  it('names the variant where the metadata decides', () => {
    expect(variantName(one('BiomesOPlenty:foliage', 7), 0, 0, 0, 'BiomesOPlenty:foliage')).toBe(
      'BiomesOPlenty:foliage@7',
    );
    expect(variantName(one('minecraft:vine', 2), 0, 0, 0, 'minecraft:vine')).toBe('minecraft:vine');
    expect(
      variantName(one('BiomesOPlenty:foliage', undefined), 0, 0, 0, 'BiomesOPlenty:foliage'),
    ).toBe('BiomesOPlenty:foliage');
  });

  it('keeps the two tables apart: a block passes by name or by metadata, never both', () => {
    for (const name of PASSABLE_BY_METADATA.keys())
      expect(PASSABLE_BLOCKS.has(name), name).toBe(false);
  });
});
