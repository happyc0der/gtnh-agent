import { describe, expect, it } from 'vitest';
import { runMockScenario } from '../../src/app/mock/mock-agent.ts';
import { createProviders } from '../../src/app/providers.ts';
import { findScenario, type Scenario } from '../../src/app/mock/scenarios.ts';
import { defaultConfig, type AgentConfigInput } from '../../src/config/env.ts';
import { OllamaPlannerProvider } from '../../src/llm/ollama-planner-provider.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { MockPlannerProvider } from '../../src/planner/mock-planner-provider.ts';
import {
  DeterministicDecisionProvider,
  SafetyFirstDecisionProvider,
} from '../../src/system1/decision-provider.ts';
import { ModelCadenceProvider } from '../../src/system1/model-cadence.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { fakeOllama, golden } from '../fixtures/fake-ollama.ts';
import { testClock } from '../fixtures/index.ts';

const scenario = (name: string): Scenario => {
  const s = findScenario(name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  return s;
};

const OLLAMA: AgentConfigInput = {
  decisions: { provider: 'ollama' },
  planner: { provider: 'ollama' },
  llm: { decisionModel: 'qwen3:14b', plannerModel: 'qwen3:14b' },
};

describe('createProviders', () => {
  it('defaults keep the deterministic router and the fixture planner', () => {
    const { decisionProvider, planner } = createProviders(defaultConfig());
    expect(decisionProvider).toBeInstanceOf(DeterministicDecisionProvider);
    expect(planner).toBeInstanceOf(MockPlannerProvider);
  });

  it('a model decision provider is always wrapped by the safety-first provider', () => {
    const { decisionProvider } = createProviders(
      defaultConfig({ decisions: { provider: 'ollama' } }),
    );
    expect(decisionProvider).toBeInstanceOf(SafetyFirstDecisionProvider);
    expect(decisionProvider.name).toBe('safety-first(ollama:qwen2.5:0.5b)');
  });

  it('the model is asked at its cadence: at decision points by default, or every cycle', () => {
    const at = (modelCadence?: 'decision-points' | 'every-cycle') =>
      createProviders(
        defaultConfig({
          decisions: { provider: 'ollama', ...(modelCadence ? { modelCadence } : {}) },
        }),
      ).decisionProvider;
    expect(at()).toBeInstanceOf(ModelCadenceProvider);
    expect(at()).toMatchObject({ cadence: 'decision-points' });
    expect(at('every-cycle')).toMatchObject({ cadence: 'every-cycle' });
    expect(createProviders(defaultConfig()).decisionProvider).not.toBeInstanceOf(
      ModelCadenceProvider,
    );
  });

  it('selects the Ollama planner, or none', () => {
    const ollama = createProviders(defaultConfig({ planner: { provider: 'ollama' } })).planner;
    expect(ollama).toBeInstanceOf(OllamaPlannerProvider);
    expect(ollama?.name).toBe('ollama:qwen3:14b');
    expect(createProviders(defaultConfig({ planner: { provider: 'none' } })).planner).toBeNull();
  });

  it('contacts nothing until a cycle asks', () => {
    const fake = fakeOllama({ body: golden('decision-nominal.qwen3-14b') });
    createProviders(defaultConfig(OLLAMA), { llm: { fetch: fake.fetch } });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('a mock cycle with Ollama providers (recorded replies)', () => {
  it('the model decides to ask the planner, the model plans, and step 1 runs', async () => {
    const fake = fakeOllama(
      { body: golden('decision-needs-planner.qwen3-14b') },
      { body: golden('planner-plan.qwen3-14b') },
    );
    const { result, repos, db } = await runMockScenario(scenario('needs-planner'), {
      config: OLLAMA,
      llm: { fetch: fake.fetch },
      clock: testClock(),
      newId: sequentialIds(),
    });
    expect(fake.calls.map((c) => c.body.model)).toEqual(['qwen3:14b', 'qwen3:14b']);
    expect(result.decision).toMatchObject({
      decision: 'REQUEST_PLANNER',
      provider: 'ollama:qwen3:14b',
    });
    expect(result.planner).toMatchObject({ kind: 'plan-accepted', steps: 3 });
    expect(result.action).toMatchObject({ type: 'MOVE_TO', origin: 'planner' });
    expect(result.status).toBe('succeeded');
    expect(repos.plans.get(1)).toMatchObject({ planner: 'ollama:qwen3:14b', status: 'active' });
    db.close();
  });

  it('in danger the router retreats without asking the model', async () => {
    const fake = fakeOllama({ body: golden('decision-nominal.qwen3-14b') });
    const { result, db } = await runMockScenario(scenario('lava-nearby'), {
      config: OLLAMA,
      llm: { fetch: fake.fetch },
      clock: testClock(),
    });
    expect(fake.calls).toHaveLength(0);
    expect(result.decision?.decision).toBe('RETREAT_HOME');
    expect(result.action?.type).toBe('RETURN_TO_SAFE_LOCATION');
    db.close();
  });

  it('garbage from the planner model pauses the task; nothing else runs', async () => {
    const fake = fakeOllama(
      { body: golden('decision-needs-planner.qwen3-14b') },
      { body: golden('planner-unconstrained.qwen2.5-0.5b') },
    );
    const { result, client, db } = await runMockScenario(scenario('needs-planner'), {
      config: OLLAMA,
      llm: { fetch: fake.fetch },
      clock: testClock(),
    });
    expect(result.planner).toMatchObject({ kind: 'escalation', reason: 'INVALID_OUTPUT' });
    expect(result.status).toBe('paused');
    expect(client.performed.map((p) => p.action.type)).toEqual(['PAUSE_AND_ASK_USER']);
    db.close();
  });

  it('a model plan that breaks a safety rule is rejected before anything runs', async () => {
    const fake = fakeOllama(
      { body: golden('decision-needs-planner.qwen3-14b') },
      { body: golden('planner-unsafe.qwen2.5-0.5b') },
    );
    const { result, repos, client, db } = await runMockScenario(scenario('needs-planner'), {
      config: OLLAMA,
      llm: { fetch: fake.fetch },
      clock: testClock(),
    });
    expect(result.planner).toMatchObject({ kind: 'plan-rejected' });
    expect(repos.violations.recent(10).map((v) => v.code)).toEqual(
      expect.arrayContaining(['PLAN_INVALID', 'PROTECTED_ITEM']),
    );
    expect(client.performed.map((p) => p.action.type)).toEqual(['PAUSE_AND_ASK_USER']);
    db.close();
  });

  it('a plan step that treats a machine as a chest is refused when it comes up', async () => {
    // Recorded qwen3:14b plan: inspect, move, then OPEN_CONTAINER on the macerator. Every step
    // passes the static plan check; the executor refuses step 3 against the live state.
    const fake = fakeOllama({ body: golden('planner-machine-as-container.qwen3-14b') });
    const db = openDatabase(IN_MEMORY);
    const clock = testClock();
    const newId = sequentialIds();
    const summaries: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { result } = await runMockScenario(scenario('needs-planner'), {
        db,
        clock,
        newId,
        config: { planner: { provider: 'ollama' } },
        llm: { fetch: fake.fetch },
      });
      summaries.push(result.summary);
      clock.advance(1000);
    }
    expect(fake.calls).toHaveLength(1);
    expect(summaries).toEqual([
      'REQUEST_PLANNER -> INSPECT_MACHINE -> succeeded',
      'REQUEST_PLANNER -> MOVE_TO -> succeeded',
      expect.stringMatching(/^REQUEST_PLANNER -> OPEN_CONTAINER -> rejected/),
    ]);
    const repos = createRepositories(db, clock);
    expect(repos.plans.get(1)).toMatchObject({ status: 'failed', planner: 'ollama:qwen3:14b' });
    expect(repos.tasks.get('task-needs-planner')?.status).toBe('blocked');
    db.close();
  });
});
