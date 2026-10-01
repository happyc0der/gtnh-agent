import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { ChunkStore, decodeChunkBulk } from '../../../src/bot/gtnh1710/chunk-data.ts';
import {
  bareHandProgressPerTick,
  checkDig,
  DIG_NEIGHBOURS,
  DIGGABLE,
  digWaitTicks,
  faceTowards,
  serverMinimumTicks,
  vanillaDigTicks,
  type DigArea,
} from '../../../src/bot/gtnh1710/digging.ts';
import { DIG_STATUS, outbound } from '../../../src/bot/gtnh1710/packets.ts';
import { parseModIdData } from '../../../src/bot/gtnh1710/registry.ts';
import {
  buildDiggableTable,
  diggableOf,
  scanResources,
} from '../../../src/bot/gtnh1710/resource-scan.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { encodeString, encodeVarInt, ProtocolError } from '../../../src/bot/gtnh1710/wire.ts';
import {
  DIGGABLE_BLOCKS,
  FALLING_DIGGABLE_BLOCKS,
  type DiggableBlock,
} from '../../../src/domain/blocks.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY, flatWorld, neidColumn } from './chunk-fixtures.ts';

describe('the dig allowlist', () => {
  it('is exactly the domain allowlist: vanilla natural blocks a bare hand harvests', () => {
    expect([...DIGGABLE.keys()].sort()).toEqual([...DIGGABLE_BLOCKS].sort());
    for (const [name, info] of DIGGABLE) {
      expect(name.startsWith('minecraft:'), name).toBe(true);
      expect(info.bareHandHarvests, name).toBe(true);
      expect(info.falls, name).toBe(FALLING_DIGGABLE_BLOCKS.has(name));
    }
  });

  it('uses the verified 1.7.10 hardness values', () => {
    const hardness = Object.fromEntries([...DIGGABLE].map(([n, i]) => [n, i.hardness]));
    expect(hardness).toEqual({
      'minecraft:log': 2,
      'minecraft:log2': 2,
      'minecraft:leaves': 0.2,
      'minecraft:leaves2': 0.2,
      'minecraft:dirt': 0.5,
      'minecraft:grass': 0.6,
      'minecraft:sand': 0.5,
      'minecraft:gravel': 0.6,
      'minecraft:clay': 0.6,
    });
  });
});

describe('dig time', () => {
  it.each<[DiggableBlock, number, number, number]>([
    // block, vanilla client ticks, the server's minimum, what the agent waits
    ['minecraft:dirt', 15, 10, 21],
    ['minecraft:sand', 15, 10, 21],
    ['minecraft:grass', 18, 12, 25],
    ['minecraft:gravel', 18, 12, 25],
    ['minecraft:clay', 18, 12, 25],
    ['minecraft:log', 60, 41, 77],
    ['minecraft:log2', 60, 41, 77],
    ['minecraft:leaves', 6, 4, 10],
    ['minecraft:leaves2', 6, 4, 10],
  ])('%s: vanilla %i ticks, the server accepts from %i, the agent waits %i', (b, v, s, w) => {
    expect(vanillaDigTicks(b)).toBe(v);
    expect(serverMinimumTicks(b)).toBe(s);
    expect(digWaitTicks(b)).toBe(w);
    // The server's rule, in its own float arithmetic: progress x (ticks + 1) >= 0.7.
    const p = Math.fround(bareHandProgressPerTick(b));
    expect(Math.fround(p * (s + 1))).toBeGreaterThanOrEqual(Math.fround(0.7));
    expect(Math.fround(p * s)).toBeLessThan(Math.fround(0.7));
    // The margin covers a server running at little more than half speed.
    expect(w / s).toBeGreaterThan(1.8);
  });
});

