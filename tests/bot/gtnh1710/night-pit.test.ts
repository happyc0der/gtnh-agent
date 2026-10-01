import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { checkDigDown, underFeetOf, type DigArea } from '../../../src/bot/gtnh1710/digging.ts';
import {
  continueNightPit,
  enclosedIn,
  planNightPit,
  planShelterExit,
  PlannedWorld,
  walledIn,
  type PitOptions,
} from '../../../src/bot/gtnh1710/night-pit.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';

const ID = {
  air: 0,
  stone: 1,
  grass: 2,
  dirt: 3,
  cobblestone: 4,
  water: 9,
  lava: 11,
  sand: 12,
  gravel: 13,
  coalOre: 16,
  log: 17,
  sandstone: 24,
  tallgrass: 31,
} as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
  [ID.cobblestone, 'minecraft:cobblestone'],
  [ID.water, 'minecraft:water'],
  [ID.lava, 'minecraft:lava'],
  [ID.sand, 'minecraft:sand'],
  [ID.gravel, 'minecraft:gravel'],
  [ID.coalOre, 'minecraft:coal_ore'],
  [ID.log, 'minecraft:log'],
  [ID.sandstone, 'minecraft:sandstone'],
  [ID.tallgrass, 'minecraft:tallgrass'],
]);
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/**
 * Flat land: `top` at y=63 (grass), `under` at y=60-62 (dirt), stone below, air above,
 * plus `blocks`; columns in `unloaded` are not loaded.
 */
