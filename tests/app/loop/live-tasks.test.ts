import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSingleCycle, type CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { runMockScenario } from '../../../src/app/mock/mock-agent.ts';
import { findScenario } from '../../../src/app/mock/scenarios.ts';
import { addTask, completeTask, listTasks } from '../../../src/app/commands/task-commands.ts';
import {
  checkLimits,
  DEFAULT_SESSION_LIMITS,
  runSession,
  type SessionLimits,
} from '../../../src/app/loop/live-session.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { MockPlannerProvider } from '../../../src/planner/mock-planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK } from '../../bot/gtnh1710/chunk-fixtures.ts';
import type { FakeStack } from '../../bot/gtnh1710/fake-chests.ts';
import {
  FakeGtnhServer,
  gtBlockEventsMessage,
  gtTileEntityMessage,
  spawnFrame,
} from '../../bot/gtnh1710/fake-server.ts';

// The fake world: a grass floor at y=105, the player at (-4.5, 106, -7.5), a chest at
// (-5, 106, -6) with 128 cobblestone, a walking fence around both.
const CHEST = { x: -5, y: 106, z: -6 };
const COBBLE = 4;
const fetchPlan = (overrides: Record<string, unknown> = {}) => ({
  goal: 'Fetch 10 cobblestone from the test chest',
  steps: [
    {
      step: 1,
      action: { type: 'MOVE_TO', args: { target: { x: -4.5, y: 106, z: -6.5 }, tolerance: 0.5 } },
      rationale: 'Stand next to the chest.',
    },
    {
      step: 2,
      action: { type: 'OPEN_CONTAINER', args: { containerId: 'chest.test' } },
      rationale: 'Look inside.',
    },
    {
      step: 3,
      action: {
        type: 'WITHDRAW_ITEM',
        args: { containerId: 'chest.test', item: 'minecraft:cobblestone', quantity: 10 },
      },
      rationale: 'Take exactly 10.',
    },
  ],
  requiresUserApproval: false,
  explanation: 'Operator plan for the test world.',
  failureHandling: {
    onStepFailure: 'PAUSE_AND_ASK_USER',
    maxRetriesPerStep: 1,
    escalationMessage: 'Could not fetch cobblestone.',
  },
  ...overrides,
});

let dir = '';
let server: FakeGtnhServer;
let config: AgentConfig;
let repos: Repositories;
let newId = sequentialIds();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-task-'));
  server = new FakeGtnhServer({
    items: [
      [COBBLE, 'minecraft:cobblestone'],
      [264, 'minecraft:diamond'],
      [297, 'minecraft:bread'],
      [263, 'minecraft:coal'],
      [7495, 'gregtech:gt.metaitem.01'],
      [9001, 'BuildCraft|Core:engineBlock'],
      [9002, 'Natura:N Crops'],
    ],
    chests: [
      {
        ...CHEST,
        size: 27,
        items: [
          { slot: 0, id: COBBLE, count: 64, damage: 0 },
          { slot: 1, id: COBBLE, count: 64, damage: 0 },
          { slot: 2, id: 264, count: 3, damage: 0 },
        ],
      },
    ],
    blockOverrides: new Map([[`${CHEST.x},${CHEST.y},${CHEST.z}`, BLOCK.chest]]),
  });
  config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await server.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: {
        enabled: true,
        fence: { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 106, z: -4 } },
        stopFile: join(dir, 'STOP'),
      },
      containers: {
        enabled: true,
        chests: { 'chest.test': { name: 'Test chest', position: CHEST } },
      },
    },
    safety: { protectedItems: ['minecraft:diamond'] },
  });
  repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
  newId = sequentialIds();
  syncConfigToDatabase(config, repos);
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One `once --live`: a fresh connection, one cycle, disconnect. */
async function liveCycle(): Promise<CycleResult> {
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
  });
  await client.connect();
  try {
    return await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: new MockPlannerProvider([]),
      clock: systemClock,
      newId,
    });
  } finally {
    await client.disconnect();
  }
}

