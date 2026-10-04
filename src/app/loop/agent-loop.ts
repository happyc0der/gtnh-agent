import type { MinecraftClient } from '../../bot/minecraft-client.ts';
import type { AgentConfig } from '../../config/env.ts';
import {
  createAction,
  type Action,
  type ActionOrigin,
  type ActionSpec,
} from '../../domain/actions.ts';
import { DecisionResultSchema, type DecisionResult } from '../../domain/decisions.ts';
import { GameStateSchema, type GameState } from '../../domain/game-state.ts';
import { MEAL_HISTORY_LENGTH } from '../../domain/food.ts';
import { distance } from '../../domain/geometry.ts';
import type { SafetyViolation } from '../../domain/safety.ts';
import { ActionExecutor, type ExecutionOutcome } from '../../executor/action-executor.ts';
import { SqliteActionLog } from '../../executor/action-log.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { PlannerProvider } from '../../planner/planner-provider.ts';
import {
  actionFingerprint,
  assessStateReliability,
  type SafetyContext,
} from '../../safety/safety-policy.ts';
import { proposeAction } from '../../system1/action-proposer.ts';
import type { DecisionProvider } from '../../system1/decision-provider.ts';
import type { RouterContext } from '../../system1/state-queries.ts';
import type { Clock } from '../../util/clock.ts';
import type { IdGenerator } from '../../util/ids.ts';
import { errorMessage } from '../../util/json.ts';
import { rememberDeadEnd } from './dead-ends.ts';
import { readTrail, recordTrail, TRAIL_LOCATION, trailRetreat } from './trail.ts';
import { knownStepAfterAction } from './known-steps.ts';
import {
  buildSafetyContext,
  overlayAgentMemory,
  rememberContainers,
  rememberSeen,
  seedPlayerBuilds,
  taskPlanFacts,
} from './agent-memory.ts';
import {
  consultPlanner,
  isStaleRejection,
  onlyStaleRefusals,
  updatePlanProgress,
  type PlanStepRef,
} from './plan-steps.ts';

/**
 * One agent cycle (runSingleCycle), and the single actions a human (runUserAction) or the play
 * loop (runQuestBookAction) asks for, through the same executor. What the agent remembers
 * around a cycle is in agent-memory.ts; which plan step a cycle runs when System 1 asks for
 * the planner, and what the step's outcome does to its plan, in plan-steps.ts.
 */
