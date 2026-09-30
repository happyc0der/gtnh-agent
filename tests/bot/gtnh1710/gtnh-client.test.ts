import { afterEach, describe, expect, it } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { runSingleCycle, syncConfigToDatabase } from '../../../src/app/agent-loop.ts';
import { defaultConfig, type MinecraftConfig } from '../../../src/config/env.ts';
import { ACTION_TYPES, createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { GameStateSchema } from '../../../src/domain/game-state.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { MockPlannerProvider } from '../../../src/planner/mock-planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { memoryRepos } from '../../fixtures/index.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
});

async function start(
  serverOptions: FakeServerOptions = {},
  mc: Partial<MinecraftConfig> = {},
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: MinecraftConfig }> {
  const server = new FakeGtnhServer(serverOptions);
  servers.push(server);
  const port = await server.listen();
  const config = {
    ...defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port,
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
      },
    }).minecraft,
    ...mc,
  };
  const client = new Gtnh1710Client({ config, clock: systemClock, retryDelayMs: 50 });
  clients.push(client);
  return { server, client, config };
}

const ALLOWED_PLAY_IDS = new Set([0x00, 0x03, 0x06, 0x17]);

describe('Gtnh1710Client against a scripted GTNH server', () => {
  it('joins with the FML handshake and observes a schema-valid GameState', async () => {
    const { server, client } = await start();
    await client.connect();
    const state = await client.observe();

    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(state.source).toBe('gtnh1710');
    expect(state.player.dimension).toEqual({ known: true, value: 'overworld' });
    expect(state.player.position).toEqual({
      known: true,
      value: { x: -4.5, y: 107.62000000476837 - PLAYER_EYE_HEIGHT, z: -7.5 },
    });
    expect(state.player.health).toEqual({ known: true, value: 20 });
    expect(state.player.hunger).toEqual({ known: true, value: 18 });
    expect(state.player.armor).toEqual({
      known: true,
      value: { equippedPieces: 0, lowestDurabilityFraction: null },
    });
    expect(state.player.heldTool).toEqual({ known: true, value: null });
    expect(state.inventory).toEqual({
      known: true,
      value: {
        items: {
          'minecraft:bread': 10,
          'minecraft:coal': 16,
          'gregtech:gt.metaitem.01@2032': 3,
          'BuildCraft|Core:engineBlock': 1,
          'Natura:N Crops': 2,
        },
        usedSlots: 6,
        capacitySlots: 36,
      },
    });
    // Not observable yet: the agent must fail closed on these.
    expect(state.nearbyThreats.known).toBe(false);
    expect(state.power.availableEUt.known).toBe(false);

    const info = client.info();
    expect(info.registry).toEqual({ items: 2005, blocks: 1 });
    expect(info.identity).toEqual({
      motd: 'gtnh-agent-test (localhost only)',
      version: '1.7.10',
      mods: 6,
    });
    expect(info.handshakeStep).toBe('DONE');
    expect(server.handshakeHosts[1]).toBe('127.0.0.1\0FML\0');
  });

  it('sends nothing but keep-alives, handshake messages, idle ticks and exact position echoes', async () => {
    const { server, client } = await start();
    await client.connect();
    await new Promise((r) => setTimeout(r, 400)); // let keep-alives and idle ticks flow

    expect(server.playPacketIds().every((id) => ALLOWED_PLAY_IDS.has(id))).toBe(true);
    expect(new Set(server.pluginChannels())).toEqual(new Set(['REGISTER', 'FML|HS']));
    expect(server.keepAliveEchoes.length).toBeGreaterThan(0);
    expect(server.idleTicks).toBeGreaterThan(0);
    // Every position the client ever reported is the server's own placement.
    expect(server.confirmedPositions.length).toBe(1);
    const p = server.confirmedPositions[0];
    expect(p?.x).toBe(-4.5);
    expect(p?.z).toBe(-7.5);
    expect(p?.headY).toBe(107.62000000476837);
    expect(Math.abs((p?.headY ?? 0) - (p?.feetY ?? 0) - PLAYER_EYE_HEIGHT)).toBeLessThan(1e-9);
  });

  it('refuses every world-changing action without sending anything new', async () => {
    const { server, client } = await start();
    await client.connect();
    const ids = sequentialIds();
    const specs: Record<string, ActionSpec> = {
      OBSERVE_STATE: { type: 'OBSERVE_STATE', args: {} },
      MOVE_TO: { type: 'MOVE_TO', args: { target: { x: 0, y: 64, z: 0 }, tolerance: 1 } },
      WAIT: { type: 'WAIT', args: { durationMs: 50 } },
      EAT_FOOD: { type: 'EAT_FOOD', args: { item: 'minecraft:bread' } },
      RETURN_TO_SAFE_LOCATION: { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } },
      OPEN_CONTAINER: { type: 'OPEN_CONTAINER', args: { containerId: 'c1' } },
      DEPOSIT_ITEM: {
        type: 'DEPOSIT_ITEM',
        args: { containerId: 'c1', item: 'minecraft:coal', quantity: 1 },
      },
      WITHDRAW_ITEM: {
        type: 'WITHDRAW_ITEM',
        args: { containerId: 'c1', item: 'minecraft:coal', quantity: 1 },
      },
      INSPECT_MACHINE: { type: 'INSPECT_MACHINE', args: { machineId: 'm1' } },
      REFUEL_KNOWN_GENERATOR: {
        type: 'REFUEL_KNOWN_GENERATOR',
        args: { generatorId: 'g1', fuelItem: 'minecraft:coal', quantity: 1 },
      },
      PAUSE_AND_ASK_USER: { type: 'PAUSE_AND_ASK_USER', args: { question: 'ok?' } },
    };
    expect(Object.keys(specs).sort()).toEqual([...ACTION_TYPES].sort());

    for (const [type, spec] of Object.entries(specs)) {
      const action = createAction(
        { spec, reason: 'test', origin: 'test', taskId: null },
        { newId: ids, now: () => new Date() },
      );
      const before = server.playPacketIds().filter((id) => id !== 0x00 && id !== 0x03).length;
      const result = await client.perform(mintValidatedAction(action, null, new Date()));
      const after = server.playPacketIds().filter((id) => id !== 0x00 && id !== 0x03).length;
      expect(after, `${type} sent a packet`).toBe(before);
      if (['OBSERVE_STATE', 'WAIT', 'PAUSE_AND_ASK_USER'].includes(type))
        expect(result.ok, type).toBe(true);
      else expect(result, type).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
    }
  });

  it('reads real GTNH stack sizes above 127, and the vanilla format when ModularUI is absent', async () => {
    const big = await start({ inventory: [{ slot: 9, id: 263, count: 3000, damage: 0 }] });
    await big.client.connect();
    expect((await big.client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:coal': 3000 } },
    });

    const vanilla = await start({
      mods: [
        { modid: 'Forge', version: '10.13.4.1614' },
        { modid: 'gregtech', version: 'MC1710' },
      ],
      inventory: [{ slot: 9, id: 297, count: 5, damage: 0 }],
    });
    await vanilla.client.connect();
    expect((await vanilla.client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:bread': 5 } },
    });
  });

  it('an undecodable inventory packet makes the inventory unknown but keeps the connection', async () => {
    const { client } = await start({ corruptInventory: true }, { initialStateGraceMs: 500 });
    await client.connect();
    const state = await client.observe();
    expect(state.inventory).toMatchObject({
      known: false,
      reason: /undecodable inventory packet 0x30/,
    });
    expect(state.player.heldTool.known).toBe(false);
    expect(state.player.position.known).toBe(true);
    expect(state.player.health.known).toBe(true);
  });

  it('retries while Forge reports "Server is still starting!"', async () => {
    const { server, client } = await start({ stillStartingPings: 2 });
    await client.connect();
    expect(server.statusPings).toBe(3);
    expect((await client.observe()).player.position.known).toBe(true);
  });

  it('with presence disabled it stays passive: no position or idle packets, health unknown', async () => {
    const { server, client } = await start({}, { presenceTicks: false, initialStateGraceMs: 300 });
    await client.connect();
    const state = await client.observe();
    expect(server.playPacketIds().filter((id) => id === 0x03 || id === 0x06)).toEqual([]);
    expect(state.player.health.known).toBe(false);
    expect(state.inventory.known).toBe(true);
  });

  it('reports a lost connection instead of stale data', async () => {
    const { server, client } = await start();
    await client.connect();
    server.dropAll();
    await new Promise((r) => setTimeout(r, 100));
    await expect(client.observe()).rejects.toThrow(/connection lost/);
  });

  it('a live cycle against the server fails closed (threats unknown) and only records a pause', async () => {
    const { server, client } = await start();
    await client.connect();
    const repos = memoryRepos();
    const config = defaultConfig();
    syncConfigToDatabase(config, repos);
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: new MockPlannerProvider([]),
      clock: systemClock,
      newId: sequentialIds(),
    });
    expect(result.decision?.decision).toBe('PAUSE_AND_ASK_USER');
    expect(result.stateViolations.map((v) => v.code)).toEqual(['STATE_UNKNOWN']);
    expect(result.status).toBe('paused');
    expect(server.playPacketIds().every((id) => ALLOWED_PLAY_IDS.has(id))).toBe(true);
  });
});

