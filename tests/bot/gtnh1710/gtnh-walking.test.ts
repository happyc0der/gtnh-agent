import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSafetyContext, syncConfigToDatabase } from '../../../src/app/agent-loop.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { sweptColumns } from '../../../src/bot/gtnh1710/walking.ts';
import { defaultConfig, type MovementConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { Position } from '../../../src/domain/common.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { ActionExecutor } from '../../../src/executor/action-executor.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { SqliteActionLog } from '../../../src/executor/action-log.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK } from './chunk-fixtures.ts';
import { FakeGtnhServer, spawnFrame, type FakeServerOptions } from './fake-server.ts';

// The fake world is a grass floor at y=105 with the player at (-4.5, 106, -7.5): the same
// x/z as the real test pen, whose fence this mirrors one level lower.
const FEET_Y = 106;
const SPAWN_EYE_Y = 107.62000000476837;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };

let dir = '';
let stopFile = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-walk-'));
  stopFile = join(dir, 'STOP');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

function configFor(port: number, movement: Partial<MovementConfig>) {
  return defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: { enabled: true, fence: FENCE, stopFile, ...movement },
    },
  });
}

async function start(
  serverOptions: FakeServerOptions = {},
  movement: Partial<MovementConfig> = {},
) {
  const server = new FakeGtnhServer(serverOptions);
  servers.push(server);
  const config = configFor(await server.listen(), movement);
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
  });
  clients.push(client);
  await client.connect();
  return { server, client, config };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec, resolvedTarget: Position | null = null) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, resolvedTarget, new Date()));
}

const moveTo = (x: number, z: number, y = FEET_Y): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y, z }, tolerance: 0.5 },
});
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Gtnh1710Client gravity', () => {
  it('falls onto the ground when it finds itself in the air (the server kicks a floating player)', async () => {
    // Placed 0.83 above the floor, as a walk stopped in the middle of a step up leaves it.
    const { server, client } = await start({
      spawn: { x: -4.5, eyeY: FEET_Y + 0.83 + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && server.confirmedPositions.at(-1)?.feetY !== FEET_Y) {
      await delay(50);
    }
    const fall = server.confirmedPositions.filter((p) => p.feetY < FEET_Y + 0.83);
    expect(fall.at(-1)).toMatchObject({ x: -4.5, feetY: FEET_Y, z: -7.5, onGround: true });
    // Vanilla gravity: every step lower than the last, in the air until the landing.
    expect(fall.every((p, i) => i === 0 || p.feetY < (fall[i - 1]?.feetY ?? Infinity))).toBe(true);
    expect(fall.slice(0, -1).every((p) => !p.onGround)).toBe(true);
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -4.5, y: FEET_Y, z: -7.5 },
    });
  });

  it('stays in the air rather than fall where it may not walk (the stop file)', async () => {
    writeFileSync(stopFile, 'stop');
    const { server } = await start({
      spawn: { x: -4.5, eyeY: FEET_Y + 0.83 + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    });
    await delay(1_000);
    expect(server.confirmedPositions.every((p) => p.feetY > FEET_Y)).toBe(true);
  });
});

