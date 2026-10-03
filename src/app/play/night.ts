import { TICKS_PER_DAY, TICKS_PER_SECOND, type WorldTime } from '../../domain/game-state.ts';
import { describeShelter, describeShelterExit } from '../../goals/shelter.ts';
import {
  LEAVE_SHELTER_TASK_ID,
  NIGHT_SHELTER_TASK_ID,
  type ShelterStep,
} from '../../domain/night-shelter.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import type { SessionResult } from '../loop/live-session.ts';
import { planOf } from './narration.ts';
import { done, type PlayState, type RoundEnd } from './play-state.ts';
import type { PlayDeps, PlayLimits } from './play.ts';

/**
 * Night in play: at dusk play has code make a shelter (a pit under the player, or a box
 * around it) and waits inside for the morning; in the morning code digs the way out before
 * the day's goal goes on. Without shelters, play stops before the dark (cli play then waits
 * offline until sunrise).
 */

/**
 * Real minutes until the next sunrise (tick 0 of the next day): from a day that night is soon
 * to end, the whole evening and night (minutesUntilDay is 0 by day).
 */
export const untilSunrise = (t: WorldTime): number =>
  Number(((TICKS_PER_DAY - t.timeOfDay) / TICKS_PER_SECOND / 60).toFixed(1));

/** Evening or night: hostile mobs come out. */
export const isDark = (t: WorldTime): boolean => t.phase === 'evening' || t.phase === 'night';

/** Real minutes before night when play starts on a shelter (placing is refused once mobs are near). */
export const SHELTER_LEAD_MINUTES = 2;

/** Dark, or dark within SHELTER_LEAD_MINUTES: time to be in a shelter. */
export const nightSoon = (t: WorldTime): boolean =>
  isDark(t) || (t.phase === 'day' && t.minutesUntilNight <= SHELTER_LEAD_MINUTES);

/**
 * Inside the shelter: waits until it is day again, checking the stop file / Ctrl+C and the
 * time limit every few seconds, and meanwhile hearing and answering owners' commands
 * (`between`: travel and goals wait for the morning). Returns why play must stop, or null at
 * sunrise.
 */
async function waitForMorning(
  deps: PlayDeps,
  hooks: { stopRequested: () => string | null },
  limits: PlayLimits,
  started: number,
  now: () => number,
  between: () => Promise<void>,
): Promise<string | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const stop = hooks.stopRequested();
    if (stop !== null) return stop;
    if (now() - started >= limits.maxMinutes * 60_000) {
      return `reached the limit of ${limits.maxMinutes} minutes`;
    }
    const t = (await deps.time?.()) ?? null;
    if (t === null) return 'the clock is unknown, so the morning cannot be awaited';
    if (t.phase === 'day' && !nightSoon(t)) return null;
    await between();
    await sleep(5000);
  }
}

export function nightReason(t: WorldTime): string {
  return (
    `it is ${t.phase} (${t.minutesUntilDay} min until sunrise): without a shelter the agent ` +
    'leaves (goes offline) before the mobs come'
  );
}

/**
 * One bounded session on a task whose route is a code-made blueprint (the night shelter,
 * the way out of it in the morning, standing by for commands). Its steps run as known safe
 * steps (known-steps.ts): code proposes each, the executor validates, executes and verifies
 * it, and the planner is not asked. The last verified step completes the task, which ends
 * the session.
 */
export async function blueprintSession(
  play: PlayState,
  b: {
    taskId: string;
    goal: string;
    subgoal: string;
    steps: string[];
    /** The same steps as actions, in order. */
    known: readonly ShelterStep[];
    label: string;
    text: string;
    missing: Record<string, number>;
    maxCycles: number;
  },
): Promise<SessionResult> {
  const { deps, limits, hooks, emit } = play;
  deps.repos.transaction(() => {
    deps.repos.tasks.ensure({ id: b.taskId, goal: b.goal, subgoal: b.subgoal, status: 'active' });
    deps.repos.tasks.setStatus(b.taskId, 'active');
    deps.repos.memory.setTaskBlueprint(b.taskId, b.steps);
    setKnownSteps(deps.repos, b.taskId, b.known);
    deps.repos.memory.setTaskRequirements(b.taskId, null);
    deps.repos.memory.setValue(CURRENT_TASK_KEY, b.taskId);
  });
  emit({
    kind: 'goal',
    quest: b.label,
    goal: b.text,
    missing: b.missing,
    taskId: b.taskId,
    created: false,
  });
  const session = play.sessions + 1;
  const result = await deps.session(
    { ...limits.session, maxCycles: Math.min(limits.session.maxCycles, b.maxCycles) },
    {
      stopRequested: hooks.stopRequested,
      onCycle: (r, index) => {
        play.lastDecision = r.decision ?? null;
        emit({
          kind: 'cycle',
          session,
          index,
          summary: r.summary,
          decision: null,
          newPlan:
            r.planner?.kind === 'plan-accepted' ? planOf(deps.repos, r.planner.planId) : null,
          detail: r.outcome?.execution?.message ?? null,
        });
      },
    },
  );
  play.sessions = session;
  emit({
    kind: 'session-end',
    session,
    stopKind: result.stopKind,
    stopReason: result.stopReason,
    cycles: result.cycles.length,
    system1: result.system1,
  });
  return result;
}

