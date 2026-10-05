import { TICKS_PER_DAY, TICKS_PER_SECOND, type WorldTime } from '../../domain/game-state.ts';
import { describeShelter, describeShelterExit } from '../../goals/shelter.ts';
import {
  LEAVE_SHELTER_TASK_ID,
  NIGHT_SHELTER_TASK_ID,
  type ShelterStep,
} from '../../domain/night-shelter.ts';
import { CURRENT_TASK_KEY, NIGHT_SHELTER_KEY } from '../../persistence/memory-repository.ts';
import { setKnownSteps } from '../loop/known-steps.ts';
import type { CycleResult } from '../loop/agent-loop.ts';
import type { SessionResult } from '../loop/live-session.ts';
import { planOf } from './narration.ts';
import {
  commandWaiting,
  done,
  mobPause,
  waitOutMob,
  type PlayState,
  type RoundEnd,
} from './play-state.ts';
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
 * (`between`: travel and goals wait for the morning) and looking at the shelter again
 * (`check`: why it no longer shelters the player, or null). Returns null at sunrise, why play
 * must stop, or why the shelter no longer shelters (an independent review, 2026-10-05: the
 * wait never looked again, so a roof an Enderman took, a wall a blast opened, or a mob that
 * broke a door went unseen until the morning).
 */
async function waitForMorning(
  deps: PlayDeps,
  hooks: { stopRequested: () => string | null },
  limits: PlayLimits,
  started: number,
  now: () => number,
  between: () => Promise<void>,
  check: () => Promise<string | null>,
): Promise<null | { stop: string } | { open: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const stop = hooks.stopRequested();
    if (stop !== null) return { stop };
    if (now() - started >= limits.maxMinutes * 60_000) {
      return { stop: `reached the limit of ${limits.maxMinutes} minutes` };
    }
    const t = (await deps.time?.()) ?? null;
    if (t === null) return { stop: 'the clock is unknown, so the morning cannot be awaited' };
    if (t.phase === 'day' && !nightSoon(t)) return null;
    await between();
    const open = await check();
    if (open !== null) return { open };
    await sleep(5000);
  }
}

