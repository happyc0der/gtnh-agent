import { describe, expect, it } from 'vitest';
import { runSingleCycle, syncConfigToDatabase } from '../../src/app/agent-loop.ts';
import { runMockScenario } from '../../src/app/mock-agent.ts';
import { findScenario, SCENARIOS, type Scenario } from '../../src/app/scenarios.ts';
import type { MockMinecraftClient } from '../../src/bot/mock-minecraft-client.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { MockPlannerProvider } from '../../src/planner/mock-planner-provider.ts';
import type { DecisionProvider } from '../../src/system1/decision-provider.ts';
import { MockDecisionProvider } from '../../src/system1/mock-decision-provider.ts';
import type { ManualClock } from '../../src/util/clock.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { makeWorld, memoryRepos, T0, testClock, testConfig } from '../fixtures/index.ts';

const scenario = (name: string): Scenario => {
  const s = findScenario(name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
};

describe('single agent cycle over every mock scenario', () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, s) => {
    const { result, db } = await runMockScenario(s, { clock: testClock(), newId: sequentialIds() });
    db.close();
    expect(result.decision?.decision).toBe(s.expect.decision);
    expect(result.action?.type).toBe(s.expect.actionType);
    expect(result.status).toBe(s.expect.status);
  });
});

describe('agent loop behaviour', () => {
  it('logs every stage of the cycle in order', async () => {
    const { result, repos, db } = await runMockScenario(scenario('nominal'), {
      clock: testClock(),
      newId: sequentialIds(),
    });
    expect(repos.events.forCycle(result.cycleId).map((e) => e.kind)).toEqual([
      'CYCLE_START',
      'STATE',
      'DECISION',
      'PROPOSAL',
      'VALIDATION',
      'EXECUTION',
      'VERIFICATION',
      'CYCLE_END',
    ]);
    expect(result.stateSnapshotId).not.toBeNull();
    expect(repos.snapshots.count()).toBe(1);
    expect(repos.checkpoints.list('task-nominal').map((c) => c.label)).toEqual([
      'INSPECT_MACHINE:succeeded',
    ]);
    db.close();
  });

  it('performs exactly one action per cycle', async () => {
    const { client, db } = await runMockScenario(scenario('needs-planner'), { clock: testClock() });
    expect(client.performed).toHaveLength(1);
    db.close();
  });

  it('escalates after two failures of the same action for the same task, then stays halted', async () => {
    const db = openDatabase(IN_MEMORY);
    const clock = testClock();
    const newId = sequentialIds();
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { result } = await runMockScenario(scenario('action-fails'), { db, clock, newId });
      statuses.push(result.summary);
      clock.advance(1000);
    }
    expect(statuses).toEqual([
      'EXECUTE_KNOWN_SAFE_STEP -> INSPECT_MACHINE -> failed',
      'EXECUTE_KNOWN_SAFE_STEP -> INSPECT_MACHINE -> failed',
      'EXECUTE_KNOWN_SAFE_STEP -> INSPECT_MACHINE -> rejected [REPEATED_FAILURE]',
      'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused',
    ]);
    db.close();
  });

  it('a rejected action blocks the task and asks for attention', async () => {
    const { result, repos, db } = await runMockScenario(scenario('protected-item-step'), {
      clock: testClock(),
    });
    expect(result.needsUserAttention).toBe(true);
    expect(repos.tasks.get('task-protected-item-step')?.status).toBe('blocked');
    db.close();
  });

  it('unreliable state forces a pause even if the decision provider says otherwise', async () => {
    const clock = testClock();
    const { client } = makeWorld((w) => void (w.unobservable = ['threats']), clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = testConfig();
    syncConfigToDatabase(config, repos);
    const provider = MockDecisionProvider.always('EXECUTE_KNOWN_SAFE_STEP');

    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: provider,
      planner: null,
      clock,
      newId: sequentialIds(),
    });
    expect(provider.calls).toHaveLength(0);
    expect(result.decision?.provider).toBe('hard-safety');
    expect(result.action?.type).toBe('PAUSE_AND_ASK_USER');
    expect(result.stateViolations.map((v) => v.code)).toEqual(['STATE_UNKNOWN']);
    expect(repos.violations.recent(5).map((v) => v.code)).toContain('STATE_UNKNOWN');
  });

  it('a schema-invalid observation is an error, and nothing is executed', async () => {
    const clock = testClock();
    const { client } = makeWorld(undefined, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const result = await runSingleCycle(
      {
        config: testConfig(),
        client,
        repos,
        decisionProvider: MockDecisionProvider.always('EAT'),
        planner: new MockPlannerProvider(),
        clock,
        newId: sequentialIds(),
      },
      { state: { schemaVersion: 1, player: 'teleported' } },
    );
    expect(result.status).toBe('error');
    expect(result.needsUserAttention).toBe(true);
    expect(client.performed).toHaveLength(0);
  });

  it('the planner path records the plan as a checkpoint and tags the action origin', async () => {
    const { result, repos, db } = await runMockScenario(scenario('needs-planner'), {
      clock: testClock(),
    });
    expect(result.planner).toEqual({
      kind: 'plan-accepted',
      planId: 1,
      goal: 'Fetch cobblestone for the next step',
      steps: 2,
    });
    expect(result.action?.origin).toBe('planner');
    expect(repos.checkpoints.list('task-needs-planner').map((c) => c.label)).toEqual([
      'plan',
      'WITHDRAW_ITEM:succeeded',
    ]);
    expect(repos.plans.get(1)).toMatchObject({ status: 'active', nextStep: 1 });
    db.close();
  });

  it('an unsafe plan is rejected before execution and recorded as a violation', async () => {
    const { result, repos, client, db } = await runMockScenario(scenario('planner-unsafe-plan'), {
      clock: testClock(),
    });
    expect(result.planner).toMatchObject({ kind: 'plan-rejected' });
    expect(repos.violations.recent(10).map((v) => v.code)).toEqual(
      expect.arrayContaining(['PLAN_INVALID', 'PROTECTED_ITEM']),
    );
    expect(client.performed.map((p) => p.action.type)).toEqual(['PAUSE_AND_ASK_USER']);
    db.close();
  });
});

