import { ChunkStore, type ColumnSections } from '../../../src/bot/gtnh1710/chunk-data.ts';
import { BLOCK } from './chunk-fixtures.ts';

/**
 * Terrain for timing world surveys: the 17 x 17 chunks a client holds with the server's view
 * distance of 8, around chunk (0, 0), shaped like the test world's overworld. Rolling ground
 * with hills (stone shows on their tops), a forest of oaks with full canopies and tall grass
 * under them, a desert, plains, a winding river with sand, gravel and clay on its bed and
 * banks, and a lake. Deterministic: the same blocks on every run.
 */

/** Biome ids (the test world's: RWG and vanilla). */
export const TERRAIN_BIOME = { plains: 1, river: 211, forest: 229, desert: 230 } as const;
/** Water surface of the river and the lake. */
export const WATER_LEVEL = 61;
/** Chunks held each way from chunk (0, 0): the server's view distance. */
export const TERRAIN_RADIUS_CHUNKS = 8;

/** A hash of a lattice point, in [0, 1). */
function hash(x: number, z: number, seed: number): number {
  let h = Math.imul(x, 374_761_393) ^ Math.imul(z, 668_265_263) ^ Math.imul(seed, 1_442_695_041);
  h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** Smooth value noise in [0, 1): features about `scale` blocks across. */
function noise(x: number, z: number, scale: number, seed: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const s = (t: number): number => t * t * (3 - 2 * t);
  const tx = s(fx - x0);
  const tz = s(fz - z0);
  const a = hash(x0, z0, seed);
  const b = hash(x0 + 1, z0, seed);
  const c = hash(x0, z0 + 1, seed);
  const d = hash(x0 + 1, z0 + 1, seed);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/** How far a column is from the river's middle line (it winds east-west, south of spawn). */
const fromRiver = (x: number, z: number): number => Math.abs(z - (40 + 12 * Math.sin(x / 23)));
const LAKE = { x: -72, z: -60, radius: 13 };
const fromLake = (x: number, z: number): number => Math.hypot(x - LAKE.x, z - LAKE.z);

export interface TerrainColumn {
  /** The ground's top block (y), under any water. */
  ground: number;
  /** The ground's top block id. */
  top: number;
  water: boolean;
  biome: number;
  forest: boolean;
}

/** Two octaves of noise: regions about `scale` across, with ragged edges. */
const region = (x: number, z: number, scale: number, seed: number): number =>
  0.7 * noise(x, z, scale, seed) + 0.3 * noise(x, z, scale / 3, seed + 100);

/** One column of the terrain. */
export function terrainColumn(x: number, z: number): TerrainColumn {
  const hills = 40 * Math.max(0, region(x, z, 56, 4) - 0.55);
  let ground = Math.round(
    66 +
      10 * (noise(x, z, 48, 1) - 0.5) +
      5 * (noise(x, z, 16, 2) - 0.5) +
      1.5 * (noise(x, z, 5, 3) - 0.5) +
      hills,
  );
  ground = Math.max(ground, WATER_LEVEL + 1);
  const river = fromRiver(x, z);
  const lake = fromLake(x, z);
  const desert = region(x, z, 64, 5) > 0.58;
  const bed = (d: number, depth: number): number => WATER_LEVEL - Math.round(depth - d / 2);
  let water = false;
  if (river < 4) {
    ground = bed(river, 4);
    water = true;
  } else if (lake < LAKE.radius) {
    ground = bed(lake / 3, 5);
    water = true;
  } else if (river < 8) {
    ground = Math.min(ground, WATER_LEVEL + Math.round(river - 4)); // the banks slope up
  }
  // Sand, gravel and clay lie in patches on the beds and the banks, as BiomeDecorator's disks.
  const patch = hash(x >> 2, z >> 2, 7);
  const shore = river < 8 || lake < LAKE.radius + 3;
  let top: number;
  if (water || shore) {
    top = patch < 0.35 ? BLOCK.gravel : patch < 0.5 ? BLOCK.clay : BLOCK.sand;
  } else if (ground >= 76)
    top = BLOCK.stone; // bare hilltops and cliffs
  else if (desert) top = BLOCK.sand;
  else top = BLOCK.grass;
  const forest = !desert && !shore && !water && top === BLOCK.grass && region(x, z, 48, 6) > 0.47;
  const biome =
    water || shore
      ? TERRAIN_BIOME.river
      : desert
        ? TERRAIN_BIOME.desert
        : forest
          ? TERRAIN_BIOME.forest
          : TERRAIN_BIOME.plains;
  return { ground, top, water, biome, forest };
}

/** The loaded terrain, and its columns for placing a player. */
export function surveyTerrain(): {
  store: ChunkStore;
  column: (x: number, z: number) => TerrainColumn;
} {
  const r = TERRAIN_RADIUS_CHUNKS;
  const chunks = new Map<string, { sections: ColumnSections; biomes: Uint8Array }>();
  const chunkOf = (cx: number, cz: number) => {
    const key = `${cx},${cz}`;
    let c = chunks.get(key);
    if (c === undefined) {
      c = { sections: new Array<Uint16Array | null>(16).fill(null), biomes: new Uint8Array(256) };
      chunks.set(key, c);
    }
    return c;
  };
  const set = (x: number, y: number, z: number, id: number): void => {
    const cx = x >> 4;
    const cz = z >> 4;
    if (Math.abs(cx) > r || Math.abs(cz) > r) return;
    const c = chunkOf(cx, cz);
    let s = c.sections[y >> 4];
    if (s === null || s === undefined) {
      s = new Uint16Array(4096);
      c.sections[y >> 4] = s;
    }
    s[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
  };
  const min = -r * 16;
  const max = (r + 1) * 16 - 1;
  for (let x = min; x <= max; x++) {
    for (let z = min; z <= max; z++) {
      const c = terrainColumn(x, z);
      chunkOf(x >> 4, z >> 4).biomes[((z & 15) << 4) | (x & 15)] = c.biome;
      set(x, 0, z, BLOCK.bedrock);
      for (let y = 1; y <= c.ground; y++) {
        const depth = c.ground - y;
        const id =
          depth === 0
            ? c.top
            : c.top === BLOCK.grass && depth <= 3
              ? BLOCK.dirt
              : c.top === BLOCK.sand && depth <= 4
                ? BLOCK.sand
                : BLOCK.stone;
        set(x, y, z, id);
      }
      for (let y = c.ground + 1; c.water && y <= WATER_LEVEL; y++) set(x, y, z, BLOCK.water);
      // Tall grass on a third of the open grass.
      if (c.top === BLOCK.grass && hash(x, z, 8) < 0.3) set(x, c.ground + 1, z, BLOCK.tallgrass);
    }
  }
  // Oaks in the forest, one in about half of the 5 x 5 cells: a trunk of 4-6 logs, and a
  // canopy of two wide layers (5 x 5 without corners) and two narrow ones on top.
  for (let gx = Math.floor(min / 5); gx <= Math.floor(max / 5); gx++) {
    for (let gz = Math.floor(min / 5); gz <= Math.floor(max / 5); gz++) {
      if (hash(gx, gz, 10) > 0.5) continue;
      const x = gx * 5 + 1 + Math.floor(hash(gx, gz, 11) * 3);
      const z = gz * 5 + 1 + Math.floor(hash(gx, gz, 12) * 3);
      const c = terrainColumn(x, z);
      if (!c.forest || c.top !== BLOCK.grass) continue;
      const height = 4 + Math.floor(hash(gx, gz, 13) * 3);
      const crown = c.ground + height;
      for (let y = crown - 2; y <= crown + 1; y++) {
        const reach = y <= crown - 1 ? 2 : 1;
        for (let dx = -reach; dx <= reach; dx++) {
          for (let dz = -reach; dz <= reach; dz++) {
            if (Math.abs(dx) === reach && Math.abs(dz) === reach && (reach === 2 || y > crown)) {
              continue; // round the corners
            }
            set(x + dx, y, z + dz, BLOCK.leaves);
          }
        }
      }
      for (let y = c.ground + 1; y <= crown; y++) set(x, y, z, BLOCK.log);
    }
  }
  const store = new ChunkStore();
  for (const [key, c] of chunks) {
    const [cx, cz] = key.split(',').map(Number) as [number, number];
    store.setColumn(cx, cz, c.sections, 0, c.biomes);
  }
  return { store, column: terrainColumn };
}
