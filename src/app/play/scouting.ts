import type { WorldTime } from '../../domain/game-state.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import type { SessionLimits, SessionResult } from '../loop/live-session.ts';
import { foodDue } from './food.ts';
import { cycleEvent } from './narration.ts';
import { isDark, nightReason } from './night.ts';
import { CONTINUE_AFTER, done, mobPause, waitOutMob, type PlayState } from './play-state.ts';
import type { PlayResult } from './play.ts';

/**
 * Scouting, play's own first task. GTNH rewards a good starting spot ("You will have to travel
 * far in this tier"; gravel "near water", clay on "the riverbanks", per the quest book), so when
 * the agent can explore and world memory has seen little, play begins with ONE bounded session
 * whose task is to look around: the planner chooses EXPLORE steps, validated and verified like
 * any other. It ends once enough is seen, at the session's limits, or when anything needs a
 * human; then the quests begin. It happens once: a completed scouting task is never redone.
 */
export const SCOUT_TASK_ID = 'scout-area';
/**
 * Chunks seen near below which play scouts first (one spot's near view is about 25-37 chunks;
 * what far sight spots beyond it does not count: landmarks only, no trees).
 */
export const SCOUT_BELOW_CHUNKS = 50;
/** Chunks seen at which scouting is done: two or three long explores. */
export const SCOUT_DONE_CHUNKS = 100;
export const SCOUT_GOAL =
  'Scout the area before settling (GTNH start): EXPLORE two or three directions with little seen, ' +
  'up to 96 blocks each, to find wood (logs), water with sand, gravel and clay, and stone.';

export interface Scouting {
  /** Chunks the agent has seen near so far (world memory; not those seen only from afar). */
  chunksSeen: () => number;
}

export type ScoutingPlan = { kind: 'scout' } | { kind: 'skip' } | { kind: 'stop'; reason: string };

/** Whether play should scout first, skip it, or stop because the scouting task needs a human. */
export function scoutingDue(repos: Repositories, scouting: Scouting): ScoutingPlan {
  const task = repos.tasks.get(SCOUT_TASK_ID);
  if (task?.status === 'completed') return { kind: 'skip' };
  if (task !== null && task.status !== 'active') {
    return {
      kind: 'stop',
      reason: `the scouting task ${SCOUT_TASK_ID} is ${task.status}; it needs you (task-resume or task-complete) before play goes on`,
    };
  }
  const seen = scouting.chunksSeen();
  if (seen >= SCOUT_DONE_CHUNKS || (task === null && seen >= SCOUT_BELOW_CHUNKS)) {
    if (task !== null) finishScoutTask(repos);
    return { kind: 'skip' };
  }
  return { kind: 'scout' };
}

/** Makes scouting the current task (created active, or kept active). */
export function adoptScoutTask(repos: Repositories): { taskId: string; created: boolean } {
  return repos.transaction(() => {
    const created = repos.tasks.get(SCOUT_TASK_ID) === null;
    repos.tasks.ensure({ id: SCOUT_TASK_ID, goal: SCOUT_GOAL, subgoal: null, status: 'active' });
    repos.memory.setValue(CURRENT_TASK_KEY, SCOUT_TASK_ID);
    return { taskId: SCOUT_TASK_ID, created };
  });
}

/** Scouting is over: its task is completed, its open plan closed, and it is no longer current. */
export function finishScoutTask(repos: Repositories): void {
  repos.transaction(() => {
    const task = repos.tasks.get(SCOUT_TASK_ID);
    if (task !== null && task.status === 'active')
      repos.tasks.setStatus(SCOUT_TASK_ID, 'completed');
    const open = repos.plans.openForTask(SCOUT_TASK_ID);
    if (open !== null) repos.plans.setStatus(open.id, 'completed', 'scouting is over');
    if (repos.memory.getValue(CURRENT_TASK_KEY) === SCOUT_TASK_ID) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
  });
}