// A glass floor at y=199 from -20 to 20 (feet level 200), air above, plus test blocks.
const ID = {
  air: 0,
  stone: 1,
  grass: 2,
  dirt: 3,
  water: 9,
  lava: 11,
  sand: 12,
  gravel: 13,
  log: 17,
  leaves: 18,
  glass: 20,
  torch: 50,
  chest: 54,
  modded: 4000,
  unnamed: 4242,
} as const;
const NAMES = new Map<number, string>([
  [ID.air, 'minecraft:air'],
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
  [ID.sand, 'minecraft:sand'],
  [ID.gravel, 'minecraft:gravel'],
  [ID.log, 'minecraft:log'],
  [ID.leaves, 'minecraft:leaves'],
  [ID.glass, 'minecraft:glass'],
  [ID.torch, 'minecraft:torch'],
  [ID.chest, 'minecraft:chest'],
  [ID.modded, 'gregtech:gt.blockmachines'],
]);

function world(
  blocks: Record<string, number> = {},
  unloaded: Array<[number, number]> = [],
): WalkWorld {
  const overrides = new Map(Object.entries(blocks));
  const missing = new Set(unloaded.map(([x, z]) => `${x},${z}`));
  return {
    blockAt(x, y, z) {
      if (missing.has(`${x},${z}`)) return undefined;
      const o = overrides.get(`${x},${y},${z}`);
      if (o !== undefined) return o;
      return y === 199 && Math.abs(x) <= 20 && Math.abs(z) <= 20 ? ID.glass : ID.air;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    hazardCode: (id) =>
      id === ID.lava ? BLOCK_CODE.lava : NAMES.has(id) ? BLOCK_CODE.safe : BLOCK_CODE.unknown,
  };
}

const AREA: DigArea = {
  fence: { min: { x: -4, y: 200, z: -4 }, max: { x: 4, y: 200, z: 4 } },
  maxHeightAboveFence: 4,
};
const FEET: Vec3 = { x: 0.5, y: 200, z: 0.5 };
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;

// A terrain fence (a height range): digging goes from one below the feet up.
const TERRAIN: DigArea = {
  fence: { min: { x: -4, y: 195, z: -4 }, max: { x: 4, y: 205, z: 4 } },
  maxHeightAboveFence: 4,
};

describe('checkDig on terrain', () => {
  it('digs the ground layer next to the player, but only one block deep', () => {
    // Sand in the glass floor east of the player, with a floor under it.
    const ground = { [k(1, 199, 0)]: ID.sand, [k(1, 198, 0)]: ID.glass };
    expect(checkDig(world(ground), TERRAIN, FEET, { x: 1, y: 199, z: 0 })).toMatchObject({
      ok: true,
      block: 'minecraft:sand',
    });
    // Nothing under it: the hole would open into the air below.
    expect(
      checkDig(world({ [k(1, 199, 0)]: ID.sand }), TERRAIN, FEET, { x: 1, y: 199, z: 0 }),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing under it/) as unknown });
    // Two below the feet: never.
    const deep = { ...ground, [k(1, 198, 0)]: ID.sand, [k(1, 197, 0)]: ID.glass };
    expect(checkDig(world(deep), TERRAIN, FEET, { x: 1, y: 198, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/outside the dig heights y=199\.\.204/) as unknown,
    });
  });

  it('never digs the block the player stands on', () => {
    const under = { [k(0, 199, 0)]: ID.sand, [k(0, 198, 0)]: ID.glass };
    expect(checkDig(world(under), TERRAIN, FEET, { x: 0, y: 199, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/under the player/) as unknown,
    });
  });

  it('the pen keeps its floor: below the fence level is never dug there', () => {
    const ground = { [k(1, 199, 0)]: ID.sand, [k(1, 198, 0)]: ID.glass };
    expect(checkDig(world(ground), AREA, FEET, { x: 1, y: 199, z: 0 }).ok).toBe(false);
  });
});

