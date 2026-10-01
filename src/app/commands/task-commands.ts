import type { AgentConfig } from '../../config/env.ts';
import { EntityIdSchema } from '../../domain/common.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { validatePlan } from '../../planner/plan-validator.ts';
import { buildSafetyContext, OPERATOR_PLANNER } from '../loop/agent-loop.ts';

/**
 * Human-in-the-loop task commands (the CLI's task-add / task-complete / task-list). A task
 * added here becomes the live agent's current task; its optional plan is written by the
 * human and validated exactly like a planner's plan before it is stored. Nothing runs here:
 * each `once --live` cycle then executes at most one validated step.
 */
export type TaskCommandResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function addTask(
  repos: Repositories,
  config: AgentConfig,
  input: {
    taskId: string;
    goal: string;
    plan: unknown;
    now: Date;
    machines?: readonly string[];
    /** Items the goal needs in the inventory: the planner gets an exact route to them. */
    requirements?: Readonly<Record<string, number>>;
  },
): TaskCommandResult {
  const machines = input.machines ?? [];
  if (machines.length > 16) return { ok: false, error: 'at most 16 machines per task' };
  const badMachine = machines.find((m) => !EntityIdSchema.safeParse(m).success);
  if (badMachine !== undefined)
    return { ok: false, error: `bad machine id ${JSON.stringify(badMachine)}` };
  if (!EntityIdSchema.safeParse(input.taskId).success) {
    return { ok: false, error: `task id must be 1-64 characters of [A-Za-z0-9_.:-]` };
  }
  const goal = input.goal.trim();
  if (goal.length === 0 || goal.length > 300) {
    return { ok: false, error: 'the goal must be 1-300 characters' };
  }
  if (repos.tasks.get(input.taskId) !== null) {
    return { ok: false, error: `task ${input.taskId} already exists` };
  }
  let plan = null;
  if (input.plan !== undefined) {
    const v = validatePlan(
      input.plan,
      buildSafetyContext(config, repos, input.now),
      config.planner.maxPlanSteps,
    );
    if (!v.ok || v.plan === null) {
      const issues = [
        ...v.schemaIssues,
        ...v.stepViolations.flatMap((s) =>
          s.violations.map((x) => `step ${s.step}: ${x.code}: ${x.message}`),
        ),
      ];
      return { ok: false, error: `the plan was rejected: ${issues.join('; ')}` };
    }
    plan = v.plan;
  }
  const stored = repos.transaction(() => {
    repos.tasks.ensure({ id: input.taskId, goal, subgoal: null, status: 'active' });
    repos.tasks.setRequiredMachines(input.taskId, machines);
    repos.memory.setTaskRequirements(
      input.taskId,
      input.requirements ? { ...input.requirements } : null,
    );
    repos.memory.setValue(CURRENT_TASK_KEY, input.taskId);
    return plan === null
      ? null
      : repos.plans.create(
          input.taskId,
          plan,
          plan.requiresUserApproval ? 'pending_approval' : 'active',
          OPERATOR_PLANNER,
        );
  });
  return {
    ok: true,
    value: {
      taskId: input.taskId,
      goal,
      status: 'active',
      current: true,
      machines,
      plan:
        stored === null
          ? null
          : {
              planId: stored.id,
              status: stored.status,
              steps: stored.plan.steps.map(
                (s) => `${s.step}. ${s.action.type} ${JSON.stringify(s.action.args)}`,
              ),
            },
    },
  };
}

/** Marks a task completed; its open plan is closed and it stops being the current task. */
export function completeTask(repos: Repositories, taskId: string): TaskCommandResult {
  const task = repos.tasks.get(taskId);
  if (task === null) return { ok: false, error: `No task ${taskId}` };
  repos.transaction(() => {
    repos.tasks.setStatus(taskId, 'completed');
    const open = repos.plans.openForTask(taskId);
    if (open !== null) repos.plans.setStatus(open.id, 'rejected', 'task completed by the operator');
    if (repos.memory.getValue(CURRENT_TASK_KEY) === taskId) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
  });
  return { ok: true, value: { taskId, previousStatus: task.status, status: 'completed' } };
}

/** Every task, newest last, with the current one marked and its latest plan's progress. */
export function listTasks(repos: Repositories): TaskCommandResult {
  const current = repos.memory.getValue(CURRENT_TASK_KEY);
  return {
    ok: true,
    value: {
      currentTask: current,
      tasks: repos.tasks.list().map((t) => {
        const p = repos.plans.latestForTask(t.id);
        return {
          taskId: t.id,
          status: t.status,
          current: t.id === current,
          goal: t.goal,
          plan:
            p === null
              ? null
              : `#${p.id} ${p.status} (${p.nextStep}/${p.plan.steps.length} steps, by ${p.planner})`,
        };
      }),
    },
  };
}