/**
 * One bounded session on the scouting task. It stops early once SCOUT_DONE_CHUNKS are seen, or
 * when an observation shows the evening (then `dark` is that clock).
 */
export async function runScoutSession(input: {
  scouting: Scouting;
  limits: SessionLimits;
  session: (
    limits: SessionLimits,
    hooks: {
      stopRequested: () => string | null;
      onCycle: (result: CycleResult, index: number) => void;
    },
  ) => Promise<SessionResult>;
  stopRequested: () => string | null;
  onCycle: (result: CycleResult, index: number) => void;
}): Promise<{ session: SessionResult; scouted: boolean; dark: WorldTime | null }> {
  let dark: WorldTime | null = null;
  const enough = (): boolean => input.scouting.chunksSeen() >= SCOUT_DONE_CHUNKS;
  const session = await input.session(input.limits, {
    stopRequested: () =>
      enough()
        ? 'the area is scouted'
        : dark !== null
          ? `it is ${dark.phase}`
          : input.stopRequested(),
    onCycle: (result, index) => {
      input.onCycle(result, index);
      const after = result.outcome?.stateAfter;
      if (after?.time.known === true) {
        const t = after.time.value;
        if (t.phase === 'evening' || t.phase === 'night') dark = t;
      }
    },
  });
  return { session, scouted: enough(), dark };
}

/**
 * GTNH start: look around once before settling, when the agent can explore (deps.scouting):
 * the scouting session, when one is due and the agent is not hungry with nothing to eat. Play
 * ends here if the session stopped for the dark, a mob, a human or the stop file; else null,
 * and play goes on to its rounds.
 */
export async function scoutingRound(play: PlayState): Promise<PlayResult | null> {
  const { deps, limits, hooks, emit } = play;
  if (deps.scouting !== undefined) {
    const due = scoutingDue(deps.repos, deps.scouting);
    if (due.kind === 'stop') return done(play, due.reason);
    // Hungry with nothing to eat, food comes first: a food trip explores for food itself, and
    // below food 6 a scout's EXPLOREs would be refused (only the food task's may run then).
    // The scouting waits for the next play.
    const fed = due.kind === 'scout' ? ((await deps.food?.now()) ?? null) : null;
    if (fed !== null && foodDue(fed)) {
      emit({
        kind: 'food',
        message: `food ${fed.hunger}/20 and nothing to eat: food before scouting`,
      });
    } else if (due.kind === 'scout') {
      const stop = hooks.stopRequested();
      if (stop !== null) return done(play, stop);
      const clock = (await deps.time?.()) ?? null;
      if (clock !== null && isDark(clock)) return done(play, nightReason(clock), clock);
      const scout = adoptScoutTask(deps.repos);
      emit({ kind: 'scout', ...scout, chunksSeen: deps.scouting.chunksSeen() });
      const session = play.sessions + 1;
      const r = await runScoutSession({
        scouting: deps.scouting,
        limits: limits.session,
        session: deps.session,
        stopRequested: hooks.stopRequested,
        onCycle: (c, index) => {
          play.lastDecision = c.decision ?? null;
          emit(cycleEvent(deps.repos, session, c, index));
        },
      });
      play.sessions = session;
      play.lastStop = r.session.stopReason;
      emit({
        kind: 'session-end',
        session,
        stopKind: r.session.stopKind,
        stopReason: r.session.stopReason,
        cycles: r.session.cycles.length,
        system1: r.session.system1,
      });
      if (r.dark !== null) return done(play, nightReason(r.dark), r.dark);
      const mob = mobPause(r.session.stopKind, play.lastDecision);
      if (mob !== null) return waitOutMob(play, SCOUT_TASK_ID, mob);
      if (r.session.stopKind === 'stop-requested' && !r.scouted) {
        return done(play, r.session.stopReason);
      }
      if (!CONTINUE_AFTER.has(r.session.stopKind)) return done(play, r.session.stopReason);
      finishScoutTask(deps.repos);
    }
  }
  return null;
}
