import type { MinecraftClient } from '../bot/minecraft-client.ts';
import type { AgentConfig } from '../config/env.ts';
import {
  createAction,
  isAllowlistedActionType,
  type Action,
  type ActionOrigin,
  type ActionSpec,
} from '../domain/actions.ts';
import { DecisionResultSchema, type DecisionResult } from '../domain/decisions.ts';
import { GameStateSchema, LastActionSchema, type GameState } from '../domain/game-state.ts';
import type { SafetyViolation } from '../domain/safety.ts';
import { ActionExecutor, type ExecutionOutcome } from '../executor/action-executor.ts';
import { SqliteActionLog } from '../executor/action-log.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
import type { StoredPlan } from '../persistence/plan-repository.ts';
import type { Repositories } from '../persistence/repositories.ts';
import { PlannerResponseSchema, type Plan, type PlannerResponse } from '../planner/plan-schema.ts';
import { validatePlan } from '../planner/plan-validator.ts';
import { buildPlannerRequest, type PlannerProvider } from '../planner/planner-provider.ts';
import { mergeProtectedItems } from '../safety/protected-items.ts';
import { assessStateReliability, type SafetyContext } from '../safety/safety-policy.ts';
import { proposeAction } from '../system1/action-proposer.ts';
import type { DecisionProvider } from '../system1/decision-provider.ts';
import type { RouterContext } from '../system1/state-queries.ts';
import type { Clock } from '../util/clock.ts';
import type { IdGenerator } from '../util/ids.ts';
import { errorMessage } from '../util/json.ts';

export interface AgentDeps {
  config: AgentConfig;
  client: MinecraftClient;
  repos: Repositories;
  decisionProvider: DecisionProvider;
  planner: PlannerProvider | null;
  clock: Clock;
  newId: IdGenerator;
}

export type CycleStatus =
  'succeeded' | 'rejected' | 'failed' | 'verification_failed' | 'paused' | 'error';

export type PlannerOutcome =
  /** A new plan was stored as active and its first step proposed. */
  | { kind: 'plan-accepted'; planId: number; goal: string; steps: number }
  /** The task's active plan continued with its next step (the planner was not asked again). */
  | { kind: 'plan-step'; planId: number; goal: string; step: number; steps: number }
  /** A new plan needs a human's approval before anything runs. */
  | { kind: 'approval-required'; planId: number; goal: string; steps: number }
  /** The task's plan is still waiting for approval (the planner was not asked again). */
  | { kind: 'approval-pending'; planId: number; goal: string; steps: number }
  | { kind: 'plan-rejected'; issues: string[] }
  | { kind: 'escalation'; reason: string; message: string }
  | { kind: 'unavailable' };

export interface CycleResult {
  cycleId: string;
  status: CycleStatus;
  /** True whenever a human should look before the agent continues. */
  needsUserAttention: boolean;
  stateSnapshotId: number | null;
  stateViolations: SafetyViolation[];
  decision: DecisionResult | null;
  planner: PlannerOutcome | null;
  action: {
    actionId: string;
    type: string;
    args: Action['args'];
    origin: ActionOrigin;
    reason: string;
  } | null;
  outcome: ExecutionOutcome | null;
  summary: string;
}

/** Copies config-defined locations and protected items into the database (additive). */
export function syncConfigToDatabase(config: AgentConfig, repos: Repositories): void {
  repos.transaction(() => {
    for (const [name, location] of Object.entries(config.locations))
      repos.locations.upsert(name, location);
    repos.protectedItems.syncFromConfig(config.safety.protectedItems);
  });
}

export function buildSafetyContext(
  config: AgentConfig,
  repos: Repositories,
  now: Date,
): SafetyContext {
  return {
    config: config.safety,
    protectedItems: mergeProtectedItems(config.safety.protectedItems, repos.protectedItems.items()),
    locations: new Map([...repos.locations.all(), ...Object.entries(config.locations)]),
    now,
  };
}

const HALTED_TASK_STATUSES = new Set(['paused', 'blocked', 'completed', 'failed']);
const FINISHED_TASK_STATUSES = new Set(['completed', 'failed']);

