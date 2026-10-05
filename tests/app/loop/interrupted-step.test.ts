import { describe, expect, it } from 'vitest';
import { updatePlanProgress, type PlanStepRef } from '../../../src/app/loop/plan-steps.ts';
import type { ExecutionOutcome } from '../../../src/executor/action-executor.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import type { Plan } from '../../../src/planner/plan-schema.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { makeState } from '../../fixtures/index.ts';

// An independent review, 2026-10-05: a stop during quest play failed the plan's step like any
// failure, and with a policy that waits for a person the task was left paused. A step its owner
// or operator stopped (the client marks it data.interrupted) is no failure of the plan.
const plan: Plan = {
  goal: 'look twice',
  steps: [
    {
      step: 1,
      action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
      rationale: 'first look',
    },
  ],
  requiresUserApproval: false,
  explanation: 'test plan',
  failureHandling: {
    onStepFailure: 'PAUSE_AND_ASK_USER',
    maxRetriesPerStep: 1,
    escalationMessage: 'stop',
  },
};

const failed = (interrupted: boolean): ExecutionOutcome => ({
  actionId: 'a1',
  actionType: 'INSPECT_MACHINE',
  status: 'failed',
  validation: { ok: true, violations: [], preconditionFailures: [], requiresUserPause: false },
  execution: {
    ok: false,
    code: 'FAILED',
    message: interrupted ? 'halted: stopped by DankAxon' : 'the machine is not in reach',
    data: interrupted ? { interrupted: true } : {},
  },
  verification: null,
  stateAfter: null,
});

describe('a plan step its owner or operator stopped', () => {
  it('is no failure of the plan: no count, no pause for a person', () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    repos.tasks.ensure({ id: 'task-a', goal: 'look', subgoal: 'twice', status: 'active' });
    const stored = repos.plans.create('task-a', plan, 'active', 'mock');
    const ref: PlanStepRef = {
      planId: stored.id,
      stepIndex: 0,
      failureHandling: plan.failureHandling,
      planner: 'mock',
    };
    const update = (interrupted: boolean): boolean =>
      updatePlanProgress(repos, ref, failed(interrupted), new Date(), makeState());
    // Stopped three times: nothing counted, the plan goes on.
    for (let i = 0; i < 3; i++) expect(update(true)).toBe(false);
    expect(repos.plans.get(stored.id)).toMatchObject({ status: 'active', stepFailures: 0 });
    // Real failures still count: one retry, then the plan fails and waits for a person.
    expect(update(false)).toBe(false);
    expect(update(false)).toBe(true);
    expect(repos.plans.get(stored.id)?.status).toBe('failed');
  });
});
