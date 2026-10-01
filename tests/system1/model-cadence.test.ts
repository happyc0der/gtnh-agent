import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { Decision, DecisionResult } from '../../src/domain/decisions.ts';
import {
  cycleView,
  decisionPoint,
  describeSystem1Stats,
  median,
  mergeSystem1Stats,
  ModelCadenceProvider,
  NO_SYSTEM1_STATS,
  system1Stats,
  type CycleView,
  type DecisionConditions,
} from '../../src/system1/model-cadence.ts';
import {
  SafetyFirstDecisionProvider,
  type DecisionProvider,
} from '../../src/system1/decision-provider.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { MockDecisionProvider } from '../../src/system1/mock-decision-provider.ts';
import type { PlanFacts, RouterContext } from '../../src/system1/state-queries.ts';
import { makeState, routerCtx } from '../fixtures/index.ts';

// ---------------------------------------------------------------------------
// The decision-point check (pure), case by case
// ---------------------------------------------------------------------------

const conditions = (over: Partial<DecisionConditions> = {}): DecisionConditions => ({
  routerDecision: 'REQUEST_PLANNER',
  routerReasons: ['NO_KNOWN_STEP'],
  dangers: [],
  hungry: false,
  task: 'task-a (active)',
  timePhase: 'day',
  inventoryNearlyFull: false,
  ...over,
});

const gatherPlan = (over: Partial<PlanFacts> = {}): PlanFacts => ({
  planId: 1,
  status: 'active',
  step: 1,
  steps: 1,
  stepType: 'GATHER',
  ...over,
});

const dug = (id: string, result = 'succeeded', type = 'DIG_BLOCK') => ({ id, type, result });

/** A cycle in the middle of a GATHER: plan #1 open, the last dig succeeded. */
function view(
  over: {
    conditions?: Partial<DecisionConditions>;
    plan?: PlanFacts | null;
    lastAction?: CycleView['lastAction'];
    taskId?: string | null;
    modelDecision?: Decision | null;
  } = {},
): CycleView {
  return {
    conditions: conditions(over.conditions),
    taskId: over.taskId === undefined ? 'task-a' : over.taskId,
    plan: over.plan === undefined ? gatherPlan() : over.plan,
    lastAction: over.lastAction === undefined ? dug('a1') : over.lastAction,
    modelDecision: over.modelDecision ?? null,
  };
}

const retreating = { routerDecision: 'RETREAT_HOME', routerReasons: ['HOSTILES_NEARBY'] } as const;

