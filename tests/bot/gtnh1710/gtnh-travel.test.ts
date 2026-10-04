import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionSpec } from '../../../src/domain/actions.ts';
import { BLOCK, PLACE_TEST_BLOCK_REGISTRY, type BlockFn } from './fixtures/chunk-fixtures.ts';
import {
  explore,
  explorerHarness,
  exploreWorld,
  FEET_Y,
  GROUND,
  perform,
  positionOf,
  SPAWN,
} from './fixtures/explore-world.ts';
import type { FakeServerOptions } from './fixtures/fake-server.ts';

// Travel on the pathfinder (client/travel-actions.ts): EXPLORE, retreats and fleeing walk in
// segments planned toward their goal inside the play area of the moment, breaking and placing
// on the way as the walk policy allows (EXPLORE; never a retreat or a flee). The explore world
// (fixtures/explore-world.ts) with the player in its desert at (30.5, 64, 20.5).
const harness = explorerHarness();
beforeEach(harness.setup);
afterEach(harness.cleanup);

/** The desert with a cliff three blocks high from x = 34 east (seen live: EXPLORE stopped at cliffs). */
const CLIFF: BlockFn = (x, y, z) => {
  if (x >= 34 && x < 38 && z < 32 && y > GROUND && y <= GROUND + 3) return BLOCK.sand;
  return exploreWorld(x, y, z);
};
/** The desert with a hedge of leaves two high and three deep at x 33..35 (all z). */
const HEDGE: BlockFn = (x, y, z) => {
  if (x >= 33 && x <= 35 && z < 32 && (y === FEET_Y || y === FEET_Y + 1)) return BLOCK.leaves;
  return exploreWorld(x, y, z);
};
const COBBLE = [{ slot: 36, id: BLOCK.cobblestone, count: 16, damage: 0 }];
const server = (world: BlockFn, extra: FakeServerOptions = {}): FakeServerOptions => ({
  world,
  blocks: PLACE_TEST_BLOCK_REGISTRY,
  inventory: COBBLE,
  ...extra,
});

describe('travel on the pathfinder', { timeout: 40_000 }, () => {
  it('EXPLORE climbs a cliff it may pillar (placing on), where it used to stop', async () => {
    const { client, server: fake } = await harness.start({
      server: server(CLIFF),
      placing: true,
    });
    const r = await perform(client, explore('east', 8));
    expect(r, r.message).toMatchObject({ ok: true });
    // Up the cliff, where its 8 blocks (the climb counts) run out or the point is reached.
    expect(String(r.data['stoppedBecause'])).toMatch(
      /^went 8 blocks east$|^walked (nearly )?the whole maxDistance/,
    );
    const at = await positionOf(client);
    expect(at.y).toBe(FEET_Y + 3);
    expect(at.x).toBeGreaterThan(34);
    expect(fake.placeSim.placed.length).toBeGreaterThanOrEqual(2);
    expect(fake.moveSim.corrections).toEqual([]);
    expect(fake.moveSim.falls).toEqual([]);
  });

  it('EXPLORE without placing stops at the same cliff: no way further', async () => {
    const { client, server: fake } = await harness.start({ server: server(CLIFF) });
    const r = await perform(client, explore('east', 8));
    expect(String(r.data['stoppedBecause'])).toMatch(/^no way further|^stuck/);
    const at = await positionOf(client);
    expect(at.y).toBe(FEET_Y);
    expect(at.x).toBeLessThan(34);
    expect(fake.placeSim.placements).toEqual([]);
  });

  it('EXPLORE breaks through a leaf hedge with digging on', async () => {
    const { client, server: fake } = await harness.start({
      server: server(HEDGE),
      digging: true,
    });
    const r = await perform(client, explore('east', 8));
    expect(r, r.message).toMatchObject({ ok: true });
    expect(r.data['stoppedBecause']).toBe('went 8 blocks east');
    expect(fake.digSim.broken.length).toBeGreaterThanOrEqual(2);
    expect((await positionOf(client)).x).toBeGreaterThan(36);
  });

  it('a retreat that cannot get home (across the river) flees from the zombie near instead', async () => {
    // Home on the plains east of the river; a zombie on the bank.
    const zombie = {
      kind: 'mob' as const,
      entityId: 950,
      mobType: 54,
      x: 36.5,
      y: FEET_Y,
      z: 25.5,
    };
    const { client, server: fake } = await harness.start({
      server: server(exploreWorld, { entities: [zombie] }),
      movement: { area: { side: 32, height: 8 } },
    });
    const home = { x: 50.5, y: FEET_Y, z: 20.5 };
    const retreat: ActionSpec = { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } };
    const r = await perform(client, retreat, home);
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(/retreat stopped after .*no way further/);
    expect(r.message).toMatch(/fled instead to/);
    const at = await positionOf(client);
    expect(at.x).toBeLessThan(40); // never into the river
    expect(Math.hypot(at.x - zombie.x, at.z - zombie.z)).toBeGreaterThan(6);
    expect(fake.moveSim.corrections).toEqual([]);
    expect(fake.digSim.digs).toEqual([]);
    expect(fake.placeSim.placements).toEqual([]);
  });

  it('a retreat beyond the play area travels in hops and threats do not stop it', async () => {
    const { client } = await harness.start();
    expect(await perform(client, explore('north', 14))).toMatchObject({ ok: true });
    const home = { x: SPAWN.x, y: FEET_Y, z: SPAWN.z };
    const retreat: ActionSpec = { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } };
    const r = await perform(client, retreat, home);
    expect(r, r.message).toMatchObject({ ok: true });
    expect(r.message).toMatch(/^retreated [\d.]+ blocks in \d+ hop\(s\): at the safe location/);
    expect(await positionOf(client)).toEqual(home);
  });
});
