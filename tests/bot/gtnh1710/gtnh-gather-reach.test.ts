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
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeItem } from './fixtures/fake-server.ts';

// Seen live (2026-10-03): logs walled in by leaves, "no walk from here reaches a spot to dig
// one from", and the "Tools" quest stalled; the hotbar was full of sand, dirt, logs and
// saplings, so the old walker's leaf breaks (an empty hand only) were off. Here a two-log trunk
// stands in a ring of leaves three high and two deep, and the hotbar holds nine stacks of dirt.
// The stand spots come from the pathfinder's flood with MOVE_TO's own walk policy, so GATHER
// walks there breaking leaves (with a plain block in hand, which digs as a hand does) and fells
// the trunk.
const TRUNK = [
  { x: 2, y: 106, z: -8 },
  { x: 2, y: 107, z: -8 },
];
const FENCE = { min: { x: -9, y: 100, z: -12 }, max: { x: 8, y: 112, z: -4 } };
const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;

function ringOfLeaves(): Map<string, number> {
  const blocks = new Map<string, number>();
  for (let x = 0; x <= 4; x++) {
    for (let z = -10; z <= -6; z++) {
      for (let y = 106; y <= 108; y++) blocks.set(key({ x, y, z }), BLOCK.leaves);
    }
  }
  for (const t of TRUNK) blocks.set(key(t), BLOCK.log);
  return blocks;
}

/** Nine stacks of dirt fill the hotbar: no empty hand. */
const FULL_HOTBAR: FakeItem[] = Array.from({ length: 9 }, (_, i) => ({
  slot: 36 + i,
  id: BLOCK.dirt,
  count: 16,
  damage: 0,
}));

let dir = '';
let server: FakeGtnhServer;
let client: Gtnh1710Client | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-gather-reach-'));
});

afterEach(async () => {
  await client?.disconnect();
  client = null;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GATHER reaches logs walled in by leaves (fake server)', { timeout: 60_000 }, () => {
  it('the observation offers a stand spot behind the leaves; the walk breaks them, the dig fells the log', async () => {
    server = new FakeGtnhServer({
      blocks: DIG_TEST_BLOCK_REGISTRY,
      blockOverrides: ringOfLeaves(),
      inventory: FULL_HOTBAR,
    });
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await server.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: FENCE, stopFile: join(dir, 'STOP') },
        digging: { enabled: true },
      },
    });
    client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock, retryDelayMs: 50 });
    await client.connect();

    const state = await client.observe();
    if (!state.nearbyBlocks.known) throw new Error('blocks unknown');
    const base = state.nearbyBlocks.value.resources.find((r) => key(r.position) === key(TRUNK[0]!));
    expect(base?.standAt).toBeTruthy();

    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    expect(
      addTask(repos, config, {
        taskId: 'gather-log',
        goal: 'Gather 1 log',
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
              escalationMessage: 'Could not gather a log.',
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
    const summaries = results.map((r) => r.summary);
    expect(summaries).toContain('REQUEST_PLANNER -> MOVE_TO -> succeeded');
    expect(summaries.at(-1)).toBe('REQUEST_PLANNER -> DIG_BLOCK -> succeeded');
    expect(repos.plans.get(1)?.status).toBe('completed');
    // Leaves broken on the way, then the log.
    const broken = server.digSim.broken.map((b) => b.name);
    expect(broken.filter((n) => n === 'minecraft:leaves').length).toBeGreaterThanOrEqual(2);
    expect(broken.at(-1)).toBe('minecraft:log');
    const after = await client.observe();
    expect(after.inventory.known && after.inventory.value.items['minecraft:log']).toBe(1);
    expect(server.moveSim.corrections).toEqual([]);
  });
});