describe('Gtnh1710Client walking', () => {
  it('walks to a target: one checked step per tick, on the ground, with a correct stance', async () => {
    const { server, client } = await start();
    const result = await perform(client, moveTo(-2.5, -5.5));
    expect(result).toMatchObject({ ok: true, code: 'OK' });

    const steps = server.walkSteps();
    expect(steps.length).toBe(result.data['steps']);
    let prev = { x: -4.5, z: -7.5 };
    for (const s of steps) {
      expect(s.feetY).toBe(FEET_Y);
      expect(s.headY - s.feetY).toBeCloseTo(PLAYER_EYE_HEIGHT, 9);
      expect(s.onGround).toBe(true);
      expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeLessThanOrEqual(0.2 + 1e-9);
      prev = s;
    }
    // Facing the way it walks: south-east is yaw -45.
    expect(steps[0]?.yaw).toBeCloseTo(-45, 3);
    expect(steps.at(-1)).toMatchObject({ x: -2.5, z: -5.5 });
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -2.5, y: FEET_Y, z: -5.5 },
    });

    // Idle ticks resume afterwards, and nothing but the allowed packets was ever sent.
    const idle = server.idleTicks;
    await delay(200);
    expect(server.idleTicks).toBeGreaterThan(idle);
    expect(server.playPacketIds().every((id) => [0x00, 0x03, 0x06, 0x17].includes(id))).toBe(true);
  });

  it('refuses without sending anything: no fence, stop file, halt, or an unreachable target', async () => {
    const unfenced = await start({}, { fence: null });
    expect(await perform(unfenced.client, moveTo(-2.5, -5.5))).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: expect.stringMatching(/no movement fence/) as string,
    });
    expect(unfenced.server.walkSteps()).toHaveLength(0);

    const { server, client } = await start();
    const refusals: Array<[ActionSpec, RegExp]> = [
      [moveTo(5.5, 5.5), /outside the movement fence/],
      [moveTo(-2.5, -5.5, FEET_Y + 1), /walking stays on level y=106/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }

    writeFileSync(stopFile, 'stop');
    expect((await perform(client, moveTo(-2.5, -5.5))).message).toMatch(/stop file .* exists/);
    unlinkSync(stopFile);
    client.halt('operator said stop');
    expect((await perform(client, moveTo(-2.5, -5.5))).message).toMatch(
      /halted: operator said stop/,
    );
    expect(server.walkSteps()).toHaveLength(0);
  });

  it('stops at once when the server corrects the position, and echoes the correction', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(5));
    server.placePlayer(-4.5, SPAWN_EYE_Y, -7.5);
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/the server corrected the position/);

    const sent = server.walkSteps().length;
    await delay(150);
    expect(server.walkSteps().length).toBe(sent); // no step after the correction
    expect(server.confirmedPositions.at(-1)).toMatchObject({
      x: -4.5,
      z: -7.5,
      headY: SPAWN_EYE_Y,
    });
    const position = (await client.observe()).player.position;
    expect(position.known && position.value.x).toBe(-4.5);
  });

  it('a hostile mob coming near stops a MOVE_TO walk, but not a retreat', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(3));
    server.broadcast(
      spawnFrame({ kind: 'mob', entityId: 700, mobType: 54, x: -7, y: FEET_Y, z: -10 }),
    );
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/hostile entity minecraft:Zombie/);

    const retreat = await perform(
      client,
      { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } },
      { x: -2.5, y: FEET_Y, z: -5.5 },
    );
    expect(retreat).toMatchObject({ ok: true, code: 'OK' });
  });

  it('stops before lava that appears next to the way ahead', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(2));
    // Lava in the floor at (-8, -11): the blocks touching it are x -9..-7, z -12..-10.
    server.setBlock(-8, FEET_Y - 1, -11, BLOCK.lava);
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/the way ahead is not clear: .*next to minecraft:lava/);
    // Its body never entered a block touching the lava.
    for (const s of server.walkSteps()) {
      const at = { x: s.x, y: FEET_Y, z: s.z };
      for (const [x, z] of sweptColumns(at, at)) {
        expect(x >= -9 && x <= -7 && z >= -12 && z <= -10, `step at ${s.x}, ${s.z}`).toBe(false);
      }
    }
  });

  it('stops when the connection drops', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(2));
    server.dropAll();
    expect((await walk).message).toMatch(/the connection closed/);
  });

  it('goes through the executor: validated, walked and verified', async () => {
    const { client, config } = await start();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    const executor = new ActionExecutor({
      client,
      log: new SqliteActionLog(repos),
      history: repos.actions,
      clock: systemClock,
      newId: sequentialIds(),
    });
    const action = createAction(
      { spec: moveTo(-6.5, -9.5), reason: 'test walk', origin: 'user', taskId: null },
      { newId: sequentialIds(), now: () => new Date() },
    );
    const state = await client.observe();
    const outcome = await executor.execute(
      action,
      state,
      buildSafetyContext(config, repos, new Date()),
      'cyc-walk',
    );
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification?.verified).toBe(true);
  });
});

describe('Gtnh1710Client walking over terrain', () => {
  it('steps up onto a block: rises first, crosses above it, lands on top', async () => {
    const { server, client } = await start(
      { blockOverrides: new Map([['-3,106,-8', BLOCK.stone]]) },
      { fence: { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 108, z: -4 } } },
    );
    const result = await perform(client, moveTo(-2.5, -7.5, FEET_Y + 1));
    expect(result).toMatchObject({ ok: true, code: 'OK' });
    const steps = server.walkSteps();
    const crossing = steps.findIndex((s) => s.x > -3 + 0.3); // the body starts over the raised block
    expect(steps[crossing]?.feetY).toBeGreaterThan(FEET_Y + 1);
    expect(steps.slice(0, -1).some((s) => !s.onGround)).toBe(true);
    expect(steps.at(-1)).toMatchObject({ x: -2.5, feetY: FEET_Y + 1, z: -7.5, onGround: true });
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -2.5, y: FEET_Y + 1, z: -7.5 },
    });
  });
});
