import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSafetyContext, syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
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
import {
  BLOCK,
  flatWorld,
  FOLIAGE,
  openSkyLight,
  TEST_BLOCK_REGISTRY,
} from './fixtures/chunk-fixtures.ts';
import {
  DEFAULT_MODS,
  FakeGtnhServer,
  spawnFrame,
  type FakeServerOptions,
} from './fixtures/fake-server.ts';

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

  it('comes down into a hole it stands just past the edge of (the server would hold it up)', async () => {
    // Seen live 2026-10-04: a walk stopped 0.03 past an edge, stepping down into a hole; the
    // server's wider box reached the block behind, so nothing fell, and walks refused to start.
    const hole = new Map([
      ['-5,105,-8', BLOCK.air],
      ['-5,104,-8', BLOCK.grass],
    ]);
    const z = -7.33; // the box (0.3 each way) over z -8 only; the server's reaches z -7
    const { server, client } = await start(
      {
        blockOverrides: hole,
        spawn: { x: -4.5, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z, yaw: 0, pitch: 0 },
      },
      { fence: { ...FENCE, min: { ...FENCE.min, y: FEET_Y - 1 } } },
    );
    await vi.waitFor(() => expect(server.confirmedPositions.at(-1)?.feetY).toBe(FEET_Y - 1), {
      timeout: 3_000,
    });
    expect(server.confirmedPositions.at(-1)).toMatchObject({ x: -4.5, z, onGround: true });
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -4.5, y: FEET_Y - 1, z },
    });
  });

  it('comes to rest on the ground when the server put it a little above (saved mid-jump)', async () => {
    // Seen live: the player joined 0.42 above the sand; the server held it up, the night pit
    // did not ("the player is not standing on a block").
    const { server, client } = await start({
      spawn: { x: -4.5, eyeY: FEET_Y + 0.42 + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    });
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -4.5, y: FEET_Y, z: -7.5 },
    });
    expect(server.confirmedPositions.at(-1)).toMatchObject({ feetY: FEET_Y, onGround: true });
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

  it('stops when health drops, but not for hunger: at food 0 a walk goes on to its food', async () => {
    // Seen live: starving, the food trip's walks stopped after 34 and 104 steps, "health
    // dropped", every few seconds, and never reached the garden.
    const fed = await start();
    const walk = perform(fed.client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(fed.server.walkSteps().length).toBeGreaterThanOrEqual(5));
    fed.server.combatSim.hurtPlayer(2);
    expect((await walk).message).toMatch(/health dropped from 20 to 18/);

    const starving = await start({ health: { health: 20, food: 0, saturation: 0 } });
    const going = perform(starving.client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(starving.server.walkSteps().length).toBeGreaterThanOrEqual(5));
    starving.server.combatSim.hurtPlayer(2);
    const r = await going;
    expect(r, r.message).toMatchObject({ ok: true });
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

  it('a calm spider (in daylight, beyond its leap) does not stop a walk; the same one at night does', async () => {
    // 6.5 blocks east of the start, and farther with every step toward the north-west.
    const spider = { kind: 'mob' as const, entityId: 701, mobType: 52, x: 2, y: FEET_Y, z: -7.5 };
    const options = { light: openSkyLight(flatWorld()), entities: [spider] };
    const day = await start({ ...options, dayTicks: 6000 });
    expect(await perform(day.client, moveTo(-8.5, -11.5))).toMatchObject({ ok: true, code: 'OK' });
    // At night it is a threat: a walk away from it, beyond 6 blocks, goes on (a person walks
    // on away from a mob); a walk toward it stops at once.
    const night = await start({ ...options, dayTicks: 18_000 });
    expect(await perform(night.client, moveTo(-8.5, -11.5))).toMatchObject({ ok: true });
    const toward = await start({ ...options, dayTicks: 18_000 });
    const result = await perform(toward.client, moveTo(-1.5, -7.5));
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/hostile entity minecraft:Spider 6\.5 blocks away/);
  }, 20_000);

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

/** The test registry with BOP foliage (the walker passes it by its metadata). */
const FOLIAGE_REGISTRY: Array<[number, string]> = [
  ...TEST_BLOCK_REGISTRY,
  [BLOCK.bopFoliage, 'BiomesOPlenty:foliage'],
];
const TERRAIN_FENCE = { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 108, z: -4 } };

