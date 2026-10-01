import type { StoredPlan } from '../persistence/plan-repository.ts';
import type { Repositories } from '../persistence/repositories.ts';

/**
 * Human-in-the-loop plan commands (the CLI's plan-show / plan-approve / plan-reject).
 * Plans only change status here; nothing is executed. The agent loop runs an approved
 * plan one validated step per cycle.
 */
export type PlanCommandResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

type StepProgress = 'done' | 'next' | 'failed' | 'not run';

export function describePlan(p: StoredPlan): Record<string, unknown> {
  const progress = (i: number): StepProgress => {
    if (i < p.nextStep) return 'done';
    if (i === p.nextStep && p.status === 'active') return 'next';
    if (i === p.nextStep && p.status === 'failed') return 'failed';
    return 'not run';
  };
  return {
    planId: p.id,
    taskId: p.taskId,
    status: p.status,
    statusReason: p.statusReason,
    planner: p.planner,
    goal: p.plan.goal,
    explanation: p.plan.explanation,
    requiresUserApproval: p.plan.requiresUserApproval,
    failureHandling: p.plan.failureHandling,
    currentStepFailures: p.stepFailures,
    steps: p.plan.steps.map((s, i) => ({
      step: i + 1,
      progress: progress(i),
      action: s.action,
      rationale: s.rationale,
    })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** A task's latest plan in full, or (without a task) every open plan in brief. */
export function showPlans(repos: Repositories, taskId: string | undefined): PlanCommandResult {
  if (taskId === undefined) {
    return {
      ok: true,
      value: {
        openPlans: repos.plans.listOpen().map((p) => ({
          planId: p.id,
          taskId: p.taskId,
          status: p.status,
          goal: p.plan.goal,
          progress: `${p.nextStep}/${p.plan.steps.length} steps done`,
        })),
      },
    };
  }
  const latest = repos.plans.latestForTask(taskId);
  if (latest === null) return { ok: false, error: `Task ${taskId} has no plans` };
  return { ok: true, value: describePlan(latest) };
}

/**
 * Approves the task's plan that is waiting for approval and resumes the task if it was
 * paused (the pause was the approval question). `planId`, when given, must match: it pins
 * the approval to the plan the human actually reviewed.
 */
export function approvePlan(
  repos: Repositories,
  taskId: string,
  planId: number | undefined,
): PlanCommandResult {
  const task = repos.tasks.get(taskId);
  if (task === null) return { ok: false, error: `No task ${taskId}` };
  const open = repos.plans.openForTask(taskId);
  if (open?.status !== 'pending_approval') {
    const latest = repos.plans.latestForTask(taskId);
    return {
      ok: false,
      error:
        `Task ${taskId} has no plan waiting for approval` +
        (latest === null ? '' : ` (latest plan #${latest.id} is ${latest.status})`),
    };
  }
  if (planId !== undefined && planId !== open.id) {
    return {
      ok: false,
      error: `Plan #${planId} is not the plan waiting for approval (that is #${open.id}); review it with plan-show`,
    };
  }
  const resume = task.status === 'paused';
  repos.transaction(() => {
    repos.plans.setStatus(open.id, 'active', 'approved by the user');
    if (resume) repos.tasks.setStatus(taskId, 'active');
  });
  return {
    ok: true,
    value: {
      planId: open.id,
      goal: open.plan.goal,
      status: 'active',
      task: { taskId, previousStatus: task.status, status: resume ? 'active' : task.status },
      ...(resume
        ? {}
        : { note: `The task is ${task.status}; run task-resume if it should continue.` }),
    },
  };
}

/** Rejects the task's open plan (waiting for approval or active). The task's status is kept. */
export function rejectPlan(
  repos: Repositories,
  taskId: string,
  planId: number | undefined,
  reason: string | undefined,
): PlanCommandResult {
  const task = repos.tasks.get(taskId);
  if (task === null) return { ok: false, error: `No task ${taskId}` };
  const open = repos.plans.openForTask(taskId);
  if (open === null) return { ok: false, error: `Task ${taskId} has no open plan` };
  if (planId !== undefined && planId !== open.id) {
    return {
      ok: false,
      error: `Plan #${planId} is not the task's open plan (that is #${open.id})`,
    };
  }
  const why = `rejected by the user${reason === undefined ? '' : `: ${reason}`}`.slice(0, 500);
  repos.plans.setStatus(open.id, 'rejected', why);
  return {
    ok: true,
    value: {
      planId: open.id,
      goal: open.plan.goal,
      previousStatus: open.status,
      status: 'rejected',
      task: { taskId, status: task.status },
      note:
        task.status === 'active'
          ? 'The task is active: the next cycle will ask the planner for a new plan.'
          : `The task stays ${task.status}; task-resume lets the agent ask the planner for a new plan.`,
    },
  };
}
