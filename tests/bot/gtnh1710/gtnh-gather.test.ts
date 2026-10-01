import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runSingleCycle,
  syncConfigToDatabase,
  type CycleResult,
} from '../../../src/app/agent-loop.ts';
import { addTask } from '../../../src/app/task-commands.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { MockPlannerProvider } from '../../../src/planner/mock-planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './chunk-fixtures.ts';
import { FakeGtnhServer } from './fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105, in a terrain fence.
// Sand stands on the floor: two blocks within reach of the eyes, and one that is 5.1 blocks
// away, so the agent walks to the stand spot the client lists for it first.
const SAND = [
  { x: -5, y: 106, z: -10 },
  { x: -3, y: 106, z: -10 },
  { x: -8, y: 106, z: -12 },
];
const TERRAIN = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

let dir = '';
let server: FakeGtnhServer;
let client: Gtnh1710Client | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-gather-'));
});

afterEach(async () => {
  await client?.disconnect();
  client = null;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GATHER on the live client (fake server)', () => {
  it('one planner call, then the client digs, walks and picks up like any checked dig', async () => {
    server = new FakeGtnhServer({
      blocks: DIG_TEST_BLOCK_REGISTRY,
      blockOverrides: new Map(SAND.map((p) => [key(p), BLOCK.sand])),
    });
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await server.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: TERRAIN, stopFile: join(dir, 'STOP') },
        digging: { enabled: true },
      },
    });
    client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock, retryDelayMs: 50 });
    await client.connect();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    expect(
      addTask(repos, config, {
        taskId: 'gather-sand',
        goal: 'Gather 3 sand',
        plan: undefined,
        now: new Date(),
      }),
    ).toMatchObject({ ok: true });
    const planner = new MockPlannerProvider([
      {
        name: 'gather',
        when: {},
        response: {
          kind: 'plan',
          plan: {
            goal: 'Gather 3 sand',
            steps: [
              {
                step: 1,
                action: { type: 'GATHER', args: { block: 'minecraft:sand', count: 3 } },
                rationale: 'The sand in view gives the sand the task needs.',
              },
            ],
            requiresUserApproval: false,
            explanation: 'One GATHER step.',
            failureHandling: {
              onStepFailure: 'REPLAN',
              maxRetriesPerStep: 1,
              escalationMessage: 'Could not gather sand.',
            },
          },
        },
      },
    ]);
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner,
      clock: systemClock,
      newId: sequentialIds(),
    };

    const results: CycleResult[] = [];
    while (results.length < 8 && repos.plans.get(1)?.status !== 'completed') {
      results.push(await runSingleCycle(deps));
    }
    expect(results.map((r) => r.summary)).toEqual([
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    ]);
    expect(planner.requests).toHaveLength(1);
    expect(repos.plans.get(1)?.status).toBe('completed');
    // The walk went to the stand spot the client computed for the far block.
    expect(results[2]?.action?.reason).toMatch(/to dig \(-8, 106, -12\)/);
    expect(server.digSim.broken.map((b) => key(b))).toEqual(SAND.map(key));
    expect(server.digSim.pickedUp).toEqual([
      { item: 'minecraft:sand', count: 1 },
      { item: 'minecraft:sand', count: 1 },
      { item: 'minecraft:sand', count: 1 },
    ]);
    const after = await client.observe();
    expect(after.inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:sand': 3 } },
    });
    expect(repos.memory.journal('gather-sand').at(-2)?.text).toMatch(
      /^GATHER 3 minecraft:sand done; 3 dug, 3\/3 gathered, 4 action\(s\)/,
    );
  }, 45_000);

  it('a log walled in by leaves: the walk to its stand spot breaks through, then the dig', async () => {
    // Seen live 2026-10-01 (a Hot Forest): the logs stood behind one- and two-block-high leaf
    // bushes, no walk reached a stand spot, and the agent gave up on the forest. Here a
    // two-high wall of leaves crosses the fence at x = -3, with the log beyond it, out of reach.
    // Every leaf drops a sapling, which must not pass for the log's drop.
    const log = { x: -1, y: 106, z: -11 };
    const world = new Map<string, number>([[key(log), BLOCK.log]]);
    for (let z = TERRAIN.min.z; z <= TERRAIN.max.z; z++) {
      for (const y of [106, 107]) world.set(`-3,${y},${z}`, BLOCK.leaves);
    }
    server = new FakeGtnhServer({
      blocks: [...DIG_TEST_BLOCK_REGISTRY, [6, 'minecraft:sapling']],
      blockOverrides: world,
      dig: { drops: { 'minecraft:leaves': { item: 'minecraft:sapling', count: 1 } } },
    });
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await server.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: TERRAIN, stopFile: join(dir, 'STOP') },
        digging: { enabled: true },
      },
    });
    client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock, retryDelayMs: 50 });
    await client.connect();
    // The log gets a stand spot: one a walk reaches by breaking leaves.
    const seen = await client.observe();
    const listed = seen.nearbyBlocks.known
      ? seen.nearbyBlocks.value.resources.find((r) => key(r.position) === key(log))
      : undefined;
    expect(listed?.standAt?.x).toBeGreaterThan(-3);

    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    addTask(repos, config, {
      taskId: 'gather-log',
      goal: 'Gather 1 log',
      plan: undefined,
      now: new Date(),
    });
    const planner = new MockPlannerProvider([
      {
        name: 'gather',
        when: {},
        response: {
          kind: 'plan',
          plan: {
            goal: 'Gather 1 log',
            steps: [
              {
                step: 1,
                action: { type: 'GATHER', args: { block: 'minecraft:log', count: 1 } },
                rationale: 'The log in view.',
              },
            ],
            requiresUserApproval: false,
            explanation: 'One GATHER step.',
            failureHandling: {
              onStepFailure: 'REPLAN',
              maxRetriesPerStep: 1,
              escalationMessage: 'Could not gather the log.',
            },
          },
        },
      },
    ]);
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner,
      clock: systemClock,
      newId: sequentialIds(),
    };
    const results: CycleResult[] = [];
    while (results.length < 6 && repos.plans.get(1)?.status !== 'completed') {
      results.push(await runSingleCycle(deps));
    }
    expect(results.map((r) => r.summary)).toEqual([
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    ]);
    expect(repos.plans.get(1)?.status).toBe('completed');
    expect(results[0]?.outcome?.execution?.data).toMatchObject({
      broken: 2,
      drops: '2 x minecraft:sapling',
    });
    // The dig reports the log, not the saplings the walk picked up.
    expect(results[1]?.outcome?.execution?.data).toMatchObject({
      block: 'minecraft:log',
      dropCollected: true,
      drops: '1 x minecraft:log',
    });
    expect(server.digSim.broken.map((b) => b.name)).toEqual([
      'minecraft:leaves',
      'minecraft:leaves',
      'minecraft:log',
    ]);
    const after = await client.observe();
    expect(after.inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:log': 1, 'minecraft:sapling': 2 } },
    });
  }, 45_000);
});
