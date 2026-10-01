import type { Decision, DecisionResult } from '../domain/decisions.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
import { system1Stats, type System1Stats } from '../system1/model-cadence.ts';
import { runSingleCycle, type AgentDeps, type CycleResult } from './agent-loop.ts';

/**
 * A BOUNDED run: ordinary single cycles, back to back, on one connection, for the current
 * task. Nothing here decides or checks anything a single cycle does not: each cycle is
 * runSingleCycle, with the same decision logic, validation, execution and verification.
 * The run only decides whether to start ANOTHER cycle, and it stops at the first sign that
 * a human should look:
 *
 *  - the task is finished (or there is none);
 *  - a cycle that did not succeed, or that asks for attention;
 *  - a cycle whose decision was not plain task progress (a safety retreat, eating, upkeep or
 *    a pause), so a human sees why the agent turned aside;
 *  - the cycle or time limit, the stop file / Ctrl+C (checked before every cycle), or a
 *    lost connection (a cycle error).
 */
export interface SessionLimits {
  /** Hard cap on cycles in this run (1-200). */
  maxCycles: number;
  /** Hard cap on wall-clock time (1-60 minutes). */
  maxMinutes: number;
  /** Pause between cycles, so the server's updates arrive (0-10 000 ms). */
  pauseMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  maxCycles: 20,
  maxMinutes: 10,
  pauseMs: 300,
};

/** Decisions after which the run may go on: steps of the task itself, and resting for it. */
const TASK_PROGRESS: ReadonlySet<Decision> = new Set([
  'REQUEST_PLANNER',
  'EXECUTE_KNOWN_SAFE_STEP',
  'WAIT_FOR_MACHINE',
  'REST',
]);

/** Why a run stopped, for callers that decide what comes next (the play loop). */
export type SessionStopKind =
  | 'no-task'
  | 'task-finished'
  | 'task-halted'
  | 'limit'
  | 'stop-requested'
  | 'cycle-failed'
  | 'needs-attention'
  | 'non-task-decision';

export interface SessionResult {
  cycles: Array<{ cycleId: string; summary: string }>;
  stopReason: string;
  stopKind: SessionStopKind;
  taskId: string | null;
  taskStatus: string | null;
  elapsedMs: number;
  /** How System 1 decided this session's cycles: the model, continuing, or binding rules. */
  system1?: System1Stats | undefined;
}

export function checkLimits(limits: SessionLimits): string | null {
  if (!Number.isInteger(limits.maxCycles) || limits.maxCycles < 1 || limits.maxCycles > 200) {
    return 'max cycles must be 1-200';
  }
  if (!(limits.maxMinutes >= 1 && limits.maxMinutes <= 60)) return 'max minutes must be 1-60';
  if (!Number.isInteger(limits.pauseMs) || limits.pauseMs < 0 || limits.pauseMs > 10_000) {
    return 'pause must be 0-10000 ms';
  }
  return null;
}

export async function runSession(
  deps: AgentDeps,
  limits: SessionLimits,
  hooks: {
    /** A reason to stop before the next cycle (stop file, Ctrl+C), or null. */
    stopRequested: () => string | null;
    onCycle?: (result: CycleResult, index: number) => void;
  },
): Promise<SessionResult> {
  const problem = checkLimits(limits);
  if (problem !== null) throw new Error(problem);
  const started = Date.now();
  const cycles: SessionResult['cycles'] = [];
  const decisions: Array<DecisionResult | null> = [];
  const taskId = deps.repos.memory.getValue(CURRENT_TASK_KEY);
  const taskStatus = (): string | null =>
    taskId === null ? null : (deps.repos.tasks.get(taskId)?.status ?? null);
  const done = (stopKind: SessionStopKind, stopReason: string): SessionResult => ({
    cycles,
    stopReason,
    stopKind,
    taskId,
    taskStatus: taskStatus(),
    elapsedMs: Date.now() - started,
    system1: system1Stats(decisions),
  });
  // A new session: a model asked at decision points decides its first cycle.
  deps.decisionProvider.startSession?.();

  for (;;) {
    const status = taskStatus();
    if (taskId === null || status === null) {
      return done('no-task', 'there is no current task (cli task-add)');
    }
    if (status === 'completed') return done('task-finished', 'the task is completed');
    if (status !== 'active') return done('task-halted', `the task is ${status}`);
    if (cycles.length >= limits.maxCycles)
      return done('limit', `reached the limit of ${limits.maxCycles} cycles`);
    if (Date.now() - started >= limits.maxMinutes * 60_000) {
      return done('limit', `reached the limit of ${limits.maxMinutes} minutes`);
    }
    const stop = hooks.stopRequested();
    if (stop !== null) return done('stop-requested', stop);

    const result = await runSingleCycle(deps);
    cycles.push({ cycleId: result.cycleId, summary: result.summary });
    decisions.push(result.decision);
    hooks.onCycle?.(result, cycles.length);

    if (result.status !== 'succeeded' || result.needsUserAttention) {
      // A cycle that asks for a human is reported as such even when it also failed.
      return done(
        result.needsUserAttention ? 'needs-attention' : 'cycle-failed',
        result.status !== 'succeeded'
          ? `stopped after: ${result.summary}`
          : `needs attention after: ${result.summary}`,
      );
    }
    if (result.decision === null || !TASK_PROGRESS.has(result.decision.decision)) {
      return done('non-task-decision', `stopped after a non-task decision: ${result.summary}`);
    }
    if (limits.pauseMs > 0) await new Promise((r) => setTimeout(r, limits.pauseMs));
  }
}
