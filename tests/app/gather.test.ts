import { describe, expect, it } from 'vitest';
import {
  OPERATOR_PLANNER,
  runSingleCycle,
  syncConfigToDatabase,
  type CycleResult,
} from '../../src/app/agent-loop.ts';
import type { MockResourceBlock, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import type { DiggableBlock } from '../../src/domain/blocks.ts';
import type { BlockPosition } from '../../src/domain/common.ts';
import { FOOD_TASK_ID } from '../../src/domain/food.ts';
import type { Plan, PlannerRequest, PlannerResponse } from '../../src/planner/plan-schema.ts';
import type { PlannerProvider } from '../../src/planner/planner-provider.ts';
import { actionFingerprint } from '../../src/safety/safety-policy.ts';
import { DeterministicDecisionProvider } from '../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { makeWorld, memoryRepos, testClock, testConfig } from '../fixtures/index.ts';

// The mock player starts at (1, 64, 1). The sand lies in rows at y 64 along z = 5 and z = 6,
// from x = 0; each block's stand spot is on the north side of its column (z 4.5), as the
// live client would list it.
function sandRows(perRow: number): MockResourceBlock[] {
  return [5, 6].flatMap((z) =>
    Array.from({ length: perRow }, (_, x) => ({
      block: 'minecraft:sand' as const,
      position: { x, y: 64, z },
      standAt: { x: x + 0.5, y: 64, z: 4.5 },
    })),
  );
}

const plan = (steps: Array<Plan['steps'][number]['action']>, goal = 'Gather sand'): Plan => ({
  goal,
  steps: steps.map((action, i) => ({ step: i + 1, action, rationale: 'the route says so' })),
  requiresUserApproval: false,
  explanation: 'Code digs the blocks one by one.',
  failureHandling: {
    onStepFailure: 'REPLAN',
    maxRetriesPerStep: 1,
    escalationMessage: 'Could not gather.',
  },
});
const gatherOf = (block: DiggableBlock, count: number): PlannerResponse => ({
  kind: 'plan',
  plan: plan([{ type: 'GATHER', args: { block, count } }], `Gather ${count} ${block}`),
});
const NO_PLAN: PlannerResponse = {
  kind: 'escalation',
  escalation: { reason: 'OTHER', message: 'no more plans', questionForUser: 'What now?' },
};

/** A world with these resource blocks, a planner that answers `responses` in turn. */
function gathering(blocks: MockResourceBlock[], ...responses: PlannerResponse[]) {
  return gatheringIn((w) => void (w.resourceBlocks = blocks), ...responses);
}

/** A world as `mutate` makes it, a planner that answers `responses` in turn. */
async function gatheringIn(mutate: (w: MockWorld) => void, ...responses: PlannerResponse[]) {
  const clock = testClock();
  const { world, client } = makeWorld((w) => {
    w.recipe = null; // no known step: System 1 asks for the plan
    mutate(w);
  }, clock);
  await client.connect();
  const repos = memoryRepos(clock);
  const config = testConfig();
  syncConfigToDatabase(config, repos);
  const requests: PlannerRequest[] = [];
  const planner: PlannerProvider = {
    name: 'scripted',
    plan: (request) => {
      requests.push(request);
      return Promise.resolve(responses.shift() ?? NO_PLAN);
    },
  };
  const deps = {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner,
    clock,
    newId: sequentialIds(),
  };
  const taskId = world.task?.taskId ?? 'task-test';
  const cycle = (): Promise<CycleResult> => {
    clock.advance(500);
    return runSingleCycle(deps);
  };
  return {
    world,
    client,
    repos,
    clock,
    requests,
    taskId,
    cycle,
    /** Cycles until `stop` holds after one (at most `max`). */
    async until(stop: (r: CycleResult) => boolean, max = 200): Promise<CycleResult[]> {
      const results: CycleResult[] = [];
      while (results.length < max) {
        const r = await cycle();
        results.push(r);
        if (stop(r)) break;
      }
      return results;
    },
    journal: (): string[] => repos.memory.journal(taskId).map((e) => e.text),
    performed: (): ActionSpec[] =>
      client.performed.map((p) => ({ type: p.action.type, args: p.action.args }) as ActionSpec),
  };
}

const at = (spec: ActionSpec | undefined): BlockPosition | null =>
  spec?.type === 'DIG_BLOCK' ? spec.args.position : null;

describe('GATHER: one plan step, many checked actions', () => {
  it('gathers 54 sand with ONE planner call: one validated, verified action per cycle', async () => {
    const g = await gathering(sandRows(27), gatherOf('minecraft:sand', 54));
    const results = await g.until(() => g.repos.plans.get(1)?.status !== 'active');

    expect(g.requests).toHaveLength(1);
    expect(g.repos.plans.get(1)).toMatchObject({ status: 'completed', nextStep: 1 });
    expect(g.world.inventory.items['minecraft:sand']).toBe(54);
    const types = g.performed().map((s) => s.type);
    expect(types.filter((t) => t === 'DIG_BLOCK')).toHaveLength(54);
    expect(new Set(types)).toEqual(new Set(['MOVE_TO', 'DIG_BLOCK']));
    expect(types.length).toBeLessThanOrEqual(64);
    expect(results).toHaveLength(types.length);
    // Every one went through the executor: logged, validated, executed and verified.
    const logged = g.repos.actions.recent(100, g.taskId);
    expect(logged).toHaveLength(types.length);
    expect(logged.every((a) => a.origin === 'planner' && a.status === 'succeeded')).toBe(true);
    expect(results.every((r) => r.summary.startsWith('REQUEST_PLANNER -> '))).toBe(true);
    expect(results[1]?.action?.reason).toMatch(
      /^plan #1 "Gather 54 minecraft:sand" step 1\/1: GATHER 54 minecraft:sand: dig \(\d+, 64, [56]\) \(\d+\/54 gathered, action 2 of at most 64\)$/,
    );

    expect(g.journal()).toEqual([
      'new plan #1: Gather 54 minecraft:sand (1 steps)',
      expect.stringMatching(
        /^GATHER 54 minecraft:sand \(plan #1 step 1\) started: counts minecraft:sand, 0 held; \d+ minecraft:sand listed in view$/,
      ),
      expect.stringMatching(/^GATHER 54 minecraft:sand: 16 dug, 16\/54 gathered, \d+ action\(s\)/),
      expect.stringMatching(/^GATHER 54 minecraft:sand: 32 dug, 32\/54 gathered/),
      expect.stringMatching(/^GATHER 54 minecraft:sand: 48 dug, 48\/54 gathered/),
      expect.stringMatching(
        /^GATHER 54 minecraft:sand done; 54 dug, 54\/54 gathered, \d+ action\(s\), [\d.]+ min$/,
      ),
      'plan #1 done: Gather 54 minecraft:sand',
    ]);
    // The progress is gone with the step.
    expect(g.repos.memory.getValue(`task_gather:${g.taskId}`)).toBeNull();
  });

  it('nothing left in view: the step fails as stale, and the next cycle asks the planner (EXPLORE)', async () => {
    const explore: PlannerResponse = {
      kind: 'plan',
      plan: plan([{ type: 'EXPLORE', args: { toward: 'east', maxDistance: 32 } }], 'Find sand'),
    };
    const g = await gathering(sandRows(2), gatherOf('minecraft:sand', 10), explore);
    const results = await g.until((r) => r.action === null);

    expect(g.world.inventory.items['minecraft:sand']).toBe(4);
    expect(results.at(-1)).toMatchObject({
      status: 'succeeded',
      action: null,
      outcome: null,
      needsUserAttention: false,
      planner: { kind: 'plan-step', planId: 1 },
      summary: 'REQUEST_PLANNER -> GATHER:no-target -> succeeded',
    });
    expect(g.repos.plans.get(1)).toMatchObject({
      status: 'failed',
      statusReason: 'step 1 GATHER stale: no minecraft:sand left in view to dig',
    });
    expect(g.repos.tasks.get(g.taskId)?.status).toBe('active');
    expect(g.journal().at(-1)).toMatch(
      /^GATHER 10 minecraft:sand ended: no minecraft:sand left in view to dig; plan again \(EXPLORE for more if the task still needs it\); 4 dug, 4\/10 gathered/,
    );
    expect(g.requests).toHaveLength(1);

    const next = await g.cycle();
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]?.journal.at(-1)).toMatch(/no minecraft:sand left in view to dig/);
    expect(next).toMatchObject({ status: 'succeeded', action: { type: 'EXPLORE' } });
  });

  it('a new plan whose GATHER has nothing to dig is refused as stale; the task goes on', async () => {
    const g = await gathering(sandRows(2), gatherOf('minecraft:gravel', 10));
    const r = await g.cycle();
    expect(r).toMatchObject({
      status: 'rejected',
      action: null,
      needsUserAttention: false,
      planner: { kind: 'plan-accepted', planId: 1, steps: 1 },
      summary: 'REQUEST_PLANNER -> GATHER:no-target -> rejected',
    });
    expect(g.client.performed).toHaveLength(0);
    expect(g.repos.plans.get(1)?.status).toBe('failed');
    expect(g.repos.tasks.get(g.taskId)?.status).toBe('active');
    expect(g.journal().at(-1)).toBe(
      'GATHER 10 minecraft:gravel (plan #1 step 1) ended: no minecraft:gravel left in view to dig; ' +
        'plan again (EXPLORE for more if the task still needs it)',
    );
    expect(g.repos.checkpoints.list(g.taskId).map((c) => c.label)).toEqual([
      'plan',
      'GATHER:no-target',
    ]);
  });

  it('a GATHER with nothing to dig is skipped when the plan goes on: the next GATHER runs', async () => {
    // Seen live: GATHER 9 gravel (none in view), then GATHER 7 logs (66 in view).
    const both: PlannerResponse = {
      kind: 'plan',
      plan: plan(
        [
          { type: 'GATHER', args: { block: 'minecraft:gravel', count: 9 } },
          { type: 'GATHER', args: { block: 'minecraft:sand', count: 2 } },
        ],
        'Gravel and sand',
      ),
    };
    const g = await gathering(sandRows(2), both);
    const first = await g.cycle();
    expect(first).toMatchObject({
      status: 'succeeded',
      summary: 'REQUEST_PLANNER -> GATHER:no-target, skipped -> succeeded',
    });
    expect(g.repos.plans.get(1)).toMatchObject({ status: 'active', nextStep: 1 });
    expect(g.journal()).toContainEqual(
      expect.stringMatching(/^plan #1 step 1 GATHER skipped \(no minecraft:gravel left in view/),
    );
    // The sand GATHER runs next (a walk to the sand first), with no new plan.
    const second = await g.cycle();
    expect(['MOVE_TO', 'DIG_BLOCK']).toContain(g.performed()[0]?.type);
    expect(second.planner).toMatchObject({ kind: 'plan-step', planId: 1 });
    expect(g.requests).toHaveLength(1);
  });

  it('ends at 64 actions for a checkpoint: the next cycle asks the planner with fresh stock', async () => {
    const g = await gathering(
      sandRows(60),
      gatherOf('minecraft:sand', 200),
      gatherOf('minecraft:sand', 200),
    );
    const results = await g.until(() => g.repos.plans.get(1)?.status !== 'active');
    expect(results).toHaveLength(64);
    expect(g.client.performed).toHaveLength(64);
    expect(results.every((r) => r.status === 'succeeded')).toBe(true);
    expect(g.repos.plans.get(1)).toMatchObject({
      status: 'failed',
      statusReason: 'step 1 GATHER checkpoint: its bound of 64 actions',
    });
    expect(g.journal().at(-1)).toMatch(
      /^GATHER 200 minecraft:sand ended at its bound of 64 actions: a checkpoint, plan again with fresh stock; \d+ dug, \d+\/200 gathered, 64 action\(s\)/,
    );
    expect(g.requests).toHaveLength(1);

    const held = g.world.inventory.items['minecraft:sand'] ?? 0;
    const next = await g.cycle();
    expect(g.requests).toHaveLength(2);
    expect(next.planner).toMatchObject({ kind: 'plan-accepted', planId: 2 });
    expect(['DIG_BLOCK', 'MOVE_TO']).toContain(next.action?.type);
    // The new step counts from what is held now.
    expect(g.journal().at(-2)).toMatch(/^new plan #2/);
    expect(g.journal().at(-1)).toContain(`started: counts minecraft:sand, ${held} held`);
  });

  it('ends after 5 minutes for a checkpoint, also when the time passed between cycles', async () => {
    const g = await gathering(sandRows(10), gatherOf('minecraft:sand', 20));
    await g.cycle();
    await g.cycle();
    g.clock.advance(5 * 60_000);
    const r = await g.cycle();
    expect(r).toMatchObject({
      status: 'succeeded',
      action: null,
      summary: 'REQUEST_PLANNER -> GATHER:bound -> succeeded',
    });
    expect(g.repos.plans.get(1)?.statusReason).toBe(
      'step 1 GATHER checkpoint: its bound of 5 minutes',
    );
    expect(g.client.performed).toHaveLength(2);
  });

  it("a failed dig's block is not tried again; failures in a row meet the plan's failure handling", async () => {
    const g = await gathering(sandRows(4), gatherOf('minecraft:sand', 6));
    expect((await g.cycle()).action?.type).toBe('MOVE_TO'); // nothing within reach yet
    g.client.failNext('DIG_BLOCK', 'simulated: the server re-sent the block');
    const failed = await g.cycle();
    expect(failed.status).toBe('failed');
    const first = at(g.performed().at(-1));
    expect(g.repos.plans.get(1)).toMatchObject({ status: 'active', stepFailures: 1 });

    const ok = await g.cycle();
    expect(ok.status).toBe('succeeded');
    expect(at(g.performed().at(-1))).not.toEqual(first);
    // A verified action of the step: the failures in a row start again from zero.
    expect(g.repos.plans.get(1)?.stepFailures).toBe(0);

    g.client.failNext('DIG_BLOCK', 'simulated: the server re-sent the block', 2);
    await g.cycle();
    await g.cycle();
    expect(g.repos.plans.get(1)).toMatchObject({
      status: 'failed',
      statusReason: 'step 1 failed 2 time(s)',
    });
    // The failed blocks were each tried once only.
    const digs = g.performed().flatMap((s) => (s.type === 'DIG_BLOCK' ? [JSON.stringify(s)] : []));
    expect(new Set(digs).size).toBe(digs.length);
    expect(g.journal().slice(-2)).toEqual([
      expect.stringMatching(
        /^GATHER 6 minecraft:sand ended with its plan: its DIG_BLOCK did not succeed 2 time\(s\) in a row; 1 dug, 1\/6 gathered, 5 action\(s\)/,
      ),
      expect.stringMatching(/^plan #1 failed at step 1 \(DIG_BLOCK\) 2 time\(s\)/),
    ]);
    // REPLAN: the task goes on, and the next cycle asks the planner again.
    expect(g.repos.tasks.get(g.taskId)?.status).toBe('active');
    await g.cycle();
    expect(g.requests).toHaveLength(2);
  });

  it('System 1 still comes first: a mob interrupts the GATHER, which then goes on without a new plan', async () => {
    const g = await gathering(sandRows(6), gatherOf('minecraft:sand', 8));
    await g.cycle();
    await g.cycle();
    g.world.hostiles.push({ x: 4, y: 64, z: 8 });
    const fled = await g.cycle();
    expect(fled.decision?.decision).toBe('RETREAT_HOME');
    expect(fled.action?.type).toBe('RETURN_TO_SAFE_LOCATION');
    expect(g.repos.plans.get(1)?.status).toBe('active');

    g.world.hostiles = [];
    await g.until(() => g.repos.plans.get(1)?.status !== 'active');
    expect(g.repos.plans.get(1)?.status).toBe('completed');
    expect(g.requests).toHaveLength(1);
    expect(g.world.inventory.items['minecraft:sand']).toBe(8);
  });

  it('never proposes a dig the safety policy would refuse: it passes over sand above its head', async () => {
    const g = await gathering(
      [
        // Right above the player's head: it would fall on it (UNSAFE_DIG). Nearest, too.
        {
          block: 'minecraft:sand',
          position: { x: 1, y: 66, z: 1 },
          standAt: { x: 1.5, y: 64, z: 2.5 },
        },
        {
          block: 'minecraft:sand',
          position: { x: 3, y: 64, z: 1 },
          standAt: { x: 2.5, y: 64, z: 1.5 },
        },
      ],
      gatherOf('minecraft:sand', 1),
    );
    const r = await g.cycle();
    expect(r).toMatchObject({
      status: 'succeeded',
      action: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 64, z: 1 } } },
    });
    expect(g.repos.violations.recent(10)).toEqual([]);
    expect(g.repos.plans.get(1)?.status).toBe('completed');
  });

  it('passes over a block whose dig already failed twice for the task (no REPEATED_FAILURE stop)', async () => {
    const g = await gathering(
      [
        {
          block: 'minecraft:sand',
          position: { x: 2, y: 64, z: 1 },
          standAt: { x: 1.5, y: 64, z: 1.5 },
        },
        {
          block: 'minecraft:sand',
          position: { x: 3, y: 64, z: 1 },
          standAt: { x: 2.5, y: 64, z: 1.5 },
        },
      ],
      gatherOf('minecraft:sand', 1),
    );
    const fingerprint = actionFingerprint({
      type: 'DIG_BLOCK',
      args: { position: { x: 2, y: 64, z: 1 } },
    });
    for (const id of ['old-1', 'old-2']) {
      g.repos.actions.insert({
        actionId: id,
        cycleId: null,
        taskId: g.taskId,
        actionType: 'DIG_BLOCK',
        origin: 'planner',
        fingerprint,
        reason: 'an earlier plan',
        action: {},
        status: 'failed',
        validation: { ok: true },
      });
    }
    const r = await g.cycle();
    expect(r.action).toMatchObject({
      type: 'DIG_BLOCK',
      args: { position: { x: 3, y: 64, z: 1 } },
    });
    expect(r.status).toBe('succeeded');
    expect(g.repos.tasks.get(g.taskId)?.status).toBe('active');
  });

  it("an operator's GATHER plan completes its task when the count is held", async () => {
    const g = await gathering(sandRows(3));
    g.repos.tasks.ensure({ id: g.taskId, goal: 'Gather sand', subgoal: null, status: 'active' });
    const stored = g.repos.plans.create(
      g.taskId,
      plan([{ type: 'GATHER', args: { block: 'minecraft:sand', count: 3 } }]),
      'active',
      OPERATOR_PLANNER,
    );
    await g.until(() => g.repos.plans.get(stored.id)?.status !== 'active');
    expect(g.repos.plans.get(stored.id)?.status).toBe('completed');
    expect(g.repos.tasks.get(g.taskId)?.status).toBe('completed');
    expect(g.requests).toHaveLength(0);
  });
});

