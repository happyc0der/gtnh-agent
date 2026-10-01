import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runSingleCycle,
  runUserAction,
  syncConfigToDatabase,
  type AgentDeps,
} from '../../../src/app/loop/agent-loop.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { known } from '../../../src/domain/known.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY, type BlockFn } from './chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on grass at y=105, over dirt (101-104) and
// stone (100): solid ground, unlike the flat test world (grass over air).
const SPAWN_COLUMN = { x: -5, z: -8 };
const UNDER = { x: -5, y: 105, z: -8 };
const TERRAIN = { min: { x: -14, y: 96, z: -18 }, max: { x: 4, y: 112, z: 2 } };

/** Bedrock at 0, stone at 100, dirt at 101-104, grass at 105, air above. */
const solidGround: BlockFn = (_x, y) =>
  y === 0
    ? BLOCK.bedrock
    : y === 100
      ? BLOCK.stone
      : y > 100 && y < 105
        ? BLOCK.dirt
        : y === 105
          ? BLOCK.grass
          : BLOCK.air;

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-dig-down-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  server: FakeServerOptions = {},
  minecraft: {
    fence?: typeof TERRAIN;
    movement?: boolean;
    digging?: boolean;
  } = {},
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: AgentConfig }> {
  const fake = new FakeGtnhServer({
    blocks: DIG_TEST_BLOCK_REGISTRY,
    world: solidGround,
    // The fall is checked against a server that moves the player only when told (C06).
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
      movement: {
        enabled: minecraft.movement ?? true,
        fence: minecraft.fence ?? TERRAIN,
        stopFile: join(dir, 'STOP'),
      },
      digging: { enabled: minecraft.digging ?? true },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client, config };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const down = (p: { x: number; y: number; z: number }): ActionSpec => ({
  type: 'DIG_DOWN',
  args: { position: { x: p.x, y: p.y, z: p.z } },
});
const digPackets = (server: FakeGtnhServer) => server.playPacketIds().filter((id) => id === 0x07);
const blocksOf = (s: GameState) => {
  if (!s.nearbyBlocks.known) throw new Error(`nearby blocks unknown: ${s.nearbyBlocks.reason}`);
  return s.nearbyBlocks.value;
};

describe('Gtnh1710Client DIG_DOWN (the night pit only)', () => {
  it('digs the block under its feet, then falls exactly one block onto the next with vanilla gravity', async () => {
    const { server, client } = await start();
    // The observation reports the ground under the player.
    expect(blocksOf(await client.observe()).underFeet).toEqual({
      position: UNDER,
      block: 'minecraft:grass',
      landing: 'minecraft:dirt',
      landingHolds: true,
    });

    const result = await perform(client, down(UNDER));
    expect(result).toMatchObject({
      ok: true,
      data: {
        block: 'minecraft:grass',
        dropCollected: true,
        drops: '1 x minecraft:dirt',
        feetX: -4.5,
        feetY: 105,
        feetZ: -7.5,
      },
    });
    expect(result.message).toMatch(/fell into the hole: the feet are at \(-4\.5, 105, -7\.5\)/);
    // C07 start and finish on the block under the feet, its top face; the server broke it.
    expect(server.digSim.digs.map((d) => [d.status, d.x, d.y, d.z, d.face])).toEqual([
      [0, -5, 105, -8, 1],
      [2, -5, 105, -8, 1],
    ]);
    expect(server.digSim.broken).toEqual([{ ...UNDER, name: 'minecraft:grass', late: false }]);

    // The fall: straight down, in the air until the last step, which lands on y=105.
    const fall = server.walkSteps();
    expect(fall.every((p) => p.x === -4.5 && p.z === -7.5)).toBe(true);
    expect(fall.map((p) => Number(p.feetY.toFixed(4)))).toEqual([
      105.9216, 105.7664, 105.5358, 105.2315, 105,
    ]);
    expect(fall.map((p) => p.onGround)).toEqual([false, false, false, false, true]);
    // The fall comes after the finish (and the server's air), never before.
    const ids = server.playPacketIds();
    expect(ids.slice(ids.lastIndexOf(0x07)).filter((id) => id === 0x06)).toHaveLength(5);

    const state = await client.observe();
    expect(state.player.position).toEqual(known({ x: -4.5, y: 105, z: -7.5 }));
    expect(blocksOf(state).removed).toEqual([UNDER]);
    expect(blocksOf(state).underFeet).toMatchObject({
      position: { x: -5, y: 104, z: -8 },
      block: 'minecraft:dirt',
    });
    expect(state.inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:dirt': 1 } },
    });
  }, 15_000);

  it('three in a row make the pit: the feet end three blocks lower', async () => {
    const { server, client } = await start();
    for (const y of [105, 104, 103]) {
      const r = await perform(client, down({ ...SPAWN_COLUMN, y }));
      expect(r, `dig at y=${y}`).toMatchObject({ ok: true, data: { feetY: y } });
    }
    expect(server.digSim.broken.map((b) => b.y)).toEqual([105, 104, 103]);
    expect(client.world.ownPosition).toEqual({ x: -4.5, y: 103, z: -7.5 });
    expect(server.digSim.pickedUp).toEqual([
      { item: 'minecraft:dirt', count: 1 },
      { item: 'minecraft:dirt', count: 1 },
      { item: 'minecraft:dirt', count: 1 },
    ]);
  }, 20_000);

  it('refuses before sending anything: a cave or water under it, lava or water near, or the wrong block', async () => {
    const { server, client } = await start();
    const set = async (p: { x: number; y: number; z: number }, id: number): Promise<void> => {
      server.setBlock(p.x, p.y, p.z, id);
      await vi.waitFor(() => expect(client.world.blockAt(p.x, p.y, p.z)).toBe(id));
    };
    const refused = async (reason: RegExp): Promise<void> => {
      const r = await perform(client, down(UNDER));
      expect(r, reason.source).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    };
    // A cave under the block: the player would fall farther than one block.
    await set({ x: -5, y: 104, z: -8 }, BLOCK.air);
    await refused(/minecraft:air is under it at \(-5, 104, -8\), not a plain full block/);
    // Sand under it, with nothing under the sand: it would fall with the player on it.
    await set({ x: -5, y: 104, z: -8 }, BLOCK.sand);
    await set({ x: -5, y: 103, z: -8 }, BLOCK.air);
    await refused(/minecraft:sand under it at \(-5, 104, -8\) has minecraft:air under it/);
    await set({ x: -5, y: 103, z: -8 }, BLOCK.dirt);
    await set({ x: -5, y: 104, z: -8 }, BLOCK.dirt);
    // Lava next to the landing.
    await set({ x: -4, y: 104, z: -9 }, BLOCK.lava);
    await refused(/near minecraft:lava at \(-4, 104, -9\)/);
    await set({ x: -4, y: 104, z: -9 }, BLOCK.dirt);
    // Water beside the player's feet: it would pour into the hole.
    await set({ x: -4, y: 106, z: -8 }, BLOCK.water);
    await refused(/minecraft:water at \(-4, 106, -8\) is near it/);
    await set({ x: -4, y: 106, z: -8 }, BLOCK.air);
    // Only the block under the feet.
    const beside = await perform(client, down({ x: -4, y: 105, z: -8 }));
    expect(beside.message).toMatch(/is not the block under the player's feet/);
    // Not centred on the column (the server placed it near the edge).
    server.placePlayer(-4.8, 107.62000000476837, -7.5);
    await vi.waitFor(() => expect(client.world.ownPosition?.x).toBe(-4.8));
    await refused(/stands across more than one column/);
    expect(digPackets(server)).toEqual([]);
    expect(server.digSim.broken).toEqual([]);
  }, 20_000);

  it('refuses next to blocks that are not loaded (a chunk border)', async () => {
    // The player's column is x=-1 (chunk -1); the column east of it, x=0, is chunk 0.
    const { server, client } = await start({
      spawn: { x: -0.5, eyeY: 107.62000000476837, z: -7.5, yaw: 0, pitch: 0 },
    });
    server.unloadChunk(0, -1);
    await vi.waitFor(() => expect(client.world.blockAt(0, 105, -8)).toBeUndefined());
    const r = await perform(client, down({ x: -1, y: 105, z: -8 }));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/at \(0, 105, -8\) is not loaded/);
    expect(digPackets(server)).toEqual([]);
  }, 15_000);

  it('is off without digging, refused without walking (the fall), and never in the pen', async () => {
    const off = await start({}, { digging: false });
    expect(await perform(off.client, down(UNDER))).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    const still = await start({}, { movement: false });
    const r = await perform(still.client, down(UNDER));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/the player falls into the hole, and movement is disabled/);
    const pen = await start(
      {},
      { fence: { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 106, z: -4 } } },
    );
    expect((await perform(pen.client, down(UNDER))).message).toMatch(
      /needs a terrain fence \(a height range\): the pen keeps its floor/,
    );
    for (const s of [off.server, still.server, pen.server]) expect(digPackets(s)).toEqual([]);
  }, 20_000);
});

