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
import type { Repositories } from '../persistence/repositories.ts';
import { PlannerResponseSchema, type PlannerResponse } from '../planner/plan-schema.ts';
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
  | { kind: 'plan-accepted'; goal: string; steps: number }
  | { kind: 'approval-required'; goal: string; steps: number }
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

/**
 * Merges agent memory into the observation: the persisted task status wins if the
 * task was halted (so a paused task stays paused until a human resumes it), and the
 * last logged action is filled in.
 */
function overlayAgentMemory(state: GameState, repos: Repositories): GameState {
  let next = state;
  if (state.currentTask !== null) {
    const t = state.currentTask;
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

/**
 * Runs exactly ONE observe -> decide -> validate -> execute -> verify cycle and stops.
 * There is intentionally no loop here; continuous operation is a later milestone.
 */
export async function runSingleCycle(
  deps: AgentDeps,
  options: { state?: unknown } = {},
): Promise<CycleResult> {
  const { config, client, repos, clock, newId } = deps;
  const cycleId = newId('cyc');
  repos.events.append(cycleId, 'CYCLE_START', { at: clock.now().toISOString() });

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

  // 1. Observe (or receive) the game state; invalid state never reaches the router.
  let raw: unknown;
  try {
    raw = options.state ?? (await client.observe());
  } catch (error) {
    return errorResult(`Observation failed: ${errorMessage(error)}`);
  }
  const parsedState = GameStateSchema.safeParse(raw);
  if (!parsedState.success) {
    return errorResult(
      `Observed state failed schema validation: ${parsedState.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const state = overlayAgentMemory(parsedState.data, repos);

  // 2. Persist the snapshot.
  const stateSnapshotId = repos.snapshots.insert(cycleId, state);
  repos.events.append(cycleId, 'STATE', { stateSnapshotId, observedAt: state.timestamp });

  // 3. Hard safety validation of the state itself.
  const ctx = buildSafetyContext(config, repos, clock.now());
  const stateViolations = assessStateReliability(state, ctx);
  if (stateViolations.length > 0) repos.violations.insertMany(cycleId, null, stateViolations);

  // 4. System 1 decision (forced to PAUSE if the state is unreliable, whatever the provider says).
  const routerCtx: RouterContext = { safety: ctx, routing: config.routing };
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
  if (proposal.kind === 'planner') {
    const consulted = await consultPlanner(deps, state, ctx, cycleId, stateSnapshotId);
    chosen = consulted.chosen;
    planner = consulted.outcome;
  } else {
    chosen = { spec: proposal.spec, reason: proposal.reason, origin: 'deterministic-router' };
  }

  const taskId = state.currentTask?.taskId ?? null;
  const action = createAction({ ...chosen, taskId }, { newId, now: () => clock.now() });

  // 6-10. Validate, persist, execute, verify, persist: all inside the executor.
  const executor = new ActionExecutor({
    client,
    log: new SqliteActionLog(repos),
    history: repos.actions,
    clock,
    newId,
  });
  const outcome = await executor.execute(action, state, ctx, cycleId);

  // Task bookkeeping: pauses and rejections halt the task until a human resumes it.
  const paused = action.type === 'PAUSE_AND_ASK_USER' && outcome.status === 'succeeded';
  const status: CycleStatus = paused ? 'paused' : outcome.status;
  const needsUserAttention =
    paused ||
    outcome.status === 'rejected' ||
    decision.requiresHumanConfirmation ||
    status === 'verification_failed';
  if (taskId !== null) {
    repos.transaction(() => {
      if (paused) repos.tasks.setStatus(taskId, 'paused');
      else if (outcome.status === 'rejected') repos.tasks.setStatus(taskId, 'blocked');
      repos.checkpoints.add(
        taskId,
        `${action.type}:${outcome.status}`,
        { cycleId, actionId: action.actionId, decision: decision.decision },
        stateSnapshotId,
      );
    });
  }

  const violations = outcome.validation.violations.map((v) => v.code);
  const summary =
    `${decision.decision} -> ${action.type} -> ${status}` +
    (violations.length > 0 ? ` [${violations.join(', ')}]` : '') +
    (outcome.validation.preconditionFailures.length > 0
      ? ` [preconditions: ${outcome.validation.preconditionFailures.join('; ')}]`
      : '');

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

async function consultPlanner(
  deps: AgentDeps,
  state: GameState,
  ctx: SafetyContext,
  cycleId: string,
  stateSnapshotId: number,
): Promise<{ chosen: ChosenAction; outcome: PlannerOutcome }> {
  const { config, repos, planner } = deps;
  const pauseWith = (
    question: string,
    outcome: PlannerOutcome,
  ): { chosen: ChosenAction; outcome: PlannerOutcome } => ({
    chosen: {
      spec: { type: 'PAUSE_AND_ASK_USER', args: { question: question.slice(0, 500) } },
      reason: `planner: ${outcome.kind}`,
      origin: 'deterministic-router',
    },
    outcome,
  });

  if (planner === null || config.planner.provider === 'none') {
    return pauseWith(
      'No planner is configured and no known safe step exists. What should the agent do?',
      {
        kind: 'unavailable',
      },
    );
  }

  const taskId = state.currentTask?.taskId ?? null;
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
  if (taskId !== null) {
    repos.checkpoints.add(taskId, 'plan', { plan: response.plan, validation }, stateSnapshotId);
  }
  if (!validation.ok || validation.plan === null) {
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
  if (plan.requiresUserApproval) {
    return pauseWith(
      `Approve plan "${plan.goal}" (${plan.steps.length} steps)? ${plan.explanation}`,
      {
        kind: 'approval-required',
        goal: plan.goal,
        steps: plan.steps.length,
      },
    );
  }
  const first = plan.steps[0];
  if (first === undefined) {
    return pauseWith('The planner returned an empty plan.', {
      kind: 'plan-rejected',
      issues: ['empty plan'],
    });
  }
  return {
    chosen: {
      spec: first.action,
      reason: `plan "${plan.goal}" step 1/${plan.steps.length}: ${first.rationale}`.slice(0, 500),
      origin: 'planner',
    },
    outcome: { kind: 'plan-accepted', goal: plan.goal, steps: plan.steps.length },
  };
}
