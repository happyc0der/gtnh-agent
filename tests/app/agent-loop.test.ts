import { describe, expect, it } from 'vitest';
import { runSingleCycle, syncConfigToDatabase } from '../../src/app/agent-loop.ts';
import { runMockScenario } from '../../src/app/mock-agent.ts';
import { findScenario, MOCK_CONFIG, SCENARIOS, type Scenario } from '../../src/app/scenarios.ts';
import type { MockMinecraftClient } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig } from '../../src/config/env.ts';
import type { SeenChunk } from '../../src/domain/world-memory.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { MockPlannerProvider } from '../../src/planner/mock-planner-provider.ts';
import type { PlannerRequest, PlannerResponse } from '../../src/planner/plan-schema.ts';
import type { PlannerProvider } from '../../src/planner/planner-provider.ts';
import type { DecisionProvider } from '../../src/system1/decision-provider.ts';
import { MockDecisionProvider } from '../../src/system1/mock-decision-provider.ts';
import type { ManualClock } from '../../src/util/clock.ts';
import { actionFingerprint } from '../../src/safety/safety-policy.ts';
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

describe('world memory and exploring', () => {
  const sighting: SeenChunk = {
    dimension: 'overworld',
    chunkX: 0,
    chunkZ: 4,
    biome: { id: 229, name: 'Hot Forest', share: 1 },
    counts: { log: 12 },
    examples: { log: [{ x: 3, y: 64, z: 70 }] },
    seenAt: T0,
  };
  const planNeeded: DecisionProvider = {
    name: 'test',
    decide: () =>
      Promise.resolve({
        decision: 'REQUEST_PLANNER',
        confidence: 1,
        reasonCodes: ['NO_KNOWN_STEP'],
        factsUsed: {},
        requiresHumanConfirmation: false,
        provider: 'test',
      }),
  };
  const explorePlan = {
    kind: 'plan',
    plan: {
      goal: 'Find wood',
      steps: [
        {
          step: 1,
          action: { type: 'EXPLORE', args: { toward: { x: 3, z: 70 }, maxDistance: 96 } },
          rationale: 'logs were seen there',
        },
      ],
      requiresUserApproval: false,
      explanation: 'The forest to the south has logs.',
      failureHandling: { onStepFailure: 'REPLAN', maxRetriesPerStep: 1, escalationMessage: 'x' },
    },
  };

  async function cycle(movement: { enabled: boolean; mode: 'fixed' | 'follow' }) {
    const clock = testClock();
    const { client } = makeWorld(undefined, clock);
    await client.connect();
    const pending = [sighting];
    const seeing = Object.assign(client, { takeSeenChunks: () => pending.splice(0) });
    const repos = memoryRepos(clock);
    const config = defaultConfig({ ...MOCK_CONFIG, minecraft: { movement } });
    syncConfigToDatabase(config, repos);
    const planner = new MockPlannerProvider([{ name: 'explore', when: {}, response: explorePlan }]);
    const result = await runSingleCycle({
      config,
      client: seeing,
      repos,
      decisionProvider: planNeeded,
      planner,
      clock,
      newId: sequentialIds(),
    });
    return { result, repos, planner, client };
  }

  it('stores what the client saw, and offers EXPLORE with it when the play area follows', async () => {
    const { result, repos, planner, client } = await cycle({ enabled: true, mode: 'follow' });
    expect(repos.worldMemory.get('overworld', 0, 4)).toEqual(sighting);
    const request = planner.requests[0];
    expect(request?.allowedActions).toContain('EXPLORE');
    expect(request?.exploration?.chunksSeen).toBe(1);
    expect(request?.exploration?.places[0]).toMatchObject({ resource: 'log', x: 3, z: 70 });
    // The plan's EXPLORE ran (the mock walks straight toward the point) and was verified.
    expect(result.status).toBe('succeeded');
    expect(client.world.player.position.z).toBeGreaterThan(60);
  });

  it('asks the planner once more when it escalates for want of a place while exploring is open', async () => {
    const clock = testClock();
    // Gravel: nothing in view gives it, so the route says to explore.
    const { client } = makeWorld((w) => {
      if (w.task !== null) w.task.requirements = { 'minecraft:gravel': 8 };
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = defaultConfig({
      ...MOCK_CONFIG,
      minecraft: { movement: { enabled: true, mode: 'follow' } },
    });
    syncConfigToDatabase(config, repos);
    const taskId = (await client.observe()).currentTask?.taskId ?? '';
    const requests: PlannerRequest[] = [];
    const planner: PlannerProvider = {
      name: 'stubborn',
      plan: (request) => {
        requests.push(request);
        return Promise.resolve<PlannerResponse>(
          requests.length === 1
            ? {
                kind: 'escalation',
                escalation: {
                  reason: 'INSUFFICIENT_STATE',
                  message: 'the allowed actions do not provide a way to explore',
                  questionForUser: 'Where is gravel?',
                },
              }
            : (explorePlan as PlannerResponse),
        );
      },
    };
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: planNeeded,
      planner,
      clock,
      newId: sequentialIds(),
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.route?.steps.join(' ')).toContain('no known place yet: explore');
    expect(requests[1]?.journal.at(-1)).toMatch(/EXPLORE is in allowedActions/);
    expect(result.planner).toMatchObject({ kind: 'plan-accepted' });
    expect(repos.memory.journal(taskId).map((e) => e.text)).toContainEqual(
      expect.stringContaining('although EXPLORE was open; asked again'),
    );
  });

  it('asks the planner once more when its first step already failed twice from here', async () => {
    const clock = testClock();
    const { client } = makeWorld((w) => {
      if (w.task !== null) w.task.requirements = { 'minecraft:gravel': 8 };
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = defaultConfig({
      ...MOCK_CONFIG,
      minecraft: { movement: { enabled: true, mode: 'follow' } },
    });
    syncConfigToDatabase(config, repos);
    const state = await client.observe();
    const taskId = state.currentTask?.taskId ?? '';
    // The EXPLORE of explorePlan failed twice from where the player stands (seen live: toward
    // a tree behind water, no way further).
    const fingerprint = actionFingerprint(
      { type: 'EXPLORE', args: { toward: { x: 3, z: 70 }, maxDistance: 96 } },
      state.player.position.known ? state.player.position.value : null,
    );
    for (const id of ['old-1', 'old-2']) {
      repos.actions.insert({
        actionId: id,
        cycleId: null,
        taskId,
        actionType: 'EXPLORE',
        origin: 'planner',
        fingerprint,
        reason: 'an earlier plan',
        action: {},
        status: 'failed',
        validation: { ok: true },
      });
      repos.actions.update(id, {
        status: 'failed',
        execution: {
          ok: false,
          code: 'FAILED',
          message: 'not exploring: no way further',
          data: {},
        },
      });
    }
    const elsewhere: PlannerResponse = {
      kind: 'plan',
      plan: {
        ...(explorePlan as Extract<PlannerResponse, { kind: 'plan' }>).plan,
        steps: [
          {
            step: 1,
            action: { type: 'EXPLORE', args: { toward: { x: -30, z: 20 }, maxDistance: 96 } },
            rationale: 'another way round',
          },
        ],
      },
    };
    const requests: PlannerRequest[] = [];
    const planner: PlannerProvider = {
      name: 'stubborn',
      plan: (request) => {
        requests.push(request);
        return Promise.resolve(
          requests.length === 1 ? (explorePlan as PlannerResponse) : elsewhere,
        );
      },
    };
    const result = await runSingleCycle({
      config,
      client,
      repos,
      decisionProvider: planNeeded,
      planner,
      clock,
      newId: sequentialIds(),
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.journal.at(-1)).toMatch(
      /step 1, EXPLORE .* already failed 2 time\(s\) from where the player stands \(last time: not exploring: no way further\)/,
    );
    expect(result.planner).toMatchObject({ kind: 'plan-accepted' });
    expect(result.action).toMatchObject({
      type: 'EXPLORE',
      args: { toward: { x: -30, z: 20 } },
    });
    expect(repos.memory.journal(taskId).map((e) => e.text)).toContainEqual(
      expect.stringContaining('which failed 2 time(s) from here; asked again'),
    );
  });

  it('keeps remembering, but offers no EXPLORE, with a fixed fence', async () => {
    const { repos, planner } = await cycle({ enabled: true, mode: 'fixed' });
    expect(repos.worldMemory.count()).toBe(1);
    expect(planner.requests[0]?.allowedActions).not.toContain('EXPLORE');
    expect(planner.requests[0]?.exploration).toBeUndefined();
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
