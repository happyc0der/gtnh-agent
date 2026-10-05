import { TICKS_PER_DAY, TICKS_PER_SECOND, type WorldTime } from '../../domain/game-state.ts';
import { describeShelter, describeShelterExit } from '../../goals/shelter.ts';
import {
  LEAVE_SHELTER_TASK_ID,
  NIGHT_SHELTER_TASK_ID,
  type ShelterStep,
} from '../../domain/night-shelter.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import type { SessionResult } from '../loop/live-session.ts';
import { planOf } from './narration.ts';
import { commandWaiting, done, type PlayState, type RoundEnd } from './play-state.ts';
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
  // By day (dusk is near), the minutes until sunrise read 0: say when the night comes.
  const when =
    t.phase === 'day'
      ? `night in ${t.minutesUntilNight} min`
      : `${t.minutesUntilDay} min until sunrise`;
  return (
    `it is ${t.phase} (${when}): without a shelter the agent ` +
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
    /** Why the session must stop now (default: the stop file, Ctrl+C: hooks.stopRequested). */
    stopRequested?: () => string | null;
    /** After each cycle, with its result (an owner's tunnel watches the dusk and the food). */
    onCycle?: (r: CycleResult) => void;
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
      stopRequested: b.stopRequested ?? hooks.stopRequested,
      onCycle: (r, index) => {
        play.lastDecision = r.decision ?? null;
        b.onCycle?.(r);
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
        play.sheltered = { until: now() + untilSunrise(clock) * 60_000 };
        const stop = await waitForMorning(
          deps,
          hooks,
          limits,
          started,
          now,
          play.whileSheltered,
        ).finally(() => {
          play.sheltered = null;
        });
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
      // Not sheltered, and code has no step that shelters it: a session would ask the planner,
      // which must never improvise a shelter (seen live 2026-10-04: asked so in a pit whose
      // roof was back but whose wall a way out had opened, it dug the pit's own walls).
      if (status.steps.length === 0) {
        return done(
          play,
          `${nightReason(clock)}; no shelter: it is open, and code has no step that closes it`,
          clock,
        );
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
    const mobs = status?.walled === true && status.sheltered ? (status.hostiles ?? null) : null;
    if (mobs !== null) return waitOutMobs(play, mobs);
    if (play.sheltered !== null && 'mobs' in play.sheltered) {
      play.sheltered = null;
      play.emit({
        kind: 'night',
        message: 'morning: no hostile near any more: leaving the shelter',
      });
    }
    // Walled in with no way out code can plan (a shaft deeper than a staircase out, seen live
    // 2026-10-04 after digging down to stone), or no way out that worked: an owner's command
    // goes first, since it may be the way out (!surface, !home pillar and dig). Before, play
    // ended here every round, and with a command waiting the idle wait returned at once: a busy
    // loop that never reached the command round.
    const commanded =
      deps.repos.commands.running() !== null ||
      deps.repos.commands.queued().length > 0 ||
      commandWaiting(play) !== null;
    if (status !== null && status.walled && status.exit.length === 0) {
      if (commanded) return null;
      return done(
        play,
        `the player is walled in, and code found no way out: ${status.problem ?? 'unknown'}`,
      );
    }
    if (status !== null && status.walled && status.exit.length > 0) {
      if (play.exitTries >= limits.maxStuckSessions) {
        if (commanded) return null;
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
        subgoal: digs === 0 ? 'climb out' : `dig ${digs} block(s), then walk out`,
        steps: describeShelterExit(status),
        known: status.exit,
        label: 'leave the shelter',
        text: digs === 0 ? 'climb out' : `dig ${digs} blocks`,
        missing: {},
        maxCycles: status.exit.length * 2 + 2,
      });
      // A hostile came near while the player is still sealed in (System 1's SHELTERED pause):
      // the next round waits inside for it to go (waitOutMobs), as a morning that began so.
      if (play.lastDecision?.reasonCodes.includes('SHELTERED') === true) {
        play.exitTries -= 1;
        return 'next-round';
      }
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

/** How often play looks again while it waits in its shelter for hostiles to go. */
export const MOB_SHELTER_POLL_MS = 5_000;
/**
 * How long play waits in its shelter for hostiles to go before it waits offline instead, as
 * for a mob near home (play.ts MOB_WAIT_MS): a mob that cannot reach the player and does not
 * burn (one in a cave, a creeper) may stay all day.
 */
export const MOB_SHELTER_MAX_MS = 5 * 60_000;

/**
 * Morning, sealed in its shelter with hostiles near (the safety rules' HOSTILES_NEARBY): no
 * mob can reach the player down there, and digging out would open the way to them. It waits
 * inside for them to go (the sun burns zombies and skeletons), hearing and answering owners'
 * commands as at night, and no exit try is spent (seen live 2026-10-04: zombies about the
 * night pit at sunrise; the exit gave up after three sessions, and the retreat home could
 * not leave the pit). A round of it: the next looks again. After MOB_SHELTER_MAX_MS of it,
 * play ends to wait offline (the caller waits a while and plays on), as for a mob near home.
 */
async function waitOutMobs(play: PlayState, mobs: string): Promise<RoundEnd> {
  const since =
    play.sheltered !== null && 'mobs' in play.sheltered ? play.sheltered.since : play.now();
  if (play.sheltered === null || !('mobs' in play.sheltered)) {
    play.emit({
      kind: 'night',
      message: `morning: hostiles near the shelter (${mobs}): waiting inside for them to go`,
    });
  }
  if (play.now() - since >= MOB_SHELTER_MAX_MS) {
    play.sheltered = null;
    const minutes = Math.round(MOB_SHELTER_MAX_MS / 60_000);
    return {
      ...done(
        play,
        `hostiles stayed near the sealed shelter for ${minutes} min (${mobs}): waiting offline for them to leave`,
      ),
      mobNearby: mobs,
    };
  }
  play.sheltered = { mobs, since };
  await play.whileSheltered();
  const sleep = play.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  await sleep(MOB_SHELTER_POLL_MS);
  return 'next-round';
}
