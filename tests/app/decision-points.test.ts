import { describe, expect, it } from 'vitest';
import {
  runSingleCycle,
  syncConfigToDatabase,
  type CycleResult,
} from '../../src/app/agent-loop.ts';
import { runSession } from '../../src/app/live-session.ts';
import { describePlayEvent, type PlayEvent } from '../../src/app/play.ts';
import { createProviders } from '../../src/app/providers.ts';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import type { MockResourceBlock } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig, type ModelCadence } from '../../src/config/env.ts';
import type { DiggableBlock } from '../../src/domain/blocks.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import type { Plan, PlannerResponse } from '../../src/planner/plan-schema.ts';
import type { PlannerProvider } from '../../src/planner/planner-provider.ts';
import {
  describeSystem1Stats,
  NO_SYSTEM1_STATS,
  system1Stats,
  type System1Stats,
} from '../../src/system1/model-cadence.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { fakeOllama, golden } from '../fixtures/fake-ollama.ts';
import { makeWorld, memoryRepos, testClock } from '../fixtures/index.ts';

/**
 * System 1 with a model at decision points, over many cycles of the agent loop. The model is
 * a fake Ollama server that always answers REQUEST_PLANNER (a recorded qwen3:14b reply), built
 * through the real provider factory, so each of its calls is one System 1 model decision.
 */

// The mock player starts at (1, 64, 1); sand lies in two rows along z = 5 and z = 6.
function sandRows(perRow: number): MockResourceBlock[] {
  return [5, 6].flatMap((z) =>
    Array.from({ length: perRow }, (_, x) => ({
      block: 'minecraft:sand' as const,
      position: { x, y: 64, z },
      standAt: { x: x + 0.5, y: 64, z: 4.5 },
    })),
  );
}

const plan = (steps: Array<Plan['steps'][number]['action']>, goal: string): PlannerResponse => ({
  kind: 'plan',
  plan: {
    goal,
    steps: steps.map((action, i) => ({ step: i + 1, action, rationale: 'the route says so' })),
    requiresUserApproval: false,
    explanation: 'Code digs the blocks one by one.',
    failureHandling: {
      onStepFailure: 'REPLAN',
      maxRetriesPerStep: 1,
      escalationMessage: 'Could not gather.',
    },
  },
});
const gather = (block: DiggableBlock, count: number): PlannerResponse =>
  plan([{ type: 'GATHER', args: { block, count } }], `Gather ${count} ${block}`);
const NO_PLAN: PlannerResponse = {
  kind: 'escalation',
  escalation: { reason: 'OTHER', message: 'no more plans', questionForUser: 'What now?' },
};

async function agent(
  cadence: ModelCadence,
  blocks: MockResourceBlock[],
  ...plans: PlannerResponse[]
) {
  const clock = testClock();
  const { world, client } = makeWorld((w) => {
    w.recipe = null; // no known step: System 1 asks for the planner
    w.resourceBlocks = blocks;
  }, clock);
  await client.connect();
  const repos = memoryRepos(clock);
  const config = defaultConfig({
    ...MOCK_CONFIG,
    decisions: { provider: 'ollama', modelCadence: cadence },
    llm: { decisionModel: 'qwen3:14b' },
  });
  syncConfigToDatabase(config, repos);
  const model = fakeOllama({ body: golden('decision-needs-planner.qwen3-14b') });
  const { decisionProvider } = createProviders(config, { llm: { fetch: model.fetch } });
  let plannerCalls = 0;
  const planner: PlannerProvider = {
    name: 'scripted',
    plan: () => {
      plannerCalls += 1;
      return Promise.resolve(plans.shift() ?? NO_PLAN);
    },
  };
  const deps = {
    config,
    client,
    repos,
    decisionProvider,
    planner,
    clock,
    newId: sequentialIds(),
  };
  const cycle = (): Promise<CycleResult> => {
    clock.advance(500);
    return runSingleCycle(deps);
  };
  return {
    world,
    client,
    repos,
    deps,
    cycle,
    modelCalls: (): number => model.calls.length,
    plannerCalls: (): number => plannerCalls,
    /** Cycles until `stop` holds after one (at most `max`). */
    async until(stop: (r: CycleResult) => boolean, max = 300): Promise<CycleResult[]> {
      const results: CycleResult[] = [];
      while (results.length < max) {
        const r = await cycle();
        results.push(r);
        if (stop(r)) break;
      }
      return results;
    },
  };
}

const cadenceOf = (r: CycleResult | undefined): unknown => r?.decision?.factsUsed['cadence'];
const whyOf = (r: CycleResult | undefined): unknown => r?.decision?.factsUsed['cadenceWhy'];
const planIdOf = (r: CycleResult): number | null =>
  r.planner !== null && 'planId' in r.planner ? r.planner.planId : null;
/** 0-based indexes of the cycles the model decided. */
const modelCycles = (results: CycleResult[]): number[] =>
  results.flatMap((r, i) => (cadenceOf(r) === 'model' ? [i] : []));