/** The planner name for plans a human wrote (`cli task-add --plan`). */
export const OPERATOR_PLANNER = 'operator';

/**
 * Merges agent memory into the observation:
 *  - on the live server (which knows nothing of tasks) the operator's current task is filled
 *    in, unless it is finished;
 *  - the persisted task status wins if the task was halted (so a paused task stays paused
 *    until a human resumes it);
 *  - containers whose contents are not visible now get the contents last seen, if recent
 *    (planning checks only; the live client re-reads the real contents before clicking);
 *  - the last logged action is filled in.
 */
export function overlayAgentMemory(
  state: GameState,
  repos: Repositories,
  config: AgentConfig,
): GameState {
  let next = state;
  if (state.currentTask === null && state.source === 'gtnh1710') {
    const id = repos.memory.getValue(CURRENT_TASK_KEY);
    const task = id === null ? null : repos.tasks.get(id);
    if (task !== null && !FINISHED_TASK_STATUSES.has(task.status)) {
      next = {
        ...next,
        currentTask: {
          taskId: task.id,
          goal: task.goal,
          subgoal: task.subgoal,
          status: task.status,
        },
      };
      // Machines the task depends on: System 1 waits while one is busy and pauses if one is
      // switched off (or missing: an unobserved machine is 'unknown').
      const machines = repos.tasks.requiredMachines(task.id);
      if (machines.length > 0 && next.knownRecipeState === null) {
        next = {
          ...next,
          knownRecipeState: {
            target: task.goal.slice(0, 200),
            missingComponents: {},
            requiredMachineIds: machines.slice(0, 16),
            nextKnownSafeStep: null,
          },
        };
      }
    }
  }
  const maxAge = config.memory.containerContentsMaxAgeMs;
  const observedAt = Date.parse(state.timestamp);
  if (state.storage.some((s) => !s.items.known)) {
    next = {
      ...next,
      storage: next.storage.map((s) => {
        if (s.items.known) return s;
        const seen = repos.memory.recallContainer(s.id);
        if (seen === null) return s;
        const age = observedAt - Date.parse(seen.observedAt);
        return age >= 0 && age <= maxAge
          ? { ...s, items: { known: true as const, value: seen.items } }
          : s;
      }),
    };
  }
  if (next.currentTask !== null) {
    const t = next.currentTask;
    const stored = repos.tasks.ensure({
      id: t.taskId,
      goal: t.goal,
      subgoal: t.subgoal,
      status: t.status,
    });
    if (HALTED_TASK_STATUSES.has(stored.status)) {
      next = { ...next, currentTask: { ...t, status: stored.status } };
    }
  }
  if (next.lastAction === null) {
    const last = repos.actions.recent(1)[0];
    if (last !== undefined && isAllowlistedActionType(last.actionType)) {
      const result = {
        rejected: 'rejected',
        failed: 'failed',
        verification_failed: 'verification_failed',
        succeeded: 'succeeded',
      }[last.status as string];
      const parsed = LastActionSchema.safeParse({
        actionId: last.actionId,
        actionType: last.actionType,
        result,
        timestamp: last.updatedAt,
      });
      if (parsed.success && Date.parse(parsed.data.timestamp) <= Date.parse(state.timestamp)) {
        next = { ...next, lastAction: parsed.data };
      }
    }
  }
  return next;
}

function pauseDecision(provider: string, detail: string): DecisionResult {
  return {
    decision: 'PAUSE_AND_ASK_USER',
    confidence: 1,
    reasonCodes: ['STATE_UNRELIABLE'],
    factsUsed: { detail },
    requiresHumanConfirmation: true,
    provider,
  };
}

interface ChosenAction {
  spec: ActionSpec;
  reason: string;
  origin: ActionOrigin;
}

interface CycleFrame {
  cycleId: string;
  finish: (result: Omit<CycleResult, 'cycleId'>) => CycleResult;
  errorResult: (summary: string) => CycleResult;
}

