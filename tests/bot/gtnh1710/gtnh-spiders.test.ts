import { afterEach, describe, expect, it } from 'vitest';
import { runSingleCycle, syncConfigToDatabase } from '../../../src/app/loop/agent-loop.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type MinecraftConfig } from '../../../src/config/env.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { MockPlannerProvider } from '../../../src/planner/mock-planner-provider.ts';
import { assessDangers, assessStateReliability } from '../../../src/safety/safety-policy.ts';
import type { SafetyContext } from '../../../src/safety/safety-policy.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { memoryRepos } from '../../fixtures/index.ts';
import { flatWorld, openSkyLight } from './chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
});

async function start(
  serverOptions: FakeServerOptions,
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: MinecraftConfig }> {
  const server = new FakeGtnhServer(serverOptions);
  servers.push(server);
  const port = await server.listen();
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
    },
  }).minecraft;
  const client = new Gtnh1710Client({ config, clock: systemClock, retryDelayMs: 50 });
  clients.push(client);
  await client.connect();
  return { server, client, config };
}

// The fake server spawns the player at (-4.5, 106, -7.5) on a grass floor (y 105), under an
// open sky; the spider stands on the grass 8 blocks east of it.
const SPIDER = { kind: 'mob' as const, entityId: 501, mobType: 52, x: 3.5, y: 106, z: -7.5 };
const settle = () => new Promise((r) => setTimeout(r, 150));
const ctx = (): SafetyContext => ({
  config: defaultConfig().safety,
  protectedItems: new Set<string>(),
  locations: new Map(),
  now: new Date(),
});

function spiderOf(s: GameState) {
  if (!s.nearbyEntities.known) throw new Error(`entities unknown: ${s.nearbyEntities.reason}`);
  return s.nearbyEntities.value.entities.find((e) => e.id === SPIDER.entityId);
}

describe('Gtnh1710Client: a spider in the light (end to end)', () => {
  it('in daylight on open ground it is listed calm and is no threat; at night it is', async () => {
    const world = flatWorld();
    const { server, client } = await start({
      dayTicks: 6000,
      light: openSkyLight(world),
      entities: [SPIDER],
    });
    await settle();
    const day = await client.observe();
    expect(day.time).toMatchObject({ known: true, value: { phase: 'day' } });
    expect(spiderOf(day)).toMatchObject({ type: 'minecraft:Spider', distance: 8, calm: true });
    expect(day.nearbyThreats).toMatchObject({
      known: true,
      value: { hostileCount: 0, nearestHostileDistance: null },
    });
    expect(assessStateReliability(day, ctx())).toEqual([]);
    expect(assessDangers(day, ctx())).toEqual([]);
    expect(client.world.lightLevelAt(3, 106, -8, new Date())).toBe(15);

    // A cycle of the agent's own: it pauses only because it has no task (no retreat).
    const repos = memoryRepos();
    const config = defaultConfig();
    syncConfigToDatabase(config, repos);
    const cycle = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: new MockPlannerProvider([]),
      clock: systemClock,
      newId: sequentialIds(),
    });
    expect(cycle.stateViolations).toEqual([]);
    expect(cycle.decision).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['NO_ACTIVE_TASK'],
    });

    // Night falls: in the dark it may pick the player, and it counts as a threat.
    server.setTime(18_000);
    await settle();
    const night = await client.observe();
    expect(spiderOf(night)?.calm).toBe(false);
    expect(night.nearbyThreats).toMatchObject({
      value: { hostileCount: 1, nearestHostileDistance: 8 },
    });
    expect(assessDangers(night, ctx()).map((v) => v.code)).toEqual(['HOSTILES_NEARBY']);
    // ...and stays one at sunrise: it may have the player as its target now.
    server.setTime(1000);
    await settle();
    expect(spiderOf(await client.observe())?.calm).toBe(false);
  });

  it('a thunderstorm darkens the open sky by day: the spider counts as a threat', async () => {
    const { server, client } = await start({
      dayTicks: 6000,
      light: openSkyLight(flatWorld()),
      entities: [SPIDER],
    });
    await settle();
    expect(spiderOf(await client.observe())?.calm).toBe(true);
    // WorldServer.updateWeather when the rain starts: 1, then the rain and thunder strengths.
    server.sendWeather(1, 0);
    server.sendWeather(7, 1);
    server.sendWeather(8, 1);
    await settle();
    const storm = await client.observe();
    expect(client.world.lightLevelAt(3, 106, -8, new Date())).toBe(10);
    expect(spiderOf(storm)?.calm).toBe(false);
    expect(storm.nearbyThreats).toMatchObject({ value: { hostileCount: 1 } });
  });

  it('where the chunk data carries no light (all 0: the fake default) no spider is calm', async () => {
    const { client } = await start({ dayTicks: 6000, entities: [SPIDER] });
    await settle();
    const s = await client.observe();
    expect(spiderOf(s)?.calm).toBe(false);
    expect(s.nearbyThreats).toMatchObject({ value: { hostileCount: 1 } });
  });
});
