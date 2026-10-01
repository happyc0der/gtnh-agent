import type { MinecraftClient } from '../../bot/minecraft-client.ts';
import type { AgentConfig } from '../../config/env.ts';
import {
  createAction,
  isAllowlistedActionType,
  type Action,
  type ActionOrigin,
  type ActionSpec,
} from '../../domain/actions.ts';
import type { BlockPosition } from '../../domain/common.ts';
import { DecisionResultSchema, type DecisionResult } from '../../domain/decisions.ts';
import { GameStateSchema, LastActionSchema, type GameState } from '../../domain/game-state.ts';
import { MEAL_HISTORY_LENGTH } from '../../domain/food.ts';
import { distance } from '../../domain/geometry.ts';
import type { SafetyViolation } from '../../domain/safety.ts';
import { summarizeExploration, type ExplorationSummary } from '../../domain/world-memory.ts';
import {
  ActionExecutor,
  validateCandidate,
  type ExecutionOutcome,
} from '../../executor/action-executor.ts';
import { SqliteActionLog } from '../../executor/action-log.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { StoredPlan } from '../../persistence/plan-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { DIG_YIELDS } from '../../goals/route-book.ts';
import {
  chooseGatherAction,
  GATHER,
  gatherSourceOf,
  sourceName,
  startGather,
  type GatherOptions,
  type GatherStep,
} from '../../planner/gather.ts';
import {
  MAX_JOURNAL_LINE,
  PlannerResponseSchema,
  type Plan,
  type PlannerRequest,
  type PlannerResponse,
} from '../../planner/plan-schema.ts';
import { trimStaleSteps, validatePlan } from '../../planner/plan-validator.ts';
import {
  buildPlannerRequest,
  rememberedPlacesOf,
  type PlannerProvider,
} from '../../planner/planner-provider.ts';
import { mergeProtectedItems } from '../../safety/protected-items.ts';
import {
  actionFingerprint,
  assessStateReliability,
  type SafetyContext,
} from '../../safety/safety-policy.ts';
import { proposeAction } from '../../system1/action-proposer.ts';
import type { DecisionProvider } from '../../system1/decision-provider.ts';
import type { PlanFacts, RouterContext } from '../../system1/state-queries.ts';
import type { Clock } from '../../util/clock.ts';
import type { IdGenerator } from '../../util/ids.ts';
import { errorMessage, stableStringify } from '../../util/json.ts';
import {
  gatherAfterAction,
  gatherStopped,
  gatherTurn,
  previewCheck,
  type GatherRef,
} from './gather-step.ts';
import { readDeadEnds, rememberDeadEnd, withoutDeadEnds } from './dead-ends.ts';
import { readTrail, recordTrail, TRAIL_LOCATION, trailRetreat } from './trail.ts';
import { knownStepAfterAction, nextKnownStep } from './known-steps.ts';

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
function requirementsOf(
  repos: Repositories,
  taskId: string,
): { requirements?: Record<string, number>; blueprint?: string[] } {
  const r = repos.memory.taskRequirements(taskId);
  const b = repos.memory.taskBlueprint(taskId);
  return { ...(r === null ? {} : { requirements: r }), ...(b === null ? {} : { blueprint: b }) };
}

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
          ...requirementsOf(repos, task.id),
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
      // A code-made blueprint (the night shelter, the way out of it): its next step is a
      // known safe step, which System 1's rule 6 runs (known-steps.ts).
      const known = nextKnownStep(repos, task.id);
      if (known !== null) {
        next = {
          ...next,
          knownRecipeState: {
            ...(next.knownRecipeState ?? {
              target: task.goal.slice(0, 200),
              missingComponents: {},
              requiredMachineIds: [],
            }),
            nextKnownSafeStep: known.spec,
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

/** Records every container whose contents are visible in this (raw) observation. */
function rememberContainers(repos: Repositories, state: GameState | null): void {
  if (state === null) return;
  for (const s of state.storage) {
    if (s.items.known) repos.memory.rememberContainer(s.id, s.items.value, state.timestamp);
  }
  // The window of a block the agent opened (a profile's, or an observe-only block's): its
  // layout is learned per block (window_layouts), the material for a new profile.
  if (state.blockWindow !== null) repos.windowLayouts.record(state.blockWindow);
}

/**
 * World memory: stores what the client has seen since it was last asked (per chunk; only what
 * a player could see). A problem here is logged and never stops the cycle.
 */
function rememberSeen(deps: AgentDeps, cycleId: string): void {
  try {
    const seen = deps.client.takeSeenChunks?.() ?? [];
    if (seen.length > 0) deps.repos.worldMemory.remember(seen);
  } catch (error) {
    deps.repos.events.append(cycleId, 'ERROR', { worldMemory: errorMessage(error) });
  }
}

/**
 * What the planner gets from world memory, when the agent can explore (movement enabled, in
 * mode 'follow'); undefined otherwise, and then EXPLORE is not offered to the planner either.
 */
export function explorationFor(
  config: AgentConfig,
  repos: Repositories,
  state: GameState,
  now: Date,
): ExplorationSummary | undefined {
  const m = config.minecraft.movement;
  if (!m.enabled || m.mode !== 'follow') return undefined;
  const { position, dimension } = state.player;
  if (!position.known || !dimension.known) return undefined;
  const summary = summarizeExploration({
    chunks: repos.worldMemory.chunks(dimension.value),
    from: position.value,
    boundary: config.safety.boundary,
    now,
  });
  // Places an EXPLORE from around here could not get closer to are no use from here.
  return withoutDeadEnds(summary, readDeadEnds(repos.memory), position.value);
}

/**
 * The current task's latest plan, for System 1: a model asked at decision points
 * (src/system1/model-cadence.ts) lets the router's decision continue an open plan, and
 * decides when it ended or there is none.
 */
export function taskPlanFacts(repos: Repositories, state: GameState): PlanFacts | null {
  const taskId = state.currentTask?.taskId ?? null;
  const plan = taskId === null ? null : repos.plans.latestForTask(taskId);
  if (plan === null) return null;
  const steps = plan.plan.steps.length;
  return {
    planId: plan.id,
    status: plan.status,
    step: Math.min(plan.nextStep + 1, steps),
    steps,
    stepType: plan.plan.steps[plan.nextStep]?.action.type ?? null,
  };
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

interface PlanStepRef {
  planId: number;
  /** 0-based index of the step being executed. */
  stepIndex: number;
  failureHandling: Plan['failureHandling'];
  /** Who wrote the plan (OPERATOR_PLANNER for a human's plan). */
  planner: string;
  /**
   * The step is a GATHER (gather-step.ts), which runs many actions: this one is for the
   * block at `target` (`walk`: the walk to its stand spot; `travel`: an EXPLORE toward a
   * place it is remembered at), or for the animal `entity`.
   */
  gather?: {
    ref: GatherRef;
    target: BlockPosition;
    walk: boolean;
    entity: number | null;
    travel?: boolean;
  };
}

const reviewHint = (taskId: string, planId: number): string =>
  `Review: node src/app/cli.ts plan-show --task ${taskId}; then plan-approve (or plan-reject) --task ${taskId} --plan ${planId}.`;

type Consulted =
  | { chosen: ChosenAction; outcome: PlannerOutcome; planStep: PlanStepRef | null }
  /** A GATHER step ended before choosing an action: nothing runs this cycle. */
  | {
      chosen: null;
      outcome: PlannerOutcome;
      ended: { status: CycleStatus; label: string; why: string };
    };

/**
 * Where world memory remembers a GATHER step's block, for a step with none of it in view
 * (gather.ts GatherOptions.remembered). None for an animal: animals wander, and world memory
 * keeps places of blocks only.
 */
function rememberedFor(
  deps: AgentDeps,
  gather: GatherStep,
  state: GameState,
  now: Date,
): NonNullable<GatherOptions['remembered']> {
  if (!('block' in gather.args)) return [];
  return rememberedPlacesOf(
    gather.args.block,
    state,
    explorationFor(deps.config, deps.repos, state, now),
  );
}

function stepOf(
  deps: AgentDeps,
  stored: StoredPlan,
  outcomeKind: 'plan-accepted' | 'plan-step',
  state: GameState,
  ctx: SafetyContext,
): Consulted {
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
  const head = `plan #${stored.id} "${stored.plan.goal}" step ${stored.nextStep + 1}/${total}`;
  const planStep: PlanStepRef = {
    planId: stored.id,
    stepIndex: stored.nextStep,
    failureHandling: stored.plan.failureHandling,
    planner: stored.planner,
  };
  if (step.action.type === GATHER) {
    // Code picks this cycle's action from the fresh observation (no model is asked).
    const ref: GatherRef = {
      taskId: stored.taskId,
      planId: stored.id,
      stepIndex: stored.nextStep,
      gather: step.action,
    };
    const turn = gatherTurn(
      deps.repos,
      ref,
      state,
      ctx,
      rememberedFor(deps, step.action, state, ctx.now),
    );
    if (turn.kind === 'end') return gatherEnded(deps.repos, stored, turn, outcome);
    return {
      chosen: {
        spec: turn.spec,
        reason: `${head}: ${turn.reason}`.slice(0, 500),
        origin: 'planner',
      },
      outcome,
      planStep: {
        ...planStep,
        gather: {
          ref,
          target: turn.target,
          walk: turn.walk,
          entity: turn.entity,
          ...(turn.travel === true ? { travel: true } : {}),
        },
      },
    };
  }
  return {
    chosen: {
      spec: step.action,
      reason: `${head}: ${step.rationale}`.slice(0, 500),
      origin: 'planner',
    },
    outcome,
    planStep,
  };
}

/**
 * A GATHER step that ended before choosing an action (its journal line is written):
 *  - done: the step is verified, and the plan advances like after any verified step;
 *  - at its bound (64 actions or 5 minutes): a checkpoint; and nothing left to dig: a stale
 *    step. Either fails the plan, so the next cycle asks the planner again (it reads why in
 *    the journal, and can EXPLORE).
 * Nothing runs this cycle. A plan the planner has just made, whose GATHER finds nothing to
 * dig, is refused like a first step the executor refuses as stale: the cycle is
 * 'rejected', and the task goes on.
 */
function gatherEnded(
  repos: Repositories,
  stored: StoredPlan,
  turn: { end: 'done' | 'bound' | 'no-target'; why: string },
  outcome: PlannerOutcome,
): Consulted {
  const step = stored.nextStep + 1;
  if (turn.end === 'no-target' && step < stored.plan.steps.length) {
    // Nothing of it to dig here, but the plan goes on: skip to its next step (seen live:
    // GATHER gravel with none in view, before GATHER logs with 66 in view). The next plan
    // sees the item still missing in the route, and can EXPLORE for it.
    repos.memory.appendJournal(
      stored.taskId,
      `plan #${stored.id} step ${step} GATHER skipped (${turn.why}); on to step ${step + 1}`.slice(
        0,
        300,
      ),
    );
    repos.plans.advance(stored.id);
    return {
      chosen: null,
      outcome,
      ended: { status: 'succeeded', label: 'GATHER:no-target, skipped', why: turn.why },
    };
  }
  if (turn.end === 'done') {
    stepVerified(repos, stored.id);
  } else {
    const kind = turn.end === 'bound' ? 'checkpoint' : 'stale';
    repos.plans.setStatus(
      stored.id,
      'failed',
      `step ${step} GATHER ${kind}: ${turn.why}`.slice(0, 500),
    );
  }
  const stale = turn.end === 'no-target' && outcome.kind === 'plan-accepted';
  return {
    chosen: null,
    outcome,
    ended: { status: stale ? 'rejected' : 'succeeded', label: `GATHER:${turn.end}`, why: turn.why },
  };
}

/** The plan's current step is verified: advance (completing the plan after its last step). */
function stepVerified(repos: Repositories, planId: number): void {
  const plan = repos.plans.advance(planId);
  if (plan.status === 'completed') {
    repos.memory.appendJournal(
      plan.taskId,
      `plan #${plan.id} done: ${plan.plan.goal}`.slice(0, 300),
    );
  }
  // A plan a human wrote for the task IS the task: finishing it finishes the task.
  if (plan.status === 'completed' && plan.planner === OPERATOR_PLANNER) {
    repos.tasks.setStatus(plan.taskId, 'completed');
  }
}

/**
 * Safety refusals that only say a step no longer matches what is observed, not that it is
 * dangerous: NOT_DIGGABLE means the block is not in the current list of observed diggable
 * blocks (already dug, or out of the scan since the player moved); NOT_INTERACTABLE the
 * same for blocks to interact with (a furnace out of the scan, or gone); TARGET_GONE means
 * the entity to attack is no longer near (it died, wandered off or despawned). The step is
 * still refused; only the reaction differs (see isStaleRejection).
 */
const STALE_VIOLATION_CODES: ReadonlySet<string> = new Set([
  'NOT_DIGGABLE',
  'NOT_PLACEABLE',
  'NOT_INTERACTABLE',
  'TARGET_GONE',
]);

/**
 * A planner's step rejected only because it no longer fits the world NOW: preconditions
 * (out of reach, too few items, the block gone) and/or a stale-observation refusal
 * (STALE_VIOLATION_CODES), and nothing else. The player moved or the world changed since
 * the plan was made: a stale plan, not an unsafe one. Or a danger came up after System 1
 * decided (ACTION_NOT_ALLOWED_IN_DANGER alone): System 1 meets it next cycle (a retreat, a
 * flight, a fight), and the planner is asked again after (seen live: a gatling skeleton came
 * in range while the planner planned, the EXPLORE was refused, and the task was blocked for a
 * human). A human's plan is never treated this way, and any other safety violation still
 * halts the task.
 */
export function isStaleRejection(ref: PlanStepRef | null, outcome: ExecutionOutcome): boolean {
  const v = outcome.validation;
  return (
    ref !== null &&
    ref.planner !== OPERATOR_PLANNER &&
    outcome.status === 'rejected' &&
    v.violations.every(
      (x) => STALE_VIOLATION_CODES.has(x.code) || x.code === 'ACTION_NOT_ALLOWED_IN_DANGER',
    ) &&
    (v.violations.length > 0 || v.preconditionFailures.length > 0)
  );
}

/**
 * Rejected only because the step no longer fits what is observed (preconditions and/or
 * STALE_VIOLATION_CODES), nothing else: for a code-made blueprint's step (known-steps.ts),
 * whose plan is made again from the new view.
 */
function onlyStaleRefusals(outcome: ExecutionOutcome): boolean {
  const v = outcome.validation;
  return (
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
 *
 * A GATHER step runs many actions: a verified one advances the plan only once the
 * inventory holds the step's count; until then the step goes on (its failures are counted
 * in a row again), and at its bound (64 actions or 5 minutes) the plan ends for a
 * checkpoint, so the next cycle asks the planner. An action of it that does not succeed
 * meets the plan's own failure handling, like any step.
 */
function updatePlanProgress(
  repos: Repositories,
  ref: PlanStepRef,
  outcome: ExecutionOutcome,
  now: Date,
  stateBefore: GameState,
): boolean {
  const journal = (text: string): void => {
    const plan = repos.plans.get(ref.planId);
    if (plan !== null) repos.memory.appendJournal(plan.taskId, text);
  };
  const gather = ref.gather;
  if (gather !== undefined) {
    const after = gatherAfterAction(repos, gather.ref, gather, outcome, now);
    if (after.next === 'more') {
      repos.plans.resetStepFailures(ref.planId);
      return false;
    }
    if (after.next === 'bound') {
      repos.plans.setStatus(
        ref.planId,
        'failed',
        `step ${ref.stepIndex + 1} GATHER checkpoint: ${after.why}`.slice(0, 500),
      );
      return false;
    }
    // 'done' is a verified step (below); 'failed' meets the plan's failure handling (below).
  }
  /** A GATHER whose plan stops here: its last journal line. */
  const gatherEnds = (why: string): void => {
    if (gather !== undefined) {
      gatherStopped(repos, gather.ref, why, now, outcome.stateAfter ?? stateBefore);
    }
  };
  switch (outcome.status) {
    case 'succeeded':
      stepVerified(repos, ref.planId);
      return false;
    case 'rejected':
      gatherEnds(`its ${outcome.actionType} was refused`);
      journal(
        `plan #${ref.planId} failed at step ${ref.stepIndex + 1} (${outcome.actionType}): ` +
          (outcome.validation.preconditionFailures[0] ??
            outcome.validation.violations[0]?.message ??
            'rejected'),
      );
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
      gatherEnds(`its ${outcome.actionType} did not succeed ${failures} time(s) in a row`);
      journal(
        `plan #${ref.planId} failed at step ${ref.stepIndex + 1} (${outcome.actionType}) ` +
          `${failures} time(s): ${outcome.execution?.message ?? 'not verified'}`,
      );
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

/**
 * A plan's DIG_BLOCK steps that dig a listed block giving nothing the task still needs (a
 * resource goal: currentTask.requirements), as a refusal like refusedFirstStep's, with a note
 * that names them and the GATHER that digs the right blocks; null when every dig gives
 * something needed, or the task names no requirements. Seen live: "dig the nearest gravel
 * block" eight times at blocks that were sand, dirt and grass; every dig was valid, and none
 * gave gravel.
 */
function digsForNothing(plan: Plan, state: GameState): ReturnType<typeof refusedFirstStep> {
  const needs = state.currentTask?.requirements;
  if (needs === undefined || Object.keys(needs).length === 0 || !state.nearbyBlocks.known) {
    return null;
  }
  const listed = state.nearbyBlocks.value.resources;
  const useless: string[] = [];
  for (const s of plan.steps) {
    if (s.action.type !== 'DIG_BLOCK') continue;
    const at = s.action.args.position;
    const block = listed.find(
      (r) => r.position.x === at.x && r.position.y === at.y && r.position.z === at.z,
    )?.block;
    if (block === undefined) continue; // not listed: the executor refuses it as NOT_DIGGABLE
    if (DIG_YIELDS[block].some((y) => needs[y.item] !== undefined)) continue;
    useless.push(`(${at.x}, ${at.y}, ${at.z}) is ${block}`);
  }
  if (useless.length === 0) return null;
  const first = plan.steps.find((s) => s.action.type === 'DIG_BLOCK')?.action as ActionSpec;
  const wanted = Object.entries(needs)
    .map(([item, n]) => `${n} ${item}`)
    .join(', ');
  const why = `it digs blocks that give nothing the task needs (${wanted}): ${useless.join('; ')}`;
  const tail = '. To get a block, plan GATHER {block, count}: code digs only that block.';
  const head = 'Your plan would dig the wrong blocks';
  const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
  return {
    step: `DIG_BLOCK x${useless.length}`,
    why,
    note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
    action: first,
    lastFailure: null,
    repeated: false,
  };
}

/**
 * Refusals a new plan cannot change: the observation is not trustworthy, or a danger allows
 * only escapes. System 1 deals with those, not the planner.
 */
const NOT_THE_PLANS: ReadonlySet<string> = new Set(['ACTION_NOT_ALLOWED_IN_DANGER']);

/**
 * The plan's first step when code would refuse it: the executor's own checks (schema, safety
 * policy, preconditions: validateCandidate), dry run on this state. Null when it would run,
 * when it is a GATHER (code expands that), or when the refusal is not the plan's to fix
 * (danger, an unreliable observation). With why, and a note for the planner; for a repeated
 * failure, also what the last failure said (for a walk: from this very block).
 */
function refusedFirstStep(
  deps: AgentDeps,
  plan: Plan,
  state: GameState,
  ctx: SafetyContext,
  taskId: string,
): {
  step: string;
  why: string;
  note: string;
  action: { type: string; args: unknown };
  /** What the last failure of this very step said, when it is a repeated failure. */
  lastFailure: string | null;
  /** The repeated-failure rule is among the refusals. */
  repeated: boolean;
} | null {
  // GATHER steps run first to last, one with nothing to dig skipped (gatherEnded): the step
  // that would act first is the one to check, and with none, the plan would do nothing (seen
  // live: "GATHER logs, GATHER gravel" again and again, the logs walled in, no gravel in view).
  const idle: string[] = [];
  let first: ActionSpec | undefined;
  for (const s of plan.steps) {
    if (s.action.type !== GATHER) {
      first = s.action;
      break;
    }
    const choice = chooseGatherAction(
      s.action,
      startGather(0, 0, s.action, state, ctx.now),
      state,
      {
        reach: ctx.config.interactionReach,
        now: ctx.now,
        check: previewCheck(deps.repos.actions, taskId, state, ctx),
        remembered: rememberedFor(deps, s.action, state, ctx.now),
      },
    );
    if (choice.kind === 'act') return null;
    if (choice.end === 'no-target') {
      idle.push(`GATHER ${sourceName(gatherSourceOf(s.action))}: ${choice.why}`);
    }
  }
  if (first === undefined) {
    if (idle.length === 0) return null;
    const why = idle.join('; ');
    const head = 'Your plan would dig nothing';
    const tail = '. Plan something else: EXPLORE toward where it can be reached, or another step.';
    const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
    const lead = plan.steps[0]?.action as { type: string; args: unknown };
    return {
      step: idle.map((l) => l.slice(0, l.indexOf(': '))).join(', '),
      why,
      note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
      action: lead,
      lastFailure: null,
      repeated: false,
    };
  }
  const action = createAction(
    { spec: first, reason: "dry run of a new plan's first step", origin: 'planner', taskId },
    { newId: () => 'dry-run', now: () => deps.clock.now() },
  );
  const { report } = validateCandidate(action, state, ctx, deps.repos.actions);
  if (report.ok) return null;
  const unreliable = new Set(assessStateReliability(state, ctx).map((v) => v.code));
  if (report.violations.some((v) => NOT_THE_PLANS.has(v.code) || unreliable.has(v.code))) {
    return null;
  }
  let why = [...report.violations.map((v) => v.message), ...report.preconditionFailures].join('; ');
  let lastFailure: string | null = null;
  const repeated = report.violations.some((v) => v.code === 'REPEATED_FAILURE');
  if (repeated) {
    const from = state.player.position.known ? state.player.position.value : null;
    const fingerprint = actionFingerprint(first, from);
    const last = deps.repos.actions
      .recent(50, taskId)
      .find(
        (a) =>
          a.fingerprint === fingerprint &&
          (a.status === 'failed' || a.status === 'verification_failed'),
      );
    const e = last?.execution;
    const failures = deps.repos.actions.countFailures(taskId, fingerprint);
    // A walk's failures count from this very block only (actionFingerprint).
    const here = fingerprint === actionFingerprint(first) ? '' : ' from where the player stands';
    if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') {
      why = `it failed ${failures} time(s)${here}: ${e.message}`;
      lastFailure = e.message;
    }
  }
  const step = `${first.type} ${stableStringify(first.args)}`.slice(0, 120);
  const head = `Step 1 of your plan, ${step}, would be refused`;
  const tail = '. Plan something else: another target or kind of step.';
  // Why, in the room the journal line leaves.
  const room = MAX_JOURNAL_LINE - head.length - tail.length - 3;
  return {
    step,
    why,
    note: `${head} (${why.slice(0, Math.max(0, room))})${tail}`,
    action: first,
    lastFailure,
    repeated,
  };
}

/** What the planner is told when it escalated for want of a place while exploring was open. */
const EXPLORE_REMINDER =
  'You escalated for want of a place, but EXPLORE is in allowedActions, it is day, and the ' +
  'route says where to look: plan an EXPLORE toward the place or biome it names (or a ' +
  'direction with little seen) as the last step. A failed EXPLORE from elsewhere or toward ' +
  'another point says nothing here.';

/** EXPLORE is offered, it is day, and the route points at somewhere to explore. */
function explorationOpen(request: PlannerRequest): boolean {
  return (
    request.allowedActions.includes('EXPLORE') &&
    request.state.time?.phase === 'day' &&
    (request.route?.steps ?? []).some((s) => s.includes('no known place yet: explore'))
  );
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

  // A code-made blueprint (the night shelter, the way out of it) runs its next step as a
  // known safe step whatever the decision provider chose: code's own steps never go through
  // the planner (known-steps.ts).
  const known = nextKnownStep(repos, taskId);
  if (known !== null) {
    return {
      chosen: {
        spec: known.spec,
        reason: `code's step ${known.index + 1}/${known.total}: ${known.text}`.slice(0, 500),
        origin: 'deterministic-router',
      },
      outcome: { kind: 'known-step', step: known.index + 1, steps: known.total },
      planStep: null,
    };
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
  if (open?.status === 'active') {
    // The open plan's next step, dry run like a new plan's first (refusedFirstStep): one the
    // repeated-failure rule would refuse now ends the plan, and the planner is asked again
    // below, told why. Seen live: an EXPLORE failed twice from one spot; the next session ran
    // the open plan's step a third time, the rule refused it, and play stopped for a human.
    // Other refusals still meet the plan's own handling when the step runs (a machine taken
    // for a chest blocks the task); a GATHER runs on as code expands it.
    const next = open.plan.steps[open.nextStep];
    const refused =
      next === undefined || next.action.type === GATHER
        ? null
        : refusedFirstStep(
            deps,
            { ...open.plan, steps: open.plan.steps.slice(open.nextStep) },
            state,
            ctx,
            taskId,
          );
    if (refused === null || !refused.repeated) return stepOf(deps, open, 'plan-step', state, ctx);
    repos.plans.setStatus(
      open.id,
      'failed',
      `step ${open.nextStep + 1} would be refused: ${refused.why}`.slice(0, 500),
    );
    repos.memory.appendJournal(
      taskId,
      `plan #${open.id} ended: its step ${open.nextStep + 1}, ${refused.step}, would be refused (${refused.why})`.slice(
        0,
        MAX_JOURNAL_LINE,
      ),
    );
    if (refused.lastFailure !== null) {
      rememberDeadEnd(
        repos.memory,
        refused.action,
        { ok: false, message: refused.lastFailure },
        state.player.position.known ? state.player.position.value : null,
      );
    }
  }

  if (planner === null || config.planner.provider === 'none') {
    return pauseWith(
      'No planner is configured and no known safe step exists. What should the agent do?',
      {
        kind: 'unavailable',
      },
    );
  }

  const limit = config.planner.recentHistoryLimit;
  const requestNow = (): PlannerRequest => {
    const exploration = explorationFor(config, repos, state, ctx.now);
    return buildPlannerRequest({
      state,
      safety: ctx,
      maxPlanSteps: config.planner.maxPlanSteps,
      ...(exploration === undefined ? {} : { exploration }),
      recentMeals: repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
      combatEnabled: config.minecraft.combat.enabled,
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
      journal: repos.memory.journal(taskId).map((e) => e.text),
    });
  };
  const request = requestNow();

  const ask = async (req: PlannerRequest): Promise<PlannerResponse> => {
    try {
      // A journal line past the request's limit fails the whole request before the model
      // sees it (seen live: both re-ask notes were too long, so neither re-ask ever ran).
      const journal = req.journal.map((line) => line.slice(0, MAX_JOURNAL_LINE));
      const parsed = PlannerResponseSchema.safeParse(await planner.plan({ ...req, journal }));
      return parsed.success
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
      return {
        kind: 'escalation',
        escalation: {
          reason: 'OTHER',
          message: `Planner error: ${errorMessage(error)}`.slice(0, 500),
          questionForUser: 'The planner failed. How should the agent proceed?',
        },
      };
    }
  };
  let response = await ask(request);
  // An escalation for want of a place while exploring is open, in daylight, with the route
  // saying where to look, contradicts the request: ask once more and say so (seen live: the
  // model kept escalating "no way to explore" with EXPLORE allowed and a forest in the route).
  if (
    response.kind === 'escalation' &&
    response.escalation.reason === 'INSUFFICIENT_STATE' &&
    explorationOpen(request)
  ) {
    repos.events.append(cycleId, 'PLAN', { provider: planner.name, response });
    repos.memory.appendJournal(
      taskId,
      `planner escalated (${response.escalation.reason}) although EXPLORE was open; asked again`,
    );
    response = await ask({ ...request, journal: [...request.journal, EXPLORE_REMINDER] });
  }
  repos.events.append(cycleId, 'PLAN', { provider: planner.name, response });

  if (response.kind === 'escalation') {
    const e = response.escalation;
    repos.memory.appendJournal(taskId, `planner escalated (${e.reason}): ${e.message}`);
    return pauseWith(e.questionForUser, {
      kind: 'escalation',
      reason: e.reason,
      message: e.message,
    });
  }

  // Steps after an EXPLORE (and view-bound steps after a GATHER) were planned from a view
  // that will be gone when they run: they are dropped first, and only the steps that will run
  // are checked (seen live: a starving agent's food plan, EXPLORE, GATHER garden, then
  // EAT_FOOD of the garden block, was rejected whole for its third step, and it paused).
  const firstTrim = trimStaleSteps(response.plan);
  const validation = validatePlan(firstTrim.plan, ctx, config.planner.maxPlanSteps);
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

  // The next plan starts from where the dropped steps would have (firstTrim above).
  let plan = validation.plan;
  let trimmed = firstTrim.note;
  // A first step code would refuse ends the session, often for a human (seen live: the model
  // planned the same EXPLORE toward an unreachable tree a third time, and EXPLORE toward the
  // forest it stood in, 1.6 blocks away, three sessions running). Code checks the step the
  // way the executor will, and if it would refuse it for a reason the planner can change,
  // asks once more, saying why; should that answer not do, the first plan stands and the
  // executor refuses its step as before.
  const refused = digsForNothing(plan, state) ?? refusedFirstStep(deps, plan, state, ctx, taskId);
  if (refused !== null) {
    repos.memory.appendJournal(
      taskId,
      `planner chose ${refused.step}, which code would refuse (${refused.why}); asked again`.slice(
        0,
        MAX_JOURNAL_LINE,
      ),
    );
    // An EXPLORE that found no way further from here is a dead end (dead-ends.ts): remember
    // it now, so the request asked again no longer offers the places around its point.
    let base = request;
    if (refused.lastFailure !== null) {
      rememberDeadEnd(
        repos.memory,
        refused.action,
        { ok: false, message: refused.lastFailure },
        state.player.position.known ? state.player.position.value : null,
      );
      base = requestNow();
    }
    const again = await ask({ ...base, journal: [...base.journal, refused.note] });
    repos.events.append(cycleId, 'PLAN', { provider: planner.name, response: again });
    const againTrim = again.kind === 'plan' ? trimStaleSteps(again.plan) : null;
    const checked =
      againTrim === null ? null : validatePlan(againTrim.plan, ctx, config.planner.maxPlanSteps);
    if (againTrim !== null && checked?.ok === true && checked.plan !== null) {
      plan = checked.plan;
      trimmed = againTrim.note;
    }
  }
  const stored = repos.plans.create(
    taskId,
    plan,
    plan.requiresUserApproval ? 'pending_approval' : 'active',
    planner.name,
  );
  repos.checkpoints.add(
    taskId,
    'plan',
    { planId: stored.id, status: stored.status, plan, ...(trimmed === null ? {} : { trimmed }) },
    stateSnapshotId,
  );
  if (stored.status === 'pending_approval') {
    // The commands come before the planner's explanation so truncation cannot cut them off.
    return pauseWith(
      `Approve plan #${stored.id} "${plan.goal}" (${plan.steps.length} steps)? ${reviewHint(taskId, stored.id)} Planner: ${plan.explanation}`,
      { kind: 'approval-required', planId: stored.id, goal: plan.goal, steps: plan.steps.length },
    );
  }
  repos.memory.appendJournal(
    taskId,
    `new plan #${stored.id}: ${stored.plan.goal} (${stored.plan.steps.length} steps` +
      `${trimmed === null ? '' : `; code ${trimmed}`})`,
  );
  return stepOf(deps, stored, 'plan-accepted', state, ctx);
}
