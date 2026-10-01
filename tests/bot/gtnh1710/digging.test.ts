import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { ChunkStore, decodeChunkBulk } from '../../../src/bot/gtnh1710/chunk-data.ts';
import {
  checkDig,
  checkWalkBreak,
  DIG_NEIGHBOURS,
  faceTowards,
  standSpotFor,
  walkBreaks,
  type DigArea,
} from '../../../src/bot/gtnh1710/digging.ts';
import { reachableFeet } from '../../../src/bot/gtnh1710/terrain.ts';
import { DIG_STATUS, outbound } from '../../../src/bot/gtnh1710/packets.ts';
import { parseModIdData } from '../../../src/bot/gtnh1710/registry.ts';
import {
  buildDiggableTable,
  diggableOf,
  GROUND_DIRT_SAMPLE,
  scanResources,
} from '../../../src/bot/gtnh1710/resource-scan.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { encodeString, encodeVarInt, ProtocolError } from '../../../src/bot/gtnh1710/wire.ts';
import {
  DIGGABLE_BLOCKS,
  FALLING_DIGGABLE_BLOCKS,
  type DiggableBlock,
} from '../../../src/domain/blocks.ts';
import {
  bareHandProgressPerTick,
  DIGGABLE,
  digWaitTicks,
  serverMinimumTicks,
  vanillaDigTicks,
} from '../../../src/domain/dig-time.ts';
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
  tallgrass: 31,
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
  [ID.tallgrass, 'minecraft:tallgrass'],
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

describe('stand spots (standSpotFor)', () => {
  const log = { x: 3, y: 200, z: 0 };

  it('beside the block, the nearest walk first', () => {
    const w = world({ [k(3, 200, 0)]: ID.log });
    const reachable = reachableFeet(w, TERRAIN.fence, FEET, 64);
    expect(standSpotFor(w, TERRAIN, log, FEET, reachable)).toEqual({ x: 2.5, y: 200, z: 0.5 });
  });

  it('only where a walk gets to, given the spots it reaches (seen live: logs ringed by leaves)', () => {
    const ringed: Record<string, number> = { [k(3, 200, 0)]: ID.log };
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
        for (const y of [200, 201]) ringed[k(3 + dx, y, dz)] = ID.leaves;
      }
    }
    const w = world(ringed);
    // Beside it, inside the ring, there is room to stand...
    expect(standSpotFor(w, TERRAIN, log, FEET)).toEqual({ x: 2.5, y: 200, z: 0.5 });
    // ...but no walk gets there through the leaves...
    expect(
      standSpotFor(w, TERRAIN, log, FEET, reachableFeet(w, TERRAIN.fence, FEET, 64)),
    ).toBeNull();
    // ...unless it may break them (digging enabled): through the ring's west side.
    const breaking = reachableFeet(w, TERRAIN.fence, FEET, 64, walkBreaks(TERRAIN));
    expect(breaking.get('2,200,0')).toMatchObject({ breaks: 2 });
    expect(standSpotFor(w, TERRAIN, log, FEET, breaking)).toEqual({ x: 2.5, y: 200, z: 0.5 });
  });

  it('a spot a walk reaches only by breaking the leaves in it, once they are broken', () => {
    // The log's only open side, west, is filled with leaves (and the player stands beside them).
    const blocks: Record<string, number> = { [k(3, 200, 0)]: ID.log };
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        for (const y of [200, 201]) blocks[k(3 + dx, y, dz)] = dx === -1 ? ID.leaves : ID.stone;
      }
    }
    const w = world(blocks);
    const feet = { x: 0.5, y: 200, z: 0.5 };
    expect(standSpotFor(w, TERRAIN, log, feet)).toBeNull();
    const breaking = reachableFeet(w, TERRAIN.fence, feet, 64, walkBreaks(TERRAIN));
    expect(standSpotFor(w, TERRAIN, log, feet, breaking)).toEqual({ x: 2.5, y: 200, z: 0.5 });
  });
});

