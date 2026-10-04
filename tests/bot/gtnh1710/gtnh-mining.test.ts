import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSingleCycle, type CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { addTask } from '../../../src/app/commands/task-commands.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { MockPlannerProvider } from '../../../src/planner/mock-planner-provider.ts';
import type { PlannerResponse } from '../../../src/planner/plan-schema.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { tinkersPickaxeNbt } from './fixtures/fake-digging.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// GATHER of stone and of GT ores on the live client against the fake server: the agent loop
// plans once, then each dig is chosen in code, checked by the safety policy (a pickaxe that
// harvests the block), done by the client with the tool it picks, and verified.

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105, in a terrain fence.
// Two blocks are within reach of the eyes; the third, 5.1 blocks away, needs a walk first.
const SPOTS = [
  { x: -5, y: 106, z: -10 },
  { x: -3, y: 106, z: -10 },
  { x: -8, y: 106, z: -12 },
] as const;
const TERRAIN = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

// Item and block ids as in gtnh-digging.test.ts.
const ID = {
  bread: 297,
  woodenPickaxe: 270,
  tinkersPickaxe: 6100,
  /** gregtech:gt.metaitem.03: raw ores are its damage values (5000 + the material). */
  rawOre: 7496,
  /** gregtech:gt.blockores. */
  gtOres: 1500,
} as const;
const ITEMS: Array<[number, string]> = [
  [ID.bread, 'minecraft:bread'],
  [ID.woodenPickaxe, 'minecraft:wooden_pickaxe'],
  [ID.tinkersPickaxe, 'TConstruct:pickaxe'],
  [ID.rawOre, 'gregtech:gt.metaitem.03'],
];
const BLOCKS: Array<[number, string]> = [
  ...DIG_TEST_BLOCK_REGISTRY,
  [BLOCK.cobblestone, 'minecraft:cobblestone'],
  [ID.gtOres, 'gregtech:gt.blockores'],
];
const RAW_IRON = 'gregtech:gt.metaitem.03@5032';

let dir = '';
let server: FakeGtnhServer;
let client: Gtnh1710Client | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-mining-'));
});

afterEach(async () => {
  await client?.disconnect();
  client = null;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The fake server as `options` make it, the live client, and the loop with one plan. */
async function gathering(options: FakeServerOptions, taskId: string, plan: PlannerResponse) {
  server = new FakeGtnhServer({ blocks: BLOCKS, items: ITEMS, ...options });
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
    addTask(repos, config, { taskId, goal: 'Mine', plan: undefined, now: new Date() }),
  ).toMatchObject({ ok: true });
  const planner = new MockPlannerProvider([{ name: 'mine', when: {}, response: plan }]);
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
  while (results.length < 8 && repos.plans.get(1)?.status === undefined) {
    results.push(await runSingleCycle(deps));
  }
  while (results.length < 8 && repos.plans.get(1)?.status === 'active') {
    results.push(await runSingleCycle(deps));
  }
  return { client, repos, planner, results };
}

const gatherPlan = (args: Record<string, unknown>): PlannerResponse =>
  ({
    kind: 'plan',
    plan: {
      goal: 'Mine',
      steps: [{ step: 1, action: { type: 'GATHER', args }, rationale: 'The route says so.' }],
      requiresUserApproval: false,
      explanation: 'One GATHER step.',
      failureHandling: {
        onStepFailure: 'REPLAN',
        maxRetriesPerStep: 1,
        escalationMessage: 'Could not mine.',
      },
    },
  }) as PlannerResponse;

describe('GATHER mining on the live client (fake server)', () => {
  it('3 cobblestone from stone: the client holds the wooden pickaxe for each dig', async () => {
    const { client, repos, planner, results } = await gathering(
      {
        blockOverrides: new Map(SPOTS.map((p) => [key(p), BLOCK.stone])),
        inventory: [{ slot: 36, id: ID.woodenPickaxe, count: 1, damage: 0 }],
      },
      'mine-stone',
      gatherPlan({ block: 'minecraft:stone', count: 3 }),
    );
    expect(results.map((r) => r.summary)).toEqual([
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    ]);
    expect(planner.requests).toHaveLength(1);
    expect(repos.plans.get(1)?.status).toBe('completed');
    // Each stone was harvested with the pickaxe (the server drops cobblestone only then).
    expect(server.digSim.broken.map((b) => [key(b), b.held])).toEqual([
      [key(SPOTS[0]), 'minecraft:wooden_pickaxe@0'],
      [key(SPOTS[1]), 'minecraft:wooden_pickaxe@1'],
      [key(SPOTS[2]), 'minecraft:wooden_pickaxe@2'],
    ]);
    expect((await client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:cobblestone': 3, 'minecraft:wooden_pickaxe@3': 1 } },
    });
    expect(repos.memory.journal('mine-stone').at(-2)?.text).toMatch(
      /^GATHER 3 minecraft:stone done; 3 dug, 3\/3 gathered, 4 action\(s\)/,
    );
  }, 45_000);

  it("2 raw iron ore from GT ores with a Tinkers' pickaxe; the ore above its level is refused", async () => {
    // Iron ores (metadata 2) at the first and third spots, an ore of level 3 between them.
    const { repos, planner, results } = await gathering(
      {
        blockOverrides: new Map(SPOTS.map((p) => [key(p), ID.gtOres])),
        blockMeta: new Map([
          [key(SPOTS[0]), 2],
          [key(SPOTS[1]), 3],
          [key(SPOTS[2]), 2],
        ]),
        inventory: [
          {
            slot: 36,
            id: ID.tinkersPickaxe,
            count: 1,
            damage: 0,
            nbt: true,
            nbtData: tinkersPickaxeNbt({
              harvestLevel: 2,
              miningSpeed: 500,
              totalDurability: 135,
            }),
          },
        ],
        dig: {
          dropsAt: {
            [key(SPOTS[0])]: { item: RAW_IRON, count: 1 },
            [key(SPOTS[2])]: { item: RAW_IRON, count: 1 },
          },
        },
      },
      'mine-iron',
      gatherPlan({ block: 'gregtech:gt.blockores', item: RAW_IRON, count: 2 }),
    );
    // The third ore is within reach from where the first one's pickup left the player (the
    // second was never dug, so there was no walk to pick up its drop).
    expect(results.map((r) => r.summary)).toEqual([
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
      'REQUEST_PLANNER -> DIG_BLOCK -> failed',
      'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    ]);
    // The client refused the level-3 ore before sending anything; the step passed it over.
    expect(results[1]?.action?.args).toEqual({ position: SPOTS[1] });
    expect(results[1]?.outcome?.execution?.message).toMatch(
      /no carried tool harvests gregtech:gt.blockores: it needs a pickaxe of level 3 or more/,
    );
    expect(server.digSim.digs.map((d) => key(d))).not.toContain(key(SPOTS[1]));
    expect(planner.requests).toHaveLength(1);
    expect(repos.plans.get(1)?.status).toBe('completed');
    expect(server.digSim.broken.map((b) => key(b))).toEqual([key(SPOTS[0]), key(SPOTS[2])]);
    expect(server.digSim.pickedUp).toEqual([
      { item: RAW_IRON, count: 1 },
      { item: RAW_IRON, count: 1 },
    ]);
    expect(repos.memory.journal('mine-iron').at(-2)?.text).toMatch(
      new RegExp(
        `^GATHER 2 gregtech:gt\\.blockores for ${RAW_IRON.replace(/[.@]/g, '\\$&')} done; 2 dug, 2/2 gathered, 3 action`,
      ),
    );
  }, 45_000);
});