/** Marks that the agent spends the night in a shelter: the morning digs it out (morningRound). */
function inShelter(play: PlayState): void {
  if (play.deps.repos.memory.getValue(NIGHT_SHELTER_KEY) === null) {
    play.deps.repos.memory.setValue(NIGHT_SHELTER_KEY, new Date(play.now()).toISOString());
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
  if (clock !== null && nightSoon(clock) && !play.inNight) {
    play.inNight = true;
    play.nights += 1;
    play.shelteredTonight = false;
  } else if (clock !== null && !nightSoon(clock)) {
    play.inNight = false;
  }
  if (clock !== null && nightSoon(clock)) {
    // A new night: the next morning's way out has all its tries again (an independent review,
    // 2026-10-05: three that failed one morning left none for any morning after).
    play.exitTries = 0;
    play.exitGaveUpAt = null;
    if (deps.shelter === undefined) {
      if (isDark(clock)) return done(play, nightReason(clock), clock);
    } else {
      const shelter = deps.shelter;
      const status = await shelter('night');
      if (status === null)
        return done(play, `${nightReason(clock)}: the shelter cannot be checked`, clock);
      if (status.sheltered) {
        inShelter(play);
        emit({
          kind: 'night',
          message: `sheltered: waiting for the morning (${untilSunrise(clock)} min)`,
        });
        play.sheltered = { until: now() + untilSunrise(clock) * 60_000 };
        play.shelteredTonight = true;
        const end = await waitForMorning(
          deps,
          hooks,
          limits,
          started,
          now,
          play.whileSheltered,
          async () => {
            const again = await shelter('night');
            if (again === null || again.sheltered) return null;
            return again.problem ?? 'its walls or roof are open';
          },
        ).finally(() => {
          play.sheltered = null;
        });
        if (end !== null && 'stop' in end) return done(play, end.stop);
        if (end !== null) {
          // Closed again (the rest of the pit) at the next round, or offline if it cannot be.
          emit({ kind: 'night', message: `the shelter no longer shelters: ${end.open}` });
          return 'next-round';
        }
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
      inShelter(play);
      const pit = status.kind === 'pit';
      let interrupted = false;
      // What the shelter needs and the inventory lacks (the goal line says "missing").
      const carried = (await deps.inventory()) ?? {};
      const missing = Object.fromEntries(
        Object.entries(status.needs).flatMap(([item, n]) =>
          n > (carried[item] ?? 0) ? [[item, n - (carried[item] ?? 0)]] : [],
        ),
      );
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
        missing,
        maxCycles: status.steps.length * 2 + 2,
        onCycle: (r) => {
          interrupted = interruptedCycle(r);
        },
      });
      // A step an owner's stop cut short spends no try, and the stop is answered now, not once
      // the shelter is done (an independent review, 2026-10-05).
      if (interrupted) play.shelterTries -= 1;
      await play.whileSheltered();
      if (result.stopKind === 'stop-requested') return done(play, result.stopReason);
      if (result.stopKind === 'needs-attention') {
        // A shelter step that stopped for a person (a refusal, a pause) means no shelter
        // tonight: leave before the dark (cli play waits offline until sunrise). The night
        // task is made active again at the next dusk. Unless the night is over meanwhile (a
        // time jump: someone slept, and the dig down is refused by day): the morning digs out
        // of what was dug (an independent review, 2026-10-05: offline 11 min by daylight).
        const after = (await deps.time?.()) ?? clock;
        if (!nightSoon(after)) return 'next-round';
        return done(play, `${nightReason(after)}; no shelter: ${result.stopReason}`, after);
      }
      return 'next-round';
    }
  }
  if (play.shelterTries > 0) setKnownSteps(deps.repos, NIGHT_SHELTER_TASK_ID, null);
  play.shelterTries = 0;
  // A night task left active by a night spent offline is over by day (an independent review,
  // 2026-10-05: it read "working on: Night is coming..." all the next day).
  if (deps.repos.tasks.get(NIGHT_SHELTER_TASK_ID)?.status === 'active') {
    setKnownSteps(deps.repos, NIGHT_SHELTER_TASK_ID, null);
    deps.repos.tasks.setStatus(NIGHT_SHELTER_TASK_ID, 'completed');
  }
  return null;
}

/** How long after the morning's way out gave up it is tried again (a mob may have gone). */
export const EXIT_RETRY_MS = 5 * 60_000;

/**
 * Morning in last night's shelter (walls all around, roofed or not): dig out first, as a
 * person does. Code plans the way out (the pit: the roof, then a staircase; the box: one
 * wall, head level first) and runs it as known safe steps. Only a shelter the night was spent
 * in (NIGHT_SHELTER_KEY, set at dusk): a shaft or hole a walk dug by day is no shelter to leave
 * (an independent review, 2026-10-05: at the bottom of a !goto's shaft, play ran "leave the
 * shelter" at noon, undoing the command). Not walled in (out of it): null, the shelter is
 * done with, and this morning's tries are over.
 */
