import { describe, expect, it } from 'vitest';
import {
  runSingleCycle,
  syncConfigToDatabase,
  type CycleResult,
} from '../../src/app/agent-loop.ts';
import {
  approvePlan,
  rejectPlan,
  showPlans,
  type PlanCommandResult,
} from '../../src/app/plan-commands.ts';
import { findScenario } from '../../src/app/scenarios.ts';
import { MockMinecraftClient } from '../../src/bot/mock-minecraft-client.ts';
import {
  MockPlannerProvider,
  type PlannerFixture,
} from '../../src/planner/mock-planner-provider.ts';
import type { Plan } from '../../src/planner/plan-schema.ts';
import { DeterministicDecisionProvider } from '../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { memoryRepos, testClock, testConfig } from '../fixtures/index.ts';

/** One world, one database and one planner, shared by several single cycles. */
async function session(name: string, fixtures?: readonly PlannerFixture[]) {
  const s = findScenario(name);
  if (s === undefined) throw new Error(`no scenario ${name}`);
  const clock = testClock();
  const repos = memoryRepos(clock);
  const config = testConfig();
  syncConfigToDatabase(config, repos);
  const client = new MockMinecraftClient(s.world(), clock);
  s.setup?.(client);
  await client.connect();
  const planner = new MockPlannerProvider(fixtures ?? s.plannerFixtures ?? []);
  const deps = {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner,
    clock,
    newId: sequentialIds(),
  };
  return {
    repos,
    client,
    planner,
    taskId: `task-${name}`,
    cycle(): Promise<CycleResult> {
      clock.advance(1000);
      return runSingleCycle(deps);
    },
  };
}

const twoStepPlan = (overrides: Partial<Plan> = {}): Plan => ({
  goal: 'Fetch cobblestone for the next step',
  steps: [
    {
      step: 1,
      action: {
        type: 'WITHDRAW_ITEM',
        args: { containerId: 'chest.main', item: 'minecraft:cobblestone', quantity: 64 },
      },
      rationale: 'Cobblestone is needed and the main chest has some.',
    },
    {
      step: 2,
      action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
      rationale: 'Confirm the macerator is idle before continuing.',
    },
  ],
  requiresUserApproval: false,
  explanation: 'Two low-risk steps using only known containers and machines.',
  failureHandling: {
    onStepFailure: 'PAUSE_AND_ASK_USER',
    maxRetriesPerStep: 1,
    escalationMessage: 'Could not fetch cobblestone.',
  },
  ...overrides,
});

/** The error of a failed plan command ('' if it succeeded). */
const errorOf = (r: PlanCommandResult): string => (r.ok ? '' : r.error);

const fixture = (plan: Plan): PlannerFixture[] => [
  { name: 'plan', when: {}, response: { kind: 'plan', plan } },
];

