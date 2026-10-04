import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { WALK_SPEED } from '../../../src/bot/gtnh1710/pathing/physics.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY, type BlockFn } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// Walks over terrain on the pathfinder, against a fake server that checks every move as a
// 1.7.10 server does (fixtures/fake-movement.ts: a move into a block is reset with S08, and a
// hard landing hurts). Ground: grass at y=105 (the feet at 106) over dirt and stone, west of
// x = 0; three blocks lower (grass at 102) from x = 0 east: a cliff.
const FEET_Y = 106;
const CLIFF_X = 0;
const LOW_FEET_Y = FEET_Y - 3;
const FENCE = { min: { x: -9, y: 98, z: -12 }, max: { x: 6, y: 110, z: -4 } };
/** One block wide (z = -8): no way round anything in it. */
const STRIP = { min: { x: -9, y: 98, z: -8 }, max: { x: 6, y: 110, z: -8 } };

function ground(x: number, y: number): number {
  const top = x >= CLIFF_X ? 102 : 105;
  if (y === 0) return BLOCK.bedrock;
  if (y > top) return BLOCK.air;
  if (y === top) return BLOCK.grass;
  return y >= top - 2 ? BLOCK.dirt : BLOCK.stone;
}

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-path-walk-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  opts: { blocks?: ReadonlyMap<string, number>; digging?: boolean; fence?: typeof FENCE } = {},
  server: FakeServerOptions = {},
) {
  const overrides = opts.blocks ?? new Map<string, number>();
  const world: BlockFn = (x, y, z) => overrides.get(`${x},${y},${z}`) ?? ground(x, y);
  const fake = new FakeGtnhServer({
    blocks: DIG_TEST_BLOCK_REGISTRY,
    world,
    spawn: { x: -4.5, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    ...server,
  });
  servers.push(fake);
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await fake.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: { enabled: true, fence: opts.fence ?? FENCE, stopFile: join(dir, 'STOP') },
      digging: { enabled: opts.digging ?? false },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const moveTo = (x: number, y: number, z: number): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y, z }, tolerance: 0.5 },
});

async function positionOf(client: Gtnh1710Client) {
  const p = (await client.observe()).player.position;
  if (!p.known) throw new Error('position unknown');
  return p.value;
}

/** A wall `high` blocks high (default 2) across the fence's whole depth at x. */
function wall(x: number, id: number, high = 2): Map<string, number> {
  const out = new Map<string, number>();
  for (let z = FENCE.min.z; z <= FENCE.max.z; z++) {
    for (let y = FEET_Y; y < FEET_Y + high; y++) out.set(`${x},${y},${z}`, id);
  }
  return out;
}

describe('walking over terrain on the pathfinder', { timeout: 30_000 }, () => {
  it('falls three blocks down a cliff (the old walker stopped at two), every move accepted, no damage', async () => {
    const { server, client } = await start();
    const r = await perform(client, moveTo(2.5, LOW_FEET_Y, -7.5));
    expect(r, r.message).toMatchObject({ ok: true, code: 'OK', data: { reached: true } });
    expect(await positionOf(client)).toEqual({ x: 2.5, y: LOW_FEET_Y, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
    expect(server.moveSim.falls).toEqual([]);
    expect(server.combatSim.playerHealth).toBe(20);
    // In the air between the edge and the landing, as a player is; on the ground at the end.
    const steps = server.walkSteps();
    expect(steps.some((s) => !s.onGround && s.feetY < FEET_Y && s.feetY > LOW_FEET_Y)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ x: 2.5, feetY: LOW_FEET_Y, z: -7.5, onGround: true });
    // Never faster than vanilla walking across.
    let prev = { x: -4.5, z: -7.5 };
    for (const s of steps) {
      expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
      prev = s;
    }
  });

  it('climbs back up the cliff only where a step is one block (here: nowhere), else refuses', async () => {
    const { server, client } = await start();
    expect(await perform(client, moveTo(2.5, LOW_FEET_Y, -7.5))).toMatchObject({ ok: true });
    const up = await perform(client, moveTo(-2.5, FEET_Y, -7.5));
    expect(up).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(up.message).toMatch(/no walkable path to the target inside the fence/);
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('breaks dirt in its way with digging enabled (as DIG_BLOCK digs), then walks on', async () => {
    const { server, client } = await start({ blocks: wall(-2, BLOCK.dirt, 3), digging: true });
    const r = await perform(client, moveTo(-0.5, FEET_Y, -7.5));
    expect(r, r.message).toMatchObject({ ok: true, data: { broken: 2 } });
    expect(r.message).toMatch(/broke 2 dirt on the way: \(-2, 107, -8\), \(-2, 106, -8\)/);
    expect(r.message).toMatch(/picked up 2 x minecraft:dirt/);
    // Upper block first, each started (with an empty hand) and finished (C07), then confirmed.
    // (The first dirt reaches the held slot while the second is dug: holding a block digs as a
    // hand does.)
    expect(server.digSim.digs.map((d) => [d.status, d.x, d.y, d.z])).toEqual([
      [0, -2, 107, -8],
      [2, -2, 107, -8],
      [0, -2, 106, -8],
      [2, -2, 106, -8],
    ]);
    expect(server.digSim.digs.filter((d) => d.status === 0).every((d) => d.emptyHand)).toBe(true);
    expect(server.digSim.broken.map((b) => b.late)).toEqual([false, false]);
    expect(await positionOf(client)).toEqual({ x: -0.5, y: FEET_Y, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('breaks only what it must: over a wall two high it opens the top and climbs over', async () => {
    // One break and a jump cost less than two breaks (the dig time is in the cost).
    const { server, client } = await start({ blocks: wall(-2, BLOCK.dirt), digging: true });
    const r = await perform(client, moveTo(-0.5, FEET_Y, -7.5));
    expect(r, r.message).toMatchObject({ ok: true, data: { broken: 1 } });
    expect(r.message).toMatch(
      /^walked 6\.00 blocks in \d+ steps; broke 1 dirt on the way: \(-2, 107, -8\)/,
    );
    // Up onto the wall's lower block, and down the other side.
    expect(server.walkSteps().some((s) => s.feetY === FEET_Y + 1 && s.onGround)).toBe(true);
    expect(await positionOf(client)).toEqual({ x: -0.5, y: FEET_Y, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('never breaks stone without a pickaxe that harvests it: no way through the wall', async () => {
    const { server, client } = await start({
      blocks: wall(-2, BLOCK.stone),
      digging: true,
      fence: STRIP,
    });
    const r = await perform(client, moveTo(-0.5, FEET_Y, -7.5));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/no walkable path to the target inside the fence/);
    expect(server.digSim.digs).toEqual([]);
    expect(server.walkSteps()).toEqual([]);
  });

  it('stops when the server resets a move it does not accept (a block it never sent), and stays put', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-0.5, FEET_Y, -7.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(2));
    // A block in the way that the client is never told about: its step runs into it.
    server.setBlockSilently(-2, FEET_Y, -8, BLOCK.stone);
    server.setBlockSilently(-2, FEET_Y + 1, -8, BLOCK.stone);
    const r = await walk;
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(/the server corrected the position/);
    expect(server.moveSim.corrections.length).toBeGreaterThanOrEqual(1);
    const at = await positionOf(client);
    expect(at.x).toBeLessThan(-2.3); // never inside the stone
  });
});
