import type { AgentConfig } from '../../config/env.ts';
import { isAllowlistedActionType } from '../../domain/actions.ts';
import { LastActionSchema, type GameState } from '../../domain/game-state.ts';
import { summarizeExploration, type ExplorationSummary } from '../../domain/world-memory.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { mergeProtectedItems } from '../../safety/protected-items.ts';
import type { SafetyContext } from '../../safety/safety-policy.ts';
import type { PlanFacts } from '../../system1/state-queries.ts';
import { errorMessage } from '../../util/json.ts';
import type { AgentDeps } from './agent-loop.ts';
import { readDeadEnds, withoutDeadEnds } from './dead-ends.ts';
import { nextKnownStep } from './known-steps.ts';

/**
 * Agent memory around a cycle (agent-loop.ts): the config copied into the database, the
 * safety context built from both, and what the agent remembers laid over each observation
 * (the operator's current task, containers seen, world memory and its dead ends, the task's
 * plan for System 1).
 */

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

function requirementsOf(
  repos: Repositories,
  taskId: string,
): { requirements?: Record<string, number>; anyKind?: string[]; blueprint?: string[] } {
  const r = repos.memory.taskRequirements(taskId);
  const k = r === null ? [] : repos.memory.taskAnyKind(taskId);
  const b = repos.memory.taskBlueprint(taskId);
  return {
    ...(r === null ? {} : { requirements: r }),
    ...(k.length === 0 ? {} : { anyKind: k }),
    ...(b === null ? {} : { blueprint: b }),
  };
}

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

/** Records every container whose contents are visible in this (raw) observation. */
export function rememberContainers(repos: Repositories, state: GameState | null): void {
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
 * a player could see), and the players' builds it saw (src/domain/player-builds.ts: blocks
 * it never breaks). A problem here is logged and never stops the cycle.
 */
export function rememberSeen(deps: AgentDeps, cycleId: string): void {
  try {
    const seen = deps.client.takeSeenChunks?.() ?? [];
    if (seen.length > 0) deps.repos.worldMemory.remember(seen);
  } catch (error) {
    deps.repos.events.append(cycleId, 'ERROR', { worldMemory: errorMessage(error) });
  }
  try {
    const builds = deps.client.takePlayerBuilds?.();
    if (builds !== undefined) deps.repos.playerBuilds.apply(builds);
  } catch (error) {
    deps.repos.events.append(cycleId, 'ERROR', { playerBuilds: errorMessage(error) });
  }
}

/** Clients that have been given the players' builds agent memory keeps. */
const seededClients = new WeakSet<object>();

/**
 * Gives a client the players' builds agent memory keeps, once (before its first observation):
 * so after a restart, or on a new connection, the blocks a player built stay never broken.
 * A problem here is logged; the client then knows only the builds it sees itself.
 */
export function seedPlayerBuilds(deps: AgentDeps, cycleId: string): void {
  const client = deps.client;
  if (client.knowPlayerBuilds === undefined || seededClients.has(client)) return;
  try {
    client.knowPlayerBuilds(deps.repos.playerBuilds.all());
    seededClients.add(client);
  } catch (error) {
    deps.repos.events.append(cycleId, 'ERROR', { playerBuilds: errorMessage(error) });
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