describe('Gtnh1710Client refuses to join the wrong server', () => {
  it('when live connections are disabled or no identity marker is set', async () => {
    const { server, client: disabled } = await start({}, { enableLiveConnection: false });
    await expect(disabled.connect()).rejects.toThrow(/Live connection is disabled/);
    const { client: unmarked } = await start({}, { serverIdentityMarker: null });
    await expect(unmarked.connect()).rejects.toThrow(/identity marker/);
    expect(server.statusPings + server.logins).toBe(0);
  });

  it('when the host is public (before any network traffic)', async () => {
    const config = defaultConfig({
      minecraft: { enableLiveConnection: true, serverIdentityMarker: 'gtnh-agent-test' },
    }).minecraft;
    const client = new Gtnh1710Client({
      config: { ...config, host: '8.8.8.8' },
      clock: systemClock,
    });
    await expect(client.connect()).rejects.toThrow(/public IP/);
  });

  it.each<[string, FakeServerOptions, RegExp]>([
    ['the MOTD lacks the marker', { motd: 'NYCNavs survival' }, /MOTD/],
    ['it is not a Forge server', { modinfoType: 'VANILLA' }, /not a Forge/],
    ['it has no GregTech', { mods: [{ modid: 'Forge', version: '10.13.4.1614' }] }, /GregTech/],
    ['it is not 1.7.10', { versionName: '1.12.2' }, /expected 1\.7\.10/],
  ])('when %s, without logging in', async (_name, options, error) => {
    const { server, client } = await start(options);
    await expect(client.connect()).rejects.toThrow(error);
    expect(server.logins).toBe(0);
  });

  it('when the server is in online mode or kicks during login', async () => {
    const { client: online } = await start({ onlineMode: true });
    await expect(online.connect()).rejects.toThrow(/online mode/);
    const { client: kicked } = await start({
      kickOnLogin: 'You are not white-listed on this server!',
    });
    await expect(kicked.connect()).rejects.toThrow(/not white-listed/);
  });
});