/** Opens a cycle in the event log and returns how to close it. */
function startCycle(deps: AgentDeps, idPrefix: string, detail: object = {}): CycleFrame {
  const { repos, clock, newId } = deps;
  const cycleId = newId(idPrefix);
  repos.events.append(cycleId, 'CYCLE_START', { at: clock.now().toISOString(), ...detail });
  const finish = (result: Omit<CycleResult, 'cycleId'>): CycleResult => {
    const full = { cycleId, ...result };
    repos.events.append(cycleId, 'CYCLE_END', {
      status: full.status,
      needsUserAttention: full.needsUserAttention,
      summary: full.summary,
    });
    return full;
  };
  const errorResult = (summary: string): CycleResult => {
    repos.events.append(cycleId, 'ERROR', { summary });
    return finish({
      status: 'error',
      needsUserAttention: true,
      stateSnapshotId: null,
      stateViolations: [],
      decision: null,
      planner: null,
      action: null,
      outcome: null,
      summary,
    });
  };
  return { cycleId, finish, errorResult };
}

/** Observes (or receives) the state, validates it, overlays agent memory and persists a snapshot. */
async function observeState(
  deps: AgentDeps,
  cycleId: string,
  given: unknown,
  note: Record<string, unknown> = {},
): Promise<{ state: GameState; stateSnapshotId: number } | { error: string }> {
  const { client, repos } = deps;
  let raw: unknown;
  try {
    raw = given ?? (await client.observe());
  } catch (error) {
    return { error: `Observation failed: ${errorMessage(error)}` };
  }
  const parsedState = GameStateSchema.safeParse(raw);
  if (!parsedState.success) {
    return {
      error: `Observed state failed schema validation: ${parsedState.error.issues[0]?.message ?? 'unknown'}`,
    };
  }
  rememberContainers(repos, parsedState.data);
  const state = overlayAgentMemory(parsedState.data, repos, deps.config);
  const stateSnapshotId = repos.snapshots.insert(cycleId, state);
  repos.events.append(cycleId, 'STATE', {
    stateSnapshotId,
    observedAt: state.timestamp,
    ...note,
  });
  return { state, stateSnapshotId };
}

/** Records every container whose contents are visible in this (raw) observation. */
function rememberContainers(repos: Repositories, state: GameState | null): void {
  if (state === null) return;
  for (const s of state.storage) {
    if (s.items.known) repos.memory.rememberContainer(s.id, s.items.value, state.timestamp);
  }
}

/**
 * The state and safety context the executor validates against. Deciding usually takes
 * microseconds, and then this is the cycle's own observation. When a decision provider or
 * the planner took long enough for the observation to go stale, the client is observed
 * again (a second snapshot and STATE event, marked `reobserved`), so nothing is validated
 * or done on an outdated view of the world. A state that was already unreliable stays as it
 * is: the cycle is pausing anyway.
 */
async function freshForExecution(
  deps: AgentDeps,
  cycleId: string,
  state: GameState,
  ctx: SafetyContext,
  stateViolationCount: number,
): Promise<{ state: GameState; ctx: SafetyContext } | { error: string }> {
  const now = deps.clock.now();
  if (now.getTime() === ctx.now.getTime()) return { state, ctx };
  const execCtx = buildSafetyContext(deps.config, deps.repos, now);
  const wentStale =
    stateViolationCount === 0 &&
    assessStateReliability(state, execCtx).some((v) => v.code === 'STATE_STALE');
  if (!wentStale) return { state, ctx: execCtx };

  const again = await observeState(deps, cycleId, undefined, {
    reobserved: true,
    previousObservedAt: state.timestamp,
    decidedAt: now.toISOString(),
  });
  if ('error' in again) return { error: `Re-observation failed: ${again.error}` };
  return {
    state: again.state,
    ctx: buildSafetyContext(deps.config, deps.repos, deps.clock.now()),
  };
}

function newExecutor(deps: AgentDeps): ActionExecutor {
  return new ActionExecutor({
    client: deps.client,
    log: new SqliteActionLog(deps.repos),
    history: deps.repos.actions,
    clock: deps.clock,
    newId: deps.newId,
  });
}

function outcomeSummary(head: string, outcome: ExecutionOutcome, status: CycleStatus): string {
  const violations = outcome.validation.violations.map((v) => v.code);
  return (
    `${head} -> ${status}` +
    (violations.length > 0 ? ` [${violations.join(', ')}]` : '') +
    (outcome.validation.preconditionFailures.length > 0
      ? ` [preconditions: ${outcome.validation.preconditionFailures.join('; ')}]`
      : '')
  );
}