function land(
  blocks: Record<string, number> = {},
  opts: { top?: number; under?: number; unloaded?: Array<[number, number]> } = {},
): WalkWorld {
  const overrides = new Map(Object.entries(blocks));
  const missing = new Set((opts.unloaded ?? []).map(([x, z]) => `${x},${z}`));
  return {
    blockAt(x, y, z) {
      if (missing.has(`${x},${z}`)) return undefined;
      const o = overrides.get(k(x, y, z));
      if (o !== undefined) return o;
      if (y === 63) return opts.top ?? ID.grass;
      if (y >= 60 && y < 63) return opts.under ?? ID.dirt;
      return y < 60 ? ID.stone : ID.air;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    hazardCode: (id) =>
      id === ID.lava
        ? BLOCK_CODE.lava
        : id === 0 || NAMES.has(id)
          ? BLOCK_CODE.safe
          : BLOCK_CODE.unknown,
  };
}

const AREA: DigArea = {
  fence: { min: { x: -20, y: 40, z: -20 }, max: { x: 20, y: 90, z: 20 } },
  maxHeightAboveFence: 4,
};
const OPTS: PitOptions = { area: AREA, maxPathLength: 64 };
const FEET: Vec3 = { x: 0.5, y: 64, z: 0.5 };
const UNDER = { x: 0, y: 63, z: 0 };
const specs = (steps: readonly ShelterStep[]) => steps.map((s) => s.spec);
const reasonOf = (r: { ok: boolean; reason?: string }): string =>
  r.ok ? 'ok' : (r.reason ?? 'no reason');

describe('checkDigDown: the block under the feet, exactly one block down', () => {
  it('allows dirt or grass under a centred player, over a plain full block', () => {
    expect(checkDigDown(land(), AREA, FEET, UNDER)).toMatchObject({
      ok: true,
      block: 'minecraft:grass',
      face: 1,
    });
    expect(underFeetOf(land(), FEET)).toEqual({
      position: UNDER,
      block: 'minecraft:grass',
      landing: 'minecraft:dirt',
      landingHolds: true,
    });
  });

  it.each<[string, Record<string, number>, RegExp]>([
    [
      'a cave under it',
      { [k(0, 62, 0)]: ID.air },
      /not a plain full block: the player would not land exactly one block lower/,
    ],
    ['water under it', { [k(0, 62, 0)]: ID.water }, /minecraft:water is under it/],
    [
      'sand under it with a cave below',
      { [k(0, 62, 0)]: ID.sand, [k(0, 61, 0)]: ID.air },
      /minecraft:sand under it at \(0, 62, 0\) has minecraft:air under it: it could fall/,
    ],
    ['lava near the landing', { [k(1, 61, 1)]: ID.lava }, /near minecraft:lava at \(1, 61, 1\)/],
    ['water beside the dug block', { [k(1, 63, 0)]: ID.water }, /touches minecraft:water/],
    [
      'water near the body',
      { [k(1, 64, 1)]: ID.water },
      /minecraft:water at \(1, 64, 1\) is near it/,
    ],
    [
      'tall grass where the feet are',
      { [k(0, 64, 0)]: ID.tallgrass },
      /touches minecraft:tallgrass/,
    ],
    [
      'sand beside it with nothing under it',
      { [k(-1, 63, 0)]: ID.sand, [k(-1, 62, 0)]: ID.air },
      /minecraft:sand beside it at \(-1, 63, 0\) has nothing solid under it/,
    ],
    ['stone', { [k(0, 63, 0)]: ID.stone }, /minecraft:stone: digging down takes only dirt, grass/],
    [
      'an ore near it',
      { [k(-1, 62, -1)]: ID.coalOre },
      /minecraft:coal_ore at \(-1, 62, -1\) is near it/,
    ],
  ])('refuses %s', (_name, blocks, reason) => {
    const r = checkDigDown(land(blocks), AREA, FEET, UNDER);
    expect(r.ok).toBe(false);
    expect(reasonOf(r)).toMatch(reason);
  });

  it('refuses unloaded blocks around it, another block than the one underfoot, and a player not centred', () => {
    // The column east of the player is not loaded (a chunk border).
    expect(reasonOf(checkDigDown(land({}, { unloaded: [[1, 0]] }), AREA, FEET, UNDER))).toMatch(
      /not loaded/,
    );
    expect(reasonOf(checkDigDown(land(), AREA, FEET, { x: 1, y: 63, z: 0 }))).toMatch(
      /is not the block under the player's feet/,
    );
    expect(reasonOf(checkDigDown(land(), AREA, FEET, { x: 0, y: 62, z: 0 }))).toMatch(
      /is not the block under the player's feet/,
    );
    const offCentre = { x: 0.2, y: 64, z: 0.5 };
    expect(reasonOf(checkDigDown(land(), AREA, offCentre, UNDER))).toMatch(
      /stands across more than one column/,
    );
    expect(underFeetOf(land(), offCentre)).toBeNull();
    expect(reasonOf(checkDigDown(land(), AREA, { ...FEET, y: 64.4 }, UNDER))).toMatch(
      /not on a block top/,
    );
  });

  it('never in the pen (a fence on one level keeps its floor), nor below the fence', () => {
    const pen: DigArea = {
      ...AREA,
      fence: { min: { ...AREA.fence.min, y: 64 }, max: { ...AREA.fence.max, y: 64 } },
    };
    expect(reasonOf(checkDigDown(land(), pen, FEET, UNDER))).toMatch(/needs a terrain fence/);
    const shallow: DigArea = {
      ...AREA,
      fence: { ...AREA.fence, min: { ...AREA.fence.min, y: 64 } },
    };
    expect(reasonOf(checkDigDown(land(), shallow, FEET, UNDER))).toMatch(
      /would leave the fence's heights/,
    );
  });
});

describe('the night pit plan', () => {
  it('on grass land: three digs down, then a dirt roof in the ground layer, and a way out', () => {
    const plan = planNightPit(land(), FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.site).toEqual({ x: 0, z: 0, groundY: 63 });
    // The roof comes from the digs themselves: grass and dirt drop dirt.
    expect(plan.roof).toBe('minecraft:dirt');
    expect(specs(plan.steps)).toEqual([
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 62, z: 0 } } },
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 61, z: 0 } } },
      { type: 'PLACE_BLOCK', args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' } },
    ]);
    expect(plan.steps.map((s) => s.text)).toEqual([
      'dig down: the minecraft:grass under the feet at (0, 63, 0)',
      'dig down: the minecraft:dirt under the feet at (0, 62, 0)',
      'dig down: the minecraft:dirt under the feet at (0, 61, 0)',
      'place minecraft:dirt at (0, 63, 0): the roof, against the ground beside it',
    ]);
    // The morning: the roof, a staircase east (upper block first), and the walk out.
    expect(specs(plan.exit)).toEqual([
      { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 62, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 2, y: 63, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
    ]);
  });

  it('prefers a roof block it carries: dirt, then logs (both dug again in the morning)', () => {
    const logs = planNightPit(
      land({}, { top: ID.sand, under: ID.sand }),
      FEET,
      { 'minecraft:log@2': 3 },
      OPTS,
    );
    if (!logs.ok) throw new Error(logs.reason);
    expect(logs.roof).toBe('minecraft:log@2');
    // A desert gives only sand, which would fall: without dirt or logs there is no roof.
    const desert = planNightPit(
      land({}, { top: ID.sand, under: ID.sand }),
      FEET,
      { 'minecraft:cobblestone': 9 },
      OPTS,
    );
    expect(reasonOf(desert)).toMatch(/no block for the roof: dirt or logs/);
  });

  it('walks to the column next door when its own cannot take a pit (a cave under it)', () => {
    const plan = planNightPit(land({ [k(0, 60, 0)]: ID.air }), FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    // The nearest columns first (ties: lower x, then lower z): west of the player.
    expect(plan.site).toEqual({ x: -1, z: 0, groundY: 63 });
    expect(specs(plan.steps).slice(0, 2)).toEqual([
      { type: 'MOVE_TO', args: { target: { x: -0.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
      { type: 'DIG_DOWN', args: { position: { x: -1, y: 63, z: 0 } } },
    ]);
    expect(plan.steps).toHaveLength(5);
  });

  it('refuses where the ground is not natural, solid ground down to the floor all around', () => {
    // Stone at the top: DIG_DOWN takes only dirt, grass, sand, gravel and clay.
    expect(reasonOf(planNightPit(land({}, { top: ID.stone }), FEET, {}, OPTS))).toMatch(
      /no spot for a pit here or next to it \(here: digging down at \(0, 63, 0\): .*minecraft:stone/,
    );
    // A pond in the wall: not natural ground.
    const pond: Record<string, number> = {};
    for (let x = -2; x <= 2; x++)
      for (let z = -2; z <= 2; z++) if (x !== 0 || z !== 0) pond[k(x, 63, z)] = ID.water;
    expect(reasonOf(planNightPit(land(pond), FEET, {}, OPTS))).toMatch(
      /here: the pit's wall at .* would be minecraft:water, not natural ground/,
    );
    // The pen (a fence on one level).
    const pen = {
      ...OPTS,
      area: {
        ...AREA,
        fence: { min: { ...AREA.fence.min, y: 64 }, max: { ...AREA.fence.max, y: 64 } },
      },
    };
    expect(reasonOf(planNightPit(land(), FEET, {}, pen))).toMatch(/a pit needs a terrain fence/);
  });

  it('never digs in without a way out in the morning (walls of stone it cannot dig)', () => {
    // Grass and dirt in the player's column only; stone all around it.
    const column = { [k(0, 63, 0)]: ID.grass, [k(0, 62, 0)]: ID.dirt, [k(0, 61, 0)]: ID.dirt };
    const r = planNightPit(land(column, { top: ID.stone, under: ID.stone }), FEET, {}, OPTS);
    expect(reasonOf(r)).toMatch(/here: no way out in the morning: .*minecraft:stone/);
  });

  it('goes on with a pit it started: the digs left, then the roof', () => {
    const site = { x: 0, z: 0, groundY: 63 };
    const oneDug = land({ [k(0, 63, 0)]: ID.air });
    const r = continueNightPit(oneDug, { x: 0.5, y: 63, z: 0.5 }, {}, site, OPTS);
    if (r === null || !r.ok) throw new Error(r === null ? 'no plan' : r.reason);
    expect(specs(r.steps)).toEqual([
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 62, z: 0 } } },
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 61, z: 0 } } },
      { type: 'PLACE_BLOCK', args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' } },
    ]);
    // At the floor with the roof open: only the roof (from a carried log).
    const dug = land({ [k(0, 63, 0)]: ID.air, [k(0, 62, 0)]: ID.air, [k(0, 61, 0)]: ID.air });
    const bottom = { x: 0.5, y: 61, z: 0.5 };
    const roof = continueNightPit(dug, bottom, { 'minecraft:log': 1 }, site, OPTS);
    expect(roof === null ? null : roof.ok ? specs(roof.steps) : roof.reason).toEqual([
      { type: 'PLACE_BLOCK', args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:log' } },
    ]);
    // No dirt or log left for the roof: it says so.
    expect(reasonOf(continueNightPit(dug, bottom, {}, site, OPTS) ?? { ok: true })).toMatch(
      /no block for the roof/,
    );
    // The player is elsewhere (a new day, a new spot): the site does not apply.
    expect(continueNightPit(land(), FEET, {}, site, OPTS)).toBeNull();
    expect(continueNightPit(oneDug, { x: 5.5, y: 64, z: 0.5 }, {}, site, OPTS)).toBeNull();
  });
});