describe('GATHER for food', () => {
  const huntPlan = (count: number): PlannerResponse => ({
    kind: 'plan',
    plan: plan([{ type: 'GATHER', args: { animal: 'minecraft:Cow', count } }], 'Hunt a cow'),
  });

  it('hunts a cow with ONE planner call: a walk next to it, strikes until it dies, its drops', async () => {
    const g = await gatheringIn((w) => {
      w.resourceBlocks = [];
      w.mobs = [
        {
          id: 501,
          type: 'minecraft:Cow',
          category: 'passive',
          position: { x: 6, y: 64, z: 1 },
          health: 10,
          drops: { 'minecraft:beef': 2, 'minecraft:leather': 1 },
        },
      ];
    }, huntPlan(3));
    await g.until(() => g.repos.plans.get(1)?.status !== 'active', 20);
    expect(g.requests).toHaveLength(1);
    expect(g.repos.plans.get(1)).toMatchObject({ status: 'completed' });
    expect(g.world.inventory.items).toMatchObject({ 'minecraft:beef': 2, 'minecraft:leather': 1 });
    // A bare hand deals 1 a hit, 8 hits a burst: the walk, then two bursts.
    expect(g.performed().map((s) => s.type)).toEqual(['MOVE_TO', 'ATTACK_ENTITY', 'ATTACK_ENTITY']);
    expect(g.journal()).toContain(
      'GATHER 3 minecraft:Cow (plan #1 step 1) started: counts minecraft:beef or minecraft:leather, ' +
        '0 held; 1 minecraft:Cow listed in view',
    );
    expect(g.journal()).toContainEqual(
      expect.stringMatching(/^GATHER 3 minecraft:Cow done; 2 attack\(s\), 3\/3 gathered/),
    );
  });

  it('starving on the food task by day: digs the gardens in view (and nothing else may run)', async () => {
    // Food 2 with nothing to eat (seen live): below minHunger, only the food task's walks,
    // EXPLOREs and garden digs may run (safety-policy.ts getsFood).
    const g = await gatheringIn(
      (w) => {
        w.player.hunger = 2;
        delete w.inventory.items['minecraft:bread'];
        w.task = { taskId: FOOD_TASK_ID, goal: 'Get food', subgoal: '0/10', status: 'active' };
        w.resourceBlocks = [
          { block: 'harvestcraft:berrygarden', position: { x: 1, y: 64, z: 3 } },
          {
            block: 'harvestcraft:grassgarden',
            position: { x: 7, y: 64, z: 1 },
            standAt: { x: 6.5, y: 64, z: 1.5 },
          },
        ];
      },
      {
        kind: 'plan',
        plan: plan(
          [{ type: 'GATHER', args: { block: 'harvestcraft:berrygarden', count: 3 } }],
          'Dig the berry garden',
        ),
      },
    );
    const results = await g.until((r) => r.action?.type === 'DIG_BLOCK', 5);
    expect(results.at(-1)).toMatchObject({
      status: 'succeeded',
      decision: { decision: 'REQUEST_PLANNER' },
    });
    expect(g.world.inventory.items['harvestcraft:blackberryItem']).toBe(3);
    expect(g.repos.plans.get(1)?.status).toBe('completed');
  });
});

