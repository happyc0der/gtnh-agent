import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { checkDigDown, underFeetOf, type DigArea } from '../../../src/bot/gtnh1710/digging.ts';
import {
  continueNightPit,
  enclosedIn,
  OUT_FREE_DISTANCE,
  OUT_FREE_WALK,
  planClimbOut,
  planNightPit,
  planShelterExit,
  PlannedWorld,
  sealedIn,
  shaftSite,
  walledIn,
  type PitOptions,
  type PitSite,
} from '../../../src/bot/gtnh1710/night-pit.ts';
import { goalBlock } from '../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath, type PathOptions } from '../../../src/bot/gtnh1710/pathing/search.ts';
import { walksAway } from '../../../src/bot/gtnh1710/terrain.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { savedWorld } from './fixtures/saved-world.ts';

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
  sapling: 6,
  tallgrass: 31,
  foliage: 1102,
} as const;
const NAMES = new Map<number, string>([
  [ID.foliage, 'BiomesOPlenty:foliage'],
  [ID.sapling, 'minecraft:sapling'],
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
 * plus `blocks`; columns in `unloaded` are not loaded. With `metas`, the world reports block
 * metadata (0 where not listed); without, none.
 */
function land(
  blocks: Record<string, number> = {},
  opts: {
    top?: number;
    under?: number;
    unloaded?: Array<[number, number]>;
    metas?: Record<string, number>;
  } = {},
): WalkWorld {
  const overrides = new Map(Object.entries(blocks));
  const missing = new Set((opts.unloaded ?? []).map(([x, z]) => `${x},${z}`));
  const world: WalkWorld = {
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
  const metas = opts.metas;
  if (metas === undefined) return world;
  return {
    ...world,
    metaAt: (x, y, z) => (missing.has(`${x},${z}`) ? undefined : (metas[k(x, y, z)] ?? 0)),
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
/** No pickaxe: cobblestone cannot be harvested. */
const noCobble = (b: string): string | null =>
  b === 'minecraft:cobblestone' ? 'it needs a pickaxe, and the player carries none' : null;

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
      'a sapling where the feet are (a wild plant would drop with it: a planted one never)',
      { [k(0, 64, 0)]: ID.sapling },
      /touches minecraft:sapling/,
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

  it('allows BOP foliage the walker passes around it, but not poison ivy or unknown variants', () => {
    // Short grass east of the feet and a bush north-west of them, at feet level.
    const plants = { [k(1, 64, 0)]: ID.foliage, [k(-1, 64, 1)]: ID.foliage };
    const meadow = land(plants, { metas: { [k(1, 64, 0)]: 1, [k(-1, 64, 1)]: 4 } });
    expect(checkDigDown(meadow, AREA, FEET, UNDER)).toMatchObject({ ok: true });
    const ivy = land(plants, { metas: { [k(1, 64, 0)]: 7, [k(-1, 64, 1)]: 4 } });
    expect(reasonOf(checkDigDown(ivy, AREA, FEET, UNDER))).toMatch(
      /BiomesOPlenty:foliage@7 at \(1, 64, 0\) is near it/,
    );
    expect(reasonOf(checkDigDown(land(plants), AREA, FEET, UNDER))).toMatch(
      /BiomesOPlenty:foliage at \(-1, 64, 1\) is near it/,
    );
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

  it('digs in its own column on a meadow of BOP foliage, reading the metadata of the plants', () => {
    const plants = { [k(1, 64, 0)]: ID.foliage, [k(-1, 64, 1)]: ID.foliage };
    const meadow = land(plants, { metas: { [k(1, 64, 0)]: 1, [k(-1, 64, 1)]: 4 } });
    const plan = planNightPit(meadow, FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.site).toEqual({ x: 0, z: 0, groundY: 63 });
    expect(specs(plan.steps).slice(0, 3)).toEqual([
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 62, z: 0 } } },
      { type: 'DIG_DOWN', args: { position: { x: 0, y: 61, z: 0 } } },
    ]);
    expect(plan.exit.length).toBeGreaterThan(0);
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

  it('walks a few blocks to open ground when its spot and the next ones cannot take a pit', () => {
    // Seen live: by a tree, the pit's wall would have been leaves, and the agent went offline
    // for the night. Here roots (logs) under the 3 x 3 around it spoil every spot within 2.
    const roots: Record<string, number> = {};
    for (let x = -1; x <= 1; x++) {
      for (let z = -1; z <= 1; z++) {
        roots[k(x, 62, z)] = ID.log;
        roots[k(x, 61, z)] = ID.log;
      }
    }
    const plan = planNightPit(land(roots), FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    // Beyond the next columns: the nearest spot whose four walls hold no root.
    expect(Math.max(Math.abs(plan.site.x), Math.abs(plan.site.z))).toBeGreaterThanOrEqual(2);
    expect(specs(plan.steps)[0]).toMatchObject({ type: 'MOVE_TO' });
    expect(specs(plan.steps)[1]).toMatchObject({ type: 'DIG_DOWN' });
  });

  it('takes a pit beside a column one lower, tall grass in the ground layer (seen live)', () => {
    // The roof's layer may hold a plant beside it: the player is walled in below it.
    const plan = planNightPit(land({ [k(-1, 63, 0)]: ID.tallgrass }), FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.site).toEqual({ x: 0, z: 0, groundY: 63 });
    expect(specs(plan.steps).at(-1)).toEqual({
      type: 'PLACE_BLOCK',
      args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' },
    });
  });

  it('refuses where the ground is not natural, solid ground down to the floor all around', () => {
    // Stone at the top: DIG_DOWN takes only dirt, grass, sand, gravel and clay.
    expect(reasonOf(planNightPit(land({}, { top: ID.stone }), FEET, {}, OPTS))).toMatch(
      /no spot for a pit within 12 blocks' walk \(here: digging down at \(0, 63, 0\): .*minecraft:stone/,
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

  it('closes a wall that a way out opened, for another night in the same pit', () => {
    // Seen live 2026-10-04: the morning's staircase stopped after its first step; at dusk the
    // roof went back, the step stayed open beside the head, and with no step left the planner
    // was asked and dug the pit's walls.
    const site = { x: 0, z: 0, groundY: 63 };
    const bottom = { x: 0.5, y: 61, z: 0.5 };
    const opened = land({
      [k(0, 62, 0)]: ID.air,
      [k(0, 61, 0)]: ID.air,
      [k(1, 63, 0)]: ID.air,
      [k(1, 62, 0)]: ID.air,
    });
    expect(enclosedIn(opened, bottom)).toBe(false);
    const r = continueNightPit(opened, bottom, { 'minecraft:dirt': 4 }, site, OPTS);
    if (r === null || !r.ok) throw new Error(r === null ? 'no plan' : r.reason);
    expect(specs(r.steps)).toEqual([
      { type: 'PLACE_BLOCK', args: { position: { x: 1, y: 62, z: 0 }, item: 'minecraft:dirt' } },
    ]);
    // With the roof open too: the roof, then the wall, from the carried dirt.
    const roofless = land({
      [k(0, 63, 0)]: ID.air,
      [k(0, 62, 0)]: ID.air,
      [k(0, 61, 0)]: ID.air,
      [k(1, 63, 0)]: ID.air,
      [k(1, 62, 0)]: ID.air,
    });
    const both = continueNightPit(roofless, bottom, { 'minecraft:dirt': 2 }, site, OPTS);
    expect(both === null ? null : both.ok ? specs(both.steps) : both.reason).toEqual([
      { type: 'PLACE_BLOCK', args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' } },
      { type: 'PLACE_BLOCK', args: { position: { x: 1, y: 62, z: 0 }, item: 'minecraft:dirt' } },
    ]);
    // One dirt is the roof's: none is left for the wall, and it says so.
    expect(
      reasonOf(
        continueNightPit(roofless, bottom, { 'minecraft:dirt': 1 }, site, OPTS) ?? { ok: true },
      ),
    ).toMatch(/1 open cell\(s\) in the pit's walls and too few blocks to close them/);
  });
});

describe('the way out in the morning', () => {
  /** The finished pit: three cells dug, a dirt roof in the ground layer. */
  const pit = (extra: Record<string, number> = {}) =>
    land({ [k(0, 62, 0)]: ID.air, [k(0, 61, 0)]: ID.air, ...extra });
  const BOTTOM: Vec3 = { x: 0.5, y: 61, z: 0.5 };
  /** The pit's site: its column, and its ground layer (the roof's level). */
  const SITE = { x: 0, z: 0, groundY: 63 };

  it('knows a walled-in, roofed player', () => {
    expect(walledIn(pit(), BOTTOM)).toBe(true);
    expect(enclosedIn(pit(), BOTTOM)).toBe(true);
    expect(enclosedIn(pit({ [k(0, 63, 0)]: ID.air }), BOTTOM)).toBe(false);
    expect(walledIn(land(), FEET)).toBe(false);
    expect(walledIn(land({}, { unloaded: [[1, 0]] }), FEET)).toBeNull();
  });

  it('knows when the player is sealed in: known full blocks beside, above and below it', () => {
    expect(sealedIn(pit(), BOTTOM)).toBe(true);
    expect(sealedIn(pit({ [k(0, 63, 0)]: ID.air }), BOTTOM)).toBe(false);
    // Water in a wall: the body cannot pass it (enclosedIn), but a mob swims through.
    const wet = pit({ [k(1, 61, 0)]: ID.water });
    expect(enclosedIn(wet, BOTTOM)).toBe(true);
    expect(sealedIn(wet, BOTTOM)).toBe(false);
    // A cave under the floor.
    expect(sealedIn(pit({ [k(0, 60, 0)]: ID.air }), BOTTOM)).toBe(false);
    expect(
      sealedIn(
        land({ [k(0, 62, 0)]: ID.air, [k(0, 61, 0)]: ID.air }, { unloaded: [[0, 1]] }),
        BOTTOM,
      ),
    ).toBeNull();
  });

  it('from the pit: the roof, then a staircase where no planted plant stands on the ground to dig', () => {
    // A sapling east of the pit: the dig under it is refused, so the staircase goes west.
    const r = planShelterExit(pit({ [k(1, 64, 0)]: ID.sapling }), BOTTOM, OPTS);
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

  it('digs the way out only through blocks a carried tool harvests (no pickaxe: no cobble)', () => {
    // Seen live: a staircase out through cobblestone, which only a pickaxe may dig, was
    // refused at every try, and the agent stayed in its pit.
    const noPickaxe = {
      ...OPTS,
      canHarvest: (b: string) =>
        b === 'minecraft:cobblestone' ? 'it needs a pickaxe, and the player carries none' : null,
    };
    const cobble = (sides: ReadonlyArray<readonly [number, number]>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [dx, dz] of sides) {
        out[k(dx, 63, dz)] = ID.cobblestone;
        out[k(dx, 62, dz)] = ID.cobblestone;
      }
      return out;
    };
    const east = pit(cobble([[1, 0]]));
    // Without the rule, the first side (east) would do, through the cobblestone.
    expect(planShelterExit(east, BOTTOM, OPTS)).toMatchObject({ ok: true });
    const r = planShelterExit(east, BOTTOM, noPickaxe);
    if (!r.ok) throw new Error(r.reason);
    const dug = specs(r.steps).flatMap((st) => (st.type === 'DIG_BLOCK' ? [st.args.position] : []));
    expect(dug.some((p) => p.x === 1 && p.z === 0)).toBe(false);
    // Cobblestone on every side: no way out it may dig.
    const all = pit(
      cobble([
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]),
    );
    expect(planShelterExit(all, BOTTOM, noPickaxe).ok).toBe(false);
  });

  it('ends the way out at the ground layer, not on a step an earlier way out dug', () => {
    // Seen live 2026-10-04: a restart stopped the way out after the roof and the first step
    // east. The next plan took that step for open ground and walked out onto it, two blocks
    // under the ground, walled on three sides: no retreat could leave it.
    const halfway = pit({ [k(0, 63, 0)]: ID.air, [k(1, 63, 0)]: ID.air, [k(1, 62, 0)]: ID.air });
    const r = planShelterExit(halfway, BOTTOM, OPTS, SITE.groundY);
    if (!r.ok) throw new Error(r.reason);
    // On up the same staircase: one dig (the second step), then out onto the ground.
    expect(specs(r.steps)).toEqual([
      { type: 'DIG_BLOCK', args: { position: { x: 2, y: 63, z: 0 } } },
      { type: 'MOVE_TO', args: { target: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
    ]);
    // A cave beside the pit's floor is no way out either: not on the level, not up a step.
    const cave = pit({ [k(2, 61, 0)]: ID.air, [k(2, 62, 0)]: ID.air, [k(1, 63, 0)]: ID.air });
    const c = planShelterExit(cave, BOTTOM, OPTS, SITE.groundY);
    if (!c.ok) throw new Error(c.reason);
    const end = specs(c.steps).at(-1);
    expect(end?.type).toBe('MOVE_TO');
    expect(end?.type === 'MOVE_TO' && end.args.target.y).toBeGreaterThanOrEqual(SITE.groundY);
  });

  it('ends no way out in a hole a walk cannot leave: a pit amid old pits and their staircases', () => {
    // An independent review, 2026-10-05: near six finished pits, the surface spots failed the
    // wall check, a spot in an old staircase's notch passed, and its way out ended two blocks
    // under the ground on another old staircase, whose next step's floor it had dug: a walk
    // that breaks nothing reached four cells there.
    const over: Record<string, number> = {};
    const oldPit = (x: number, z: number, dx: number, dz: number): void => {
      for (let y = 61; y <= 63; y++) over[k(x, y, z)] = ID.air;
      over[k(x + dx, 62, z + dz)] = ID.air;
      over[k(x + dx, 63, z + dz)] = ID.air;
      over[k(x + 2 * dx, 63, z + 2 * dz)] = ID.air;
    };
    for (const [x, z, dx, dz] of [
      [2, 1, 0, -1],
      [-1, -1, 0, 1],
      [-1, 4, 0, -1],
      [-5, -3, -1, 0],
      [4, -3, 0, -1],
      [3, -6, 0, 1],
    ] as const) {
      oldPit(x, z, dx, dz);
    }
    // Dirt down to y=50 under the grass, as the review's world (the old staircases dig dirt).
    const base = land(over);
    const world: WalkWorld = {
      ...base,
      blockAt: (x, y, z) =>
        over[k(x, y, z)] ?? (y >= 50 && y < 63 ? ID.dirt : base.blockAt(x, y, z)),
    };
    const plan = planNightPit(world, FEET, {}, OPTS);
    if (!plan.ok) throw new Error(plan.reason);
    // The night, dug and roofed; the morning's way out as play plans it (minY: the ground layer).
    const night = new PlannedWorld(world);
    for (const s of plan.steps) {
      if (s.spec.type === 'DIG_DOWN') night.dig(s.spec.args.position);
      if (s.spec.type === 'PLACE_BLOCK') night.place(s.spec.args.position, 'minecraft:dirt');
    }
    const bottom = { x: plan.site.x + 0.5, y: plan.site.groundY - 2, z: plan.site.z + 0.5 };
    const exit = planShelterExit(night, bottom, OPTS, plan.site.groundY);
    if (!exit.ok) throw new Error(exit.reason);
    expect(exit.free).toBe(true);
    const after = new PlannedWorld(night);
    for (const s of exit.steps) if (s.spec.type === 'DIG_BLOCK') after.dig(s.spec.args.position);
    const last = exit.steps.at(-1)?.spec;
    if (last?.type !== 'MOVE_TO') throw new Error('the way out ends in no walk');
    expect(walksAway(after, AREA.fence, last.args.target, OUT_FREE_DISTANCE, OUT_FREE_WALK)).toBe(
      true,
    );
    // The same notch, its way out no longer onto the first step of the next old staircase.
    expect(plan.site).toEqual({ x: -1, z: 1, groundY: 62 });
    expect(last.args.target).not.toEqual({ x: -0.5, y: 62, z: 3.5 });
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

  it('climbs out of a shaft it dug down, deeper than a staircase out reaches (shaftSite)', () => {
    // Seen live 2026-10-04: 8 deep, dug down to stone, roofed for the night: "no way out".
    const shaft: Record<string, number> = { [k(0, 57, 0)]: ID.cobblestone };
    for (let y = 55; y <= 63; y++) if (y !== 57) shaft[k(0, y, 0)] = ID.air;
    const world = land(shaft);
    const feet = { x: 0.5, y: 55, z: 0.5 };
    expect(planShelterExit(world, feet, OPTS).ok).toBe(false);
    const site = shaftSite(world, feet);
    expect(site).toEqual({ x: 0, z: 0, groundY: 64 });
    const options: PathOptions = {
      pillar: true,
      canBreak: (c) => {
        const id = world.blockAt(c.x, c.y, c.z);
        return id === ID.cobblestone ? 40 : null;
      },
      canPlace: () => true,
      throwaway: { count: 16, block: 'minecraft:dirt' },
    };
    const climb = planClimbOut(world, AREA.fence, feet, site as PitSite, options);
    if (!climb.ok) throw new Error(climb.reason);
    expect(specs(climb.steps)[0]).toMatchObject({ type: 'MOVE_TO', args: { target: { y: 64 } } });
    // Deep underground, no rim within 16 blocks: none.
    expect(shaftSite(world, { x: 0.5, y: 30, z: 0.5 })).toBeNull();
  });

  it('climbs out through the roof on a pillar when no wall may be dug (planClimbOut)', () => {
    // Seen live 2026-10-03: cobblestone on three sides and no pickaxe, bamboo on the fourth.
    const walls: Record<string, number> = {};
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      walls[k(dx, 63, dz)] = ID.cobblestone;
      walls[k(dx, 62, dz)] = ID.cobblestone;
    }
    const walled = pit(walls);
    expect(planShelterExit(walled, BOTTOM, { ...OPTS, canHarvest: noCobble }).ok).toBe(false);
    const options = (world: WalkWorld, count = 5): PathOptions => ({
      pillar: true,
      canBreak: (c) => {
        const id = world.blockAt(c.x, c.y, c.z);
        return id === ID.grass || id === ID.dirt ? 20 : null;
      },
      canPlace: () => true,
      throwaway: { count, block: 'minecraft:dirt' },
    });
    const r = planClimbOut(walled, AREA.fence, BOTTOM, SITE, options(walled));
    if (!r.ok) throw new Error(r.reason);
    expect(r.digs).toBe(1);
    // One walk: through the roof (the one block broken), two blocks up a pillar, onto a wall.
    expect(r.steps).toHaveLength(1);
    expect(specs(r.steps)[0]).toMatchObject({
      type: 'MOVE_TO',
      args: { target: { y: 64 }, tolerance: 0.5 },
    });
    expect(r.steps[0]?.text).toMatch(
      /^climb out to \(-?\d+, 64, -?\d+\) \(breaking 1 block\(s\), placing 2\)$/,
    );
    // Seen live: the ground north of the pit lies a block lower (its top at the pit's
    // second level), so one block up the pillar and a step north is out of the pit; the climb
    // goes on across the ground, clear of the hole (CLIMB_OUT_DISTANCE).
    const lower = pit({ ...walls, [k(0, 63, -1)]: ID.air, [k(0, 62, -1)]: ID.grass });
    const low = planClimbOut(lower, AREA.fence, BOTTOM, SITE, options(lower));
    if (!low.ok) throw new Error(low.reason);
    expect(specs(low.steps)).toEqual([
      { type: 'MOVE_TO', args: { target: { x: 0.5, y: 64, z: -2.5 }, tolerance: 0.5 } },
    ]);
    expect(low.steps[0]?.text).toBe('climb out to (0, 64, -3) (breaking 1 block(s), placing 1)');
    // Too few blocks to pillar with: no climb.
    expect(reasonOf(planClimbOut(walled, AREA.fence, BOTTOM, SITE, options(walled, 1)))).toMatch(
      /^no climb out of the pit: /,
    );
  });

  it('climbs out of the real hole of 2026-10-04 although the first path is cut (re-plans)', () => {
    // The saved world around the agent that morning: sealed 5 blocks under the ground, under a
    // cobblestone roof, beside the sand and dirt of two earlier pits. The way out was refused
    // ("cut after 3 movement(s)") and the agent stayed in.
    const world = savedWorld('night-pit-2026-10-04');
    const feet = { x: -23.5, y: 70, z: 42.5 };
    expect(sealedIn(world, feet)).toBe(true);
    const site = shaftSite(world, feet);
    expect(site).toEqual({ x: -24, z: 42, groundY: 74 });
    const fence = { min: { ...world.box.min }, max: { ...world.box.max } };
    const options: PathOptions = {
      pillar: true,
      canBreak: (c) => {
        const id = world.blockAt(c.x, c.y, c.z);
        const name = id === undefined ? undefined : world.blockName(id);
        return name !== undefined &&
          ['minecraft:dirt', 'minecraft:grass', 'minecraft:sand', 'minecraft:cobblestone'].includes(
            name,
          )
          ? 30
          : null;
      },
      canPlace: () => true,
      throwaway: { count: 64, block: 'minecraft:dirt' },
    };
    const r = planClimbOut(world, fence, feet, site as PitSite, options);
    if (!r.ok) throw new Error(r.reason);
    // The first search is cut: a MOVE_TO for each stretch. Each is one the walk can run: its own
    // search (to that block, with a walk's limits and break cap, from where the stretch before
    // ends, on the world as it leaves it) reaches without a cut. A single MOVE_TO to the end
    // would have been refused: its search is cut the same way.
    expect(r.steps.length).toBeGreaterThan(1);
    const w = new PlannedWorld(world);
    let from: Vec3 = feet;
    for (const step of r.steps) {
      if (step.spec.type !== 'MOVE_TO') throw new Error(`not a walk: ${step.text}`);
      const t = step.spec.args.target;
      const walk = planPath(
        w,
        fence,
        from,
        goalBlock(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z)),
        { ...options, maxBreaks: 24, maxNodes: 60_000, maxTimeMs: 5_000 },
      );
      expect(walk.status, step.text).toBe('reached');
      for (const m of walk.movements) {
        for (const b of m.breaks) w.dig(b.cell);
        if (m.place !== null) w.place(m.place.cell, m.place.block);
      }
      from = t;
    }
    const last = r.steps.at(-1)?.spec;
    const to = last?.type === 'MOVE_TO' ? last.args.target : null;
    // On the ground, clear of the hole: the climb that ended in the next column, in the hole an
    // earlier pit had left, sent the day's retreats back into it.
    expect(to).not.toBeNull();
    expect(to?.y).toBeGreaterThanOrEqual(74);
    expect(Math.hypot((to?.x ?? 0) + 23.5, (to?.z ?? 0) - 42.5)).toBeGreaterThanOrEqual(3);
  });
});
