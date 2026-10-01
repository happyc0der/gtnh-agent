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
} as const;

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

/**
 * One column in NotEnoughIDs layout (u16 ids, u16 metadata, block light, sky light, biomes:
 * one byte per column, index z << 4 | x, from `biomeAt`, or all 0).
 */
export function neidColumn(
  cx: number,
  cz: number,
  block: BlockFn,
  skyLight = true,
  biomes = true,
  biomeAt?: BiomeFn,
): ColumnBytes {
  let mask = 0;
  const idArrays: Buffer[] = [];
  for (let sec = 0; sec < 16; sec++) {
    const ids = Buffer.alloc(8192);
    let any = false;
    for (let i = 0; i < 4096; i++) {
      const id = block(cx * 16 + (i & 15), sec * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15));
      if (id !== 0) {
        any = true;
        ids.writeUInt16BE(id, i * 2);
      }
    }
    if (any) {
      mask |= 1 << sec;
      idArrays.push(ids);
    }
  }
  const n = idArrays.length;
  const biomeBytes = Buffer.alloc(biomes ? 256 : 0);
  if (biomes && biomeAt !== undefined) {
    for (let i = 0; i < 256; i++) biomeBytes[i] = biomeAt(cx * 16 + (i & 15), cz * 16 + (i >> 4));
  }
  const data = Buffer.concat([
    ...idArrays,
    Buffer.alloc(8192 * n), // metadata
    Buffer.alloc(2048 * n), // block light
    Buffer.alloc(skyLight ? 2048 * n : 0),
    biomeBytes,
  ]);
  return { header: { chunkX: cx, chunkZ: cz, primaryBitMask: mask, addBitMask: 0 }, data };
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

/** NEID Block Change (0x23): int x, ubyte y, int z, varint id, short metadata. */
export function blockChangeFrame(x: number, y: number, z: number, id: number): Buffer {
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
    Buffer.concat([i32(x), Buffer.from([y]), i32(z), Buffer.from(varint), Buffer.from([0, 0])]),
  );
}

/** NEID Multi Block Change (0x22): 6-byte records (u16 position, u16 id, u16 metadata). */
export function multiBlockChangeFrame(
  chunkX: number,
  chunkZ: number,
  records: Array<{ x: number; y: number; z: number; id: number }>,
): Buffer {
  const body = records.map((r) => {
    const b = Buffer.alloc(6);
    b.writeUInt16BE(((r.x & 15) << 12) | ((r.z & 15) << 8) | (r.y & 255), 0);
    b.writeUInt16BE(r.id, 2);
    return b;
  });
  const count = Buffer.alloc(2);
  count.writeUInt16BE(records.length);
  return encodeFrame(
    0x22,
    Buffer.concat([i32(chunkX), i32(chunkZ), count, i32(records.length * 6), ...body]),
  );
}