describe('accepting a plan drops the steps planned from a view it replaces', () => {
  it('EXPLORE, EXPLORE, DIG_BLOCK runs as one EXPLORE; the journal and the plan say why', async () => {
    const g = await gathering(sandRows(2), {
      kind: 'plan',
      plan: plan([
        { type: 'EXPLORE', args: { toward: 'east', maxDistance: 32 } },
        { type: 'EXPLORE', args: { toward: 'south', maxDistance: 32 } },
        { type: 'DIG_BLOCK', args: { position: { x: 1, y: 64, z: 5 } } },
      ]),
    });
    const r = await g.cycle();
    expect(r).toMatchObject({
      status: 'succeeded',
      action: { type: 'EXPLORE' },
      planner: { kind: 'plan-accepted', planId: 1, steps: 1 },
    });
    const stored = g.repos.plans.get(1);
    expect(stored?.plan.steps.map((s) => s.action.type)).toEqual(['EXPLORE']);
    expect(stored?.plan.explanation).toMatch(/dropped steps 2-3 after the EXPLORE at step 1/);
    expect(stored?.status).toBe('completed');
    expect(g.journal()).toEqual([
      'new plan #1: Gather sand (1 steps; code dropped steps 2-3 after the EXPLORE at step 1)',
      'plan #1 done: Gather sand',
    ]);
    // The next plan starts from the new view.
    await g.cycle();
    expect(g.requests).toHaveLength(2);
  });

  it('after a GATHER, a step naming a position is dropped; crafting what it gathers stays', async () => {
    const g = await gathering(sandRows(2), {
      kind: 'plan',
      plan: plan([
        { type: 'GATHER', args: { block: 'minecraft:sand', count: 2 } },
        { type: 'CRAFT_ITEM', args: { recipe: 'planks_oak', times: 1, craftingTableId: null } },
        { type: 'MOVE_TO', args: { target: { x: 1, y: 64, z: 1 }, tolerance: 1 } },
        { type: 'WAIT', args: { durationMs: 1000 } },
      ]),
    });
    await g.cycle();
    expect(g.repos.plans.get(1)?.plan.steps.map((s) => s.action.type)).toEqual([
      'GATHER',
      'CRAFT_ITEM',
    ]);
    expect(g.journal()[0]).toBe(
      'new plan #1: Gather sand (2 steps; code dropped steps 3-4 after the GATHER at step 1)',
    );
  });
});
