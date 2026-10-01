import { deflateSync } from 'node:zlib';
import type { ColumnHeader } from '../../../src/bot/gtnh1710/chunk-data.ts';
import { encodeFrame, i32, u16 } from '../../../src/bot/gtnh1710/wire.ts';

/** Block ids used by the test worlds (the vanilla 1.7.10 numbering, as in the real registry). */
export const BLOCK = {
  air: 0,
  stone: 1,
  grass: 2,
  dirt: 3,
  bedrock: 7,
  flowingLava: 10,
  lava: 11,
  fire: 51,
  cactus: 81,
  chest: 54,
  craftingTable: 58,
  trappedChest: 146,
  /** GregTech's machine block (every machine and pipe); 2693 in the real test world. */
  gtMachines: 2693,
  // Digging tests:
  flowingWater: 8,
  water: 9,
  sand: 12,
  gravel: 13,
  log: 17,
  leaves: 18,
  glass: 20,
  tallgrass: 31,
  torch: 50,
  clay: 82,
  leaves2: 161,
  log2: 162,
  // Placing tests:
  cobblestone: 4,
  planks: 5,
  sandstone: 24,
  deadbush: 32,
  yellowFlower: 37,
  // Walking through plants (a modded id: the registry names it per world).
  bopFoliage: 1102,
} as const;

/** BiomesOPlenty:foliage metadata the walking tests use. */
export const FOLIAGE = { shortgrass: 1, bush: 4, poisonIvy: 7, berryBush: 8 } as const;

export const TEST_BLOCK_REGISTRY: Array<[number, string]> = [
  [BLOCK.stone, 'minecraft:stone'],
  [BLOCK.grass, 'minecraft:grass'],
  [BLOCK.dirt, 'minecraft:dirt'],
  [BLOCK.bedrock, 'minecraft:bedrock'],
  [BLOCK.flowingLava, 'minecraft:flowing_lava'],
  [BLOCK.lava, 'minecraft:lava'],
  [BLOCK.fire, 'minecraft:fire'],
  [BLOCK.cactus, 'minecraft:cactus'],
  [BLOCK.chest, 'minecraft:chest'],
  [BLOCK.craftingTable, 'minecraft:crafting_table'],
  [BLOCK.trappedChest, 'minecraft:trapped_chest'],
  [BLOCK.gtMachines, 'gregtech:gt.blockmachines'],
];

/** The test registry plus the blocks the digging tests use. */
export const DIG_TEST_BLOCK_REGISTRY: Array<[number, string]> = [
  ...TEST_BLOCK_REGISTRY,
  [BLOCK.flowingWater, 'minecraft:flowing_water'],
  [BLOCK.water, 'minecraft:water'],
  [BLOCK.sand, 'minecraft:sand'],
  [BLOCK.gravel, 'minecraft:gravel'],
  [BLOCK.log, 'minecraft:log'],
  [BLOCK.leaves, 'minecraft:leaves'],
  [BLOCK.glass, 'minecraft:glass'],
  [BLOCK.tallgrass, 'minecraft:tallgrass'],
  [BLOCK.torch, 'minecraft:torch'],
  [BLOCK.clay, 'minecraft:clay'],
  [BLOCK.leaves2, 'minecraft:leaves2'],
  [BLOCK.log2, 'minecraft:log2'],
];

/** The digging registry plus the blocks the placing tests use. */
export const PLACE_TEST_BLOCK_REGISTRY: Array<[number, string]> = [
  ...DIG_TEST_BLOCK_REGISTRY,
  [BLOCK.cobblestone, 'minecraft:cobblestone'],
  [BLOCK.planks, 'minecraft:planks'],
  [BLOCK.sandstone, 'minecraft:sandstone'],
  [BLOCK.deadbush, 'minecraft:deadbush'],
  [BLOCK.yellowFlower, 'minecraft:yellow_flower'],
];

export type BlockFn = (x: number, y: number, z: number) => number;
/** Block metadata of a position (world x, y, z). */
export type MetaFn = (x: number, y: number, z: number) => number;
const NO_META: MetaFn = () => 0;
/** Block light and sky light of a position (world x, y, z), 0-15 each. */
export type LightFn = (x: number, y: number, z: number) => { block: number; sky: number };
/** No light at all (what every test world had before light was kept). */
const NO_LIGHT: LightFn = () => ({ block: 0, sky: 0 });

/**
 * Light as an open world has it by day: full sky light above each column's highest block,
 * none at or below it (no light comes in from the side), and `blockLight` (default none).
 */
export function openSkyLight(
  world: BlockFn,
  blockLight: (x: number, y: number, z: number) => number = () => 0,
): LightFn {
  const tops = new Map<string, number>();
  const top = (x: number, z: number): number => {
    const key = `${x},${z}`;
    let t = tops.get(key);
    if (t === undefined) {
      t = -1;
      for (let y = 255; y >= 0; y--) {
        if (world(x, y, z) !== 0) {
          t = y;
          break;
        }
      }
      tops.set(key, t);
    }
    return t;
  };
  return (x, y, z) => ({ block: blockLight(x, y, z), sky: y > top(x, z) ? 15 : 0 });
}

