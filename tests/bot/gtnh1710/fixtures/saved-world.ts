import { readFileSync } from 'node:fs';
import { BLOCK_CODE, hazardKindOfBlock } from '../../../../src/bot/gtnh1710/block-hazards.ts';
import type { WalkWorld } from '../../../../src/bot/gtnh1710/walking.ts';

/**
 * A box of the test server's saved world (region files and level.dat's block names, read
 * offline by scripts/world-box.ts), kept as a fixture: a palette of "name:meta" and one
 * base-36 palette index per cell, x fastest, then z, then y. Cells outside the box are not
 * loaded.
 */
interface SavedBox {
  readonly min: { readonly x: number; readonly y: number; readonly z: number };
  readonly max: { readonly x: number; readonly y: number; readonly z: number };
  readonly palette: readonly string[];
  readonly cells: string;
}

/** The fixture `name` (tests/bot/gtnh1710/fixtures/<name>.json) as a world the walker reads. */
export function savedWorld(name: string): WalkWorld & { readonly box: SavedBox } {
  const box = JSON.parse(
    readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'),
  ) as SavedBox;
  const blocks = box.palette.map((p) => {
    const at = p.lastIndexOf(':');
    return { name: p.slice(0, at), meta: Number(p.slice(at + 1)) };
  });
  // Air is id 0; every other palette entry its own id (1 + its index).
  const ids = blocks.map((b, i) => (b.name === 'minecraft:air' ? 0 : i + 1));
  const sx = box.max.x - box.min.x + 1;
  const sz = box.max.z - box.min.z + 1;
  const indexAt = (x: number, y: number, z: number): number | undefined => {
    if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y) return undefined;
    if (z < box.min.z || z > box.max.z) return undefined;
    const i = (y - box.min.y) * sx * sz + (z - box.min.z) * sx + (x - box.min.x);
    return parseInt(box.cells[i] as string, 36);
  };
  return {
    box,
    blockAt(x, y, z) {
      const i = indexAt(x, y, z);
      return i === undefined ? undefined : ids[i];
    },
    metaAt(x, y, z) {
      const i = indexAt(x, y, z);
      return i === undefined ? undefined : blocks[i]?.meta;
    },
    blockName(id) {
      return id === 0 ? 'minecraft:air' : blocks[id - 1]?.name;
    },
    hazardCode(id) {
      const name = id === 0 ? 'minecraft:air' : blocks[id - 1]?.name;
      if (name === undefined) return BLOCK_CODE.unknown;
      const kind = hazardKindOfBlock(name);
      return kind === null ? BLOCK_CODE.safe : BLOCK_CODE[kind];
    },
  };
}