describe('System 1 asks the model at decision points only', () => {
  it('a 54-sand GATHER: the model decides at the start and at each plan change, not per dig', async () => {
    const a = await agent(
      'decision-points',
      sandRows(27),
      gather('minecraft:sand', 54),
      plan([{ type: 'WAIT', args: { durationMs: 1000 } }], 'Wait a moment'),
    );
    const results = await a.until((r) => r.status === 'paused'); // the last plan request escalates
    const gatherCycles = results.filter((r) => planIdOf(r) === 1).length;

    expect(a.world.inventory.items['minecraft:sand']).toBe(54);
    expect(a.repos.plans.get(1)?.status).toBe('completed');
    expect(gatherCycles).toBeGreaterThanOrEqual(54); // 54 digs, and the walks between them
    // The GATHER, then one cycle for the WAIT plan, then one whose planner request escalates.
    expect(results).toHaveLength(gatherCycles + 2);

    // Three model decisions in all those cycles: the session's first, and after each plan ended.
    expect(a.modelCalls()).toBe(3);
    expect(modelCycles(results)).toEqual([0, gatherCycles, gatherCycles + 1]);
    expect(a.plannerCalls()).toBe(3);
    expect(whyOf(results[0])).toBe('the first cycle of the session');
    expect(whyOf(results[gatherCycles])).toBe(
      'plan #1 ended (completed); no open plan to continue',
    );
    expect(whyOf(results[gatherCycles + 1])).toBe(
      'plan #2 ended (completed); no open plan to continue',
    );

    // Every other cycle continued the GATHER with the router's decision, without the model
    // (and without the planner): one validated, verified action each.
    const continued = results.filter((r) => cadenceOf(r) === 'continuing');
    expect(continued).toHaveLength(gatherCycles - 1);
    for (const r of continued) {
      expect(r.decision).toMatchObject({
        decision: 'REQUEST_PLANNER',
        provider: 'continuing(deterministic-router)',
      });
      expect(r.planner).toMatchObject({ kind: 'plan-step', planId: 1 });
      expect(r.status).toBe('succeeded');
      expect(whyOf(r)).toBe(
        'nothing changed since the previous cycle: plan #1 step 1/1 (GATHER) goes on',
      );
    }
    // The model's own decisions show its name as the provider.
    expect(results[0]?.decision).toMatchObject({
      decision: 'REQUEST_PLANNER',
      provider: 'ollama:qwen3:14b',
      factsUsed: { cadence: 'model', model: 'qwen3:14b' },
    });
    // What the stats line at the end of such a session counts.
    expect(system1Stats(results.map((r) => r.decision))).toMatchObject({
      decisions: results.length,
      model: 3,
      continued: results.length - 3,
      binding: 0,
    });
    // The log shows which way each decision went, and why.
    const logged = a.repos.events
      .forCycle(results[1]?.cycleId ?? '')
      .find((e) => e.kind === 'DECISION');
    expect(JSON.stringify(logged)).toContain('"cadence":"continuing"');
  });

  it('every-cycle still asks the model every cycle', async () => {
    const a = await agent(
      'every-cycle',
      sandRows(27),
      gather('minecraft:sand', 54),
      plan([{ type: 'WAIT', args: { durationMs: 1000 } }], 'Wait a moment'),
    );
    const results = await a.until((r) => r.status === 'paused');
    expect(a.world.inventory.items['minecraft:sand']).toBe(54);
    expect(a.modelCalls()).toBe(results.length);
    expect(results.every((r) => cadenceOf(r) === 'model')).toBe(true);
    expect(a.plannerCalls()).toBe(3);
  });

  it("a mob mid-plan: the router's binding retreat (no model), then the model once it is gone", async () => {
    const a = await agent('decision-points', sandRows(6), gather('minecraft:sand', 8));
    await a.cycle();
    await a.cycle();
    expect(a.modelCalls()).toBe(1);

    a.world.hostiles.push({ x: 4, y: 64, z: 8 });
    const fled = await a.cycle();
    expect(fled.decision).toMatchObject({
      decision: 'RETREAT_HOME',
      reasonCodes: ['HOSTILES_NEARBY'],
      provider: 'safety-first(ollama:qwen3:14b)',
      factsUsed: { cadence: 'binding' },
    });
    expect(fled.action?.type).toBe('RETURN_TO_SAFE_LOCATION');
    expect(a.modelCalls()).toBe(1); // nobody but the router decided

    a.world.hostiles = [];
    const back = await a.cycle();
    expect(a.modelCalls()).toBe(2);
    expect(back.decision).toMatchObject({
      decision: 'REQUEST_PLANNER',
      provider: 'ollama:qwen3:14b',
      factsUsed: {
        cadence: 'model',
        cadenceWhy:
          "the router's decision changed: RETREAT_HOME [HOSTILES_NEARBY] -> REQUEST_PLANNER [NO_KNOWN_STEP]; " +
          'dangers changed: HOSTILES_NEARBY -> none',
      },
    });
    // The model said go on: the same GATHER continues, no new plan.
    expect(back.planner).toMatchObject({ kind: 'plan-step', planId: 1 });

    const rest = await a.until(() => a.repos.plans.get(1)?.status !== 'active');
    expect(rest.every((r) => cadenceOf(r) === 'continuing')).toBe(true);
    expect(a.repos.plans.get(1)?.status).toBe('completed');
    expect(a.world.inventory.items['minecraft:sand']).toBe(8);
    expect(a.modelCalls()).toBe(2);
    expect(a.plannerCalls()).toBe(1);
  });

  it('a failed action and the evening are decision points too', async () => {
    const a = await agent('decision-points', sandRows(6), gather('minecraft:sand', 8));
    await a.cycle(); // the model, then the plan's first action
    expect(a.modelCalls()).toBe(1);

    a.client.failNext('DIG_BLOCK', 'simulated: the server re-sent the block');
    const upToFailure = await a.until((r) => r.status === 'failed', 5);
    expect(upToFailure.at(-1)?.status).toBe('failed');
    expect(a.modelCalls()).toBe(1);
    const retry = await a.cycle();
    expect(whyOf(retry)).toBe('the previous DIG_BLOCK failed');
    expect(retry.planner).toMatchObject({ kind: 'plan-step', planId: 1 }); // the plan retries
    expect(a.modelCalls()).toBe(2);

    await a.cycle();
    expect(a.modelCalls()).toBe(2);
    a.world.timeOfDay = 12_500;
    const evening = await a.cycle();
    expect(whyOf(evening)).toBe('the time of day changed: day -> evening');
    expect(a.modelCalls()).toBe(3);
  });

  it("each session's first cycle asks the model; the session reports how System 1 decided", async () => {
    const a = await agent('decision-points', sandRows(27), gather('minecraft:sand', 54));
    a.repos.tasks.ensure({ id: 'task-test', goal: 'Gather sand', subgoal: null, status: 'active' });
    a.repos.memory.setValue(CURRENT_TASK_KEY, 'task-test');
    const limits = { maxCycles: 5, maxMinutes: 1, pauseMs: 0 };
    const hooks = {
      stopRequested: (): string | null => {
        a.deps.clock.advance(500);
        return null;
      },
    };

    const first = await runSession(a.deps, limits, hooks);
    expect(first.stopKind).toBe('limit');
    expect(first.system1).toMatchObject({ decisions: 5, model: 1, continued: 4, binding: 0 });
    expect(first.system1?.modelMs).toHaveLength(1);

    const second = await runSession(a.deps, limits, hooks);
    expect(second.system1).toMatchObject({ decisions: 5, model: 1, continued: 4, binding: 0 });
    expect(a.modelCalls()).toBe(2);
    expect(a.plannerCalls()).toBe(1); // the second session went on with the same GATHER
    expect(describeSystem1Stats(second.system1 ?? NO_SYSTEM1_STATS)).toMatch(
      /^System 1 over 5 cycle\(s\): 1 model decision\(s\) \(median \d+\.\d s\), 4 continued without the model, 0 binding router decision\(s\)$/,
    );
  });
});

