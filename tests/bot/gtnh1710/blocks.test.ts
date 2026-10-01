import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_CODE,
  buildBlockCodeTable,
  hazardKindOfBlock,
} from '../../../src/bot/gtnh1710/block-hazards.ts';
import {
  ChunkStore,
  decodeChunkBulk,
  decodeChunkColumn,
  decodeChunkColumnWithBiomes,
  type ColumnHeader,
} from '../../../src/bot/gtnh1710/chunk-data.ts';
import { MAX_REPORTED_HAZARDS, scanHazards } from '../../../src/bot/gtnh1710/hazard-scan.ts';
import { decodePlay, VANILLA_DECODING } from '../../../src/bot/gtnh1710/packets.ts';
import { parseModIdData } from '../../../src/bot/gtnh1710/registry.ts';
import {
  encodeString,
  encodeVarInt,
  i32,
  ProtocolError,
  Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import {
  BLOCK,
  flatWorld,
  neidColumn,
  TEST_BLOCK_REGISTRY,
  vanillaColumn,
  type BlockFn,
  type MetaFn,
} from './chunk-fixtures.ts';

const NEID = { neid: true };
const VANILLA = { neid: false };

function registryOf(blocks: Array<[number, string]>) {
  const entries = blocks.map(([id, name]) =>
    Buffer.concat([encodeString(`\u0001${name}`), encodeVarInt(id)]),
  );
  return parseModIdData(
    Buffer.concat([
      Buffer.from([3]),
      encodeVarInt(blocks.length),
      ...entries,
      encodeVarInt(0),
      encodeVarInt(0),
    ]),
  );
}
const codes = buildBlockCodeTable(registryOf(TEST_BLOCK_REGISTRY));

/**
 * A chunk store holding the columns within `radius` chunks of (0,0), built from a world
 * function (and its metadata), sent in NEID's or vanilla's layout.
 */
function storeOf(world: BlockFn, radius = 3, meta?: MetaFn, neid = true): ChunkStore {
  const store = new ChunkStore();
  const columns = [];
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      const column = neid ? neidColumn : vanillaColumn;
      columns.push(column(cx, cz, world, true, true, undefined, meta));
    }
  }
  const decoded = decodeChunkBulk(
    columns.map((c) => c.header),
    true,
    deflateSync(Buffer.concat(columns.map((c) => c.data))),
    neid ? NEID : VANILLA,
  );
  for (const c of decoded) {
    store.setColumn(c.header.chunkX, c.header.chunkZ, c.sections, 0, c.biomes, c.meta);
  }
  return store;
}

describe('hazard block table', () => {
  it.each([
    ['minecraft:lava', 'lava'],
    ['minecraft:flowing_lava', 'lava'],
    ['TConstruct:fluid.molten.iron', 'lava'],
    ['tinkersdefense:moltenQueensGold', 'lava'],
    ['minecraft:fire', 'fire'],
    ['Thaumcraft:blockFluxGoo', 'harmful_fluid'],
    ['minecraft:cactus', 'damaging_block'],
    ['ExtraUtilities:spike_base_diamond', 'damaging_block'],
  ])('%s is a %s hazard', (name, kind) => {
    expect(hazardKindOfBlock(name)).toBe(kind);
  });

  it.each([
    'Forestry:logsFireproof',
    'TwilightForest:tile.TFFireflyJar',
    'chisel:lavastone',
    'TConstruct:LavaTank',
    'modernmarkings:tile.wall_marking_symbol_fire',
    'minecraft:web',
    'minecraft:stone',
  ])('%s is not a hazard', (name) => {
    expect(hazardKindOfBlock(name)).toBeNull();
  });

  it('marks ids missing from the registry as unknown, and air as safe', () => {
    expect(codes[0]).toBe(BLOCK_CODE.safe);
    expect(codes[BLOCK.stone]).toBe(BLOCK_CODE.safe);
    expect(codes[BLOCK.lava]).toBe(BLOCK_CODE.lava);
    expect(codes[4242]).toBe(BLOCK_CODE.unknown);
  });
});