describe('decisionPoint: at decision points', () => {
  it("asks the model at a session's first cycle", () => {
    expect(decisionPoint('decision-points', null, view())).toEqual({
      askModel: true,
      why: ['the first cycle of the session'],
    });
  });

  it('nothing changed: the open plan (a GATHER) goes on without the model', () => {
    expect(decisionPoint('decision-points', view(), view({ lastAction: dug('a2') }))).toEqual({
      askModel: false,
      why: 'nothing changed since the previous cycle: plan #1 step 1/1 (GATHER) goes on',
    });
  });

  it.each<[string, CycleView, CycleView, string]>([
    [
      'the plan advanced to its next step',
      view({ plan: gatherPlan({ steps: 2 }) }),
      view({ plan: gatherPlan({ step: 2, steps: 2, stepType: 'CRAFT_ITEM' }) }),
      'nothing changed since the previous cycle: plan #1 step 2/2 (CRAFT_ITEM) goes on',
    ],
    [
      'the previous cycle made a plan (the model decided that cycle, as the router)',
      view({ plan: null, modelDecision: 'REQUEST_PLANNER' }),
      view({ lastAction: dug('a2') }),
      'nothing changed since the previous cycle: plan #1 step 1/1 (GATHER) goes on',
    ],
    [
      'the failed action was already seen (a cycle without an action since)',
      view({ lastAction: dug('a2', 'failed') }),
      view({ lastAction: dug('a2', 'failed') }),
      'nothing changed since the previous cycle: plan #1 step 1/1 (GATHER) goes on',
    ],
    [
      'a known next step without a plan',
      view({
        plan: null,
        conditions: {
          routerDecision: 'EXECUTE_KNOWN_SAFE_STEP',
          routerReasons: ['KNOWN_SAFE_STEP'],
        },
      }),
      view({
        plan: null,
        conditions: {
          routerDecision: 'EXECUTE_KNOWN_SAFE_STEP',
          routerReasons: ['KNOWN_SAFE_STEP'],
        },
      }),
      'nothing changed since the previous cycle: EXECUTE_KNOWN_SAFE_STEP goes on',
    ],
    [
      'a machine still busy',
      view({ conditions: { routerDecision: 'WAIT_FOR_MACHINE', routerReasons: ['MACHINE_BUSY'] } }),
      view({ conditions: { routerDecision: 'WAIT_FOR_MACHINE', routerReasons: ['MACHINE_BUSY'] } }),
      'nothing changed since the previous cycle: WAIT_FOR_MACHINE goes on',
    ],
  ])('goes on without the model when %s', (_name, previous, now, why) => {
    expect(decisionPoint('decision-points', previous, now)).toEqual({ askModel: false, why });
  });

  it.each<[string, CycleView, CycleView, string[]]>([
    [
      'the previous action failed',
      view(),
      view({ lastAction: dug('a2', 'failed') }),
      ['the previous DIG_BLOCK failed'],
    ],
    [
      'the previous action was rejected',
      view(),
      view({ lastAction: dug('a2', 'rejected', 'MOVE_TO') }),
      ['the previous MOVE_TO was rejected'],
    ],
    [
      'the previous action was not verified',
      view(),
      view({ lastAction: dug('a2', 'verification_failed') }),
      ['the previous DIG_BLOCK was not verified'],
    ],
    [
      'the previous cycle paused',
      view(),
      view({ lastAction: dug('a2', 'succeeded', 'PAUSE_AND_ASK_USER') }),
      ['the previous cycle paused'],
    ],
    [
      'the model chose otherwise than the router (going on would undo its choice)',
      view({ modelDecision: 'WAIT_FOR_MACHINE' }),
      view({ lastAction: dug('a2', 'succeeded', 'WAIT') }),
      ['the model chose WAIT_FOR_MACHINE last cycle, the router REQUEST_PLANNER'],
    ],
    [
      'the plan completed',
      view(),
      view({ plan: gatherPlan({ status: 'completed', stepType: null }) }),
      ['plan #1 ended (completed)', 'no open plan to continue'],
    ],
    [
      'the plan failed (a GATHER with nothing left to dig, or at its bound)',
      view(),
      view({ plan: gatherPlan({ status: 'failed' }) }),
      ['plan #1 ended (failed)', 'no open plan to continue'],
    ],
    ['the plan was replaced', view(), view({ plan: gatherPlan({ planId: 2 }) }), ['plan #1 ended']],
    [
      'the previous cycle made a plan and finished it (one step)',
      view({ plan: gatherPlan({ status: 'completed', stepType: null }) }),
      view({ plan: gatherPlan({ planId: 2, status: 'completed', stepType: null }) }),
      ['plan #2 ended (completed)', 'no open plan to continue'],
    ],
    [
      "the previous cycle made a plan whose GATHER found nothing to dig (it is 'rejected')",
      view({ plan: null }),
      view({ plan: gatherPlan({ status: 'failed' }) }),
      ['plan #1 ended (failed)', 'no open plan to continue'],
    ],
    [
      'there is no plan to continue',
      view({ plan: null, lastAction: null }),
      view({ plan: null, lastAction: null }),
      ['no open plan to continue'],
    ],
    [
      'the plan waits for approval (it has not run, so it has not ended)',
      view({ plan: null }),
      view({ plan: gatherPlan({ status: 'pending_approval' }) }),
      ['no open plan to continue'],
    ],
    [
      'the plan ended earlier and there is still none to continue',
      view({ plan: gatherPlan({ status: 'completed', stepType: null }) }),
      view({ plan: gatherPlan({ status: 'completed', stepType: null }) }),
      ['no open plan to continue'],
    ],
    [
      "the router's reasons changed (a machine became busy)",
      view(),
      view({ conditions: { routerDecision: 'WAIT_FOR_MACHINE', routerReasons: ['MACHINE_BUSY'] } }),
      [
        "the router's decision changed: REQUEST_PLANNER [NO_KNOWN_STEP] -> WAIT_FOR_MACHINE [MACHINE_BUSY]",
      ],
    ],
    [
      'a mob came (the caller applies the binding retreat first)',
      view(),
      view({ conditions: { ...retreating, dangers: ['HOSTILES_NEARBY'] } }),
      [
        "the router's decision changed: REQUEST_PLANNER [NO_KNOWN_STEP] -> RETREAT_HOME [HOSTILES_NEARBY]",
        'dangers changed: none -> HOSTILES_NEARBY',
      ],
    ],
    [
      'the mob is gone',
      view({ conditions: { ...retreating, dangers: ['HOSTILES_NEARBY'] } }),
      view(),
      [
        "the router's decision changed: RETREAT_HOME [HOSTILES_NEARBY] -> REQUEST_PLANNER [NO_KNOWN_STEP]",
        'dangers changed: HOSTILES_NEARBY -> none',
      ],
    ],
    [
      'a hazard and low health',
      view(),
      view({ conditions: { dangers: ['HAZARD_PROXIMITY', 'LOW_HEALTH'] } }),
      ['dangers changed: none -> HAZARD_PROXIMITY, LOW_HEALTH'],
    ],
    ['food ran low', view(), view({ conditions: { hungry: true } }), ['hungry now']],
    ['the agent ate', view({ conditions: { hungry: true } }), view(), ['no longer hungry']],
    [
      'the task changed (its plan did not end)',
      view(),
      view({ taskId: 'task-b', plan: null, conditions: { task: 'task-b (active)' } }),
      ['no open plan to continue', 'the task changed: task-a (active) -> task-b (active)'],
    ],
    [
      'evening came',
      view(),
      view({ conditions: { timePhase: 'evening' } }),
      ['the time of day changed: day -> evening'],
    ],
    [
      'the inventory nearly filled',
      view(),
      view({ conditions: { inventoryNearlyFull: true } }),
      ['the inventory is nearly full'],
    ],
    [
      'the inventory has room again',
      view({ conditions: { inventoryNearlyFull: true } }),
      view(),
      ['the inventory has room again'],
    ],
    [
      'several things at once',
      view(),
      view({
        lastAction: dug('a2', 'failed'),
        plan: gatherPlan({ status: 'failed' }),
        conditions: { timePhase: 'evening', hungry: true },
      }),
      [
        'the previous DIG_BLOCK failed',
        'plan #1 ended (failed)',
        'no open plan to continue',
        'hungry now',
        'the time of day changed: day -> evening',
      ],
    ],
  ])('asks the model when %s', (_name, previous, now, why) => {
    expect(decisionPoint('decision-points', previous, now)).toEqual({ askModel: true, why });
  });
});