const total = (stacks: Array<FakeStack | null>, id: number): number =>
  stacks.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);

describe('live tasks', () => {
  it('runs an operator plan one step per cycle, across connections, and completes the task', async () => {
    expect(
      addTask(repos, config, {
        taskId: 'fetch-cobble',
        goal: 'Fetch 10 cobblestone',
        plan: fetchPlan(),
        now: new Date(),
      }),
    ).toMatchObject({ ok: true, value: { current: true, plan: { status: 'active' } } });

    const summaries: string[] = [];
    for (let i = 0; i < 4; i++) summaries.push((await liveCycle()).summary);
    expect(summaries).toEqual([
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      'REQUEST_PLANNER -> OPEN_CONTAINER -> succeeded',
      // The chest is closed again in this cycle's connection: its contents come from memory.
      'REQUEST_PLANNER -> WITHDRAW_ITEM -> succeeded',
      'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused',
    ]);
    expect(repos.tasks.get('fetch-cobble')?.status).toBe('completed');
    expect(total(server.chestSim.chestContents(CHEST.x, CHEST.y, CHEST.z), COBBLE)).toBe(118);
    expect(total(server.chestSim.playerSlots(), COBBLE)).toBe(10);
    expect(server.chestSim.dropped).toEqual([]);
  }, 15_000);

  it('refuses a plan that breaks a safety rule, and stores nothing', () => {
    const bad = fetchPlan({
      steps: [
        {
          step: 1,
          action: {
            type: 'WITHDRAW_ITEM',
            args: { containerId: 'chest.test', item: 'minecraft:diamond', quantity: 1 },
          },
          rationale: 'Take a diamond.',
        },
      ],
    });
    const r = addTask(repos, config, {
      taskId: 't1',
      goal: 'diamonds',
      plan: bad,
      now: new Date(),
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/step 1: PROTECTED_ITEM/);
    expect(repos.tasks.get('t1')).toBeNull();
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBeNull();
  });

  it('remembered chest contents expire', async () => {
    addTask(repos, config, { taskId: 'fetch', goal: 'Fetch', plan: fetchPlan(), now: new Date() });
    await liveCycle(); // move
    await liveCycle(); // open: remembers the contents
    config = { ...config, memory: { containerContentsMaxAgeMs: 0 } };
    await new Promise((r) => setTimeout(r, 20));
    const r = await liveCycle();
    expect(r.summary).toBe(
      'REQUEST_PLANNER -> WITHDRAW_ITEM -> rejected [preconditions: contents of chest.test are unknown]',
    );
    expect(total(server.chestSim.playerSlots(), COBBLE)).toBe(0);
  });

  it('a finished task is not picked up again; mock runs never see the live task', async () => {
    addTask(repos, config, { taskId: 'fetch', goal: 'Fetch', plan: fetchPlan(), now: new Date() });
    expect(listTasks(repos)).toMatchObject({ ok: true, value: { currentTask: 'fetch' } });

    const scenario = findScenario('no-task');
    if (scenario === undefined) throw new Error('no scenario');
    const mock = await runMockScenario(scenario, { db: openDatabase(IN_MEMORY) });
    expect(mock.result.decision?.reasonCodes).toEqual(['NO_ACTIVE_TASK']);

    expect(completeTask(repos, 'fetch')).toMatchObject({
      ok: true,
      value: { status: 'completed' },
    });
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBeNull();
    expect(repos.plans.latestForTask('fetch')?.status).toBe('rejected');
    expect((await liveCycle()).decision?.reasonCodes).toEqual(['NO_ACTIVE_TASK']);
  });
});

describe('bounded auto-run', () => {
  async function session(
    limits: Partial<SessionLimits> = {},
    stop: () => string | null = () => null,
  ) {
    const client = new Gtnh1710Client({
      config: config.minecraft,
      clock: systemClock,
      retryDelayMs: 50,
    });
    await client.connect();
    try {
      return await runSession(
        {
          config,
          client,
          repos,
          decisionProvider: new DeterministicDecisionProvider(),
          planner: new MockPlannerProvider([]),
          clock: systemClock,
          newId,
        },
        { ...DEFAULT_SESSION_LIMITS, pauseMs: 50, ...limits },
        { stopRequested: stop },
      );
    } finally {
      await client.disconnect();
    }
  }

  it('finishes the task on one connection and stops there', async () => {
    addTask(repos, config, { taskId: 'fetch', goal: 'Fetch', plan: fetchPlan(), now: new Date() });
    const logins = server.logins;
    const run = await session();
    expect(run.cycles.map((c) => c.summary)).toEqual([
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      'REQUEST_PLANNER -> OPEN_CONTAINER -> succeeded',
      'REQUEST_PLANNER -> WITHDRAW_ITEM -> succeeded',
    ]);
    expect(run).toMatchObject({ stopReason: 'the task is completed', taskStatus: 'completed' });
    expect(server.logins - logins).toBe(1);
    expect(total(server.chestSim.playerSlots(), COBBLE)).toBe(10);
    expect(server.chestSim.dropped).toEqual([]);
  });

  it('stops at the first cycle that does not succeed', async () => {
    const tooMany = fetchPlan({
      steps: [
        {
          step: 1,
          action: {
            type: 'WITHDRAW_ITEM',
            args: { containerId: 'chest.test', item: 'minecraft:cobblestone', quantity: 500 },
          },
          rationale: 'More than there is.',
        },
      ],
    });
    addTask(repos, config, { taskId: 'greedy', goal: 'Too many', plan: tooMany, now: new Date() });
    const run = await session();
    expect(run.cycles).toHaveLength(1);
    expect(run.stopReason).toMatch(/^stopped after: REQUEST_PLANNER -> WITHDRAW_ITEM -> rejected/);
    expect(run.taskStatus).toBe('blocked');
  });

  it('stops after a non-task decision, at the cycle limit, when asked, or without a task', async () => {
    expect((await session()).stopReason).toBe('there is no current task (cli task-add)');

    addTask(repos, config, { taskId: 'fetch', goal: 'Fetch', plan: fetchPlan(), now: new Date() });
    expect(await session({}, () => 'the stop file exists')).toMatchObject({
      cycles: [],
      stopReason: 'the stop file exists',
    });
    const limited = await session({ maxCycles: 1 });
    expect(limited.cycles).toHaveLength(1);
    expect(limited.stopReason).toBe('reached the limit of 1 cycles');
    expect(() => checkLimits({ maxCycles: 0, maxMinutes: 5, pauseMs: 0 })).not.toThrow();
    expect(checkLimits({ maxCycles: 0, maxMinutes: 5, pauseMs: 0 })).toBe(
      'max cycles must be 1-200',
    );
  });
});

describe('bounded auto-run and safety', () => {
  it('stops after a safety response (a retreat) instead of carrying on with the task', async () => {
    config = {
      ...config,
      locations: {
        home: {
          dimension: 'overworld',
          position: { x: -0.5, y: 106, z: -4.5 },
          kind: 'safe',
          note: null,
        },
      },
    };
    syncConfigToDatabase(config, repos);
    addTask(repos, config, { taskId: 'fetch', goal: 'Fetch', plan: fetchPlan(), now: new Date() });
    const client = new Gtnh1710Client({
      config: config.minecraft,
      clock: systemClock,
      retryDelayMs: 50,
    });
    await client.connect();
    try {
      server.broadcast(
        spawnFrame({ kind: 'mob', entityId: 900, mobType: 54, x: -6, y: 106, z: -9 }),
      );
      await vi.waitFor(() => expect(client.world.nearbyEntities(16)).toHaveLength(1));
      const run = await runSession(
        {
          config,
          client,
          repos,
          decisionProvider: new DeterministicDecisionProvider(),
          planner: new MockPlannerProvider([]),
          clock: systemClock,
          newId,
        },
        { ...DEFAULT_SESSION_LIMITS, pauseMs: 50 },
        { stopRequested: () => null },
      );
      expect(run.cycles.map((c) => c.summary)).toEqual([
        'RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> succeeded',
      ]);
      expect(run.stopReason).toMatch(/RETREAT_HOME -> RETURN_TO_SAFE_LOCATION -> succeeded$/);
      // The task itself did not move on.
      expect(repos.plans.openForTask('fetch')?.nextStep).toBe(0);
    } finally {
      await client.disconnect();
    }
  });
});

describe('tasks that depend on machines', () => {
  const MACHINE = { x: -3, y: 106, z: -7 };
  const IDLE = 64;
  const BUSY = 64 | 8;
  const OFF = 0;

  async function withMachine(common: number, run: (client: Gtnh1710Client) => Promise<void>) {
    config = { ...config, routing: { ...config.routing, machineWaitMs: 100 } };
    addTask(repos, config, {
      taskId: 'after-macerator',
      goal: 'Fetch cobblestone once the macerator is done',
      plan: fetchPlan(),
      now: new Date(),
      machines: [`gt:${MACHINE.x}.${MACHINE.y}.${MACHINE.z}`],
    });
    const client = new Gtnh1710Client({
      config: config.minecraft,
      clock: systemClock,
      retryDelayMs: 50,
    });
    await client.connect();
    try {
      server.sendGregTech(gtTileEntityMessage(MACHINE.x, MACHINE.y, MACHINE.z, 301, common));
      await vi.waitFor(async () => expect((await client.observe()).machines).toHaveLength(1));
      await run(client);
    } finally {
      await client.disconnect();
    }
  }

  const deps = (client: Gtnh1710Client) => ({
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner: new MockPlannerProvider([]),
    clock: systemClock,
    newId,
  });

  it('waits while a required machine is busy, then carries on with the plan', async () => {
    await withMachine(BUSY, async (client) => {
      const run = await runSession(
        deps(client),
        { ...DEFAULT_SESSION_LIMITS, pauseMs: 50 },
        {
          stopRequested: () => null,
          onCycle: (_r, i) => {
            // The recipe finishes after two waits.
            if (i === 2) {
              server.sendGregTech(
                gtBlockEventsMessage(0, [{ ...MACHINE, eventId: 0, value: IDLE }]),
              );
            }
          },
        },
      );
      const summaries = run.cycles.map((c) => c.summary);
      expect(summaries.slice(0, 2)).toEqual([
        'WAIT_FOR_MACHINE -> WAIT -> succeeded',
        'WAIT_FOR_MACHINE -> WAIT -> succeeded',
      ]);
      expect(summaries.slice(-3)).toEqual([
        'REQUEST_PLANNER -> MOVE_TO -> succeeded',
        'REQUEST_PLANNER -> OPEN_CONTAINER -> succeeded',
        'REQUEST_PLANNER -> WITHDRAW_ITEM -> succeeded',
      ]);
      expect(run.stopReason).toBe('the task is completed');
    });
  });

  it('pauses (and the run stops) when a required machine is switched off', async () => {
    await withMachine(OFF, async (client) => {
      const run = await runSession(
        deps(client),
        { ...DEFAULT_SESSION_LIMITS, pauseMs: 50 },
        {
          stopRequested: () => null,
        },
      );
      expect(run.cycles.map((c) => c.summary)).toEqual([
        'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused',
      ]);
      expect(repos.tasks.get('after-macerator')?.status).toBe('paused');
      expect(repos.plans.openForTask('after-macerator')?.nextStep).toBe(0);
    });
  });
});