/**
 * Shelter time (nightSoon): sheltered, play waits inside for the morning; else code makes the
 * shelter (the pit, or the box) in a blueprint session, a session a round. With no shelter to
 * be had (or, without shelters, once it is dark) play stops, and the caller waits offline
 * until sunrise. Not shelter time: null, and tonight's shelter tries are over.
 */
export async function nightRound(play: PlayState): Promise<RoundEnd> {
  const { deps, limits, hooks, emit, started, now } = play;
  const clock = (await deps.time?.()) ?? null;
  if (clock !== null && nightSoon(clock)) {
    if (deps.shelter === undefined) {
      if (isDark(clock)) return done(play, nightReason(clock), clock);
    } else {
      const status = await deps.shelter('night');
      if (status === null)
        return done(play, `${nightReason(clock)}: the shelter cannot be checked`, clock);
      if (status.sheltered) {
        emit({
          kind: 'night',
          message: `sheltered: waiting for the morning (${untilSunrise(clock)} min)`,
        });
        const stop = await waitForMorning(deps, hooks, limits, started, now, play.whileSheltered);
        if (stop !== null) return done(play, stop);
        emit({ kind: 'night', message: 'morning: leaving the shelter' });
        play.wakeNote =
          status.kind === 'pit'
            ? 'morning: the player is at the bottom of its night pit (natural walls, a roof ' +
              'above): code digs the roof and a staircase out before the day starts'
            : 'morning: the player is inside its night shelter (walls around it, a roof ' +
              'above): code digs one wall out before the day starts';
        return 'next-round';
      }
      if (status.problem !== null || play.shelterTries >= limits.maxStuckSessions) {
        const why = status.problem ?? `${play.shelterTries} sessions did not finish it`;
        return done(play, `${nightReason(clock)}; no shelter: ${why}`, clock);
      }
      play.shelterTries += 1;
      const pit = status.kind === 'pit';
      const result = await blueprintSession(play, {
        taskId: NIGHT_SHELTER_TASK_ID,
        goal: pit
          ? 'Night is coming: dig a pit three blocks down under yourself and roof it (code does it), then stay inside until morning'
          : 'Night is coming: build a shelter around yourself (code does it), then stay inside until morning',
        subgoal: `${status.steps.length} step(s) before dark`,
        steps: describeShelter(status),
        known: status.steps,
        label: 'shelter for the night',
        text: pit
          ? `dig a pit (${status.steps.length} steps)`
          : `place ${status.steps.length} blocks`,
        missing: status.needs,
        maxCycles: status.steps.length * 2 + 2,
      });
      if (result.stopKind === 'stop-requested') return done(play, result.stopReason);
      if (result.stopKind === 'needs-attention') {
        // A shelter step that stopped for a person (a refusal, a pause) means no shelter
        // tonight: leave before the dark (cli play waits offline until sunrise). The night
        // task is made active again at the next dusk.
        return done(play, `${nightReason(clock)}; no shelter: ${result.stopReason}`, clock);
      }
      return 'next-round';
    }
  }
  if (play.shelterTries > 0) setKnownSteps(deps.repos, NIGHT_SHELTER_TASK_ID, null);
  play.shelterTries = 0;
  return null;
}

/**
 * Morning in last night's shelter (walls all around, roofed or not): dig out first, as a
 * person does. Code plans the way out (the pit: the roof, then a staircase; the box: one
 * wall, head level first) and runs it as known safe steps. Not walled in: null, and this
 * morning's tries are over.
 */
export async function morningRound(play: PlayState): Promise<RoundEnd> {
  const { deps, limits } = play;
  if (deps.shelter !== undefined) {
    const status = await deps.shelter('morning');
    if (status !== null && status.walled && status.exit.length === 0) {
      return done(
        play,
        `the player is walled in, and code found no way out: ${status.problem ?? 'unknown'}`,
      );
    }
    if (status !== null && status.walled && status.exit.length > 0) {
      if (play.exitTries >= limits.maxStuckSessions) {
        return done(
          play,
          `the player could not dig out of its shelter in ${play.exitTries} sessions`,
        );
      }
      play.exitTries += 1;
      const last = status.exit.at(-1)?.spec;
      const out = last?.type === 'MOVE_TO' ? last.args.target : undefined;
      const digs = status.exit.filter((s) => s.spec.type === 'DIG_BLOCK').length;
      const result = await blueprintSession(play, {
        taskId: LEAVE_SHELTER_TASK_ID,
        goal: 'Morning: dig your way out of the night shelter (code does it), then carry on',
        subgoal: `dig ${digs} block(s), then walk out`,
        steps: describeShelterExit(status),
        known: status.exit,
        label: 'leave the shelter',
        text: `dig ${digs} blocks`,
        missing: {},
        maxCycles: status.exit.length * 2 + 2,
      });
      if (result.stopKind === 'stop-requested' || result.stopKind === 'needs-attention') {
        return done(play, result.stopReason);
      }
      // The next goal's planner learns that the walls are open: walks and EXPLORE that
      // failed from inside them say nothing about now.
      play.wakeNote =
        `morning: the player dug out of its night shelter` +
        (out === undefined ? '' : ` to (${out.x}, ${out.y}, ${out.z})`) +
        ': walking and EXPLORE work again; failures from inside its walls no longer apply';
      return 'next-round';
    }
  }
  play.exitTries = 0;
  return null;
}
