import type { ChunkStore } from './chunk-data.ts';

/**
 * Blocks of a kind near the player, for an owner's `!find <block>` and `!goto <block>`
 * (Baritone's #find and #goto <block>). Like a player, and unlike Baritone's chunk cache, it
 * sees only blocks with a face open to air: no x-ray through the ground. Pure.
 */

/** How far `!find` and `!goto <block>` look (blocks), and at most how many they list. */
export const FIND_RADIUS = 32;
export const FIND_MAX = 8;

export interface FoundBlock {
  position: { x: number; y: number; z: number };
  distance: number;
}

/**
 * Blocks whose id is in `ids` within a sphere of `radius` around the feet, nearest first
 * (ties by position), at most `max`. Only blocks with a face touching air count; columns not
 * loaded are passed over (what has not arrived is not seen).
 */
export function findExposedBlocks(
  store: ChunkStore,
  ids: ReadonlySet<number>,
  feet: { x: number; y: number; z: number },
  radius = FIND_RADIUS,
  max = FIND_MAX,
): FoundBlock[] {
  if (ids.size === 0) return [];
  const r2 = radius * radius;
  const minX = Math.floor(feet.x - radius);
  const maxX = Math.floor(feet.x + radius);
  const minZ = Math.floor(feet.z - radius);
  const maxZ = Math.floor(feet.z + radius);
  const minY = Math.max(0, Math.floor(feet.y - radius));
  const maxY = Math.min(255, Math.floor(feet.y + radius));
  const exposed = (x: number, y: number, z: number): boolean =>
    store.blockAt(x + 1, y, z) === 0 ||
    store.blockAt(x - 1, y, z) === 0 ||
    store.blockAt(x, y + 1, z) === 0 ||
    store.blockAt(x, y - 1, z) === 0 ||
    store.blockAt(x, y, z + 1) === 0 ||
    store.blockAt(x, y, z - 1) === 0;
  const found: FoundBlock[] = [];
  for (let x = minX; x <= maxX; x++) {
    const dx = x + 0.5 - feet.x;
    for (let z = minZ; z <= maxZ; z++) {
      const dz = z + 0.5 - feet.z;
      const h2 = dx * dx + dz * dz;
      if (h2 > r2) continue;
      const sections = store.columnSections(Math.floor(x / 16), Math.floor(z / 16));
      if (sections === undefined) continue;
      for (let y = minY; y <= maxY; y++) {
        const section = sections[y >> 4];
        if (section === null || section === undefined) {
          y = y | 15; // an all-air section
          continue;
        }
        const id = section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] as number;
        if (id === 0 || !ids.has(id)) continue;
        const dy = y + 0.5 - feet.y;
        const d2 = h2 + dy * dy;
        if (d2 > r2 || !exposed(x, y, z)) continue;
        found.push({ position: { x, y, z }, distance: Math.sqrt(d2) });
      }
    }
  }
  found.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.position.z - b.position.z,
  );
  return found.slice(0, max);
}