/**
 * Runs exactly ONE observe -> decide -> validate -> execute -> verify cycle and stops.
 * There is intentionally no loop here; continuous operation is a later milestone.
 */
export async function runSingleCycle(
  deps: AgentDeps,
  options: { state?: unknown } = {},
): Promise<CycleResult> {
  const { config, repos, clock, newId } = deps;
  const { cycleId, finish, errorResult } = startCycle(deps, 'cyc');

  // 1-2. Observe (or receive) the game state and persist it; invalid state never reaches the router.
  const observed = await observeState(deps, cycleId, options.state);
  if ('error' in observed) return errorResult(observed.error);
  const { state, stateSnapshotId } = observed;

  // 3. Hard safety validation of the state itself.
  const ctx = buildSafetyContext(config, repos, clock.now());
  const stateViolations = assessStateReliability(state, ctx);
  if (stateViolations.length > 0) repos.violations.insertMany(cycleId, null, stateViolations);

  // 4. System 1 decision (forced to PAUSE if the state is unreliable, whatever the provider says).
  const routerCtx: RouterContext = {
    safety: ctx,
    routing: config.routing,
    combatEnabled: config.minecraft.combat.enabled,
  };
  let decision: DecisionResult;
  if (stateViolations.length > 0) {
    decision = pauseDecision('hard-safety', stateViolations.map((v) => v.code).join(','));
  } else {
    try {
      const candidate = await deps.decisionProvider.decide(state, routerCtx);
      const parsed = DecisionResultSchema.safeParse(candidate);
      decision = parsed.success
        ? parsed.data
        : pauseDecision('hard-safety', 'invalid decision output');
    } catch (error) {
      decision = pauseDecision('hard-safety', `decision provider threw: ${errorMessage(error)}`);
    }
  }
  repos.events.append(cycleId, 'DECISION', decision);

  // 5. Decision -> exactly one proposed action (consulting the planner if asked).
  const proposal = proposeAction(decision, state, routerCtx);
  let chosen: ChosenAction;
  let planner: PlannerOutcome | null = null;
  let planStep: PlanStepRef | null = null;
  if (proposal.kind === 'planner') {
    const consulted = await consultPlanner(deps, state, ctx, cycleId, stateSnapshotId);
    chosen = consulted.chosen;
    planner = consulted.outcome;
    planStep = consulted.planStep;
  } else {
    chosen = { spec: proposal.spec, reason: proposal.reason, origin: 'deterministic-router' };
  }

  const taskId = state.currentTask?.taskId ?? null;
  const action = createAction({ ...chosen, taskId }, { newId, now: () => clock.now() });

  // A model may take seconds to decide or plan. Validate against the clock as it is now, and
  // if the observation went stale meanwhile, act only on a fresh one: the executor then
  // checks the chosen action against the new state (dangers, vitals, preconditions).
  const execution = await freshForExecution(deps, cycleId, state, ctx, stateViolations.length);
  if ('error' in execution) return errorResult(execution.error);

  // 6-10. Validate, persist, execute, verify, persist: all inside the executor.
  const outcome = await newExecutor(deps).execute(action, execution.state, execution.ctx, cycleId);
  rememberContainers(repos, outcome.stateAfter);

  // Plan bookkeeping: advance on a verified step; apply the plan's own failure policy.
  const planHalted = planStep === null ? false : updatePlanProgress(repos, planStep, outcome);

  // Task bookkeeping: pauses, rejections and failed plans halt the task until a human resumes
  // it. A stale planner step (see isStaleRejection) only fails its plan: the task goes on.
  const paused = action.type === 'PAUSE_AND_ASK_USER' && outcome.status === 'succeeded';
  const status: CycleStatus = paused ? 'paused' : outcome.status;
  const blockingRejection = outcome.status === 'rejected' && !isStaleRejection(planStep, outcome);
  const needsUserAttention =
    paused ||
    planHalted ||
    blockingRejection ||
    decision.requiresHumanConfirmation ||
    status === 'verification_failed';
  if (taskId !== null) {
    repos.transaction(() => {
      if (paused) repos.tasks.setStatus(taskId, 'paused');
      else if (blockingRejection) repos.tasks.setStatus(taskId, 'blocked');
      else if (planHalted) repos.tasks.setStatus(taskId, 'paused');
      repos.checkpoints.add(
        taskId,
        `${action.type}:${outcome.status}`,
        { cycleId, actionId: action.actionId, decision: decision.decision },
        stateSnapshotId,
      );
    });
  }

  const summary = outcomeSummary(`${decision.decision} -> ${action.type}`, outcome, status);

  return finish({
    status,
    needsUserAttention,
    stateSnapshotId,
    stateViolations,
    decision,
    planner,
    action: {
      actionId: action.actionId,
      type: action.type,
      args: action.args,
      origin: action.origin,
      reason: action.reason,
    },
    outcome,
    summary,
  });
}

