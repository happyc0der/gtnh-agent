import { describe, expect, it } from 'vitest';
import { findExposedBlocks } from '../../../src/bot/gtnh1710/block-find.ts';
import { ChunkStore, type ColumnSections } from '../../../src/bot/gtnh1710/chunk-data.ts';

const CHEST = 54;
const STONE = 1;

/** A loaded chunk column with nothing in it (all air). */
const emptyColumn = (): ColumnSections => Array.from({ length: 16 }, () => null);

function store(blocks: Array<[number, number, number, number]>, loaded = 2): ChunkStore {
  const s = new ChunkStore();
  for (let cx = -loaded; cx < loaded; cx++) {
    for (let cz = -loaded; cz < loaded; cz++) s.setColumn(cx, cz, emptyColumn(), 0);
  }
  for (const [x, y, z, id] of blocks) s.setBlock(x, y, z, id, 0);
  return s;
}

const FEET = { x: 0.5, y: 64, z: 0.5 };

describe('findExposedBlocks (!find, !goto <block>)', () => {
  it('lists the blocks of a kind nearest first, at most max; a buried one is not seen', () => {
    const buried: Array<[number, number, number, number]> = [
      [3, 70, 3, CHEST],
      [4, 70, 3, STONE],
      [2, 70, 3, STONE],
      [3, 71, 3, STONE],
      [3, 69, 3, STONE],
      [3, 70, 4, STONE],
      [3, 70, 2, STONE],
    ];
    const s = store([[5, 64, 0, CHEST], [-2, 64, 1, CHEST], [10, 64, 10, CHEST], ...buried]);
    const found = findExposedBlocks(s, new Set([CHEST]), FEET, 32, 2);
    expect(found.map((f) => f.position)).toEqual([
      { x: -2, y: 64, z: 1 },
      { x: 5, y: 64, z: 0 },
    ]);
    expect(found[0]?.distance).toBeCloseTo(Math.hypot(2, 0.5, 1), 5);
    expect(findExposedBlocks(s, new Set([CHEST]), FEET).map((f) => f.position)).not.toContainEqual({
      x: 3,
      y: 70,
      z: 3,
    });
  });

  it('passes over columns not loaded, and blocks beyond the radius', () => {
    const s = store([[40, 64, 0, CHEST]], 1);
    expect(findExposedBlocks(s, new Set([CHEST]), FEET)).toEqual([]);
    const far = store([[20, 64, 20, CHEST]]);
    expect(findExposedBlocks(far, new Set([CHEST]), FEET, 16)).toEqual([]);
    expect(findExposedBlocks(far, new Set([CHEST]), FEET, 32)).toHaveLength(1);
  });
});