describe('a slow decision provider (a model) never acts on a stale observation', () => {
  /** Decides EXECUTE_KNOWN_SAFE_STEP after "thinking" for `ms` (and optionally changing the world). */
  function slowProvider(
    clock: ManualClock,
    ms: number,
    meanwhile: () => void = () => undefined,
  ): DecisionProvider {
    return {
      name: 'slow-model',
      decide: () => {
        clock.advance(ms);
        meanwhile();
        return Promise.resolve({
          decision: 'EXECUTE_KNOWN_SAFE_STEP',
          confidence: 0.9,
          reasonCodes: ['KNOWN_SAFE_STEP'],
          factsUsed: {},
          requiresHumanConfirmation: false,
          provider: 'slow-model',
        });
      },
    };
  }

  async function run(
    provider: (clock: ManualClock, client: MockMinecraftClient) => DecisionProvider,
  ) {
    const clock = testClock();
    const { client } = makeWorld(undefined, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = testConfig();
    syncConfigToDatabase(config, repos);
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: provider(clock, client),
      planner: null,
      clock,
      newId: sequentialIds(),
    });
    return { result, client, repos, config };
  }

  it('observes again when the state went stale while deciding, then acts on the new state', async () => {
    const { result, client, repos } = await run((clock) =>
      slowProvider(clock, testConfig().safety.maxStateAgeMs + 1_000),
    );
    const states = repos.events
      .forCycle(result.cycleId)
      .filter((e) => e.kind === 'STATE')
      .map((e) => e.payload as Record<string, unknown>);
    expect(states).toHaveLength(2);
    expect(states[1]).toMatchObject({ reobserved: true, previousObservedAt: T0 });
    expect(repos.snapshots.count()).toBe(2);
    expect(result.status).toBe('succeeded');
    expect(client.performed.map((p) => p.action.type)).toEqual(['INSPECT_MACHINE']);
  });

  it('a decision that is quick enough keeps the original observation', async () => {
    const { result, repos } = await run((clock) => slowProvider(clock, 1_000));
    expect(repos.events.forCycle(result.cycleId).filter((e) => e.kind === 'STATE')).toHaveLength(1);
    expect(result.status).toBe('succeeded');
  });

  it('danger that appeared while deciding stops the stale decision before it runs', async () => {
    const { result, client } = await run((clock, c) =>
      slowProvider(clock, testConfig().safety.maxStateAgeMs + 1_000, () => {
        c.world.hostiles.push({ x: 3, y: 64, z: 1 });
      }),
    );
    expect(result.status).toBe('rejected');
    expect(result.outcome?.validation.violations.map((v) => v.code)).toEqual([
      'ACTION_NOT_ALLOWED_IN_DANGER',
    ]);
    expect(result.needsUserAttention).toBe(true);
    expect(client.performed).toHaveLength(0);
  });
});