export async function morningRound(play: PlayState): Promise<RoundEnd> {
  const { deps, limits } = play;
  if (deps.shelter !== undefined && deps.repos.memory.getValue(NIGHT_SHELTER_KEY) !== null) {
    // The clock not known yet (just after a login): it may be night still, and the way out
    // waits for it as for a look that cannot tell (an independent review, 2026-10-05: an
    // unknown clock read as day, and the morning round could dig out by night).
    const clockUnknown = deps.time !== undefined && (await deps.time()) === null;
    const status = clockUnknown ? null : await deps.shelter('morning');
    // Not known this time (the clock, the inventory, a chunk): nothing decided, and the tries and
    // their wait stand (an independent review, 2026-10-05: one such look gave three more at once).
    // It looks again a moment later, rather than run a command or the day's goal from inside
    // the pit (a later review, 2026-10-05), up to UNKNOWN_LOOKS times in a row.
    if (status === null) {
      if (play.morningUnknown >= UNKNOWN_LOOKS) return null;
      play.morningUnknown += 1;
      await play.sleep(MOB_SHELTER_POLL_MS);
      return 'next-round';
    }
    play.morningUnknown = 0;
    const mobs = status?.walled === true && status.sheltered ? (status.hostiles ?? null) : null;
    if (mobs !== null) return waitOutMobs(play, mobs);
    if (play.sheltered !== null && 'mobs' in play.sheltered) {
      play.sheltered = null;
      // Hurt (or starving) in there, the wait ends with the hostiles still near.
      play.emit({
        kind: 'night',
        message:
          status.hostiles == null
            ? 'morning: no hostile near any more: leaving the shelter'
            : `morning: the shelter shelters no more, hostiles near (${status.hostiles}): System 1 decides`,
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
        // Given up for now: tried again EXIT_RETRY_MS later (the mob or whatever stopped it may
        // be gone), and with all its tries every morning (nightRound).
        play.exitGaveUpAt ??= play.now();
        if (play.now() - play.exitGaveUpAt < EXIT_RETRY_MS) {
          if (commanded) return null;
          return done(
            play,
            `the player could not dig out of its shelter in ${play.exitTries} sessions`,
          );
        }
        play.exitTries = 0;
        play.exitGaveUpAt = null;
      }
      play.exitTries += 1;
      const lastStep = status.exit.at(-1)?.spec;
      const out = lastStep?.type === 'MOVE_TO' ? lastStep.args.target : undefined;
      let mobRefused = false;
      let interrupted = false;
      play.leavingShelter = true;
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
        onCycle: (r) => {
          mobRefused = refusedForMobs(r);
          interrupted = interruptedCycle(r);
        },
      }).finally(() => {
        play.leavingShelter = false;
      });
      // A step an owner's stop cut short spends no try, and the stop is answered now; commands
      // that move it wait until it is out (an independent review, 2026-10-05).
      if (interrupted) play.exitTries -= 1;
      play.leavingShelter = true;
      await play.whileSheltered().finally(() => {
        play.leavingShelter = false;
      });
      // A hostile came near while the player is still sealed in (System 1's SHELTERED pause), or
      // came back in range while System 1 decided and the safety rules refused the step (seen
      // live 2026-10-05: a Fire Creeper at the edge of the threat radius; the refused dig spent
      // a try, and play idled): the next round waits inside for it to go (waitOutMobs), as a
      // morning that began so. A moment first: the shelter's look at the mobs and System 1's
      // may disagree, and each round would run another session at once (an independent review,
      // 2026-10-05). Not after a meal in there that failed: that is waited out offline (mobPause,
      // below), never tried again and again while starving hurts (a later review, 2026-10-05).
      // At most MOB_SHELTER_MAX_MS of it, then offline, as waitOutMobs (a mob at the edge of the
      // threat radius would have it look again and again: a later review, 2026-10-05); meanwhile
      // commands are heard, as in the shelter at night.
      const last = play.lastDecision;
      const shelteredPause =
        last?.decision === 'PAUSE_AND_ASK_USER' && last.reasonCodes.includes('SHELTERED');
      if (shelteredPause || (status.sealed === true && mobRefused)) {
        play.exitTries -= 1;
        play.mobWaitSince ??= play.now();
        if (play.now() - play.mobWaitSince >= MOB_SHELTER_MAX_MS) {
          const minutes = Math.round(MOB_SHELTER_MAX_MS / 60_000);
          return {
            ...done(
              play,
              `hostiles stayed near the sealed shelter for ${minutes} min: waiting offline for them to leave`,
            ),
            mobNearby: 'HOSTILES_NEARBY, SHELTERED',
          };
        }
        await play.whileSheltered();
        await play.sleep(MOB_SHELTER_POLL_MS);
        return 'next-round';
      }
      // Hurt with a mob near, or a mob near with nowhere to retreat to, half dug out: offline,
      // as any session's mob pause is (the way out is planned again from where it stopped).
      const mob = mobPause(result.stopKind, play.lastDecision);
      if (mob !== null) return waitOutMob(play, LEAVE_SHELTER_TASK_ID, mob);
      if (result.stopKind === 'stop-requested' || result.stopKind === 'needs-attention') {
        return done(play, result.stopReason);
      }
      // Out: the next goal's planner learns that the walls are open, since walks and EXPLORE
      // that failed from inside them say nothing about now. A way out that stopped short says
      // nothing yet: the next round plans the rest of it.
      if (result.taskStatus === 'completed') {
        play.wakeNote =
          `morning: the player dug out of its night shelter` +
          (out === undefined ? '' : ` to (${out.x}, ${out.y}, ${out.z})`) +
          ': walking and EXPLORE work again; failures from inside its walls no longer apply';
      }
      return 'next-round';
    }
    // Out of it: tonight's shelter is done with, and so is a way out that stopped short (seen
    // live 2026-10-05: out, its task still read "working on: Morning: dig your way out" all day).
    if (status !== null && !status.walled) {
      deps.repos.memory.setValue(NIGHT_SHELTER_KEY, null);
      const exit = deps.repos.tasks.get(LEAVE_SHELTER_TASK_ID);
      if (exit != null && exit.status !== 'completed') {
        setKnownSteps(deps.repos, LEAVE_SHELTER_TASK_ID, null);
        deps.repos.tasks.setStatus(LEAVE_SHELTER_TASK_ID, 'completed');
      }
    }
  }
  play.exitTries = 0;
  play.exitGaveUpAt = null;
  play.mobWaitSince = null;
  return null;
}

