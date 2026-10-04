import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { outbound } from '../../../src/bot/gtnh1710/packets.ts';
import {
  CLICKABLE_SUPPORTS,
  checkPlace,
  checkPlaceCell,
  checkStation,
  FALLING_SUPPORTS,
  PLACE_NEIGHBOURS,
  PLACE_TARGETS,
  scanPlaceable,
  type PlaceArea,
} from '../../../src/bot/gtnh1710/placing.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { ProtocolError } from '../../../src/bot/gtnh1710/wire.ts';

// A glass floor at y=199 from -20 to 20 (feet level 200), air above, plus test blocks. The
// player stands at (0.5, 200, 0.5): its body is in the cells (0, 200, 0) and (0, 201, 0),
// its eyes at y 201.62.
const ID = {
  stone: 1,
  water: 9,
  lava: 11,
  leaves: 18,
  glass: 20,
  tallgrass: 31,
  deadbush: 32,
  flower: 37,
  torch: 50,
  chest: 54,
  foliage: 1102,
  modded: 4000,
  unnamed: 4242,
} as const;
const NAMES = new Map<number, string>([
  [ID.foliage, 'BiomesOPlenty:foliage'],
  [ID.stone, 'minecraft:stone'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
  [ID.leaves, 'minecraft:leaves'],
  [ID.glass, 'minecraft:glass'],
  [ID.tallgrass, 'minecraft:tallgrass'],
  [ID.deadbush, 'minecraft:deadbush'],
  [ID.flower, 'minecraft:yellow_flower'],
  [ID.torch, 'minecraft:torch'],
  [ID.chest, 'minecraft:chest'],
  [ID.modded, 'gregtech:gt.blockmachines'],
]);

/** The test world; with `metas` it reports block metadata (0 where not listed). */
function world(
  blocks: Record<string, number> = {},
  unloaded: Array<[number, number]> = [],
  metas?: Record<string, number>,
): WalkWorld {
  const overrides = new Map(Object.entries(blocks));
  const missing = new Set(unloaded.map(([x, z]) => `${x},${z}`));
  const w: WalkWorld = {
    blockAt(x, y, z) {
      if (missing.has(`${x},${z}`)) return undefined;
      const o = overrides.get(`${x},${y},${z}`);
      if (o !== undefined) return o;
      return y === 199 && Math.abs(x) <= 20 && Math.abs(z) <= 20 ? ID.glass : 0;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    hazardCode: (id) =>
      id === ID.lava ? BLOCK_CODE.lava : NAMES.has(id) || id === 0 ? BLOCK_CODE.safe : 255,
  };
  return metas === undefined ? w : { ...w, metaAt: (x, y, z) => metas[`${x},${y},${z}`] ?? 0 };
}

const FEET: Vec3 = { x: 0.5, y: 200, z: 0.5 };
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const AREA: PlaceArea = {
  fence: { min: { x: -4, y: 200, z: -4 }, max: { x: 4, y: 200, z: 4 } },
  maxHeightAboveFence: 4,
};
const TERRAIN: PlaceArea = {
  fence: { min: { x: -4, y: 195, z: -4 }, max: { x: 4, y: 205, z: 4 } },
  maxHeightAboveFence: 4,
};

describe('checkPlaceCell', () => {
  it('fills a floor cell next to the player against the block below, clicking its top face', () => {
    const r = checkPlaceCell(world(), FEET, { x: 1, y: 200, z: 0 }, []);
    expect(r).toMatchObject({
      ok: true,
      replaces: 0,
      support: { clicked: { x: 1, y: 199, z: 0 }, face: 1, cursor: { x: 8, y: 16, z: 8 } },
      fallingProblem: null,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.reach).toBeCloseTo(Math.hypot(1, 1.12), 5);
  });

  it('prefers the block below, then the sides, and uses one above only when its face is visible', () => {
    // A stone beside the floor cell: the block below still wins.
    const beside = world({ [k(2, 200, 0)]: ID.stone });
    expect(checkPlaceCell(beside, FEET, { x: 1, y: 200, z: 0 }, [])).toMatchObject({
      support: { clicked: { x: 1, y: 199, z: 0 }, face: 1 },
    });
    // At head height there is air below: the stone to the east, its west face (4).
    const side = world({ [k(2, 201, 0)]: ID.stone });
    expect(checkPlaceCell(side, FEET, { x: 1, y: 201, z: 0 }, [])).toMatchObject({
      ok: true,
      support: { clicked: { x: 2, y: 201, z: 0 }, face: 4, cursor: { x: 0, y: 8, z: 8 } },
      fallingProblem: expect.stringMatching(/minecraft:air is under it/) as unknown,
    });
    // Above the eyes the top face of the block below faces away: the block above is used,
    // through its bottom face (0).
    const above = world({ [k(1, 202, 0)]: ID.stone, [k(1, 204, 0)]: ID.stone });
    expect(checkPlaceCell(above, FEET, { x: 1, y: 203, z: 0 }, [])).toMatchObject({
      ok: true,
      support: { clicked: { x: 1, y: 204, z: 0 }, face: 0, cursor: { x: 8, y: 0, z: 8 } },
    });
    expect(
      checkPlaceCell(world({ [k(1, 202, 0)]: ID.stone }), FEET, { x: 1, y: 203, z: 0 }, []),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nothing to place it against/) as unknown,
    });
  });

  it('never clicks a block beyond the server reach, measured from the feet and 2 above them', () => {
    // Over the head, 3.9 from the eyes; both possible supports are more than 5.5 from the feet.
    const far = world({ [k(0, 206, 0)]: ID.stone, [k(1, 205, 0)]: ID.stone });
    expect(checkPlaceCell(far, FEET, { x: 0, y: 205, z: 0 }, [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/within the server's reach/) as unknown,
    });
  });

  it('replaces tall grass and dead bushes in place', () => {
    for (const plant of [ID.tallgrass, ID.deadbush]) {
      expect(
        checkPlaceCell(world({ [k(1, 200, 0)]: plant }), FEET, { x: 1, y: 200, z: 0 }, []),
      ).toMatchObject({ ok: true, replaces: plant });
    }
  });

  it.each<[string, Record<string, number>, { x: number; y: number; z: number }, RegExp]>([
    [
      'a flower (not replaceable)',
      { [k(1, 200, 0)]: ID.flower },
      { x: 1, y: 200, z: 0 },
      /holds minecraft:yellow_flower/,
    ],
    ['water', { [k(1, 200, 0)]: ID.water }, { x: 1, y: 200, z: 0 }, /holds minecraft:water/],
    ['a block', { [k(1, 200, 0)]: ID.stone }, { x: 1, y: 200, z: 0 }, /holds minecraft:stone/],
    [
      'an unnamed block',
      { [k(1, 200, 0)]: ID.unnamed },
      { x: 1, y: 200, z: 0 },
      /block id 4242, which the registry does not name/,
    ],
    ['out of reach', {}, { x: 4, y: 200, z: 4 }, /5\.77 blocks from the eyes \(max 4\.5\)/],
    ["the player's feet", {}, { x: 0, y: 200, z: 0 }, /a cell the player's body is in/],
    ["the player's head", {}, { x: 0, y: 201, z: 0 }, /a cell the player's body is in/],
    [
      'next to a chest',
      { [k(2, 200, 0)]: ID.chest },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:chest at \(2, 200, 0\)/,
    ],
    [
      'next to a machine',
      { [k(1, 201, 0)]: ID.modded },
      { x: 1, y: 200, z: 0 },
      /touches gregtech:gt\.blockmachines/,
    ],
    [
      'next to a torch',
      { [k(1, 200, 1)]: ID.torch },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:torch/,
    ],
    [
      'next to water',
      { [k(1, 200, -1)]: ID.water },
      { x: 1, y: 200, z: 0 },
      /touches minecraft:water/,
    ],
    [
      'next to an unnamed block',
      { [k(2, 200, 0)]: ID.unnamed },
      { x: 1, y: 200, z: 0 },
      /touches block id 4242/,
    ],
    [
      'lava diagonally',
      { [k(2, 201, 1)]: ID.lava },
      { x: 1, y: 200, z: 0 },
      /next to minecraft:lava at \(2, 201, 1\)/,
    ],
    ['below the world', {}, { x: 1, y: 0, z: 0 }, /not a cell the agent places into/],
  ])('refuses %s', (_name, blocks, target, reason) => {
    const r = checkPlaceCell(world(blocks), FEET, target, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('refuses a cell any part of the body overlaps, also when standing on an edge', () => {
    // Feet at x 0.9: the body (0.6 wide) reaches into the column x=1.
    expect(
      checkPlaceCell(world(), { x: 0.9, y: 200, z: 0.5 }, { x: 1, y: 200, z: 0 }, []),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/body is in/) as unknown,
    });
    // Touching the body's face is not overlapping.
    expect(checkPlaceCell(world(), { x: 0.7, y: 200, z: 0.5 }, { x: 1, y: 200, z: 0 }, []).ok).toBe(
      true,
    );
  });

  it('refuses a cell an entity (counted as 2 x 3 blocks) may be in', () => {
    const cell = { x: 1, y: 200, z: 0 };
    const at = (x: number, y: number, z: number) =>
      checkPlaceCell(world(), FEET, cell, [{ x, y, z }]);
    expect(at(1.5, 200, 0.5)).toMatchObject({
      ok: false,
      reason: 'an entity at (1.5, 200.0, 0.5) is in or next to (1, 200, 0)',
    });
    expect(at(2.9, 200, 0.5).ok).toBe(false); // its box reaches x 1.9
    expect(at(1.5, 197.5, 0.5).ok).toBe(false); // standing below, 3 tall
    expect(at(3, 200, 0.5).ok).toBe(true); // its box only touches the cell's face
  });

  it('plants and plain blocks may touch the cell', () => {
    const plants = world({
      [k(2, 200, 0)]: ID.flower,
      [k(1, 200, 1)]: ID.tallgrass,
      [k(1, 200, -1)]: ID.leaves,
    });
    expect(checkPlaceCell(plants, FEET, { x: 1, y: 200, z: 0 }, []).ok).toBe(true);
  });

  it('BOP foliage may touch the cell as a variant the walker passes, not as poison ivy', () => {
    const cell = { x: 1, y: 200, z: 0 };
    const bush = { [k(2, 200, 0)]: ID.foliage };
    expect(checkPlaceCell(world(bush, [], { [k(2, 200, 0)]: 4 }), FEET, cell, []).ok).toBe(true);
    expect(checkPlaceCell(world(bush, [], { [k(2, 200, 0)]: 7 }), FEET, cell, [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/touches BiomesOPlenty:foliage@7 at \(2, 200, 0\)/) as unknown,
    });
    expect(checkPlaceCell(world(bush), FEET, cell, [])).toMatchObject({ ok: false });
  });

  it('refuses when the cell or anything around it is not loaded', () => {
    expect(checkPlaceCell(world({}, [[1, 0]]), FEET, { x: 1, y: 200, z: 0 }, [])).toMatchObject({
      ok: false,
      reason: '(1, 200, 0) is not loaded',
    });
    expect(checkPlaceCell(world({}, [[2, 0]]), FEET, { x: 1, y: 200, z: 0 }, [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/next to it at \(2, 200, 0\) is not loaded/) as unknown,
    });
  });

  it("says where sand and gravel may go: on a full block, never in the player's columns", () => {
    const problem = (
      blocks: Record<string, number>,
      target: { x: number; y: number; z: number },
    ) => {
      const r = checkPlaceCell(world(blocks), FEET, target, []);
      if (!r.ok) throw new Error(r.reason);
      return r.fallingProblem;
    };
    expect(problem({}, { x: 1, y: 200, z: 0 })).toBeNull();
    // Over the head, against a block beside it: fine for cobblestone, never for sand.
    expect(problem({ [k(1, 202, 0)]: ID.stone }, { x: 0, y: 202, z: 0 })).toMatch(
      /in a column the player stands in/,
    );
    // Leaves are not a full block: sand would slide off when they decay.
    expect(problem({ [k(1, 199, 0)]: ID.leaves }, { x: 1, y: 200, z: 0 })).toMatch(
      /minecraft:leaves is under it/,
    );
  });
});

describe('checkPlace', () => {
  it('places inside the fence, from its level up to maxHeightAboveFence, never the floor', () => {
    const w = world({ [k(1, 199, 0)]: ID.glass });
    expect(
      checkPlace(w, AREA, FEET, { x: 1, y: 200, z: 0 }, 'minecraft:cobblestone', []),
    ).toMatchObject({
      ok: true,
      block: 'minecraft:cobblestone',
      support: { clicked: { x: 1, y: 199, z: 0 }, face: 1 },
    });
    expect(checkPlace(w, AREA, FEET, { x: 5, y: 200, z: 0 }, 'minecraft:dirt', [])).toMatchObject({
      ok: false,
      reason: "(5, 200, 0) is outside the fence's columns",
    });
    expect(checkPlace(w, AREA, FEET, { x: 1, y: 199, z: 0 }, 'minecraft:dirt', [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /outside the place heights y=200\.\.204 \(never the floor/,
      ) as unknown,
    });
    expect(checkPlace(w, AREA, FEET, { x: 1, y: 205, z: 0 }, 'minecraft:dirt', []).ok).toBe(false);
  });

  it('on terrain, from one below the feet up to maxHeightAboveFence above them', () => {
    // A hole in the floor next to the player, with a block under it: it may be filled.
    const hole = world({ [k(1, 199, 0)]: 0, [k(1, 198, 0)]: ID.stone });
    expect(checkPlace(hole, TERRAIN, FEET, { x: 1, y: 199, z: 0 }, 'minecraft:dirt', []).ok).toBe(
      true,
    );
    expect(
      checkPlace(hole, TERRAIN, FEET, { x: 1, y: 198, z: 0 }, 'minecraft:dirt', []),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/outside the place heights y=199\.\.204/) as unknown,
    });
  });

  it('places sand and gravel only where they cannot fall', () => {
    const w = world({ [k(2, 201, 0)]: ID.stone, [k(1, 202, 0)]: ID.stone });
    expect(checkPlace(w, AREA, FEET, { x: 1, y: 200, z: 0 }, 'minecraft:sand', []).ok).toBe(true);
    expect(checkPlace(w, AREA, FEET, { x: 1, y: 201, z: 0 }, 'minecraft:gravel', [])).toMatchObject(
      {
        ok: false,
        reason:
          'minecraft:gravel at (1, 201, 0): it would fall: minecraft:air is under it, not a plain full block',
      },
    );
    expect(checkPlace(w, AREA, FEET, { x: 1, y: 201, z: 0 }, 'minecraft:planks@2', []).ok).toBe(
      true,
    );
    // Sealing the cell over the head: logs yes, sand never.
    expect(checkPlace(w, AREA, FEET, { x: 0, y: 202, z: 0 }, 'minecraft:log', []).ok).toBe(true);
    expect(checkPlace(w, AREA, FEET, { x: 0, y: 202, z: 0 }, 'minecraft:sand', [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /in a column the player stands in: it could fall on its head/,
      ) as unknown,
    });
  });
});

describe('placing a crafting table or a furnace (checkStation)', () => {
  /** Stone at the feet and head levels along z = -1 and z = `south` (x -6..6): a corridor. */
  const corridor = (south: number, extra: Record<string, number> = {}): WalkWorld => {
    const blocks: Record<string, number> = { ...extra };
    for (let x = -6; x <= 6; x++) {
      for (const z of [-1, south]) for (const y of [200, 201]) blocks[k(x, y, z)] = ID.stone;
    }
    return world(blocks);
  };

  it('goes on the ground beside the player, in the open', () => {
    expect(checkStation(world(), TERRAIN.fence, FEET, { x: 2, y: 200, z: 0 })).toBeNull();
    expect(
      checkPlace(world(), TERRAIN, FEET, { x: 2, y: 200, z: 0 }, 'minecraft:crafting_table', []),
    ).toMatchObject({
      ok: true,
      block: 'minecraft:crafting_table',
      support: { clicked: { x: 2, y: 199, z: 0 }, face: 1 },
    });
    // In the pen (one walking level) too, and a furnace alike.
    expect(
      checkPlace(world(), AREA, FEET, { x: 1, y: 200, z: 0 }, 'minecraft:furnace', []),
    ).toMatchObject({ ok: true, block: 'minecraft:furnace' });
  });

  it('never in a 1-wide passage: the walks it cuts off refuse it (a plain block is not judged so)', () => {
    const narrow = corridor(1);
    const cell = { x: 2, y: 200, z: 0 };
    expect(checkStation(narrow, TERRAIN.fence, FEET, cell)).toMatch(
      /^it would be in the player's way: \d+ spot\(s\) it walks to now \(e\.g\. \(3, 200, 0\)\) would be cut off/,
    );
    expect(checkPlace(narrow, TERRAIN, FEET, cell, 'minecraft:furnace', [])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^minecraft:furnace at \(2, 200, 0\): it would be in the/,
      ) as unknown,
    });
    expect(checkPlace(narrow, TERRAIN, FEET, cell, 'minecraft:cobblestone', []).ok).toBe(true);
    // Two blocks wide, the other lane stays open; at a dead end nothing is cut off.
    expect(checkStation(corridor(2), TERRAIN.fence, FEET, cell)).toBeNull();
    const deadEnd = corridor(1, { [k(3, 200, 0)]: ID.stone, [k(3, 201, 0)]: ID.stone });
    expect(checkStation(deadEnd, TERRAIN.fence, FEET, cell)).toBeNull();
  });

  it("never on a staircase's only step", () => {
    // North of z = -1 a plateau two blocks high (feet at 202 on it), reached by one step at
    // x = 2: the stone at (2, 200, -2) has nothing on it, and the walker steps up straight
    // only, from (2, 200, -1).
    const blocks: Record<string, number> = {};
    for (let x = -6; x <= 6; x++) {
      for (let z = -6; z <= -2; z++) {
        blocks[k(x, 200, z)] = ID.stone;
        if (!(x === 2 && z === -2)) blocks[k(x, 201, z)] = ID.stone;
      }
    }
    const stairs = world(blocks);
    expect(checkStation(stairs, TERRAIN.fence, FEET, { x: 2, y: 200, z: -1 })).toMatch(
      /in the player's way: .*\(2, 201, -2\)/,
    );
    expect(checkStation(stairs, TERRAIN.fence, FEET, { x: 0, y: 200, z: -1 })).toBeNull();
  });

  it("only on a solid floor, never in the player's own columns, and only from walkable ground", () => {
    // At head height beside a stone: placeable for a log, but no floor under it.
    const side = world({ [k(2, 201, 0)]: ID.stone });
    expect(checkPlace(side, AREA, FEET, { x: 1, y: 201, z: 0 }, 'minecraft:log', []).ok).toBe(true);
    expect(checkStation(side, AREA.fence, FEET, { x: 1, y: 201, z: 0 })).toBe(
      'it would not stand on a solid floor: minecraft:air is under it',
    );
    expect(
      checkStation(world({ [k(1, 199, 0)]: ID.leaves }), TERRAIN.fence, FEET, {
        x: 1,
        y: 200,
        z: 0,
      }),
    ).toMatch(/minecraft:leaves is under it/);
    // Over the head (against a block beside it): never.
    const overHead = world({ [k(1, 202, 0)]: ID.stone });
    expect(checkStation(overHead, TERRAIN.fence, FEET, { x: 0, y: 202, z: 0 })).toMatch(
      /in a column the player stands in/,
    );
    // Feet in the air (mid-jump): no walk to compare, so no.
    expect(
      checkStation(world(), TERRAIN.fence, { x: 0.5, y: 200.4, z: 0.5 }, { x: 2, y: 200, z: 0 }),
    ).toMatch(/does not stand on walkable ground/);
  });
});

describe('scanPlaceable', () => {
  it('lists the empty cells a block could go into, nearest to the eyes first', () => {
    const cells = scanPlaceable(world(), FEET, [], 32);
    // The four floor cells beside the player, 1.50 from the eyes (ties by position), first.
    expect(cells.slice(0, 4).map((c) => c.position)).toEqual([
      { x: -1, y: 200, z: 0 },
      { x: 0, y: 200, z: -1 },
      { x: 0, y: 200, z: 1 },
      { x: 1, y: 200, z: 0 },
    ]);
    expect(cells.every((c) => c.takesFalling)).toBe(true);
    expect(cells.every((c) => c.position.y === 200)).toBe(true); // nothing to place against above
    expect(cells.some((c) => c.position.x === 0 && c.position.z === 0)).toBe(false);
    expect(cells).toHaveLength(32);
    expect(scanPlaceable(world(), FEET, [], 3)).toHaveLength(3);
  });

  it('leaves out cells an entity may be in', () => {
    const cells = scanPlaceable(world(), FEET, [{ x: 1.5, y: 200, z: 0.5 }], 64);
    expect(cells.some((c) => c.position.x === 1 && c.position.z === 0)).toBe(false);
  });
});

describe('the placing block sets', () => {
  it('clicks only plain full vanilla blocks, never a block with a window', () => {
    for (const name of [
      'minecraft:glass',
      'minecraft:stone',
      'minecraft:dirt',
      'minecraft:log',
      'minecraft:leaves',
      'minecraft:planks',
    ]) {
      expect(CLICKABLE_SUPPORTS.has(name), name).toBe(true);
    }
    for (const name of [
      'minecraft:chest',
      'minecraft:crafting_table',
      'minecraft:furnace',
      'minecraft:trapped_chest',
      'gregtech:gt.blockmachines',
      'minecraft:torch',
      'minecraft:tallgrass',
      'minecraft:air',
    ]) {
      expect(CLICKABLE_SUPPORTS.has(name), name).toBe(false);
    }
    expect([...CLICKABLE_SUPPORTS].every((n) => n.startsWith('minecraft:'))).toBe(true);
  });

  it('fills only air, tall grass and dead bushes; sand rests only on full blocks', () => {
    expect([...PLACE_TARGETS].sort()).toEqual([
      'minecraft:air',
      'minecraft:deadbush',
      'minecraft:tallgrass',
    ]);
    expect(FALLING_SUPPORTS.has('minecraft:leaves')).toBe(false);
    expect(FALLING_SUPPORTS.has('minecraft:sand')).toBe(true);
    expect(PLACE_NEIGHBOURS.has('minecraft:red_flower')).toBe(true);
    expect(PLACE_NEIGHBOURS.has('minecraft:water')).toBe(false);
  });
});

describe('C08 packet builder (placing)', () => {
  const cobble = { id: 4, count: 10, damage: 0, hasNbt: false };
  const top = { x: 8, y: 16, z: 8 };

  it('writes x, y, z, face, the held stack and the cursor like 1.7.10 reads them', () => {
    const p = outbound.placeBlock(-3, 105, -8, 1, cobble, top, false);
    expect(p.kind).toBe('place-block');
    // length 21, id 0x08, x -3, y 105, z -8, face 1, stack (id 4, count 10, damage 0, no
    // NBT), cursor 8/16/8
    expect(p.frame.toString('hex')).toBe(
      '15' +
        '08' +
        'fffffffd' +
        '69' +
        'fffffff8' +
        '01' +
        '0004' +
        '0a' +
        '0000' +
        'ffff' +
        '081008',
    );
    // With ModularUI the stack ends with its size as a VarInt.
    expect(outbound.placeBlock(-3, 105, -8, 1, cobble, top, true).frame.toString('hex')).toBe(
      '16' +
        '08' +
        'fffffffd' +
        '69' +
        'fffffff8' +
        '01' +
        '0004' +
        '0a' +
        '0000' +
        'ffff' +
        '0a' +
        '081008',
    );
  });

  it('can never use an item in the air, claim an odd stack or click a bad position', () => {
    expect(() => outbound.placeBlock(0, 64, 0, 255, cobble, top, false)).toThrow(/bad face/);
    expect(() => outbound.placeBlock(0, 64, 0, 6, cobble, top, false)).toThrow(ProtocolError);
    expect(() => outbound.placeBlock(0, 256, 0, 1, cobble, top, false)).toThrow(/bad y/);
    expect(() => outbound.placeBlock(0.5, 64, 0, 1, cobble, top, false)).toThrow(/bad block x\/z/);
    expect(() => outbound.placeBlock(0, 64, 0, 1, { ...cobble, count: 0 }, top, false)).toThrow(
      /cannot be placed from/,
    );
    expect(() => outbound.placeBlock(0, 64, 0, 1, { ...cobble, hasNbt: true }, top, false)).toThrow(
      /NBT/,
    );
    expect(() => outbound.placeBlock(0, 64, 0, 1, cobble, { x: 8, y: 17, z: 8 }, false)).toThrow(
      /bad cursor/,
    );
  });
});
