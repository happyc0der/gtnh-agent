import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, PLACE_TEST_BLOCK_REGISTRY, type BlockFn } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, spawnFrame, type FakeEntity } from './fixtures/fake-server.ts';

// Players' builds (src/domain/player-builds.ts): a cell that turns from air into a block while
// another player stands within 8 blocks, and that the agent did not place, is a player's build,
// never broken by a walk, DIG_BLOCK or GATHER, and kept in agent memory across connections.
// Ground: grass at y=105 over dirt (the feet at 106); the agent at (-4.5, 106, -7.5).
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: 98, z: -12 }, max: { x: 6, y: 112, z: -4 } };
const STRIP = { min: { x: -9, y: 98, z: -8 }, max: { x: 6, y: 112, z: -8 } };
const ground: BlockFn = (_x, y) =>
  y === 0 ? BLOCK.bedrock : y > 105 ? BLOCK.air : y === 105 ? BLOCK.grass : BLOCK.dirt;
const OWNER: FakeEntity = {
  kind: 'player',
  entityId: 77,
  name: 'Owner',
  x: 0.5,
  y: FEET_Y,
  z: -7.5,
};

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-builds-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

function configFor(port: number, fence = FENCE, placing = true): AgentConfig {
  return defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: { enabled: true, fence, stopFile: join(dir, 'STOP') },
      digging: { enabled: true },
      placing: { enabled: placing },
    },
    safety: { boundary: { min: { x: -50, y: 0, z: -50 }, max: { x: 50, y: 255, z: 50 } } },
  });
}

async function serve(entities: FakeEntity[] = [OWNER]) {
  const server = new FakeGtnhServer({
    blocks: PLACE_TEST_BLOCK_REGISTRY,
    world: ground,
    spawn: { x: -4.5, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z: -7.5, yaw: 0, pitch: 0 },
    inventory: [{ slot: 36, id: BLOCK.dirt, count: 10, damage: 0 }],
    entities,
  });
  servers.push(server);
  return { server, port: await server.listen() };
}

async function connect(port: number, fence = FENCE, placing = true) {
  const config = configFor(port, fence, placing);
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { client, config };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}

const loopIds = sequentialIds();
function loopDeps(client: Gtnh1710Client, config: AgentConfig, repos: Repositories) {
  return {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner: null,
    clock: systemClock,
    newId: loopIds,
  };
}