describe('stored plans advance one verified step per cycle', () => {
  it('runs a two-step plan over two cycles without asking the planner again', async () => {
    const s = await session('needs-planner');

    const first = await s.cycle();
    expect(first.planner).toEqual({
      kind: 'plan-accepted',
      planId: 1,
      goal: 'Fetch cobblestone for the next step',
      steps: 2,
    });
    expect(first.action).toMatchObject({ type: 'WITHDRAW_ITEM', origin: 'planner' });
    expect(first.status).toBe('succeeded');

    const second = await s.cycle();
    expect(second.planner).toMatchObject({ kind: 'plan-step', planId: 1, step: 2, steps: 2 });
    expect(second.action).toMatchObject({ type: 'INSPECT_MACHINE', origin: 'planner' });
    expect(second.status).toBe('succeeded');

    expect(s.planner.requests).toHaveLength(1);
    expect(s.repos.plans.get(1)).toMatchObject({
      status: 'completed',
      nextStep: 2,
      statusReason: 'all steps verified',
    });
    expect(s.repos.checkpoints.list(s.taskId).map((c) => c.label)).toEqual([
      'plan',
      'WITHDRAW_ITEM:succeeded',
      'INSPECT_MACHINE:succeeded',
    ]);

    // With the plan finished and still no known step, the next cycle plans afresh.
    const third = await s.cycle();
    expect(third.planner).toMatchObject({ kind: 'plan-accepted', planId: 2 });
    expect(s.planner.requests).toHaveLength(2);
  });

  it('retries a failed step within the plan budget, then fails the plan and pauses the task', async () => {
    const s = await session('needs-planner');
    s.client.failNext('WITHDRAW_ITEM', 'simulated failure', 2);

    const first = await s.cycle();
    expect(first.status).toBe('failed');
    expect(s.repos.plans.get(1)).toMatchObject({ status: 'active', nextStep: 0, stepFailures: 1 });
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('active');

    const second = await s.cycle();
    expect(second.planner).toMatchObject({ kind: 'plan-step', step: 1 });
    expect(second.status).toBe('failed');
    expect(second.needsUserAttention).toBe(true);
    expect(s.repos.plans.get(1)).toMatchObject({
      status: 'failed',
      statusReason: 'step 1 failed 2 time(s)',
    });
    // PAUSE_AND_ASK_USER policy: the task waits for a human.
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('paused');

    const third = await s.cycle();
    expect(third.action?.type).toBe('PAUSE_AND_ASK_USER');
    expect(s.planner.requests).toHaveLength(1);
  });

  it('REPLAN asks the planner again, and the repeated-failure rule still stops the same action', async () => {
    const plan = twoStepPlan({
      failureHandling: {
        onStepFailure: 'REPLAN',
        maxRetriesPerStep: 1,
        escalationMessage: 'Could not fetch cobblestone.',
      },
    });
    const s = await session('needs-planner', fixture(plan));
    s.client.failNext('WITHDRAW_ITEM', 'simulated failure', 5);

    await s.cycle();
    const second = await s.cycle();
    expect(second.status).toBe('failed');
    expect(s.repos.plans.get(1)?.status).toBe('failed');
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('active');

    const third = await s.cycle();
    // The new plan starts with the step that failed twice: the planner is asked once more,
    // told so; it answers the same, and the repeated-failure rule refuses the step.
    expect(s.planner.requests).toHaveLength(3);
    expect(s.planner.requests[2]?.journal.at(-1)).toMatch(/WITHDRAW_ITEM .* failed 2 time/);
    expect(third.planner).toMatchObject({ kind: 'plan-accepted', planId: 2 });
    expect(third.summary).toBe('REQUEST_PLANNER -> WITHDRAW_ITEM -> rejected [REPEATED_FAILURE]');
    expect(s.repos.plans.get(2)).toMatchObject({ status: 'failed' });
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('blocked');
  });

  it('a step that is not feasible now fails the plan; the task goes on and the planner is asked again', async () => {
    const plan = twoStepPlan({
      steps: [
        {
          step: 1,
          action: {
            type: 'WITHDRAW_ITEM',
            args: { containerId: 'chest.main', item: 'minecraft:sand', quantity: 1 },
          },
          rationale: 'The chest is assumed to hold sand (it holds only cobblestone).',
        },
      ],
    });
    const s = await session('needs-planner', fixture(plan));
    const result = await s.cycle();
    expect(result.status).toBe('rejected');
    expect(s.client.performed).toHaveLength(0);
    expect(s.repos.plans.get(1)?.status).toBe('failed');
    expect(s.repos.plans.get(1)?.statusReason).toMatch(/^step 1 rejected: /);
    // Only a precondition failed (no safety rule): a stale plan, not an unsafe one.
    expect(result.needsUserAttention).toBe(false);
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('active');
    expect((await s.cycle()).planner).toMatchObject({ kind: 'plan-accepted', planId: 2 });
  });

  it('a dig of a block no longer listed is refused as stale: the planner is asked again', async () => {
    const plan = twoStepPlan({
      steps: [
        {
          step: 1,
          action: { type: 'DIG_BLOCK', args: { position: { x: 9, y: 64, z: 9 } } },
          rationale: 'A block that was listed when the plan was made, but is not now.',
        },
      ],
    });
    const s = await session('needs-planner', fixture(plan));
    const result = await s.cycle();
    expect(result.status).toBe('rejected');
    expect(result.outcome?.validation.violations.map((v) => v.code)).toEqual(['NOT_DIGGABLE']);
    expect(s.client.performed).toHaveLength(0);
    expect(result.needsUserAttention).toBe(false);
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('active');
  });

  it('a step the safety policy rejects fails the plan and blocks the task', async () => {
    const plan = twoStepPlan({
      steps: [
        {
          step: 1,
          action: { type: 'OPEN_CONTAINER', args: { containerId: 'chest.nope' } },
          rationale: 'A container the agent does not know.',
        },
      ],
    });
    const s = await session('needs-planner', fixture(plan));
    const result = await s.cycle();
    expect(result.status).toBe('rejected');
    expect(result.needsUserAttention).toBe(true);
    expect(s.client.performed).toHaveLength(0);
    expect(s.repos.plans.get(1)?.status).toBe('failed');
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('blocked');
  });
});