describe('what cli play prints', () => {
  const cycle = (provider: string): PlayEvent => ({
    kind: 'cycle',
    session: 2,
    index: 7,
    summary: 'REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    decision: {
      provider,
      decision: 'REQUEST_PLANNER',
      reasons: ['NO_KNOWN_STEP'],
      confidence: 0.5,
    },
    newPlan: null,
    detail: null,
  });

  it("each cycle's System 1 line shows whether the model decided", () => {
    expect(describePlayEvent(cycle('continuing(deterministic-router)'))).toBe(
      '  [2.7] SYSTEM 1 (continuing(deterministic-router)): REQUEST_PLANNER [NO_KNOWN_STEP] confidence 0.5\n' +
        '  [2.7] REQUEST_PLANNER -> DIG_BLOCK -> succeeded',
    );
    expect(describePlayEvent(cycle('ollama:qwen3:14b')).split('\n')[0]).toBe(
      '  [2.7] SYSTEM 1 (ollama:qwen3:14b): REQUEST_PLANNER [NO_KNOWN_STEP] confidence 0.5',
    );
  });

  it('a session ends with how System 1 decided (none with the rule router alone)', () => {
    const end = (system1?: System1Stats): PlayEvent => ({
      kind: 'session-end',
      session: 2,
      stopKind: 'limit',
      stopReason: 'reached the limit of 20 cycles',
      cycles: 20,
      system1,
    });
    expect(
      describePlayEvent(
        end({ decisions: 20, model: 1, continued: 19, binding: 0, modelMs: [2200] }),
      ),
    ).toBe(
      'session 2: 20 cycle(s); reached the limit of 20 cycles\n' +
        '  System 1 over 20 cycle(s): 1 model decision(s) (median 2.2 s), ' +
        '19 continued without the model, 0 binding router decision(s)',
    );
    const routerOnly = { decisions: 20, model: 0, continued: 0, binding: 0, modelMs: [] };
    expect(describePlayEvent(end(routerOnly))).toBe(
      'session 2: 20 cycle(s); reached the limit of 20 cycles',
    );
    expect(describePlayEvent(end())).toBe('session 2: 20 cycle(s); reached the limit of 20 cycles');
  });
});
