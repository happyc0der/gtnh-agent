import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { SPRINT_SPEED, WALK_SPEED } from '../../../src/bot/gtnh1710/pathing/physics.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY, type BlockFn } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer } from './fixtures/fake-server.ts';

// Sprinting (C0B START/STOP_SPRINTING): only when the config allows it, the food bar is above
// 10 and the walk is long, and never while digging or placing, nor after the walk. HungerOverhaul
// makes sprinting cost food on this server, so it is off by default.
const FEET_Y = 106;
const FENCE = { min: { x: -30, y: 98, z: -12 }, max: { x: 30, y: 112, z: -4 } };
const ground: BlockFn = (_x, y) =>
  y === 0 ? BLOCK.bedrock : y > 105 ? BLOCK.air : y === 105 ? BLOCK.grass : BLOCK.dirt;
const START_SPRINTING = 4;
const STOP_SPRINTING = 5;

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-sprint-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  opts: { sprint?: boolean; food?: number; world?: BlockFn; digging?: boolean } = {},
) {
  const server = new FakeGtnhServer({
    blocks: DIG_TEST_BLOCK_REGISTRY,
    world: opts.world ?? ground,
    spawn: { x: -24.5, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    health: { health: 20, food: opts.food ?? 18, saturation: 5 },
    // Columns come into view as the player walks, as on the real server.
    streamChunks: true,
  });
  servers.push(server);
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await server.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: {
        enabled: true,
        fence: FENCE,
        stopFile: join(dir, 'STOP'),
        path: { allowSprint: opts.sprint ?? true },
      },
      digging: { enabled: opts.digging ?? false },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  // The food bar comes with the server's first health update.
  for (let i = 0; i < 40 && client.world.food === null; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { server, client };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const moveTo = (x: number): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y: FEET_Y, z: -7.5 }, tolerance: 0.5 },
});

describe('sprinting on long walks', { timeout: 30_000 }, () => {
  it('sprints a long walk (C0B start, then stop before the walk ends), at most sprinting pace', async () => {
    const { server, client } = await start();
    const r = await perform(client, moveTo(-2.5));
    expect(r, r.message).toMatchObject({ ok: true });
    expect(Number(r.data['sprinted'])).toBeGreaterThan(20);
    expect(server.entityActions.map((a) => a.action)).toEqual([START_SPRINTING, STOP_SPRINTING]);
    expect(server.sprinting).toBe(false);
    const steps = server.walkSteps();
    let prev = { x: -24.5, z: -7.5 };
    let fastest = 0;
    for (const s of steps) {
      fastest = Math.max(fastest, Math.hypot(s.x - prev.x, s.z - prev.z));
      prev = s;
    }
    expect(fastest).toBeGreaterThan(WALK_SPEED + 0.01);
    expect(fastest).toBeLessThanOrEqual(SPRINT_SPEED + 1e-9);
    // The stop comes before the last step: the walk ends at rest, not sprinting.
    const lastStep = server.received.findLastIndex((p) => p.state === 'play' && p.id === 0x06);
    expect(server.entityActions[1]?.at).toBeLessThanOrEqual(lastStep + 1);
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('never on a short walk, with sprinting off, or with food at 10 or less', async () => {
    const short = await start();
    expect(await perform(short.client, moveTo(-20.5))).toMatchObject({ ok: true });
    expect(short.server.entityActions).toEqual([]);
    const off = await start({ sprint: false });
    expect(await perform(off.client, moveTo(-2.5))).toMatchObject({ ok: true });
    expect(off.server.entityActions).toEqual([]);
    const hungry = await start({ food: 10 });
    expect(await perform(hungry.client, moveTo(-2.5))).toMatchObject({ ok: true });
    expect(hungry.server.entityActions).toEqual([]);
  });

  it('stops sprinting before it digs on the way', async () => {
    // A wall of dirt three high across the fence at x = -14.
    const wall: BlockFn = (x, y, z) =>
      x === -14 && y >= FEET_Y && y <= FEET_Y + 2 ? BLOCK.dirt : ground(x, y, z);
    const { server, client } = await start({ world: wall, digging: true });
    const r = await perform(client, moveTo(-2.5));
    expect(r, r.message).toMatchObject({ ok: true, data: { broken: 2 } });
    const firstDig = server.received.findIndex((p) => p.state === 'play' && p.id === 0x07);
    const sprintingAt = (index: number): boolean => {
      let on = false;
      for (const a of server.entityActions) if (a.at <= index) on = a.action === START_SPRINTING;
      return on;
    };
    expect(firstDig).toBeGreaterThan(0);
    expect(sprintingAt(firstDig)).toBe(false);
    // And it sprints again after the wall.
    expect(server.entityActions.filter((a) => a.action === START_SPRINTING).length).toBe(2);
    expect(server.sprinting).toBe(false);
  });
});