/** A section's block light and sky light nibble arrays (the low nibble for an even index). */
function lightArrays(
  cx: number,
  cz: number,
  sec: number,
  light: LightFn,
): { block: Buffer; sky: Buffer } {
  const block = Buffer.alloc(2048);
  const sky = Buffer.alloc(2048);
  if (light === NO_LIGHT) return { block, sky };
  for (let i = 0; i < 4096; i++) {
    const [x, y, z] = cellOf(cx, cz, sec, i);
    const l = light(x, y, z);
    const shift = (i & 1) === 0 ? 0 : 4;
    block[i >> 1] = (block[i >> 1] as number) | ((l.block & 15) << shift);
    sky[i >> 1] = (sky[i >> 1] as number) | ((l.sky & 15) << shift);
  }
  return { block, sky };
}

/** Bedrock at y=0 and a grass floor at y=105 (the fake spawn stands on it at y=106). */
export function flatWorld(
  overrides: ReadonlyMap<string, number> = new Map(),
  voidColumns: ReadonlySet<string> = new Set(),
): BlockFn {
  return (x, y, z) => {
    const o = overrides.get(`${x},${y},${z}`);
    if (o !== undefined) return o;
    if (voidColumns.has(`${x},${z}`)) return BLOCK.air;
    if (y === 0) return BLOCK.bedrock;
    if (y === 105) return BLOCK.grass;
    return BLOCK.air;
  };
}

export interface ColumnBytes {
  header: ColumnHeader;
  data: Buffer;
}

/** Biome id of a column (world x, z). */
export type BiomeFn = (x: number, z: number) => number;

/** A ground-up column's biome bytes: one per column, index z << 4 | x, from `biomeAt` or 0. */
function biomeBytesOf(cx: number, cz: number, biomes: boolean, biomeAt?: BiomeFn): Buffer {
  const bytes = Buffer.alloc(biomes ? 256 : 0);
  if (biomes && biomeAt !== undefined) {
    for (let i = 0; i < 256; i++) bytes[i] = biomeAt(cx * 16 + (i & 15), cz * 16 + (i >> 4));
  }
  return bytes;
}

/** World coordinates of block `i` (index y<<8 | z<<4 | x) of section `sec` of column (cx, cz). */
const cellOf = (cx: number, cz: number, sec: number, i: number): [number, number, number] => [
  cx * 16 + (i & 15),
  sec * 16 + (i >> 8),
  cz * 16 + ((i >> 4) & 15),
];

/**
 * One column in NotEnoughIDs layout (u16 ids, u16 metadata from `meta`, block light and sky
 * light from `light` (default none), biomes: one byte per column, index z << 4 | x, from
 * `biomeAt`, or all 0). Like the server, it sends only the sections holding a block.
 */
export function neidColumn(
  cx: number,
  cz: number,
  block: BlockFn,
  skyLight = true,
  biomes = true,
  biomeAt?: BiomeFn,
  meta: MetaFn = NO_META,
  light: LightFn = NO_LIGHT,
): ColumnBytes {
  let mask = 0;
  const idArrays: Buffer[] = [];
  const metaArrays: Buffer[] = [];
  const blockLights: Buffer[] = [];
  const skyLights: Buffer[] = [];
  for (let sec = 0; sec < 16; sec++) {
    const ids = Buffer.alloc(8192);
    const metas = Buffer.alloc(8192);
    let any = false;
    for (let i = 0; i < 4096; i++) {
      const [x, y, z] = cellOf(cx, cz, sec, i);
      const id = block(x, y, z);
      if (id !== 0) {
        any = true;
        ids.writeUInt16BE(id, i * 2);
        metas.writeUInt16BE(meta(x, y, z), i * 2);
      }
    }
    if (any) {
      mask |= 1 << sec;
      idArrays.push(ids);
      metaArrays.push(metas);
      const l = lightArrays(cx, cz, sec, light);
      blockLights.push(l.block);
      if (skyLight) skyLights.push(l.sky);
    }
  }
  const data = Buffer.concat([
    ...idArrays,
    ...metaArrays,
    ...blockLights,
    ...skyLights,
    biomeBytesOf(cx, cz, biomes, biomeAt),
  ]);
  return { header: { chunkX: cx, chunkZ: cz, primaryBitMask: mask, addBitMask: 0 }, data };
}

/**
 * One column in vanilla 1.7.10 layout (S21PacketChunkData): the sent sections' id low bytes,
 * their metadata (a nibble per block, the low one for an even index), block light, sky light
 * (nibbles too), the add arrays (id high nibbles) of the sections holding an id above 255,
 * biomes. The arguments are neidColumn's.
 */