describe('breaking on a walk (checkWalkBreak)', () => {
  const leaf = { x: 1, y: 200, z: 0 };

  it('breaks leaves by checkDig, but nothing else a dig may take', () => {
    expect(checkWalkBreak(world({ [k(1, 200, 0)]: ID.leaves }), TERRAIN, FEET, leaf)).toMatchObject(
      { ok: true, block: 'minecraft:leaves' },
    );
    expect(checkWalkBreak(world({ [k(1, 200, 0)]: ID.log }), TERRAIN, FEET, leaf)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/minecraft:log: a walk breaks only leaves/) as unknown,
    });
    expect(checkDig(world({ [k(1, 200, 0)]: ID.log }), TERRAIN, FEET, leaf).ok).toBe(true);
  });

  it.each<[string, Record<string, number>, RegExp]>([
    ['next to lava', { [k(2, 201, 1)]: ID.lava }, /next to minecraft:lava at \(2, 201, 1\)/],
    ['touching water', { [k(2, 200, 0)]: ID.water }, /touches minecraft:water/],
    ['touching a torch', { [k(1, 201, 0)]: ID.torch }, /touches minecraft:torch/],
    ['under sand', { [k(1, 201, 0)]: ID.sand }, /minecraft:sand on top of .* would fall/],
  ])('refuses leaves %s', (_name, around, reason) => {
    const w = world({ [k(1, 200, 0)]: ID.leaves, ...around });
    const r = checkWalkBreak(w, TERRAIN, FEET, leaf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('refuses leaves outside the dig heights, out of reach, or outside the safety boundary', () => {
    const w = world({ [k(1, 205, 0)]: ID.leaves, [k(4, 200, 4)]: ID.leaves });
    expect(checkWalkBreak(w, TERRAIN, FEET, { x: 1, y: 205, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/outside the dig heights/) as unknown,
    });
    expect(checkWalkBreak(w, TERRAIN, FEET, { x: 4, y: 200, z: 4 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/blocks from the eyes/) as unknown,
    });
    const near = world({ [k(1, 200, 0)]: ID.leaves });
    const boundary = { min: { x: -10, y: 0, z: -10 }, max: { x: 1.5, y: 255, z: 10 } };
    expect(checkWalkBreak(near, TERRAIN, FEET, leaf, boundary)).toMatchObject({
      ok: false,
      reason: '(1, 200, 0) is not inside the safety boundary',
    });
    // The walker's rule: the same check, with the cost.
    expect(walkBreaks(TERRAIN).check(near, FEET, leaf)).toEqual({
      ok: true,
      cost: expect.closeTo(3.2, 9) as unknown,
    });
    expect(walkBreaks(TERRAIN, boundary).check(near, FEET, leaf)).toMatchObject({ ok: false });
  });
});

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
  it('a plant beside the block is fine; one on top of it would drop, so it refuses', () => {
    // Seen live: tall grass beside the ground block ruled out every night pit around.
    const beside = { [k(1, 200, 0)]: ID.dirt, [k(2, 200, 0)]: ID.tallgrass };
    expect(checkDig(world(beside), AREA, FEET, { x: 1, y: 200, z: 0 }).ok).toBe(true);
    const onTop = { [k(1, 200, 0)]: ID.dirt, [k(1, 201, 0)]: ID.tallgrass };
    expect(checkDig(world(onTop), AREA, FEET, { x: 1, y: 200, z: 0 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/touches minecraft:tallgrass at \(1, 201, 0\)/) as unknown,
    });
  });

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

  it('lists diggable blocks at or above the feet, nearest first, and of the floor only a sample', () => {
    const store = storeOf({
      [k(3, 106, 0)]: BLOCK.dirt,
      [k(-2, 107, 0)]: BLOCK.log,
      [k(1, 106, 0)]: BLOCK.sand,
      [k(1, 107, 1)]: BLOCK.stone,
    });
    const scan = scanResources(store, table, feet);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.scanRadius).toBe(16);
    // The grass floor (y=105): only the nearest few, never the block the player stands on.
    const floor = scan.resources.filter((r) => r.position.y === 105);
    expect(floor).toHaveLength(GROUND_DIRT_SAMPLE);
    expect(floor.every((r) => r.block === 'minecraft:grass' && r.distance < 2)).toBe(true);
    expect(floor.some((r) => r.position.x === 0 && r.position.z === 0)).toBe(false);
    const rest = scan.resources.filter((r) => r.position.y !== 105);
    expect(rest.map(({ block, position }) => ({ block, position }))).toEqual([
      { block: 'minecraft:sand', position: { x: 1, y: 106, z: 0 } },
      { block: 'minecraft:log', position: { x: -2, y: 107, z: 0 } },
      { block: 'minecraft:dirt', position: { x: 3, y: 106, z: 0 } },
    ]);
    expect(rest.map((r) => r.distance)).toEqual([
      expect.closeTo(Math.hypot(1, 0.5), 9),
      expect.closeTo(Math.hypot(2, 1.5), 9),
      expect.closeTo(Math.hypot(3, 0.5), 9),
    ]);
  });

  it('when too many are found, shares the list fairly: every kind shows, each its nearest', () => {
    // A 13 x 13 layer of dirt just above the player's feet level, and one log farther out
    // (seen live: grass and sand crowded the logs a GATHER wanted out of the list).
    const blocks: Record<string, number> = {};
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) blocks[k(x, 107, z)] = BLOCK.dirt;
    blocks[k(9, 108, 9)] = BLOCK.log;
    const scan = scanResources(storeOf(blocks), table, feet, 16, 20);
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.resources).toHaveLength(20);
    expect(scan.scanRadius).toBe(16);
    const count = (block: string): number => scan.resources.filter((r) => r.block === block).length;
    // The floor sample (8 grass), the log, and the rest of the room the nearest dirt.
    expect([count('minecraft:grass'), count('minecraft:log'), count('minecraft:dirt')]).toEqual([
      GROUND_DIRT_SAMPLE,
      1,
      11,
    ]);
    const distances = scan.resources.map((r) => r.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // Of the dirt, the nearest: none left out is nearer than one listed.
    const listed = new Set(scan.resources.map((r) => k(r.position.x, r.position.y, r.position.z)));
    const farthestListed = Math.max(
      ...scan.resources.filter((r) => r.block === 'minecraft:dirt').map((r) => r.distance),
    );
    for (let x = -6; x <= 6; x++) {
      for (let z = -6; z <= 6; z++) {
        if (listed.has(k(x, 107, z))) continue;
        const d = Math.hypot(x + 0.5 - feet.x, 107.5 - feet.y, z + 0.5 - feet.z);
        expect(d, k(x, 107, z)).toBeGreaterThanOrEqual(farthestListed);
      }
    }
  });

  it('with more kinds than it may list, leaves out the farthest kind and shrinks the radius', () => {
    const store = storeOf({
      [k(2, 106, 0)]: BLOCK.sand,
      [k(-3, 107, 0)]: BLOCK.log,
      [k(5, 107, 0)]: BLOCK.dirt,
    });
    const scan = scanResources(store, table, feet, 16, 3);
    if (!scan.ok) throw new Error(scan.reason);
    // The floor grass (about 1.1 away), the sand (2.1) and the log (3.4): the dirt (5.2) is
    // left out, so the declared radius stops short of it.
    expect(scan.resources.map((r) => r.block)).toEqual([
      'minecraft:grass',
      'minecraft:sand',
      'minecraft:log',
    ]);
    const dirt = Math.hypot(5.5 - feet.x, 107.5 - feet.y, 0.5 - feet.z);
    expect(scan.scanRadius).toBeLessThan(dirt);
    expect(scan.scanRadius).toBeGreaterThan(dirt - 0.01);
  });

  it('is unknown while a chunk in range is missing', () => {
    const scan = scanResources(storeOf({}), table, { x: 20, y: 106, z: 20 });
    expect(scan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/waiting for \d+ nearby chunk/) as string,
    });
  });
});