/** The cycle's action was stopped by its owner or operator (gtnh-client.ts perform). */
function interruptedCycle(r: CycleResult): boolean {
  return r.outcome?.execution?.data?.['interrupted'] === true;
}

/** Dangers a wait in the sealed shelter outlasts: creatures go, and the vitals keep. */
const WAITABLE_DANGERS: ReadonlySet<string> = new Set([
  'HOSTILES_NEARBY',
  'UNCLASSIFIED_ENTITY_NEARBY',
  'LOW_HEALTH',
  'LOW_HUNGER',
]);

/**
 * The safety rules refused the cycle's action only because a creature is near (dangerGate),
 * with low vitals at most besides: not lava, the boundary or a repeated failure.
 */
function refusedForMobs(r: CycleResult): boolean {
  if (r.outcome?.status !== 'rejected') return false;
  const { violations, preconditionFailures } = r.outcome.validation;
  if (violations.length === 0 || preconditionFailures.length > 0) return false;
  return violations.every((v) => {
    if (v.code !== 'ACTION_NOT_ALLOWED_IN_DANGER') return false;
    const dangers = String(v.details?.['dangers'] ?? '').split(',');
    return (
      dangers.every((d) => WAITABLE_DANGERS.has(d)) &&
      dangers.some((d) => d === 'HOSTILES_NEARBY' || d === 'UNCLASSIFIED_ENTITY_NEARBY')
    );
  });
}

/** How often play looks again while it waits in its shelter for hostiles to go. */
export const MOB_SHELTER_POLL_MS = 5_000;
/**
 * Morning looks at last night's shelter in a row that could not tell (the clock, a chunk or
 * the inventory not known yet, just after a login) before play goes on to the other rounds:
 * 20 s, with no command heard and System 1 not asked meanwhile.
 */
export const UNKNOWN_LOOKS = 4;
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
  // From the first wait this morning, not this one: a mob at the edge of the threat radius
  // ends and starts it again and again.
  const since = (play.mobWaitSince ??= play.now());
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