describe('checkDig', () => {
  it('allows an allowlisted block next to the player, with only air and plain blocks around it', () => {
    const r = checkDig(world({ [k(1, 200, 0)]: ID.dirt }), AREA, FEET, { x: 1, y: 200, z: 0 });
    expect(r).toMatchObject({ ok: true, block: 'minecraft:dirt', blockId: ID.dirt });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reach).toBeCloseTo(Math.hypot(1, 1.12, 0), 5);
  });

  it('allows chopping a log above the head (it does not fall) and leaves among logs', () => {
    const tree = { [k(0, 202, 0)]: ID.log, [k(0, 203, 0)]: ID.leaves, [k(1, 203, 0)]: ID.leaves };
    expect(checkDig(world(tree), AREA, FEET, { x: 0, y: 202, z: 0 }).ok).toBe(true);
    expect(checkDig(world(tree), AREA, FEET, { x: 1, y: 203, z: 0 }).ok).toBe(true);
  });

  it.each<[string, Record<string, number>, { x: number; y: number; z: number }, RegExp]>([
    [
      'outside the fence',
      { [k(5, 200, 0)]: ID.dirt },
      { x: 5, y: 200, z: 0 },
      /outside the fence's columns/,
    ],
    [
      'the floor',
      {},
      { x: 1, y: 199, z: 0 },
      /outside the dig heights y=200..204 \(never the floor/,
    ],
    ['too high', { [k(1, 205, 0)]: ID.dirt }, { x: 1, y: 205, z: 0 }, /outside the dig heights/],
    ['air', {}, { x: 1, y: 200, z: 0 }, /is air: there is nothing to dig/],
    [
      'stone',
      { [k(1, 200, 0)]: ID.stone },
      { x: 1, y: 200, z: 0 },
      /minecraft:stone, which is not on the dig allowlist/,
    ],
    [
      'a machine',
      { [k(1, 200, 0)]: ID.modded },
      { x: 1, y: 200, z: 0 },
      /gregtech:gt.blockmachines, which is not/,
    ],
    [
      'an unnamed id',
      { [k(1, 200, 0)]: ID.unnamed },
      { x: 1, y: 200, z: 0 },
      /block id 4242, which the registry does not name/,
    ],
    [
      'out of reach',
      { [k(4, 200, 4)]: ID.dirt },
      { x: 4, y: 200, z: 4 },
      /5.\d\d blocks from the eyes \(max 4.5\)/,
    ],
    [
      'touching water',
      { [k(1, 200, 0)]: ID.dirt, [k(2, 200, 0)]: ID.water },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:water at \(2, 200, 0\)/,
    ],
    [
      'touching a torch',
      { [k(1, 200, 0)]: ID.dirt, [k(1, 201, 0)]: ID.torch },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:torch/,
    ],
    [
      'touching a chest',
      { [k(1, 200, 0)]: ID.dirt, [k(1, 200, 1)]: ID.chest },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:chest/,
    ],
    [
      'touching an unnamed block',
      { [k(1, 200, 0)]: ID.dirt, [k(1, 200, -1)]: ID.unnamed },
      { x: 1, y: 200, z: 0 },
      /touches block id 4242/,
    ],
    [
      'gravel on top',
      { [k(1, 200, 0)]: ID.dirt, [k(1, 201, 0)]: ID.gravel },
      { x: 1, y: 200, z: 0 },
      /minecraft:gravel on top of \(1, 200, 0\) would fall/,
    ],
    [
      'lava diagonally',
      { [k(1, 200, 0)]: ID.dirt, [k(2, 201, 1)]: ID.lava },
      { x: 1, y: 200, z: 0 },
      /next to minecraft:lava at \(2, 201, 1\)/,
    ],
    [
      'sand over the head',
      { [k(0, 202, 0)]: ID.sand },
      { x: 0, y: 202, z: 0 },
      /minecraft:sand directly above the player's head/,
    ],
  ])('refuses %s', (_name, blocks, target, reason) => {
    const r = checkDig(world(blocks), AREA, FEET, target);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('never digs what the player stands on, even standing on a block inside the area', () => {
    // Feet at y=201 on a dirt block at (0, 200, 0): its whole column below the head is out.
    const w = world({ [k(0, 200, 0)]: ID.dirt, [k(1, 200, 0)]: ID.dirt });
    const r = checkDig(w, AREA, { x: 0.5, y: 201, z: 0.5 }, { x: 0, y: 200, z: 0 });
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/under the player/) as string,
    });
    // Standing on the edge of two blocks: both are its support.
    const edge = checkDig(w, AREA, { x: 0.9, y: 201, z: 0.5 }, { x: 1, y: 200, z: 0 });
    expect(edge).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/under the player/) as string,
    });
  });

  it('refuses when the block or anything around it is not loaded', () => {
    const w = world({ [k(1, 200, 0)]: ID.dirt }, [[2, 0]]);
    expect(checkDig(w, AREA, FEET, { x: 1, y: 200, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/next to it at \(2, 200, 0\) is not loaded/) as string,
    });
    const gone = world({}, [[1, 0]]);
    expect(checkDig(gone, AREA, FEET, { x: 1, y: 200, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is not loaded/) as string,
    });
  });

  it('only plain full blocks and the allowlist may touch a dug block', () => {
    for (const name of [
      'minecraft:air',
      'minecraft:glass',
      'minecraft:stone',
      'minecraft:log',
      'minecraft:sand',
    ]) {
      expect(DIG_NEIGHBOURS.has(name), name).toBe(true);
    }
    for (const name of [
      'minecraft:water',
      'minecraft:torch',
      'minecraft:chest',
      'minecraft:tallgrass',
      'minecraft:snow_layer',
    ]) {
      expect(DIG_NEIGHBOURS.has(name), name).toBe(false);
    }
  });
});

