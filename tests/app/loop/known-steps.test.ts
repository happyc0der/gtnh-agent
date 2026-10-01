import { describe, expect, it } from 'vitest';
import { runSingleCycle, type AgentDeps } from '../../../src/app/loop/agent-loop.ts';
import { overlayAgentMemory, syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { ActionSpec } from '../../../src/domain/actions.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import type { PlannerProvider } from '../../../src/planner/planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { MockDecisionProvider } from '../../../src/system1/mock-decision-provider.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { makeWorld, memoryRepos, testConfig } from '../../fixtures/index.ts';

/**
 * Code-made blueprints (the night shelter, the way out of it) run as known safe steps:
 * System 1's rule 6, or, whatever a model decides, instead of the planner.
 */
const wait = (ms: number): ActionSpec => ({ type: 'WAIT', args: { durationMs: ms } });
const STEPS = [
  { spec: wait(100), text: 'wait a moment' },
  { spec: wait(200), text: 'wait a little longer' },
];

async function setup(
  decisions = new DeterministicDecisionProvider() as AgentDeps['decisionProvider'],
) {
  const { client, clock } = makeWorld();
  await client.connect();
  const config = testConfig();
  const repos = memoryRepos(clock);
  syncConfigToDatabase(config, repos);
  const asked: unknown[] = [];
  const planner: PlannerProvider = {
    name: 'never-asked',
    plan: (req) => {
      asked.push(req);
      return Promise.reject(new Error('the planner must not be asked'));
    },
  };
  const deps: AgentDeps = {
    config: { ...config, planner: { ...config.planner, provider: 'mock' } },
    client,
    repos,
    decisionProvider: decisions,
    planner,
    clock,
    newId: sequentialIds(),
  };
  repos.tasks.ensure({
    id: 'night-shelter',
    goal: 'Night is coming',
    subgoal: null,
    status: 'active',
  });
  repos.memory.setValue(CURRENT_TASK_KEY, 'night-shelter');
  setKnownSteps(repos, 'night-shelter', STEPS);
  /** A live-looking observation: the task comes from agent memory, as on the live server. */
  const live = (): GameState => ({
    ...client.snapshot(),
    source: 'gtnh1710',
    currentTask: null,
    knownRecipeState: null,
  });
  return { deps, repos, clock, live, asked };
}

describe('known safe steps from a code-made blueprint', () => {
  it("become the state's next known safe step, and rule 6 runs them in order", async () => {
    const { deps, repos, clock, live, asked } = await setup();
    expect(overlayAgentMemory(live(), repos, deps.config).knownRecipeState).toEqual({
      target: 'Night is coming',
      missingComponents: {},
      requiredMachineIds: [],
      nextKnownSafeStep: wait(100),
    });
    const first = await runSingleCycle(deps, { state: live() });
    expect(first.summary).toBe('EXECUTE_KNOWN_SAFE_STEP -> WAIT -> succeeded');
    expect(first.action).toMatchObject({
      origin: 'deterministic-router',
      args: { durationMs: 100 },
    });
    expect(nextKnownStep(repos, 'night-shelter')).toMatchObject({ index: 1, total: 2 });
    clock.advance(1000);
    const second = await runSingleCycle(deps, { state: live() });
    expect(second.summary).toBe('EXECUTE_KNOWN_SAFE_STEP -> WAIT -> succeeded');
    // The last step completes the task (a session on it then ends) and clears the blueprint.
    expect(repos.tasks.get('night-shelter')?.status).toBe('completed');
    expect(nextKnownStep(repos, 'night-shelter')).toBeNull();
    expect(repos.memory.journal('night-shelter').at(-1)?.text).toBe("code's 2 step(s) done");
    expect(asked).toEqual([]);
  });

  it('run instead of the planner when a model decides REQUEST_PLANNER', async () => {
    const { deps, repos, live, asked } = await setup(
      MockDecisionProvider.always('REQUEST_PLANNER'),
    );
    const r = await runSingleCycle(deps, { state: live() });
    expect(r.summary).toBe('REQUEST_PLANNER -> WAIT -> succeeded');
    expect(r.planner).toEqual({ kind: 'known-step', step: 1, steps: 2 });
    expect(r.action).toMatchObject({ origin: 'deterministic-router' });
    expect(r.action?.reason).toBe("code's step 1/2: wait a moment");
    expect(asked).toEqual([]);
    expect(nextKnownStep(repos, 'night-shelter')?.index).toBe(1);
  });

  it('a step that is refused stays next; a refusal only as stale does not block the task', async () => {
    const { deps, repos, live } = await setup();
    // A blueprint whose step no longer fits the world: a dig the observation does not list.
    const stale: ActionSpec = { type: 'DIG_BLOCK', args: { position: { x: 1, y: 64, z: 2 } } };
    setKnownSteps(repos, 'night-shelter', [{ spec: stale, text: 'dig a block that is gone' }]);
    const r = await runSingleCycle(deps, { state: live() });
    expect(r.summary).toBe('EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> rejected [NOT_DIGGABLE]');
    expect(r.needsUserAttention).toBe(false);
    expect(repos.tasks.get('night-shelter')?.status).toBe('active');
    expect(nextKnownStep(repos, 'night-shelter')?.spec).toEqual(stale);
    expect(repos.memory.journal('night-shelter').at(-1)?.text).toBe(
      "code's step 1/1 (dig a block that is gone) rejected",
    );
  });
});