export function vanillaColumn(
  cx: number,
  cz: number,
  block: BlockFn,
  skyLight = true,
  biomes = true,
  biomeAt?: BiomeFn,
  meta: MetaFn = NO_META,
  light: LightFn = NO_LIGHT,
): ColumnBytes {
  let mask = 0;
  let addMask = 0;
  const lows: Buffer[] = [];
  const metas: Buffer[] = [];
  const adds: Buffer[] = [];
  const blockLights: Buffer[] = [];
  const skyLights: Buffer[] = [];
  for (let sec = 0; sec < 16; sec++) {
    const low = Buffer.alloc(4096);
    const nibbles = Buffer.alloc(2048);
    const add = Buffer.alloc(2048);
    let any = false;
    let high = false;
    for (let i = 0; i < 4096; i++) {
      const [x, y, z] = cellOf(cx, cz, sec, i);
      const id = block(x, y, z);
      if (id === 0) continue;
      const m = meta(x, y, z);
      if (id > 4095 || m > 15) throw new Error(`vanilla cannot send id ${id} with metadata ${m}`);
      any = true;
      const shift = (i & 1) === 0 ? 0 : 4;
      low[i] = id & 255;
      nibbles[i >> 1] = (nibbles[i >> 1] as number) | (m << shift);
      if (id > 255) {
        high = true;
        add[i >> 1] = (add[i >> 1] as number) | ((id >> 8) << shift);
      }
    }
    if (!any) continue;
    mask |= 1 << sec;
    lows.push(low);
    metas.push(nibbles);
    const l = lightArrays(cx, cz, sec, light);
    blockLights.push(l.block);
    if (skyLight) skyLights.push(l.sky);
    if (high) {
      addMask |= 1 << sec;
      adds.push(add);
    }
  }
  const data = Buffer.concat([
    ...lows,
    ...metas,
    ...blockLights,
    ...skyLights,
    ...adds,
    biomeBytesOf(cx, cz, biomes, biomeAt),
  ]);
  return { header: { chunkX: cx, chunkZ: cz, primaryBitMask: mask, addBitMask: addMask }, data };
}

/** Map Chunk Bulk (0x26) frame for the given columns. */
export function chunkBulkFrame(
  columns: readonly ColumnBytes[],
  skyLight = true,
  corrupt = false,
): Buffer {
  const count = Buffer.alloc(2);
  count.writeInt16BE(columns.length);
  const compressed = corrupt
    ? Buffer.from('this is not zlib data')
    : deflateSync(Buffer.concat(columns.map((c) => c.data)));
  const headers = columns.map((c) =>
    Buffer.concat([
      i32(c.header.chunkX),
      i32(c.header.chunkZ),
      u16(c.header.primaryBitMask),
      u16(c.header.addBitMask),
    ]),
  );
  return encodeFrame(
    0x26,
    Buffer.concat([
      count,
      i32(compressed.length),
      Buffer.from([skyLight ? 1 : 0]),
      compressed,
      ...headers,
    ]),
  );
}

/**
 * Block Change (0x23): int x, ubyte y, int z, varint id, then the metadata: a short with
 * NEID (the default), a byte in vanilla.
 */
export function blockChangeFrame(
  x: number,
  y: number,
  z: number,
  id: number,
  meta = 0,
  neid = true,
): Buffer {
  const varint: number[] = [];
  let n = id;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    varint.push(b);
  } while (n !== 0);
  return encodeFrame(
    0x23,
    Buffer.concat([
      i32(x),
      Buffer.from([y]),
      i32(z),
      Buffer.from(varint),
      neid ? u16(meta) : Buffer.from([meta]),
    ]),
  );
}

/**
 * Multi Block Change (0x22): NEID's 6-byte records (u16 position, u16 id, u16 metadata, the
 * default), or vanilla's 4-byte ones (u16 position, u16 id << 4 | metadata).
 */
export function multiBlockChangeFrame(
  chunkX: number,
  chunkZ: number,
  records: Array<{ x: number; y: number; z: number; id: number; meta?: number }>,
  neid = true,
): Buffer {
  const size = neid ? 6 : 4;
  const body = records.map((r) => {
    const b = Buffer.alloc(size);
    b.writeUInt16BE(((r.x & 15) << 12) | ((r.z & 15) << 8) | (r.y & 255), 0);
    if (neid) {
      b.writeUInt16BE(r.id, 2);
      b.writeUInt16BE(r.meta ?? 0, 4);
    } else {
      b.writeUInt16BE((r.id << 4) | ((r.meta ?? 0) & 15), 2);
    }
    return b;
  });
  const count = Buffer.alloc(2);
  count.writeUInt16BE(records.length);
  return encodeFrame(
    0x22,
    Buffer.concat([i32(chunkX), i32(chunkZ), count, i32(records.length * size), ...body]),
  );
}