describe('plans that need approval wait for a human', () => {
  it('runs nothing but pauses until the plan is approved, then runs it step by step', async () => {
    const s = await session('planner-needs-approval');

    const first = await s.cycle();
    expect(first.planner).toMatchObject({ kind: 'approval-required', planId: 1, steps: 2 });
    expect(first.status).toBe('paused');
    expect(JSON.stringify(first.action?.args)).toContain(
      `plan-approve (or plan-reject) --task ${s.taskId} --plan 1`,
    );
    expect(s.repos.plans.get(1)?.status).toBe('pending_approval');
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('paused');

    // Still paused: the router stops before the planner.
    const second = await s.cycle();
    expect(second.decision?.reasonCodes).toEqual(['NO_ACTIVE_TASK']);
    expect(second.planner).toBeNull();

    // Resuming the task is not approving the plan: it asks again, without re-planning.
    s.repos.tasks.setStatus(s.taskId, 'active');
    const third = await s.cycle();
    expect(third.planner).toMatchObject({ kind: 'approval-pending', planId: 1 });
    expect(third.status).toBe('paused');
    expect(s.planner.requests).toHaveLength(1);
    expect(s.client.performed.map((p) => p.action.type)).toEqual([
      'PAUSE_AND_ASK_USER',
      'PAUSE_AND_ASK_USER',
      'PAUSE_AND_ASK_USER',
    ]);

    // Approval is pinned to the reviewed plan.
    expect(errorOf(approvePlan(s.repos, s.taskId, 2))).toContain('that is #1');
    expect(approvePlan(s.repos, s.taskId, 1)).toMatchObject({
      ok: true,
      value: { planId: 1, status: 'active', task: { previousStatus: 'paused', status: 'active' } },
    });
    expect(errorOf(approvePlan(s.repos, s.taskId, 1))).toContain('latest plan #1 is active');

    const fourth = await s.cycle();
    expect(fourth.planner).toMatchObject({ kind: 'plan-step', planId: 1, step: 1, steps: 2 });
    expect(fourth.action).toMatchObject({ type: 'WITHDRAW_ITEM', origin: 'planner' });
    expect(fourth.status).toBe('succeeded');

    const fifth = await s.cycle();
    expect(fifth.action?.type).toBe('INSPECT_MACHINE');
    expect(s.repos.plans.get(1)?.status).toBe('completed');
    expect(s.planner.requests).toHaveLength(1);

    const shown = showPlans(s.repos, s.taskId);
    expect(shown).toMatchObject({
      ok: true,
      value: {
        planId: 1,
        status: 'completed',
        statusReason: 'all steps verified',
        steps: [{ progress: 'done' }, { progress: 'done' }],
      },
    });
  });

  it('a rejected plan is never run; resuming the task asks for a new plan', async () => {
    const s = await session('planner-needs-approval');
    await s.cycle();

    expect(showPlans(s.repos, undefined)).toMatchObject({
      ok: true,
      value: { openPlans: [{ planId: 1, taskId: s.taskId, status: 'pending_approval' }] },
    });
    expect(showPlans(s.repos, s.taskId)).toMatchObject({
      ok: true,
      value: { steps: [{ progress: 'not run' }, { progress: 'not run' }] },
    });

    expect(rejectPlan(s.repos, s.taskId, undefined, 'too risky')).toMatchObject({
      ok: true,
      value: { planId: 1, previousStatus: 'pending_approval', status: 'rejected' },
    });
    expect(s.repos.plans.get(1)?.statusReason).toBe('rejected by the user: too risky');
    expect(s.repos.tasks.get(s.taskId)?.status).toBe('paused');
    expect(errorOf(approvePlan(s.repos, s.taskId, undefined))).toContain(
      'latest plan #1 is rejected',
    );
    expect(rejectPlan(s.repos, s.taskId, undefined, undefined)).toMatchObject({ ok: false });

    s.repos.tasks.setStatus(s.taskId, 'active');
    const next = await s.cycle();
    expect(s.planner.requests).toHaveLength(2);
    expect(next.planner).toMatchObject({ kind: 'approval-required', planId: 2 });
    expect(s.client.performed.every((p) => p.action.type === 'PAUSE_AND_ASK_USER')).toBe(true);
  });

  it('plan commands refuse unknown tasks', async () => {
    const s = await session('planner-needs-approval');
    expect(approvePlan(s.repos, 'task-nope', undefined)).toEqual({
      ok: false,
      error: 'No task task-nope',
    });
    expect(rejectPlan(s.repos, 'task-nope', undefined, undefined)).toMatchObject({ ok: false });
    expect(showPlans(s.repos, 'task-nope')).toMatchObject({ ok: false });
  });
});