describe('DIG_DOWN through the executor: the night shelter task only', () => {
  const deps = (client: Gtnh1710Client, config: AgentConfig): AgentDeps => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    return {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock: systemClock,
      newId: sequentialIds(),
    };
  };
  const pitSteps = [
    { spec: down(UNDER), text: 'dig down: the minecraft:grass under the feet at (-5, 105, -8)' },
    {
      spec: down({ ...SPAWN_COLUMN, y: 104 }),
      text: 'dig down: the minecraft:dirt under the feet at (-5, 104, -8)',
    },
  ];
  const current = (d: AgentDeps, taskId: string): void => {
    d.repos.tasks.ensure({ id: taskId, goal: `task ${taskId}`, subgoal: null, status: 'active' });
    d.repos.tasks.setStatus(taskId, 'active');
    d.repos.memory.setValue(CURRENT_TASK_KEY, taskId);
    setKnownSteps(d.repos, taskId, pitSteps);
  };

  it("runs only as the night shelter's own known step, near night, and verifies the drop (DUG_DOWN)", async () => {
    const { server, client, config } = await start({ dayTicks: 1_000 });
    const d = deps(client, config);
    // A human's command: refused (it is not a mining ability).
    const user = await runUserAction(d, down(UNDER), 'dig down');
    expect(user.summary).toBe('USER -> DIG_DOWN -> rejected [NIGHT_PIT_ONLY]');
    expect(user.outcome?.validation.violations[0]?.message).toMatch(
      /^DIG_DOWN is the night pit's own step: only code's blueprint proposes it \(origin user\); only for the night shelter task \(night-shelter\), not no task; .*; only in the evening, at night or within 4 min of it, and it is day/,
    );
    // The same step as another task's blueprint: refused.
    current(d, 'quest-1');
    const other = await runSingleCycle(d);
    expect(other.summary).toBe('EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> rejected [NIGHT_PIT_ONLY]');
    // The night shelter's own step, in the morning: refused (the night pit only).
    current(d, 'night-shelter');
    const morning = await runSingleCycle(d);
    expect(morning.summary).toBe(
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> rejected [NIGHT_PIT_ONLY]',
    );
    expect(digPackets(server)).toEqual([]);

    // At dusk: dug, fallen into the hole, verified, and the blueprint moves on.
    server.setTime(11_000);
    await vi.waitFor(async () => {
      const t = (await client.observe()).time;
      expect(t.known && t.value.timeOfDay).toBe(11_000);
    });
    current(d, 'night-shelter');
    const dusk = await runSingleCycle(d);
    expect(dusk.summary).toBe('EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded');
    expect(
      dusk.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual([
      'PASS execution-ok',
      'PASS observation-fresh',
      'PASS block-removed',
      'PASS player-dropped',
    ]);
    expect(dusk.action).toMatchObject({ origin: 'deterministic-router' });
    expect(nextKnownStep(d.repos, 'night-shelter')).toMatchObject({ index: 1, total: 2 });
    expect(server.digSim.broken).toEqual([{ ...UNDER, name: 'minecraft:grass', late: false }]);
  }, 20_000);
});