/**
 * Runs ONE action a human asked for directly (e.g. `cli move`), through the same executor
 * as a cycle: schema, the hard safety policy and preconditions against a fresh
 * observation, then execution and verification. Only the decision step is skipped; nothing
 * here is autonomous, and task state is left alone.
 */
export async function runUserAction(
  deps: AgentDeps,
  spec: ActionSpec,
  reason: string,
): Promise<CycleResult> {
  const { config, repos, clock, newId } = deps;
  const { cycleId, finish, errorResult } = startCycle(deps, 'usr', { userAction: spec.type });
  const observed = await observeState(deps, cycleId, undefined);
  if ('error' in observed) return errorResult(observed.error);
  const { state, stateSnapshotId } = observed;

  const ctx = buildSafetyContext(config, repos, clock.now());
  const stateViolations = assessStateReliability(state, ctx);
  if (stateViolations.length > 0) repos.violations.insertMany(cycleId, null, stateViolations);
  // The executor refuses anything but a pause or an observation while the state is unreliable.
  const action = createAction(
    { spec, reason, origin: 'user', taskId: null },
    { newId, now: () => clock.now() },
  );
  const outcome = await newExecutor(deps).execute(action, state, ctx, cycleId);
  rememberContainers(repos, outcome.stateAfter);
  return finish({
    status: outcome.status,
    needsUserAttention: outcome.status !== 'succeeded',
    stateSnapshotId,
    stateViolations,
    decision: null,
    planner: null,
    action: {
      actionId: action.actionId,
      type: action.type,
      args: action.args,
      origin: action.origin,
      reason: action.reason,
    },
    outcome,
    summary: outcomeSummary(`USER -> ${action.type}`, outcome, outcome.status),
  });
}

interface PlanStepRef {
  planId: number;
  /** 0-based index of the step being executed. */
  stepIndex: number;
  failureHandling: Plan['failureHandling'];
  /** Who wrote the plan (OPERATOR_PLANNER for a human's plan). */
  planner: string;
}

const reviewHint = (taskId: string, planId: number): string =>
  `Review: node src/app/cli.ts plan-show --task ${taskId}; then plan-approve (or plan-reject) --task ${taskId} --plan ${planId}.`;

type Consulted = { chosen: ChosenAction; outcome: PlannerOutcome; planStep: PlanStepRef | null };

function stepOf(stored: StoredPlan, outcomeKind: 'plan-accepted' | 'plan-step'): Consulted {
  const step = stored.plan.steps[stored.nextStep];
  if (step === undefined) throw new Error(`plan ${stored.id} has no step ${stored.nextStep}`);
  const total = stored.plan.steps.length;
  const outcome: PlannerOutcome =
    outcomeKind === 'plan-accepted'
      ? { kind: 'plan-accepted', planId: stored.id, goal: stored.plan.goal, steps: total }
      : {
          kind: 'plan-step',
          planId: stored.id,
          goal: stored.plan.goal,
          step: stored.nextStep + 1,
          steps: total,
        };
  return {
    chosen: {
      spec: step.action,
      reason:
        `plan #${stored.id} "${stored.plan.goal}" step ${stored.nextStep + 1}/${total}: ${step.rationale}`.slice(
          0,
          500,
        ),
      origin: 'planner',
    },
    outcome,
    planStep: {
      planId: stored.id,
      stepIndex: stored.nextStep,
      failureHandling: stored.plan.failureHandling,
      planner: stored.planner,
    },
  };
}