describe('chunk data decoding', () => {
  it('decodes NotEnoughIDs columns, including 16-bit ids and negative coordinates', () => {
    const world: BlockFn = (x, y, z) =>
      x === -3 && y === 70 && z === -20 ? 30000 : flatWorld()(x, y, z);
    const store = storeOf(world, 2);
    expect(store.blockAt(-3, 70, -20)).toBe(30000);
    expect(store.blockAt(5, 0, 5)).toBe(BLOCK.bedrock);
    expect(store.blockAt(-17, 105, 31)).toBe(BLOCK.grass);
    expect(store.blockAt(0, 200, 0)).toBe(0); // empty section
    expect(store.blockAt(100, 64, 100)).toBeUndefined(); // column not loaded
  });

  it('decodes vanilla columns, including the add (high nibble) array', () => {
    // One section at the bottom; block (1,0,0) has id 300 = LSB 0x2C + MSB nibble 1.
    const lsb = Buffer.alloc(4096);
    lsb[0] = BLOCK.bedrock;
    lsb[1] = 0x2c;
    const add = Buffer.alloc(2048);
    add[0] = 0x10; // index 1 -> high nibble of byte 0
    const data = Buffer.concat([
      lsb,
      Buffer.alloc(2048),
      Buffer.alloc(2048),
      Buffer.alloc(2048),
      add,
      Buffer.alloc(256),
    ]);
    const header: ColumnHeader = { chunkX: 0, chunkZ: 0, primaryBitMask: 1, addBitMask: 1 };
    const [column] = decodeChunkBulk([header], true, deflateSync(data), { neid: false });
    expect(column?.sections[0]?.[0]).toBe(BLOCK.bedrock);
    expect(column?.sections[0]?.[1]).toBe(300);
  });

  it('infers sky light for single-column packets from the data length', () => {
    const noSky = neidColumn(0, 0, flatWorld(), false, true);
    expect(decodeChunkColumn(noSky.header, true, deflateSync(noSky.data), NEID)[0]?.[0]).toBe(
      BLOCK.bedrock,
    );
    const partial = neidColumn(0, 0, flatWorld(), true, false); // not ground-up: no biomes
    expect(
      decodeChunkColumn(partial.header, false, deflateSync(partial.data), NEID)[6],
    ).toBeDefined();
    expect(() => decodeChunkColumn(noSky.header, true, deflateSync(Buffer.alloc(7)), NEID)).toThrow(
      ProtocolError,
    );
  });

  it('refuses malformed data instead of misreading it', () => {
    const c = neidColumn(0, 0, flatWorld());
    expect(() =>
      decodeChunkBulk(
        [c.header],
        true,
        deflateSync(Buffer.concat([c.data, Buffer.alloc(1)])),
        NEID,
      ),
    ).toThrow(/length/);
    expect(() => decodeChunkBulk([c.header], true, Buffer.from('not zlib'), NEID)).toThrow(
      /inflate/,
    );
    expect(() =>
      decodeChunkBulk([{ ...c.header, addBitMask: 1 }], true, deflateSync(c.data), NEID),
    ).toThrow(/add mask/);
  });

  it('keeps NotEnoughIDs metadata next to the ids: unsigned 16-bit, 0 where none was sent', () => {
    const blocks = new Map([
      ['-3,70,-20', 30000],
      ['2,106,5', BLOCK.bopFoliage],
      ['3,106,5', BLOCK.bopFoliage],
    ]);
    const meta = new Map([
      ['-3,70,-20', 40000],
      ['2,106,5', 7],
      ['3,106,5', 300],
    ]);
    const store = storeOf(flatWorld(blocks), 2, (x, y, z) => meta.get(`${x},${y},${z}`) ?? 0);
    expect(store.blockAt(-3, 70, -20)).toBe(30000);
    expect(store.metaAt(-3, 70, -20)).toBe(40000); // above 32767: unsigned
    expect(store.metaAt(2, 106, 5)).toBe(7);
    expect(store.metaAt(3, 106, 5)).toBe(300);
    expect(store.metaAt(5, 105, 5)).toBe(0); // grass
    expect(store.metaAt(0, 200, 0)).toBe(0); // an all-air section
    expect(store.metaAt(0, 300, 0)).toBe(0); // above the world: air
    expect(store.metaAt(100, 64, 100)).toBeUndefined(); // column not loaded
  });

  it('keeps vanilla metadata nibbles (an even index in the low one) beside add-array ids', () => {
    // Blocks (0,64,0) and (1,64,0) are indexes 0 and 1: one byte holds both their nibbles.
    const blocks = new Map([
      ['0,64,0', BLOCK.log],
      ['1,64,0', 300],
      ['-1,64,-1', BLOCK.bopFoliage],
    ]);
    const metas = new Map([
      ['0,64,0', 5],
      ['1,64,0', 12],
      ['-1,64,-1', 7],
    ]);
    const meta: MetaFn = (x, y, z) => metas.get(`${x},${y},${z}`) ?? 0;
    const store = storeOf(flatWorld(blocks), 1, meta, false);
    expect([store.blockAt(0, 64, 0), store.metaAt(0, 64, 0)]).toEqual([BLOCK.log, 5]);
    expect([store.blockAt(1, 64, 0), store.metaAt(1, 64, 0)]).toEqual([300, 12]);
    expect([store.blockAt(-1, 64, -1), store.metaAt(-1, 64, -1)]).toEqual([BLOCK.bopFoliage, 7]);
    expect(store.metaAt(0, 105, 0)).toBe(0);
    // One column (Chunk Data) without sky light: its length still tells the layout.
    const c = vanillaColumn(0, 0, flatWorld(blocks), false, true, undefined, meta);
    expect(c.header.addBitMask).toBe(1 << 4);
    const one = decodeChunkColumnWithBiomes(c.header, true, deflateSync(c.data), VANILLA);
    expect([one.sections[4]?.[1], one.meta[4]?.[1], one.meta[4]?.[0]]).toEqual([300, 12, 5]);
  });

  it('applies block changes with their metadata; a column sent without it has none known', () => {
    const store = storeOf(flatWorld(), 1, () => 0);
    store.setBlock(2, 106, 3, BLOCK.bopFoliage, 7);
    expect([store.blockAt(2, 106, 3), store.metaAt(2, 106, 3)]).toEqual([BLOCK.bopFoliage, 7]);
    store.setBlock(2, 106, 3, BLOCK.bopFoliage, 1);
    expect(store.metaAt(2, 106, 3)).toBe(1);
    store.setBlock(2, 106, 4, 30000, 40000); // past a byte: the section's metadata widens
    expect([store.metaAt(2, 106, 4), store.metaAt(2, 106, 3)]).toEqual([40000, 1]);
    store.setBlock(2, 106, 3, 0, 0);
    expect([store.blockAt(2, 106, 3), store.metaAt(2, 106, 3)]).toEqual([0, 0]);
    store.setBlock(-5, 150, 7, BLOCK.bopFoliage, 4); // into an all-air section
    expect(store.metaAt(-5, 150, 7)).toBe(4);

    // A partial update replaces the metadata of its sections too.
    const c = neidColumn(0, 0, flatWorld());
    const decode = () => {
      const [column] = decodeChunkBulk([c.header], true, deflateSync(c.data), NEID);
      if (column === undefined) throw new Error('no column decoded');
      return column;
    };
    const update = decode();
    store.updateSections(0, 0, update.sections, c.header.primaryBitMask, 1, update.meta);
    expect([store.blockAt(2, 106, 4), store.metaAt(2, 106, 4)]).toEqual([0, 0]);
    // Without metadata (a column or an update), the ids are known and the metadata is not.
    store.updateSections(0, 0, decode().sections, c.header.primaryBitMask, 2);
    expect([store.blockAt(2, 105, 4), store.metaAt(2, 105, 4)]).toEqual([BLOCK.grass, undefined]);
    const bare = new ChunkStore();
    bare.setColumn(0, 0, decode().sections, 0);
    bare.setBlock(3, 106, 3, BLOCK.bopFoliage, 1);
    expect([bare.blockAt(3, 106, 3), bare.metaAt(3, 106, 3)]).toEqual([
      BLOCK.bopFoliage,
      undefined,
    ]);
  });

  it('applies block changes, partial updates, unusable columns and unloads', () => {
    const store = storeOf(flatWorld(), 1);
    store.setBlock(-5, 150, 7, BLOCK.lava, 0); // creates a new section
    expect(store.blockAt(-5, 150, 7)).toBe(BLOCK.lava);
    store.markBad(0, 0, 'test', 1);
    expect(store.blockAt(3, 0, 3)).toBeUndefined();
    expect(store.problem(0, 0)).toBe('test');
    expect(store.receivedAt(0, 0)).toBe(1);
    store.unload(0, 0);
    expect(store.problem(0, 0)).toBeUndefined();
  });
});