describe('faceTowards', () => {
  it.each<[Vec3, number]>([
    [{ x: 0.5, y: 205, z: 0.5 }, 1], // from above: top
    [{ x: 0.5, y: 195, z: 0.5 }, 0], // from below: bottom
    [{ x: 0.5, y: 200.5, z: -3 }, 2], // from the north: north face
    [{ x: 0.5, y: 200.5, z: 4 }, 3],
    [{ x: -3, y: 200.5, z: 0.5 }, 4], // from the west: west face
    [{ x: 4, y: 200.5, z: 0.5 }, 5],
  ])('from %o it is face %i', (eyes, face) => {
    expect(faceTowards(eyes, { x: 0, y: 200, z: 0 })).toBe(face);
  });
});

describe('C07 packet builder', () => {
  it('writes status, x, y, z and face like 1.7.10 reads them', () => {
    const p = outbound.digBlock(DIG_STATUS.finish, -4, 106, -8, 1);
    expect(p.kind).toBe('dig-block');
    // frame: length 12, id 0x07, status 2, x -4, y 106, z -8, face 1
    expect(p.frame.toString('hex')).toBe(
      '0c' + '07' + '02' + 'fffffffc' + '6a' + 'fffffff8' + '01',
    );
  });

  it('can never send the item-dropping statuses or a bad position', () => {
    for (const status of [3, 4, 5, -1, 2.5]) {
      expect(() => outbound.digBlock(status as 0, 0, 64, 0, 1)).toThrow(ProtocolError);
    }
    expect(() => outbound.digBlock(0, 0.5, 64, 0, 1)).toThrow(/bad block x\/z/);
    expect(() => outbound.digBlock(0, 0, 256, 0, 1)).toThrow(/bad y/);
    expect(() => outbound.digBlock(0, 0, 64, 0, 6)).toThrow(/bad face/);
  });
});

function registryOf(blocks: Array<[number, string]>) {
  return parseModIdData(
    Buffer.concat([
      Buffer.from([3]),
      encodeVarInt(blocks.length),
      ...blocks.map(([id, name]) =>
        Buffer.concat([encodeString(`\u0001${name}`), encodeVarInt(id)]),
      ),
      encodeVarInt(0),
      encodeVarInt(0),
    ]),
  );
}