/**
 * Safety refusals that only say a step no longer matches what is observed, not that it is
 * dangerous: NOT_DIGGABLE means the block is not in the current list of observed diggable
 * blocks (already dug, or out of the scan since the player moved); TARGET_GONE means the
 * entity to attack is no longer near (it died, wandered off or despawned). The step is still
 * refused; only the reaction differs (see isStaleRejection).
 */
const STALE_VIOLATION_CODES: ReadonlySet<string> = new Set(['NOT_DIGGABLE', 'TARGET_GONE']);

/**
 * A planner's step rejected only because it no longer fits the world NOW: preconditions
 * (out of reach, too few items, the block gone) and/or a stale-observation refusal
 * (STALE_VIOLATION_CODES), and nothing else. The player moved or the world changed since
 * the plan was made: a stale plan, not an unsafe one. A human's plan is never treated this
 * way, and any other safety violation still halts the task.
 */
export function isStaleRejection(ref: PlanStepRef | null, outcome: ExecutionOutcome): boolean {
  const v = outcome.validation;
  return (
    ref !== null &&
    ref.planner !== OPERATOR_PLANNER &&
    outcome.status === 'rejected' &&
    v.violations.every((x) => STALE_VIOLATION_CODES.has(x.code)) &&
    (v.violations.length > 0 || v.preconditionFailures.length > 0)
  );
}

/**
 * After a plan step ran: advance on success; on failure count it against the plan's retry
 * budget and, once exhausted, fail the plan. Returns true if the task must now wait for a
 * human (a rejected step, or a failure policy other than REPLAN). A stale rejection fails
 * the plan but lets the task go on: the next cycle asks the planner again, with the
 * rejection in its recent history.
 */
function updatePlanProgress(
  repos: Repositories,
  ref: PlanStepRef,
  outcome: ExecutionOutcome,
): boolean {
  switch (outcome.status) {
    case 'succeeded': {
      const plan = repos.plans.advance(ref.planId);
      // A plan a human wrote for the task IS the task: finishing it finishes the task.
      if (plan.status === 'completed' && plan.planner === OPERATOR_PLANNER) {
        repos.tasks.setStatus(plan.taskId, 'completed');
      }
      return false;
    }
    case 'rejected':
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} rejected: ${outcome.validation.violations.map((v) => v.code).join(', ') || outcome.validation.preconditionFailures.join('; ')}`.slice(
          0,
          500,
        ),
      );
      return !isStaleRejection(ref, outcome);
    case 'failed':
    case 'verification_failed': {
      const failures = repos.plans.recordStepFailure(ref.planId);
      if (failures <= ref.failureHandling.maxRetriesPerStep) return false; // retry next cycle
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} failed ${failures} time(s)`,
      );
      // REPLAN: the next cycle asks the planner again. PAUSE_AND_ASK_USER and RETREAT_HOME
      // (no retreat directive exists yet) wait for a human.
      return ref.failureHandling.onStepFailure !== 'REPLAN';
    }
  }
}