describe('hazard scan', () => {
  const feet = { x: 0.5, y: 106, z: 0.5 };

  it('lists only exposed hazard blocks (the inside of a lava pool is not listed)', () => {
    const lava = new Map<string, number>();
    for (let x = 4; x <= 6; x++)
      for (let y = 105; y <= 107; y++)
        for (let z = 4; z <= 6; z++) lava.set(`${x},${y},${z}`, BLOCK.lava);
    const scan = scanHazards(storeOf(flatWorld(lava)), codes, feet);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.hazards).toHaveLength(26); // 27 blocks minus the hidden centre
    expect(scan.hazards.every((h) => h.kind === 'lava')).toBe(true);
    expect(scan.hazards.map((h) => h.position)).not.toContainEqual({ x: 5.5, y: 106.5, z: 5.5 });
    expect(scan.hazards[0]?.distance).toBeCloseTo(Math.hypot(4, 0.5, 4), 5);
  });

  it('fails closed on missing chunks, unusable chunks and unregistered block ids', () => {
    const partial = new ChunkStore();
    const c = neidColumn(0, 0, flatWorld());
    const [decoded] = decodeChunkBulk([c.header], true, deflateSync(c.data), NEID);
    if (decoded) partial.setColumn(0, 0, decoded.sections, 0);
    expect(scanHazards(partial, codes, feet)).toMatchObject({
      ok: false,
      reason: /waiting for 24 nearby chunk/,
    });

    const bad = storeOf(flatWorld());
    bad.markBad(1, 1, 'corrupt', 0);
    expect(scanHazards(bad, codes, feet)).toMatchObject({
      ok: false,
      reason: /chunk 1,1 block data unusable/,
    });

    const strange = storeOf(flatWorld(new Map([['3,106,3', 4242]])));
    expect(scanHazards(strange, codes, feet)).toMatchObject({
      ok: false,
      reason: /block id 4242 .* not in the registry/,
    });
  });

  it('caps the list and shrinks the declared coverage instead of truncating silently', () => {
    const cacti = new Map<string, number>();
    for (let x = -20; x <= 20; x += 2)
      for (let z = -20; z <= 20; z += 2) cacti.set(`${x},106,${z}`, BLOCK.cactus);
    const scan = scanHazards(storeOf(flatWorld(cacti)), codes, feet);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.hazards).toHaveLength(MAX_REPORTED_HAZARDS);
    expect(scan.scanRadius).toBeLessThan(32);
    // The guarantee: EVERY hazard closer than the declared coverage is listed.
    const allDistances = [...cacti.keys()].map((k) => {
      const [x, , z] = k.split(',').map(Number) as [number, number, number];
      return Math.hypot(x, 0.5, z); // feet (0.5,106,0.5) to block centre (x+0.5,106.5,z+0.5)
    });
    const inside = allDistances.filter((d) => d < scan.scanRadius).length;
    expect(inside).toBeGreaterThan(100);
    expect(scan.hazards.filter((h) => h.distance < scan.scanRadius)).toHaveLength(inside);
  });

  it('detects bottomless columns as void, listing only their edges', () => {
    const holes = new Set<string>();
    for (let x = 5; x <= 9; x++) for (let z = 5; z <= 9; z++) holes.add(`${x},${z}`);
    const scan = scanHazards(storeOf(flatWorld(new Map(), holes)), codes, feet);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.hazards.filter((h) => h.kind === 'void')).toHaveLength(16); // 5x5 hole: 16 edge columns
  });
});