/** Columns -2..1 on x and z, from the flat test world (grass floor at y=105) plus overrides. */
function storeOf(overrides: Record<string, number>): ChunkStore {
  const blockFn = flatWorld(new Map(Object.entries(overrides)));
  const columns = [];
  for (let cx = -2; cx <= 1; cx++)
    for (let cz = -2; cz <= 1; cz++) columns.push(neidColumn(cx, cz, blockFn));
  const store = new ChunkStore();
  for (const c of decodeChunkBulk(
    columns.map((c) => c.header),
    true,
    deflateSync(Buffer.concat(columns.map((c) => c.data))),
    { neid: true },
  )) {
    store.setColumn(c.header.chunkX, c.header.chunkZ, c.sections, 0);
  }
  return store;
}

describe('resource scan', () => {
  const table = buildDiggableTable(registryOf(DIG_TEST_BLOCK_REGISTRY));
  const feet = { x: 0.5, y: 106, z: 0.5 };

  it('maps this world registry ids to allowlisted blocks only', () => {
    expect(diggableOf(table, BLOCK.log)).toBe('minecraft:log');
    expect(diggableOf(table, BLOCK.grass)).toBe('minecraft:grass');
    expect(diggableOf(table, BLOCK.stone)).toBeUndefined();
    expect(diggableOf(table, BLOCK.chest)).toBeUndefined();
    expect(diggableOf(table, 0)).toBeUndefined();
  });

  it('lists diggable blocks at or above the feet, nearest first, never the ground', () => {
    const store = storeOf({
      [k(3, 106, 0)]: BLOCK.dirt,
      [k(-2, 107, 0)]: BLOCK.log,
      [k(1, 106, 0)]: BLOCK.sand,
      [k(1, 107, 1)]: BLOCK.stone,
    });
    const scan = scanResources(store, table, feet);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.scanRadius).toBe(16);
    expect(scan.resources.map(({ block, position }) => ({ block, position }))).toEqual([
      { block: 'minecraft:sand', position: { x: 1, y: 106, z: 0 } },
      { block: 'minecraft:log', position: { x: -2, y: 107, z: 0 } },
      { block: 'minecraft:dirt', position: { x: 3, y: 106, z: 0 } },
    ]);
    expect(scan.resources.map((r) => r.distance)).toEqual([
      expect.closeTo(Math.hypot(1, 0.5), 9),
      expect.closeTo(Math.hypot(2, 1.5), 9),
      expect.closeTo(Math.hypot(3, 0.5), 9),
    ]);
  });

  it('when too many are found, keeps the nearest and shrinks the declared radius', () => {
    // A 13 x 13 layer of dirt just above the player's feet level.
    const blocks: Record<string, number> = {};
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) blocks[k(x, 107, z)] = BLOCK.dirt;
    const scan = scanResources(storeOf(blocks), table, feet, 16, 20);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.resources.length).toBeGreaterThan(0);
    expect(scan.resources.length).toBeLessThanOrEqual(20);
    expect(scan.scanRadius).toBeLessThan(16);
    // Complete within the declared radius: every block that close is listed.
    const listed = new Set(scan.resources.map((r) => k(r.position.x, r.position.y, r.position.z)));
    for (let x = -6; x <= 6; x++) {
      for (let z = -6; z <= 6; z++) {
        const d = Math.hypot(x, 1.5, z);
        if (d <= scan.scanRadius) expect(listed.has(k(x, 107, z)), k(x, 107, z)).toBe(true);
      }
    }
  });

  it('is unknown while a chunk in range is missing', () => {
    const scan = scanResources(storeOf({}), table, { x: 20, y: 106, z: 20 });
    expect(scan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/waiting for \d+ nearby chunk/) as string,
    });
  });
});
