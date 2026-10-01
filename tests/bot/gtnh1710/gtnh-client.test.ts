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
import { encodeFrame } from '../../../src/bot/gtnh1710/wire.ts';
import { assessDangers } from '../../../src/safety/safety-policy.ts';
import { BLOCK } from './chunk-fixtures.ts';
import { DEFAULT_MODS, FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

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
    // No entities announced: threats are known and zero. Lava/void still needs chunk data.
    expect(state.nearbyThreats).toEqual({
      known: true,
      value: {
        scanRadius: 16,
        hostileCount: 0,
        nearestHostileDistance: null,
        unclassifiedCount: 0,
        nearestUnclassifiedDistance: null,
      },
    });
    // Flat test world: bedrock, a grass floor, nothing dangerous within the 32 m scan.
    expect(state.environmentHazards).toEqual({
      known: true,
      value: { scanRadius: 32, lavaNearby: false, voidNearby: false, hazards: [] },
    });
    expect(state.power.availableEUt.known).toBe(false);

    const info = client.info();
    expect(info.registry).toEqual({ items: 2005, blocks: 11 });
    expect(info.identity).toEqual({
      motd: 'gtnh-agent-test (localhost only)',
      version: '1.7.10',
      mods: 8,
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

  it('WAIT lasts until the OBSERVED time (last packet) has advanced by its duration', async () => {
    const { client } = await start();
    await client.connect();
    const before = await client.observe();
    const action = createAction(
      {
        spec: { type: 'WAIT', args: { durationMs: 300 } },
        reason: 'test',
        origin: 'test',
        taskId: null,
      },
      { newId: sequentialIds(), now: () => new Date() },
    );
    expect(await client.perform(mintValidatedAction(action, null, new Date()))).toMatchObject({
      ok: true,
    });
    const after = await client.observe();
    expect(Date.parse(after.timestamp) - Date.parse(before.timestamp)).toBeGreaterThanOrEqual(300);
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
      DIG_BLOCK: { type: 'DIG_BLOCK', args: { position: { x: -4, y: 105, z: -8 } } },
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

  it('a live cycle with everything observable pauses only because there is no task', async () => {
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
    expect(result.stateViolations).toEqual([]);
    expect(result.decision).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['NO_ACTIVE_TASK'],
    });
    expect(result.status).toBe('paused');
    expect(server.playPacketIds().every((id) => ALLOWED_PLAY_IDS.has(id))).toBe(true);
  });
});

describe('Gtnh1710Client entity tracking', () => {
  // The fake server spawns the player at (-4.5, 106, -7.5).
  const at = (dx: number, dz: number) => ({ x: -4.5 + dx, y: 106, z: -7.5 + dz });
  const entities: FakeServerOptions['entities'] = [
    { kind: 'mob', entityId: 101, mobType: 54, ...at(5, 0) }, // vanilla zombie, 5 m
    { kind: 'mob', entityId: 102, mobType: 92, ...at(0, 3) }, // cow, passive
    { kind: 'modded', entityId: 103, modId: 'etfuturum', typeId: 3, ...at(4, 0) }, // unclassified
    { kind: 'modded', entityId: 104, modId: 'SpecialMobs', typeId: 21, ...at(0, 8) }, // hostile mod
    { kind: 'mob', entityId: 105, mobType: 54, ...at(30, 0) }, // zombie beyond scan radius
    { kind: 'player', entityId: 106, name: 'DankAxon', ...at(2, 0) }, // other player, ignored
    { kind: 'object', entityId: 107, objectType: 50, ...at(0, -6) }, // primed TNT
    { kind: 'object', entityId: 108, objectType: 2, ...at(1, 1) }, // dropped item, ignored
  ];

  const threats = async (client: Gtnh1710Client) => {
    const s = await client.observe();
    if (!s.nearbyThreats.known) throw new Error(`threats unknown: ${s.nearbyThreats.reason}`);
    return s.nearbyThreats.value;
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('classifies vanilla mobs, objects, players and Forge modded entities', async () => {
    const { client } = await start({ entities });
    await client.connect();
    await settle();
    expect(await threats(client)).toEqual({
      scanRadius: 16,
      hostileCount: 3, // zombie, SpecialMobs#21, primed TNT
      nearestHostileDistance: 5,
      unclassifiedCount: 1, // etfuturum#3 (not yet identified)
      nearestUnclassifiedDistance: 4,
    });
    const nearby = client.world.nearbyEntities().map((e) => [e.name, e.category]);
    expect(nearby).toContainEqual(['etfuturum#3', 'unclassified']);
    expect(nearby).toContainEqual(['minecraft:Cow', 'passive']);
    expect(nearby).toContainEqual(['player:DankAxon', 'ignored']);
    // The zombie 30 m away is tracked but outside the scan radius.
    expect(client.world.nearbyEntities().map((e) => e.entityId)).not.toContain(105);
    expect(client.world.trackedEntityCount).toBe(8);
  });

  it('an identified passive modded mob (Et Futurum rabbit) is not a threat on the verified version', async () => {
    const rabbit = {
      kind: 'modded' as const,
      entityId: 201,
      modId: 'etfuturum',
      typeId: 3,
      ...at(3, 0),
    };
    const verified = await start({
      entities: [rabbit],
      mods: [...DEFAULT_MODS, { modid: 'etfuturum', version: '2.6.2.25-GTNH' }],
    });
    await verified.client.connect();
    expect((await threats(verified.client)).unclassifiedCount).toBe(0);
    expect(verified.client.world.nearbyEntities().map((e) => [e.name, e.category])).toEqual([
      ['etfuturum.rabbit', 'passive'],
    ]);

    const otherVersion = await start({
      entities: [rabbit],
      mods: [...DEFAULT_MODS, { modid: 'etfuturum', version: '2.7.0' }],
    });
    await otherVersion.client.connect();
    expect((await threats(otherVersion.client)).unclassifiedCount).toBe(1);
  });

  it('follows relative moves, teleports and removals', async () => {
    const { server, client } = await start({ entities });
    await client.connect();
    server.moveEntity(101, 3.5, 0, 0); // zombie 5 m -> 8.5 m
    server.moveEntity(101, 3.5, 0, 0); // -> 12 m
    await settle();
    expect((await threats(client)).nearestHostileDistance).toBe(6); // TNT is now nearest
    server.teleportEntity(101, -4.5, 106, -5.5); // zombie right next to us (2 m)
    await settle();
    expect((await threats(client)).nearestHostileDistance).toBe(2);
    server.destroyEntities([101, 104, 107, 103]);
    await settle();
    expect(await threats(client)).toEqual({
      scanRadius: 16,
      hostileCount: 0,
      nearestHostileDistance: null,
      unclassifiedCount: 0,
      nearestUnclassifiedDistance: null,
    });
  });

  it('threats stay unknown until the chunks around the player (and their entities) have arrived', async () => {
    const { client } = await start({ entities, sendChunks: false }, { initialStateGraceMs: 400 });
    await client.connect();
    const s = await client.observe();
    expect(s.nearbyThreats).toMatchObject({ known: false, reason: /waiting for 9 nearby chunk/ });
    expect(s.player.health.known && s.inventory.known).toBe(true);
  });

  it('unloading a nearby chunk makes threats unknown again', async () => {
    const { server, client } = await start({ entities });
    await client.connect();
    expect((await client.observe()).nearbyThreats.known).toBe(true);
    server.unloadChunk(-1, -1);
    await settle();
    expect((await client.observe()).nearbyThreats).toMatchObject({
      known: false,
      reason: /waiting for 1 nearby chunk/,
    });
  });

  it('a corrupt entity packet makes threats unknown for the rest of the session', async () => {
    const { server, client } = await start({ entities });
    await client.connect();
    server.broadcast(encodeFrame(0x0f, Buffer.from([0x05]))); // truncated spawn-mob
    await settle();
    const s = await client.observe();
    expect(s.nearbyThreats).toMatchObject({
      known: false,
      reason: /undecodable entity packet 0xf/,
    });
    expect(s.player.position.known).toBe(true); // everything else keeps working
  });
});

describe('Gtnh1710Client lava and void detection', () => {
  // The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105.
  const hazardsOf = async (client: Gtnh1710Client) => {
    const s = await client.observe();
    if (!s.environmentHazards.known)
      throw new Error(`hazards unknown: ${s.environmentHazards.reason}`);
    return s.environmentHazards.value;
  };
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('reports lava next to the player, and the safety policy sees the danger', async () => {
    const overrides = new Map([
      ['-2,106,-8', BLOCK.lava], // 2.5 m away
      ['-12,106,-8', BLOCK.cactus], // 7.5 m away
    ]);
    const { client } = await start({ blockOverrides: overrides });
    await client.connect();
    const h = await hazardsOf(client);
    expect(h.lavaNearby).toBe(true);
    expect(h.hazards.map((x) => [x.kind, x.position])).toEqual([
      ['lava', { x: -1.5, y: 106.5, z: -7.5 }],
      ['damaging_block', { x: -11.5, y: 106.5, z: -7.5 }],
    ]);
    const state = await client.observe();
    const ctx = {
      config: defaultConfig().safety,
      protectedItems: new Set<string>(),
      locations: new Map(),
      now: new Date(),
    };
    expect(assessDangers(state, ctx).map((v) => v.code)).toEqual(['HAZARD_PROXIMITY']);
  });

  it('follows block changes: lava appearing and disappearing', async () => {
    const { server, client } = await start();
    await client.connect();
    expect((await hazardsOf(client)).hazards).toEqual([]);
    server.setBlock(-5, 106, -5, BLOCK.lava); // single block change, ~2.6 m away
    await settle();
    expect((await hazardsOf(client)).hazards.map((x) => x.kind)).toEqual(['lava']);
    server.setBlocks(-1, -1, [
      { x: -5, y: 106, z: -5, id: BLOCK.air }, // lava gone
      { x: -8, y: 106, z: -8, id: BLOCK.fire }, // fire lit
    ]);
    await settle();
    expect((await hazardsOf(client)).hazards.map((x) => [x.kind, x.position])).toEqual([
      ['fire', { x: -7.5, y: 106.5, z: -7.5 }],
    ]);
  });

  it('finds holes to the void (only their edges are listed)', async () => {
    const holes = new Set<string>();
    for (let x = -10; x <= -8; x++) for (let z = -8; z <= -6; z++) holes.add(`${x},${z}`);
    const { client } = await start({ voidColumns: holes });
    await client.connect();
    const h = await hazardsOf(client);
    expect(h.voidNearby).toBe(true);
    expect(h.hazards.every((x) => x.kind === 'void')).toBe(true);
    expect(h.hazards).toHaveLength(8); // 3x3 hole: 8 edge columns, the centre is not listed
  });

  it('undecodable chunk data makes hazards unknown but keeps everything else', async () => {
    const { client } = await start({ corruptChunks: true }, { initialStateGraceMs: 500 });
    await client.connect();
    const s = await client.observe();
    expect(s.environmentHazards).toMatchObject({ known: false, reason: /block data unusable/ });
    expect(s.nearbyThreats.known).toBe(true); // chunks still "arrived" for entity purposes
    expect(s.player.position.known).toBe(true);
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