async function consultPlanner(
  deps: AgentDeps,
  state: GameState,
  ctx: SafetyContext,
  cycleId: string,
  stateSnapshotId: number,
): Promise<Consulted> {
  const { config, repos, planner } = deps;
  const pauseWith = (question: string, outcome: PlannerOutcome): Consulted => ({
    chosen: {
      spec: { type: 'PAUSE_AND_ASK_USER', args: { question: question.slice(0, 500) } },
      reason: `planner: ${outcome.kind}`,
      origin: 'deterministic-router',
    },
    outcome,
    planStep: null,
  });

  const taskId = state.currentTask?.taskId ?? null;
  if (taskId === null) {
    return pauseWith('There is no task to plan for. What should the agent do?', {
      kind: 'unavailable',
    });
  }

  // An open plan takes precedence over asking the planner again.
  const open = repos.plans.openForTask(taskId);
  if (open?.status === 'pending_approval') {
    return pauseWith(
      `Plan #${open.id} "${open.plan.goal}" (${open.plan.steps.length} steps) is still waiting for approval. ${reviewHint(taskId, open.id)}`,
      {
        kind: 'approval-pending',
        planId: open.id,
        goal: open.plan.goal,
        steps: open.plan.steps.length,
      },
    );
  }
  if (open?.status === 'active') return stepOf(open, 'plan-step');

  if (planner === null || config.planner.provider === 'none') {
    return pauseWith(
      'No planner is configured and no known safe step exists. What should the agent do?',
      {
        kind: 'unavailable',
      },
    );
  }

  const limit = config.planner.recentHistoryLimit;
  const request = buildPlannerRequest({
    state,
    safety: ctx,
    maxPlanSteps: config.planner.maxPlanSteps,
    recentActions: repos.actions
      .recent(limit, taskId)
      .flatMap((a) =>
        isAllowlistedActionType(a.actionType)
          ? [{ actionType: a.actionType, status: a.status, reason: a.reason.slice(0, 200) }]
          : [],
      ),
    recentFailures: repos.actions
      .failureSummary(taskId, limit)
      .flatMap((f) =>
        isAllowlistedActionType(f.actionType) ? [{ ...f, actionType: f.actionType }] : [],
      ),
  });

  let response: PlannerResponse;
  try {
    const parsed = PlannerResponseSchema.safeParse(await planner.plan(request));
    response = parsed.success
      ? parsed.data
      : {
          kind: 'escalation',
          escalation: {
            reason: 'INVALID_OUTPUT',
            message: 'Planner response failed schema validation',
            questionForUser: 'The planner produced invalid output. How should the agent proceed?',
          },
        };
  } catch (error) {
    response = {
      kind: 'escalation',
      escalation: {
        reason: 'OTHER',
        message: `Planner error: ${errorMessage(error)}`.slice(0, 500),
        questionForUser: 'The planner failed. How should the agent proceed?',
      },
    };
  }
  repos.events.append(cycleId, 'PLAN', { provider: planner.name, response });

  if (response.kind === 'escalation') {
    const e = response.escalation;
    return pauseWith(e.questionForUser, {
      kind: 'escalation',
      reason: e.reason,
      message: e.message,
    });
  }

  const validation = validatePlan(response.plan, ctx, config.planner.maxPlanSteps);
  if (!validation.ok || validation.plan === null) {
    repos.checkpoints.add(
      taskId,
      'plan-rejected',
      { plan: response.plan, validation },
      stateSnapshotId,
    );
    const stepViolations = validation.stepViolations.flatMap((s) => s.violations);
    const issues = [
      ...validation.schemaIssues,
      ...validation.stepViolations.flatMap((s) =>
        s.violations.map((v) => `step ${s.step}: ${v.code}`),
      ),
    ];
    repos.violations.insertMany(cycleId, null, [
      {
        code: 'PLAN_INVALID',
        severity: 'pause',
        message: `Planner plan rejected: ${issues.join('; ')}`.slice(0, 500),
        details: { goal: response.plan.goal.slice(0, 200) },
      },
      ...stepViolations,
    ]);
    return pauseWith(
      `The planner's plan was rejected (${issues.join('; ')}). How should the agent proceed?`,
      {
        kind: 'plan-rejected',
        issues,
      },
    );
  }

  const plan = validation.plan;
  const stored = repos.plans.create(
    taskId,
    plan,
    plan.requiresUserApproval ? 'pending_approval' : 'active',
    planner.name,
  );
  repos.checkpoints.add(
    taskId,
    'plan',
    { planId: stored.id, status: stored.status, plan },
    stateSnapshotId,
  );
  if (stored.status === 'pending_approval') {
    // The commands come before the planner's explanation so truncation cannot cut them off.
    return pauseWith(
      `Approve plan #${stored.id} "${plan.goal}" (${plan.steps.length} steps)? ${reviewHint(taskId, stored.id)} Planner: ${plan.explanation}`,
      { kind: 'approval-required', planId: stored.id, goal: plan.goal, steps: plan.steps.length },
    );
  }
  return stepOf(stored, 'plan-accepted');
}