describe('block change packets', () => {
  const neid = { itemStackSizeVarInt: true, neid: true };

  it('decodes Block Change with NEID (unsigned short metadata) and vanilla (byte metadata)', () => {
    const base = Buffer.concat([i32(-5), Buffer.from([106]), i32(7), encodeVarInt(30000)]);
    const wide = new Reader(Buffer.concat([base, Buffer.from([0x80, 0x03])]));
    expect(decodePlay(0x23, wide, neid)).toEqual({
      type: 'block-change',
      x: -5,
      y: 106,
      z: 7,
      blockId: 30000,
      blockMeta: 0x8003,
    });
    const r = new Reader(Buffer.concat([base, Buffer.from([3])]));
    expect(decodePlay(0x23, r, VANILLA_DECODING)).toMatchObject({ blockId: 30000, blockMeta: 3 });
    expect(r.remaining).toBe(0);
  });

  it('decodes Multi Block Change records (6 bytes with NEID, 4 in vanilla) and checks their size', () => {
    const neidBody = Buffer.concat([
      i32(-1),
      i32(2),
      Buffer.from([0, 1]),
      i32(6),
      Buffer.from([0xf3, 0x6a, 0x00, 0x0b, 0x01, 0x2c]),
    ]);
    expect(decodePlay(0x22, new Reader(neidBody), neid)).toEqual({
      type: 'multi-block-change',
      chunkX: -1,
      chunkZ: 2,
      records: [{ x: -16 + 15, y: 0x6a, z: 32 + 3, blockId: BLOCK.lava, blockMeta: 300 }],
    });
    const vanillaBody = Buffer.concat([
      i32(0),
      i32(0),
      Buffer.from([0, 1]),
      i32(4),
      Buffer.from([0x12, 0x40, 0x00, 0xb7]),
    ]);
    expect(decodePlay(0x22, new Reader(vanillaBody), VANILLA_DECODING)).toMatchObject({
      records: [{ x: 1, y: 0x40, z: 2, blockId: BLOCK.lava, blockMeta: 7 }],
    });
    expect(() => decodePlay(0x22, new Reader(vanillaBody), neid)).toThrow(
      /4 bytes for 1 records of 6/,
    );
  });
});