describe("players' builds", { timeout: 30_000 }, () => {
  it('a block a player puts down near itself is its build: listed, never a resource, never dug', async () => {
    const { server, port } = await serve();
    const { client } = await connect(port);
    // The owner, 2 blocks off, puts dirt down (the server's change: air to dirt).
    server.setBlock(-2, FEET_Y, -8, BLOCK.dirt);
    await vi.waitFor(() => expect(client.world.builtByPlayer(-2, FEET_Y, -8)).toBe(true));
    const state = await client.observe();
    if (!state.nearbyBlocks.known) throw new Error('blocks unknown');
    expect(state.nearbyBlocks.value.playerBuilt).toEqual([{ x: -2, y: FEET_Y, z: -8 }]);
    expect(
      state.nearbyBlocks.value.resources.some(
        (r) => r.position.x === -2 && r.position.y === FEET_Y && r.position.z === -8,
      ),
    ).toBe(false);
    const dig = await perform(client, {
      type: 'DIG_BLOCK',
      args: { position: { x: -2, y: FEET_Y, z: -8 } },
    });
    expect(dig).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(dig.message).toMatch(/built by a player/);
    expect(server.digSim.digs).toEqual([]);
    expect(client.takePlayerBuilds()).toMatchObject({
      added: [
        { dimension: 'overworld', position: { x: -2, y: FEET_Y, z: -8 }, block: 'minecraft:dirt' },
      ],
      removed: [],
    });
    // The owner takes it away again: forgotten.
    server.setBlock(-2, FEET_Y, -8, BLOCK.air);
    await vi.waitFor(() => expect(client.world.builtByPlayer(-2, FEET_Y, -8)).toBe(false));
    expect(client.takePlayerBuilds()).toEqual({
      added: [],
      removed: [{ dimension: 'overworld', position: { x: -2, y: FEET_Y, z: -8 } }],
    });
  });

  it('a block appearing with no player near, or one the agent placed itself, is no build', async () => {
    const { server, port } = await serve();
    const { client } = await connect(port);
    // 9 blocks west of the owner: too far.
    server.setBlock(-9, FEET_Y, -8, BLOCK.dirt);
    // The agent's own placement, with the owner 4 blocks away.
    const placed = await perform(client, {
      type: 'PLACE_BLOCK',
      args: { position: { x: -4, y: FEET_Y, z: -9 }, item: 'minecraft:dirt' },
    });
    expect(placed, placed.message).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(client.world.blockAt(-9, FEET_Y, -8)).toBe(BLOCK.dirt));
    expect(client.world.builtByPlayer(-9, FEET_Y, -8)).toBe(false);
    expect(client.world.builtByPlayer(-4, FEET_Y, -9)).toBe(false);
    expect(client.takePlayerBuilds().added).toEqual([]);
  });

  it('a walk never breaks a wall a player built: over it with blocks, else no way', async () => {
    const { server, port } = await serve();
    const { client } = await connect(port, STRIP, false);
    server.setBlocks(-1, -1, [
      { x: -2, y: FEET_Y, z: -8, id: BLOCK.dirt },
      { x: -2, y: FEET_Y + 1, z: -8, id: BLOCK.dirt },
      { x: -2, y: FEET_Y + 2, z: -8, id: BLOCK.dirt },
    ]);
    await vi.waitFor(() => expect(client.world.builtByPlayer(-2, FEET_Y + 2, -8)).toBe(true));
    // The owner walks off (far from the wall): the wall is still its build.
    server.teleportEntity(77, 40.5, FEET_Y, -7.5);
    await vi.waitFor(() =>
      expect(client.world.trackedEntities().find((e) => e.entityId === 77)?.x).toBe(40.5),
    );
    const r = await perform(client, {
      type: 'MOVE_TO',
      args: { target: { x: 0.5, y: FEET_Y, z: -7.5 }, tolerance: 0.5 },
    });
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(server.digSim.digs).toEqual([]);

    // With placing on, it goes over the wall (a pillar of its own dirt) and leaves it standing.
    const placing = await serve();
    const builder = await connect(placing.port, STRIP);
    placing.server.setBlocks(-1, -1, [
      { x: -2, y: FEET_Y, z: -8, id: BLOCK.dirt },
      { x: -2, y: FEET_Y + 1, z: -8, id: BLOCK.dirt },
      { x: -2, y: FEET_Y + 2, z: -8, id: BLOCK.dirt },
    ]);
    await vi.waitFor(() =>
      expect(builder.client.world.builtByPlayer(-2, FEET_Y + 2, -8)).toBe(true),
    );
    placing.server.teleportEntity(77, 40.5, FEET_Y, -7.5);
    await vi.waitFor(() =>
      expect(builder.client.world.trackedEntities().find((e) => e.entityId === 77)?.x).toBe(40.5),
    );
    const over = await perform(builder.client, {
      type: 'MOVE_TO',
      args: { target: { x: 0.5, y: FEET_Y, z: -7.5 }, tolerance: 0.5 },
    });
    expect(over, over.message).toMatchObject({ ok: true });
    expect(placing.server.digSim.digs).toEqual([]);
    expect(placing.server.placeSim.placed.length).toBeGreaterThan(0);
    // Its own pillar is no player's build.
    for (const p of placing.server.placeSim.placed) {
      expect(builder.client.world.builtByPlayer(p.x, p.y, p.z)).toBe(false);
    }
  });

  it('agent memory keeps them: after a reconnect the build is still never dug', async () => {
    const { server, port } = await serve();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const first = await connect(port);
    syncConfigToDatabase(first.config, repos);
    server.setBlock(-2, FEET_Y, -8, BLOCK.dirt);
    await vi.waitFor(() => expect(first.client.world.builtByPlayer(-2, FEET_Y, -8)).toBe(true));
    // A cycle stores what the client saw.
    await runUserAction(
      loopDeps(first.client, first.config, repos),
      { type: 'OBSERVE_STATE', args: {} },
      'look',
    );
    expect(repos.playerBuilds.all('overworld').map((b) => b.position)).toEqual([
      { x: -2, y: FEET_Y, z: -8 },
    ]);
    await first.client.disconnect();
    clients.splice(clients.indexOf(first.client), 1);

    // A new connection, the owner gone: the new client knows the build from agent memory.
    server.destroyEntities([77]);
    const second = await connect(port);
    const dig = await runUserAction(
      loopDeps(second.client, second.config, repos),
      { type: 'DIG_BLOCK', args: { position: { x: -2, y: FEET_Y, z: -8 } } },
      'dig the build',
    );
    expect(dig.status).toBe('rejected');
    expect(dig.outcome?.validation.violations.map((v) => v.code)).toEqual(['NOT_DIGGABLE']);
    expect(dig.outcome?.validation.violations[0]?.message).toMatch(/built by a player/);
    expect(second.client.world.builtByPlayer(-2, FEET_Y, -8)).toBe(true);
    expect(server.digSim.digs).toEqual([]);
  });

  it('only another player counts: a player entity that leaves sight no longer makes builds', async () => {
    const { server, port } = await serve([]);
    const { client } = await connect(port);
    server.setBlock(-2, FEET_Y, -8, BLOCK.dirt);
    await vi.waitFor(() => expect(client.world.blockAt(-2, FEET_Y, -8)).toBe(BLOCK.dirt));
    expect(client.world.builtByPlayer(-2, FEET_Y, -8)).toBe(false);
    server.broadcast(spawnFrame(OWNER));
    await vi.waitFor(() => expect(client.world.trackedEntities().length).toBe(1));
    server.setBlock(-3, FEET_Y, -9, BLOCK.planks);
    await vi.waitFor(() => expect(client.world.builtByPlayer(-3, FEET_Y, -9)).toBe(true));
  });
});