export interface AgentDeps {
  config: AgentConfig;
  client: MinecraftClient;
  repos: Repositories;
  decisionProvider: DecisionProvider;
  planner: PlannerProvider | null;
  clock: Clock;
  newId: IdGenerator;
  /**
   * Whether code follows a route whose every step is an exact action instead of asking the
   * planner (route-plan.ts); default true. Off only to test what the planner is asked.
   */
  followRoute?: boolean;
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
  | { kind: 'unavailable' }
  /** A code-made blueprint's next step ran instead (known-steps.ts); no planner was asked. */
  | { kind: 'known-step'; step: number; steps: number };

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
  /** Why the cycle stopped after observing, before deciding (runSingleCycle's stopBefore). */
  stoppedBefore?: string;
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

export interface ChosenAction {
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
  // The blocks a player built, from agent memory, before the client's first observation.
  seedPlayerBuilds(deps, cycleId);
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
  rememberSeen(deps, cycleId);
  const state = overlayAgentMemory(parsedState.data, repos, deps.config);
  const stateSnapshotId = repos.snapshots.insert(cycleId, state);
  repos.events.append(cycleId, 'STATE', {
    stateSnapshotId,
    observedAt: state.timestamp,
    ...note,
  });
  return { state, stateSnapshotId };
}

/**
 * `stopBefore` on a fresh look at the world (validated, not kept as a snapshot), or null when
 * it says go on or the look failed (the cycle then goes on as it would have).
 */
async function lateStop(
  deps: AgentDeps,
  stopBefore: (state: GameState) => string | null,
): Promise<string | null> {
  try {
    const parsed = GameStateSchema.safeParse(await deps.client.observe());
    return parsed.success ? stopBefore(parsed.data) : null;
  } catch {
    return null;
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
  // The cycle's own locations stay (the trail's retreat point is not in the database).
  const execCtx = { ...buildSafetyContext(deps.config, deps.repos, now), locations: ctx.locations };
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
    ctx: {
      ...buildSafetyContext(deps.config, deps.repos, deps.clock.now()),
      locations: ctx.locations,
    },
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
  options: {
    state?: unknown;
    /**
     * Asked with the cycle's fresh observation before System 1 decides: a reason ends the
     * cycle there, with nothing decided or done. The play loop ends a session this way when
     * the server's own update completes its quest (a crafting task counts the crafts on the
     * server, a moment after them), so nobody is asked to plan a task that is done.
     */
    stopBefore?: (state: GameState) => string | null;
  } = {},
): Promise<CycleResult> {
  const { config, repos, clock, newId } = deps;
  const { cycleId, finish, errorResult } = startCycle(deps, 'cyc');

  // 1-2. Observe (or receive) the game state and persist it; invalid state never reaches the router.
  const observed = await observeState(deps, cycleId, options.state);
  if ('error' in observed) return errorResult(observed.error);
  const { state, stateSnapshotId } = observed;

  // 3. Hard safety validation of the state itself.
  const base = buildSafetyContext(config, repos, clock.now());
  const stateViolations = assessStateReliability(state, base);
  if (stateViolations.length > 0) repos.violations.insertMany(cycleId, null, stateViolations);

  const stop = options.stopBefore?.(state) ?? null;
  if (stop !== null) {
    return finish({
      status: 'succeeded',
      needsUserAttention: false,
      stateSnapshotId,
      stateViolations,
      decision: null,
      planner: null,
      action: null,
      outcome: null,
      summary: `stopped before deciding: ${stop}`,
      stoppedBefore: stop,
    });
  }

  // The way back: where the player stood out of danger lately. With a creature threatening
  // it, a point back along that trail and away from it is a safe location for this cycle, and
  // RETREAT_HOME walks there when it is nearer than home.
  if (stateViolations.length === 0) recordTrail(repos.memory, state, base);
  const trail =
    stateViolations.length === 0 ? trailRetreat(readTrail(repos.memory), state, base) : null;
  const home = base.locations.get(config.routing.homeLocationName);
  const at = state.player.position.known ? state.player.position.value : null;
  // Two retreats along the trail that failed from this very block: home instead (the
  // repeated-failure rule would refuse a third, and the trail point may be cut off).
  const trailFailed =
    repos.actions.countFailures(
      state.currentTask?.taskId ?? null,
      actionFingerprint(
        { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: TRAIL_LOCATION } },
        at,
      ),
    ) >= base.config.maxFailuresPerActionPerTask;
  const nearer =
    trail !== null &&
    !trailFailed &&
    (home === undefined ||
      at === null ||
      distance(at, trail.position) < distance(at, home.position));
  const ctx: SafetyContext = nearer
    ? { ...base, locations: new Map([...base.locations, [TRAIL_LOCATION, trail]]) }
    : base;

  // 4. System 1 decision (forced to PAUSE if the state is unreliable, whatever the provider says).
  const routerCtx: RouterContext = {
    safety: ctx,
    routing: config.routing,
    combatEnabled: config.minecraft.combat.enabled,
    eatingEnabled: config.minecraft.eating.enabled,
    recentMeals: repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
    plan: taskPlanFacts(repos, state),
    ...(nearer ? { retreatTo: TRAIL_LOCATION } : {}),
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
    if (consulted.chosen === null) {
      // A GATHER step ended before choosing an action (done, at a bound, or nothing left to
      // dig): nothing runs this cycle. Its plan advanced, or ended so that the next cycle
      // asks the planner again (see gatherEnded).
      const { ended } = consulted;
      const task = state.currentTask?.taskId ?? null;
      if (task !== null) {
        repos.checkpoints.add(
          task,
          ended.label,
          { cycleId, decision: decision.decision, why: ended.why },
          stateSnapshotId,
        );
      }
      return finish({
        status: ended.status,
        needsUserAttention: decision.requiresHumanConfirmation,
        stateSnapshotId,
        stateViolations,
        decision,
        planner: consulted.outcome,
        action: null,
        outcome: null,
        summary: `${decision.decision} -> ${ended.label} -> ${ended.status}`,
      });
    }
    chosen = consulted.chosen;
    planner = consulted.outcome;
    planStep = consulted.planStep;
    // A new plan took the model seconds, and the server's own update may have come meanwhile
    // (a crafting quest completes on the craft, a moment later). Seen live: the craft that
    // finished "Crafting Time" was followed by a new plan that crafted it again, refused for
    // want of logs. The caller's stop check gets a fresh look before anything is done.
    if (options.stopBefore !== undefined && planner?.kind === 'plan-accepted') {
      const late = await lateStop(deps, options.stopBefore);
      if (late !== null) {
        return finish({
          status: 'succeeded',
          needsUserAttention: false,
          stateSnapshotId,
          stateViolations,
          decision,
          planner,
          action: null,
          outcome: null,
          summary: `stopped before acting: ${late}`,
          stoppedBefore: late,
        });
      }
    }
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
  rememberSeen(deps, cycleId);
  rememberDeadEnd(
    repos.memory,
    action,
    outcome.execution,
    execution.state.player.position.known ? execution.state.player.position.value : null,
    outcome.stateAfter?.player.position.known === true
      ? outcome.stateAfter.player.position.value
      : null,
  );

  // Plan bookkeeping: advance on a verified step; apply the plan's own failure policy.
  const planHalted =
    planStep === null
      ? false
      : updatePlanProgress(repos, planStep, outcome, clock.now(), execution.state);
  // A code-made blueprint's step: advance on a verified step (the last completes the task).
  const knownStep = taskId !== null && knownStepAfterAction(repos, taskId, action, outcome);

  // Task bookkeeping: pauses, rejections and failed plans halt the task until a human resumes
  // it. A stale planner step (see isStaleRejection), or a code-made blueprint's step refused
  // only as stale, fails without halting the task: the next plan starts from the new view.
  const paused = action.type === 'PAUSE_AND_ASK_USER' && outcome.status === 'succeeded';
  const status: CycleStatus = paused ? 'paused' : outcome.status;
  const blockingRejection =
    outcome.status === 'rejected' &&
    !isStaleRejection(planStep, outcome) &&
    !(knownStep && onlyStaleRefusals(outcome));
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
  rememberSeen(deps, cycleId);
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

/**
 * Runs ONE quest-book click that the play loop chose itself (SUBMIT_QUEST, CHECK_QUEST_BOX or
 * CLAIM_QUEST_REWARD), through the same executor as a cycle: schema, the hard safety policy
 * and preconditions against a fresh observation, then execution and verification. The play
 * loop decides these deterministically from the server's quest book, so the decision step and
 * the planner are skipped. The action is recorded under the quest's task with origin
 * `deterministic-router`, so the repeated-failure rule applies to it; task state is left to
 * the play loop.
 */
export async function runQuestBookAction(
  deps: AgentDeps,
  spec: ActionSpec,
  reason: string,
  taskId: string | null,
): Promise<CycleResult> {
  const { config, repos, clock, newId } = deps;
  const { cycleId, finish, errorResult } = startCycle(deps, 'qbk', { questBookAction: spec.type });
  const observed = await observeState(deps, cycleId, undefined);
  if ('error' in observed) return errorResult(observed.error);
  const { state, stateSnapshotId } = observed;

  const ctx = buildSafetyContext(config, repos, clock.now());
  const stateViolations = assessStateReliability(state, ctx);
  if (stateViolations.length > 0) repos.violations.insertMany(cycleId, null, stateViolations);
  const action = createAction(
    { spec, reason, origin: 'deterministic-router', taskId },
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
    summary: outcomeSummary(`QUEST BOOK -> ${action.type}`, outcome, outcome.status),
  });
}