describe('the way out in the morning', () => {
  /** The finished pit: three cells dug, a dirt roof in the ground layer. */
  const pit = (extra: Record<string, number> = {}) =>
    land({ [k(0, 62, 0)]: ID.air, [k(0, 61, 0)]: ID.air, ...extra });
  const BOTTOM: Vec3 = { x: 0.5, y: 61, z: 0.5 };

  it('knows a walled-in, roofed player', () => {
    expect(walledIn(pit(), BOTTOM)).toBe(true);
    expect(enclosedIn(pit(), BOTTOM)).toBe(true);
    expect(enclosedIn(pit({ [k(0, 63, 0)]: ID.air }), BOTTOM)).toBe(false);
    expect(walledIn(land(), FEET)).toBe(false);
    expect(walledIn(land({}, { unloaded: [[1, 0]] }), FEET)).toBeNull();
  });

  it('from the pit: the roof, then a staircase where no plant stands on the ground to dig', () => {
    // Tall grass east of the pit: the dig under it is refused, so the staircase goes west.
    const r = planShelterExit(pit({ [k(1, 64, 0)]: ID.tallgrass }), BOTTOM, OPTS);
    if (!r.ok) throw new Error(r.reason);
    expect(r.digs).toBe(4);
    expect(specs(r.steps)).toEqual([
      { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: -1, y: 63, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: -1, y: 62, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: -2, y: 63, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: -2.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
    ]);
    expect(r.steps.map((s) => s.text).slice(0, 2)).toEqual([
      'dig the minecraft:grass at (0, 63, 0) (the roof)',
      'dig the minecraft:grass at (-1, 63, 0) (step 1, upper block)',
    ]);
  });

  it('from the raised box: the wall beside it, head level first, then out on the level', () => {
    // Sand walls around the player on the grass, a cobblestone roof against a trunk.
    const box: Record<string, number> = { [k(0, 66, 0)]: ID.cobblestone, [k(1, 66, 0)]: ID.log };
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      box[k(dx, 64, dz)] = ID.sand;
      box[k(dx, 65, dz)] = ID.sand;
    }
    const r = planShelterExit(land(box), FEET, OPTS);
    if (!r.ok) throw new Error(r.reason);
    expect(r.digs).toBe(2);
    expect(specs(r.steps)).toEqual([
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 65, z: 0 } } },
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 64, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 2.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
    ]);
  });

  it('says why when there is no way out (stone all around)', () => {
    const stone = land(
      { [k(0, 62, 0)]: ID.air, [k(0, 61, 0)]: ID.air, [k(0, 63, 0)]: ID.dirt },
      { top: ID.stone, under: ID.stone },
    );
    expect(reasonOf(planShelterExit(stone, BOTTOM, OPTS))).toMatch(/minecraft:stone/);
  });

  it('checks each step on the world as the earlier ones leave it (PlannedWorld)', () => {
    const w = new PlannedWorld(land());
    w.dig({ x: 0, y: 63, z: 0 });
    w.place({ x: 0, y: 64, z: 0 }, 'minecraft:dirt');
    expect(w.blockAt(0, 63, 0)).toBe(0);
    const id = w.blockAt(0, 64, 0) as number;
    expect(w.blockName(id)).toBe('minecraft:dirt');
    expect(w.hazardCode(id)).toBe(BLOCK_CODE.safe);
    expect(w.blockAt(5, 63, 5)).toBe(ID.grass);
  });
});