describe('Gtnh1710Client block metadata', () => {
  // NEID metadata is 16-bit (300 needs two bytes); vanilla's is a nibble.
  it.each<[string, Array<{ modid: string; version: string }>, number]>([
    ['NotEnoughIDs', DEFAULT_MODS, 300],
    ['vanilla', DEFAULT_MODS.filter((m) => m.modid !== 'neid'), 12],
  ])('keeps it from %s chunk data and block changes', async (_format, mods, wide) => {
    const { server, client } = await start({
      mods,
      blocks: FOLIAGE_REGISTRY,
      blockOverrides: new Map([
        ['-3,106,-8', BLOCK.bopFoliage],
        ['-2,106,-8', BLOCK.bopFoliage],
      ]),
      blockMeta: new Map([
        ['-3,106,-8', FOLIAGE.poisonIvy],
        ['-2,106,-8', wide],
      ]),
    });
    await vi.waitFor(() => expect(client.world.metaAt(-3, 106, -8)).toBe(FOLIAGE.poisonIvy));
    expect(client.world.blockAt(-3, 106, -8)).toBe(BLOCK.bopFoliage);
    expect(client.world.metaAt(-2, 106, -8)).toBe(wide);
    expect(client.world.metaAt(-4, 105, -8)).toBe(0); // grass
    // A Block Change, then a Multi Block Change, each with its metadata.
    server.setBlock(-3, 106, -8, BLOCK.bopFoliage, FOLIAGE.shortgrass);
    await vi.waitFor(() => expect(client.world.metaAt(-3, 106, -8)).toBe(FOLIAGE.shortgrass));
    server.setBlocks(-1, -1, [
      { x: -2, y: 106, z: -8, id: BLOCK.bopFoliage, meta: FOLIAGE.berryBush },
      { x: -3, y: 106, z: -8, id: 0 },
    ]);
    await vi.waitFor(() => expect(client.world.metaAt(-2, 106, -8)).toBe(FOLIAGE.berryBush));
    expect([client.world.blockAt(-3, 106, -8), client.world.metaAt(-3, 106, -8)]).toEqual([0, 0]);
  });
});

describe('Gtnh1710Client walking over terrain', () => {
  /** A hedge of BOP foliage across x = -3, the fence's whole depth: short grass but for `other`. */
  function hedge(other: Record<string, number> = {}): FakeServerOptions {
    const blockOverrides = new Map<string, number>();
    const blockMeta = new Map<string, number>();
    for (let z = TERRAIN_FENCE.min.z; z <= TERRAIN_FENCE.max.z; z++) {
      blockOverrides.set(`-3,106,${z}`, BLOCK.bopFoliage);
      blockMeta.set(`-3,106,${z}`, other[`-3,106,${z}`] ?? FOLIAGE.shortgrass);
    }
    return { blocks: FOLIAGE_REGISTRY, blockOverrides, blockMeta };
  }

  it('walks through BOP foliage, around the poison ivy on its straight line', async () => {
    // Seen live 2026-10-01: foliage at feet level walled in logs 7 blocks away.
    const { server, client } = await start(hedge({ '-3,106,-8': FOLIAGE.poisonIvy }), {
      fence: TERRAIN_FENCE,
    });
    const result = await perform(client, moveTo(-1.5, -7.5));
    expect(result).toMatchObject({ ok: true, code: 'OK' });
    const steps = server.walkSteps();
    expect(steps.at(-1)).toMatchObject({ x: -1.5, feetY: FEET_Y, z: -7.5, onGround: true });
    // Through the hedge (every way across goes through it), never into the ivy's cell.
    expect(steps.some((s) => s.x - 0.3 < -2 && s.x + 0.3 > -3)).toBe(true);
    for (const s of steps) {
      const inIvy = s.x + 0.3 > -3 && s.x - 0.3 < -2 && s.z + 0.3 > -8 && s.z - 0.3 < -7;
      expect(inIvy, `step at ${s.x}, ${s.z}`).toBe(false);
    }
  });

  it('refuses a hedge of poison ivy without sending a step', async () => {
    const ivy: Record<string, number> = {};
    for (let z = TERRAIN_FENCE.min.z; z <= TERRAIN_FENCE.max.z; z++) {
      ivy[`-3,106,${z}`] = FOLIAGE.poisonIvy;
    }
    const { server, client } = await start(hedge(ivy), { fence: TERRAIN_FENCE });
    const result = await perform(client, moveTo(-1.5, -7.5));
    expect(result).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(result.message).toMatch(/no walkable path/);
    expect(server.walkSteps()).toHaveLength(0);
  });

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
    // A real jump (the pathfinder's physics): the server's own move check takes every step.
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('a hostile coming near as it steps off an edge stops the walk on the ground below, not over it', async () => {
    // Seen live 2026-10-04: a Mirage Enderman stopped a walk the tick its body passed an edge
    // (a step still on the ground: 1.7.10 moves along y first), and the bot hung over the hole.
    const low = new Map<string, number>();
    for (let x = -9; x <= -1; x++) {
      for (let z = -12; z <= -9; z++) {
        low.set(`${x},105,${z}`, BLOCK.air);
        low.set(`${x},104,${z}`, BLOCK.grass);
      }
    }
    const { server, client } = await start(
      { blockOverrides: low },
      { fence: { min: { x: -9, y: FEET_Y - 1, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } } },
    );
    const walk = perform(client, moveTo(-4.5, -11.5, FEET_Y - 1));
    // The step whose box (0.3 each way) has left the block at z -8, still at its level.
    const overEdge = (): boolean =>
      server.walkSteps().some((s) => s.z + 0.3 < -8 && s.feetY === FEET_Y);
    const deadline = Date.now() + 5_000;
    while (!overEdge() && Date.now() < deadline) await delay(2);
    expect(overEdge()).toBe(true);
    server.broadcast(
      spawnFrame({ kind: 'mob', entityId: 701, mobType: 54, x: -4.5, y: FEET_Y - 1, z: -11.5 }),
    );
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/hostile entity minecraft:Zombie/);
    // Down on the lower ground, where it was going: not over the edge.
    expect(result.data['y']).toBe(FEET_Y - 1);
    expect(server.confirmedPositions.at(-1)).toMatchObject({ feetY: FEET_Y - 1, onGround: true });
  });
});