describe('decisionPoint: every cycle', () => {
  it('asks the model every cycle, even when nothing changed', () => {
    for (const previous of [null, view()]) {
      expect(decisionPoint('every-cycle', previous, view())).toEqual({
        askModel: true,
        why: ['every cycle (decisions.modelCadence: every-cycle)'],
      });
    }
  });
});

describe('cycleView', () => {
  it('reads the conditions from the observation, the router and the plan facts', () => {
    const state = makeState((w) => {
      w.player.hunger = 10; // below the eating threshold (14), bread carried
      w.timeOfDay = 12_500; // evening
    });
    const plan = gatherPlan({ planId: 4, step: 2, steps: 3 });
    const ctx: RouterContext = { ...routerCtx(), plan };
    const router = routeDecision(state, ctx);
    expect(cycleView(state, ctx, router)).toEqual({
      conditions: {
        routerDecision: 'EAT',
        routerReasons: ['HUNGRY'],
        dangers: [],
        hungry: true,
        task: 'task-test (active)',
        timePhase: 'evening',
        inventoryNearlyFull: false,
      },
      taskId: 'task-test',
      plan,
      lastAction: null,
      modelDecision: null,
    });
  });

  it('lists the dangers once each, sorted, and no plan when none is given', () => {
    const state = makeState((w) => {
      w.player.health = 6;
      w.hazards = [
        { kind: 'lava', position: { x: 2, y: 64, z: 1 } },
        { kind: 'lava', position: { x: 1, y: 64, z: 2 } },
      ];
    });
    const v = cycleView(state, routerCtx(), routeDecision(state, routerCtx()));
    expect(v.conditions.dangers).toEqual(['HAZARD_PROXIMITY', 'LOW_HEALTH']);
    expect(v.plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ModelCadenceProvider: the model, continuing, or the router's binding decision
// ---------------------------------------------------------------------------

/** The router asks for the planner (no known step); task-test has plan #1, a GATHER. */
const planning = (mutate: (w: MockWorld) => void = () => undefined) =>
  makeState((w) => {
    w.recipe = null;
    mutate(w);
  });
const withPlan: RouterContext = { ...routerCtx(), plan: gatherPlan() };
const lava = (w: MockWorld): void => {
  w.player.position = { x: 30, y: 64, z: 30 };
  w.hazards = [{ kind: 'lava', position: { x: 31, y: 64, z: 30 } }];
};

function cadenced(cadence: 'decision-points' | 'every-cycle', model?: DecisionProvider) {
  const inner = MockDecisionProvider.always('REQUEST_PLANNER');
  let t = 0;
  // Each call to the clock is 250 ms later: a model call takes 250 ms.
  const provider = new ModelCadenceProvider(model ?? inner, cadence, { now: () => (t += 250) });
  return { provider, inner };
}

describe('ModelCadenceProvider', () => {
  it('is the safety-first provider, under the same name', () => {
    const { provider } = cadenced('decision-points');
    expect(provider).toBeInstanceOf(SafetyFirstDecisionProvider);
    expect(provider.name).toBe('safety-first(mock-decision-provider)');
    expect(provider.cadence).toBe('decision-points');
  });

  it('asks the model at the first cycle, then continues with the router while nothing changes', async () => {
    const { provider, inner } = cadenced('decision-points');
    const first = await provider.decide(planning(), withPlan);
    expect(first).toMatchObject({
      decision: 'REQUEST_PLANNER',
      reasonCodes: ['MOCK_DECISION'],
      provider: 'mock-decision-provider',
      factsUsed: { cadence: 'model', cadenceWhy: 'the first cycle of the session', modelMs: 250 },
    });
    const next = await provider.decide(planning(), withPlan);
    expect(next).toEqual({
      ...routeDecision(planning(), withPlan),
      provider: 'continuing(deterministic-router)',
      factsUsed: {
        ...routeDecision(planning(), withPlan).factsUsed,
        cadence: 'continuing',
        cadenceWhy: 'nothing changed since the previous cycle: plan #1 step 1/1 (GATHER) goes on',
      },
    });
    expect(inner.calls).toHaveLength(1);
  });

  it("applies the router's binding decision without asking anyone, then asks the model once it is over", async () => {
    const { provider, inner } = cadenced('decision-points');
    await provider.decide(planning(), withPlan);
    const fled = await provider.decide(planning(lava), withPlan);
    expect(fled).toMatchObject({
      decision: 'RETREAT_HOME',
      reasonCodes: ['HAZARD_NEARBY'],
      provider: 'safety-first(mock-decision-provider)',
      factsUsed: {
        cadence: 'binding',
        cadenceWhy: "the router's decision is binding (HAZARD_NEARBY): the model is not asked",
      },
    });
    expect(inner.calls).toHaveLength(1);

    const after = await provider.decide(planning(), withPlan);
    expect(after.factsUsed).toMatchObject({
      cadence: 'model',
      cadenceWhy:
        "the router's decision changed: RETREAT_HOME [HAZARD_NEARBY] -> REQUEST_PLANNER [NO_KNOWN_STEP]; " +
        'dangers changed: HAZARD_PROXIMITY -> none',
    });
    expect(inner.calls).toHaveLength(2);
  });

  it("a session's start asks the model again", async () => {
    const { provider, inner } = cadenced('decision-points');
    await provider.decide(planning(), withPlan);
    await provider.decide(planning(), withPlan);
    provider.startSession();
    const d = await provider.decide(planning(), withPlan);
    expect(d.factsUsed['cadenceWhy']).toBe('the first cycle of the session');
    expect(inner.calls).toHaveLength(2);
  });

  it('a model that chose otherwise than the router is asked again, until it agrees', async () => {
    const answer = (decision: Decision): DecisionResult => ({
      decision,
      confidence: 0.9,
      reasonCodes: ['MOCK_DECISION'],
      factsUsed: {},
      requiresHumanConfirmation: false,
      provider: 'mock-decision-provider',
    });
    const model = new MockDecisionProvider([
      answer('WAIT_FOR_MACHINE'),
      answer('WAIT_FOR_MACHINE'),
      answer('REQUEST_PLANNER'),
    ]);
    const { provider } = cadenced('decision-points', model);
    const got: DecisionResult[] = [];
    for (let i = 0; i < 5; i++) got.push(await provider.decide(planning(), withPlan));
    expect(got.map((d) => [d.decision, d.factsUsed['cadence']])).toEqual([
      ['WAIT_FOR_MACHINE', 'model'],
      ['WAIT_FOR_MACHINE', 'model'],
      ['REQUEST_PLANNER', 'model'],
      ['REQUEST_PLANNER', 'continuing'],
      ['REQUEST_PLANNER', 'continuing'],
    ]);
    expect(got[1]?.factsUsed['cadenceWhy']).toBe(
      'the model chose WAIT_FOR_MACHINE last cycle, the router REQUEST_PLANNER',
    );
    expect(model.calls).toHaveLength(3);
  });

  it('every-cycle asks the model every cycle the router does not decide alone', async () => {
    const { provider, inner } = cadenced('every-cycle');
    for (let i = 0; i < 3; i++) {
      const d = await provider.decide(planning(), withPlan);
      expect(d.factsUsed['cadence']).toBe('model');
    }
    expect((await provider.decide(planning(lava), withPlan)).factsUsed['cadence']).toBe('binding');
    expect(inner.calls).toHaveLength(3);
  });

  it("a model's bad answer is handled exactly as before (safety-first), and still counts as asked", async () => {
    const broken: DecisionProvider = {
      name: 'boom',
      decide: () => Promise.reject(new Error('model offline')),
    };
    const { provider } = cadenced('decision-points', broken);
    const d = await provider.decide(planning(), withPlan);
    expect(d).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['PROVIDER_OUTPUT_INVALID'],
      provider: 'safety-first(boom)',
      factsUsed: { cadence: 'model', cadenceWhy: 'the first cycle of the session' },
    });

    // A pause the facts rule out is overruled by the router's decision, as before.
    const pausing = cadenced('decision-points', MockDecisionProvider.always('PAUSE_AND_ASK_USER'));
    const overruled = await pausing.provider.decide(planning(), withPlan);
    expect(overruled.decision).toBe('REQUEST_PLANNER');
    expect(overruled.factsUsed['overruled']).toContain('chose PAUSE_AND_ASK_USER');
    expect(overruled.factsUsed['cadence']).toBe('model');
  });

  it('without plan facts, every plan request is a decision point (when in doubt, ask)', async () => {
    const { provider, inner } = cadenced('decision-points');
    await provider.decide(planning(), routerCtx());
    const d = await provider.decide(planning(), routerCtx());
    expect(d.factsUsed['cadenceWhy']).toBe('no open plan to continue');
    expect(inner.calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Stats for the end of a session
// ---------------------------------------------------------------------------

const decided = (cadence?: string, modelMs?: number): DecisionResult => ({
  decision: 'REQUEST_PLANNER',
  confidence: 0.5,
  reasonCodes: ['NO_KNOWN_STEP'],
  factsUsed: {
    ...(cadence === undefined ? {} : { cadence }),
    ...(modelMs === undefined ? {} : { modelMs }),
  },
  requiresHumanConfirmation: false,
  provider: 'test',
});

describe('System 1 stats', () => {
  it('counts model decisions, continued cycles and binding decisions, with the model times', () => {
    const s = system1Stats([
      decided('model', 2100),
      decided('continuing'),
      decided('continuing'),
      decided('binding'),
      decided(), // e.g. a hard-safety pause: no provider was asked
      null, // a cycle that failed before deciding
      decided('model', 9800),
      decided('model', 1900),
    ]);
    expect(s).toEqual({
      decisions: 7,
      model: 3,
      continued: 2,
      binding: 1,
      modelMs: [2100, 9800, 1900],
    });
    expect(describeSystem1Stats(s)).toBe(
      'System 1 over 7 cycle(s): 3 model decision(s) (median 2.1 s), ' +
        '2 continued without the model, 1 binding router decision(s)',
    );
    expect(describeSystem1Stats(mergeSystem1Stats(s, s))).toBe(
      'System 1 over 14 cycle(s): 6 model decision(s) (median 2.1 s), ' +
        '4 continued without the model, 2 binding router decision(s)',
    );
    expect(Object.isFrozen(NO_SYSTEM1_STATS)).toBe(true);
    expect(mergeSystem1Stats(NO_SYSTEM1_STATS, s)).toEqual(s);
  });

  it('has no line when the rule router decided everything (no model configured)', () => {
    expect(describeSystem1Stats(system1Stats([decided(), decided()]))).toBeNull();
    expect(describeSystem1Stats(NO_SYSTEM1_STATS)).toBeNull();
    expect(describeSystem1Stats(system1Stats([decided('continuing')]))).toBe(
      'System 1 over 1 cycle(s): 0 model decision(s), 1 continued without the model, ' +
        '0 binding router decision(s)',
    );
  });

  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
