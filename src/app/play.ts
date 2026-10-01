import { AGE0_QUESTS } from '../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  missingText,
  questView,
  serverQuests,
  type Abilities,
  type Quest,
  type QuestBookStep,
  type QuestProgress,
} from '../goals/quest-goals.ts';
import { needsCraftingTable, RECIPE_IDS, RECIPES } from '../domain/recipes.ts';
import {
  TICKS_PER_DAY,
  TICKS_PER_SECOND,
  type GameState,
  type WorldTime,
} from '../domain/game-state.ts';
import { describeShelter, describeShelterExit, type ShelterStatus } from '../goals/shelter.ts';
import {
  LEAVE_SHELTER_TASK_ID,
  NIGHT_SHELTER_TASK_ID,
  type ShelterStep,
} from '../domain/night-shelter.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
import { setKnownSteps } from './known-steps.ts';
import type { Repositories } from '../persistence/repositories.ts';
import type { DecisionResult } from '../domain/decisions.ts';
import type { CycleResult } from './agent-loop.ts';
import {
  checkLimits,
  DEFAULT_SESSION_LIMITS,
  type SessionLimits,
  type SessionResult,
  type SessionStopKind,
} from './live-session.ts';
import { adoptGoal, freeSlotsOf, questTaskId, updateQuests } from './quest-commands.ts';
import {
  adoptScoutTask,
  finishScoutTask,
  runScoutSession,
  SCOUT_TASK_ID,
  scoutingDue,
  type Scouting,
} from './scouting.ts';

/**
 * Autonomous play: the agent works through the Age 0 quest book by itself. Each round it
 * reads the SERVER's quest book (Better Questing) and the inventory, records the quests the
 * server now lists as completed, makes the quest-book clicks that are due (claims, checkbox
 * ticks, submits: decided here in code, never by a model, each validated, executed and
 * verified like any action), then takes the next quest as its current task and runs one
 * bounded session on it. In the session the configured decision maker and planner choose
 * what to do; every action is still validated, executed and verified exactly like any
 * other. Between sessions it checks progress. Quests count only as the server records them.
 *
 * It stops, and says why, when:
 *  - no quest it can do is left, or its inventory or the server's quest book cannot be read;
 *  - a session asks for a human (an approval, a safety stop) or the quest's task was
 *    paused, blocked or closed by someone else (it never resumes those by itself), except
 *    a pause only for a mob near home: that it waits out (mobPause);
 *  - the same quest has made no progress for `maxStuckSessions` sessions in a row;
 *  - the time or session limit, the stop file or Ctrl+C.
 * A failed action or a safe detour (retreating, eating) does not stop it by itself: that
 * is part of playing, and the planner sees it in its recent history. A streak of sessions
 * without progress ends as "stuck".
 */
export interface PlayLimits {
  /** Hard cap on wall-clock time for the whole play (1-480 minutes). */
  maxMinutes: number;
  /** Hard cap on sessions (1-1000). */
  maxSessions: number;
  /** Sessions in a row without progress on the same quest before it gives up (1-20). */
  maxStuckSessions: number;
  /** Limits of each session (see live-session). */
  session: SessionLimits;
}

export const DEFAULT_PLAY_LIMITS: PlayLimits = {
  maxMinutes: 30,
  maxSessions: 100,
  maxStuckSessions: 3,
  session: DEFAULT_SESSION_LIMITS,
};

export function checkPlayLimits(limits: PlayLimits): string | null {
  if (!(limits.maxMinutes >= 1 && limits.maxMinutes <= 480)) return 'max minutes must be 1-480';
  if (
    !Number.isInteger(limits.maxSessions) ||
    limits.maxSessions < 1 ||
    limits.maxSessions > 1000
  ) {
    return 'max sessions must be 1-1000';
  }
  if (
    !Number.isInteger(limits.maxStuckSessions) ||
    limits.maxStuckSessions < 1 ||
    limits.maxStuckSessions > 20
  ) {
    return 'max stuck sessions must be 1-20';
  }
  return checkLimits(limits.session);
}

export interface PlayDeps {
  repos: Repositories;
  /** Reads the live inventory now, or null when it is unknown. */
  inventory: () => Promise<Readonly<Record<string, number>> | null>;
  /** Reads the world's clock now (null when unknown). Without it, play ignores the time. */
  time?: () => Promise<WorldTime | null>;
  /**
   * What a night shelter around the player still needs (null when unknown): at night
   * ('night') the shelter to make and its steps, in the morning ('morning') whether the
   * player is walled in and the way out. With it, play shelters at dusk and waits for the
   * morning inside; without it, play stops before dark.
   */
  shelter?: (purpose?: 'night' | 'morning') => Promise<ShelterStatus | null>;
  /** Waits (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A goal of the player's own instead of the quest book: items to have (item -> count).
   * Play pursues it like a quest (the planner gets its route) and ends when it is reached.
   */
  goal?: FreeGoal;
  /**
   * The server's quest book and the inventory, from one fresh observation. Quest goals need
   * it: a quest counts only once the server's quest book records it.
   */
  questBook?: () => Promise<Pick<GameState, 'questBook' | 'inventory'>>;
  /**
   * Makes one quest-book click the play loop chose (runQuestBookAction: validated, executed
   * and verified). Absent while quest-book clicks are off (MC_ENABLE_QUEST_BOOK).
   */
  questAction?: (
    spec: QuestBookStep['spec'],
    reason: string,
    taskId: string,
  ) => Promise<CycleResult>;
  /** Runs one bounded session on the current task (runSession on the live connection). */
  session: (
    limits: SessionLimits,
    hooks: {
      stopRequested: () => string | null;
      onCycle: (result: CycleResult, index: number) => void;
    },
  ) => Promise<SessionResult>;
  abilities?: Abilities;
  quests?: readonly Quest[];
  /** Milliseconds since the epoch (injectable for tests). */
  now?: () => number;
  /**
   * Given when the agent can explore: play then begins by scouting the area once, while world
   * memory has seen little (src/app/scouting.ts).
   */
  scouting?: Scouting;
}

export interface FreeGoal {
  /** The task id it is worked under (e.g. goal-minecraft:diamond-100). */
  taskId: string;
  /** Shown to the planner and in messages, e.g. "get 100 minecraft:diamond". */
  name: string;
  requirements: Readonly<Record<string, number>>;
}

export type PlayEvent =
  | { kind: 'quest-completed'; quest: string; completed: number; total: number }
  | { kind: 'scout'; taskId: string; chunksSeen: number; created: boolean }
  | {
      kind: 'goal';
      quest: string;
      goal: string;
      missing: Record<string, number>;
      taskId: string;
      created: boolean;
    }
  | {
      kind: 'cycle';
      session: number;
      index: number;
      summary: string;
      /** System 1's choice this cycle: which provider, the decision, and why. */
      decision: {
        provider: string;
        decision: string;
        reasons: string[];
        confidence: number;
      } | null;
      /** A plan the planner just made: its goal, explanation and steps (one line each). */
      newPlan: { goal: string; explanation: string; steps: string[] } | null;
      /** What the executor reported for the action, if one ran. */
      detail: string | null;
    }
  | { kind: 'night'; message: string }
  | {
      /** A quest-book click play made itself (claim, checkbox, submit), and its outcome. */
      kind: 'quest-book';
      quest: string;
      action: string;
      ok: boolean;
      detail: string;
    }
  | {
      kind: 'session-end';
      session: number;
      stopKind: SessionStopKind;
      stopReason: string;
      cycles: number;
    };

export interface PlayResult {
  stopReason: string;
  /**
   * Play stopped because it is getting dark and no shelter can be made (or play has none),
   * so the agent leaves (goes offline until sunrise) before the mobs come. The clock then.
   */
  night: WorldTime | null;
  /**
   * Play stopped because a mob is near the player while it is home (or has no home to go
   * to): the pause's reasons. The task is active again; the caller waits offline a little
   * (MOB_WAIT_MS) and plays on, as a person would wait it out.
   */
  mobNearby: string | null;
  sessions: number;
  /** Quests completed during this play, in order. */
  questsCompleted: string[];
  progress: QuestProgress | null;
  elapsedMs: number;
}

/** Session ends after which play goes on (anything else needs a human). */
const CONTINUE_AFTER: ReadonlySet<SessionStopKind> = new Set([
  'task-finished',
  'limit',
  'cycle-failed',
  'non-task-decision',
  'stop-requested', // only when the quest itself was met: see below
]);

/** How long the caller waits offline for a mob near home to leave, before playing on. */
export const MOB_WAIT_MS = 30_000;
/** Mob waits in a row after which play stops and says so. */
export const MAX_MOB_WAITS = 6;

/** Pause reasons that only say a mob is near, with the agent home or without a home. */
const MOB_PAUSE_REASONS: ReadonlySet<string> = new Set([
  'HOSTILES_NEARBY',
  'UNCLASSIFIED_ENTITY_NEARBY',
  'CREEPER_NEARBY',
  'TOO_MANY_HOSTILES',
  'ALREADY_AT_SAFE_LOCATION',
  'NO_SAFE_LOCATION',
]);

/**
 * The reasons of a session that ended on a pause only because a mob was near (System 1's
 * last decision: PAUSE_AND_ASK_USER with HOSTILES_NEARBY or UNCLASSIFIED_ENTITY_NEARBY, and
 * nothing but the home codes besides), else null. Mobs move on or burn in daylight, and an
 * offline player cannot be hurt: such a pause is waited out, not handed to a person.
 */
export function mobPause(stopKind: SessionStopKind, last: DecisionResult | null): string | null {
  if (stopKind !== 'needs-attention' || last === null) return null;
  if (last.decision !== 'PAUSE_AND_ASK_USER') return null;
  const codes = last.reasonCodes;
  const mob = codes.includes('HOSTILES_NEARBY') || codes.includes('UNCLASSIFIED_ENTITY_NEARBY');
  return mob && codes.every((c) => MOB_PAUSE_REASONS.has(c)) ? codes.join(', ') : null;
}

/** A cycle of a play session, for narration (the same event the quest sessions emit). */
function cycleEvent(
  repos: Repositories,
  session: number,
  r: CycleResult,
  index: number,
): PlayEvent {
  return {
    kind: 'cycle',
    session,
    index,
    summary: r.summary,
    decision:
      r.decision === null || r.decision === undefined
        ? null
        : {
            provider: r.decision.provider,
            decision: r.decision.decision,
            reasons: r.decision.reasonCodes,
            confidence: r.decision.confidence,
          },
    newPlan: r.planner?.kind === 'plan-accepted' ? planOf(repos, r.planner.planId) : null,
    detail: r.outcome?.execution?.message ?? null,
  };
}

/** A stored plan as one line per step, for narration. */
function planOf(
  repos: Repositories,
  planId: number,
): { goal: string; explanation: string; steps: string[] } | null {
  const p = repos.plans.get(planId);
  if (p === null) return null;
  return {
    goal: p.plan.goal,
    explanation: p.plan.explanation,
    steps: p.plan.steps.map(
      (s) => `${s.step}. ${s.action.type} ${JSON.stringify(s.action.args)}  -- ${s.rationale}`,
    ),
  };
}

/**
 * What the live agent can obtain: everything digging gathers, and the results of the
 * recipes it can craft (2x2 always; 3x3 only when a crafting table is configured). The
 * crafting table itself is never counted: the agent cannot place it, so making one (from
 * GTNH's flint recipe) would only spend flint.
 */
export function liveAbilities(hasCraftingTable: boolean): Abilities {
  const craft = RECIPE_IDS.map((id) => RECIPES[id])
    .filter((r) => hasCraftingTable || !needsCraftingTable(r))
    .map((r) => r.result.item.replace(/@\d+$/, ''));
  return { gather: BASE_ABILITIES.gather, craft: new Set(craft) };
}

/** What `requirements` still needs beyond `inventory` (item -> missing count). */
function missingFor(
  requirements: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [item, n] of Object.entries(requirements)) {
    const need = n - (inventory[item] ?? 0);
    if (need > 0) out[item] = need;
  }
  return out;
}

/** Makes a free goal the current task, with its requirements (the planner's route). */
function adoptFreeGoal(
  repos: Repositories,
  goal: FreeGoal,
  missing: Record<string, number>,
): { taskId: string; created: boolean; status: string } {
  const existing = repos.tasks.get(goal.taskId);
  const task = repos.transaction(() => {
    const t = repos.tasks.ensure({
      id: goal.taskId,
      goal: goal.name.slice(0, 300),
      subgoal: missingText(missing),
      status: 'active',
    });
    repos.memory.setTaskRequirements(goal.taskId, { ...goal.requirements });
    if (t.status === 'active') repos.memory.setValue(CURRENT_TASK_KEY, goal.taskId);
    return t;
  });
  return { taskId: goal.taskId, created: existing === null, status: task.status };
}

/** The goal is held: its task completes and stops being current. */
function reachGoal(repos: Repositories, goal: FreeGoal): void {
  repos.transaction(() => {
    if (repos.tasks.get(goal.taskId) !== null) repos.tasks.setStatus(goal.taskId, 'completed');
    if (repos.memory.getValue(CURRENT_TASK_KEY) === goal.taskId) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
    repos.memory.appendJournal(goal.taskId, `GOAL "${goal.name}" reached`);
  });
}

/** Real minutes until the next sunrise (tick 0 of the next day). */
const untilSunrise = (t: WorldTime): number =>
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
 * time limit every few seconds. Returns why play must stop, or null at sunrise.
 */
async function waitForMorning(
  deps: PlayDeps,
  hooks: { stopRequested: () => string | null },
  limits: PlayLimits,
  started: number,
  now: () => number,
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
    await sleep(5000);
  }
}

function nightReason(t: WorldTime): string {
  return (
    `it is ${t.phase} (${t.minutesUntilDay} min until sunrise): without a shelter the agent ` +
    'leaves (goes offline) before the mobs come'
  );
}

const total = (missing: Record<string, number>): number =>
  Object.values(missing).reduce((n, c) => n + c, 0);

/**
 * A quest-book click that failed (or was refused, e.g. in danger) this many times in a row is
 * not tried again until a session has run. The executor's repeated-failure rule still caps
 * clicks the server did not honour.
 */
const MAX_CLICK_FAILURES = 2;

/**
 * Better Questing completes a quest whose tasks are done in its quest loop, every 60 of the
 * player's ticks (3 s): with nothing else to do, play waits this long for it, this many times.
 */
const QUEST_LOOP_WAIT_MS = 3_000;
const MAX_QUEST_LOOP_WAITS = 5;

const clickKey = (s: QuestBookStep): string => `${s.spec.type} ${JSON.stringify(s.spec.args)}`;

/**
 * By an observation: the quest is completed, or quest-book clicks finish it now (null when
 * the observation does not show the quest book and the inventory).
 */
function questMet(quest: Quest, after: GameState, abilities: Abilities): boolean | null {
  if (!after.questBook.known || !after.inventory.known) return null;
  const view = questView(
    quest,
    serverQuests(after.questBook.value),
    after.inventory.value.items,
    abilities,
  );
  return view.completed || view.completableNow;
}

export async function runPlay(
  deps: PlayDeps,
  limits: PlayLimits,
  hooks: {
    /** A reason to stop (stop file, Ctrl+C), checked before every session and cycle. */
    stopRequested: () => string | null;
    onEvent?: (event: PlayEvent) => void;
  },
): Promise<PlayResult> {
  const problem = checkPlayLimits(limits);
  if (problem !== null) throw new Error(problem);
  const now = deps.now ?? Date.now;
  const quests = deps.quests ?? AGE0_QUESTS;
  const abilities = deps.abilities ?? BASE_ABILITIES;
  const started = now();
  const questsCompleted: string[] = [];
  let progress: QuestProgress | null = null;
  let sessions = 0;
  let lastStop = '';
  /** Shelter sessions tonight (reset in daylight). */
  let shelterTries = 0;
  /** Sessions this morning trying to dig out of last night's shelter. */
  let exitTries = 0;
  /** A note for the next goal's journal (e.g. how to leave the night shelter). */
  let wakeNote: string | null = null;
  /** Missing items of the quest worked on last, and sessions in a row without fewer. */
  let last: { questId: string; missing: number; stuck: number } | null = null;
  /** Quest-book clicks that failed, by click. */
  const failedClicks = new Map<string, number>();
  /** Waits in a row for the server's quest loop, with nothing else to do. */
  let loopWaits = 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const emit = (e: PlayEvent): void => hooks.onEvent?.(e);
  /**
   * One bounded session on a task whose route is a code-made blueprint (the night shelter,
   * the way out of it in the morning). Its steps run as known safe steps (known-steps.ts):
   * code proposes each, the executor validates, executes and verifies it, and the planner is
   * not asked. The last verified step completes the task, which ends the session.
   */
  const blueprintSession = async (b: {
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
  }): Promise<SessionResult> => {
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
    const session = sessions + 1;
    const result = await deps.session(
      { ...limits.session, maxCycles: Math.min(limits.session.maxCycles, b.maxCycles) },
      {
        stopRequested: hooks.stopRequested,
        onCycle: (r, index) => {
          lastDecision = r.decision ?? null;
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
    sessions = session;
    emit({
      kind: 'session-end',
      session,
      stopKind: result.stopKind,
      stopReason: result.stopReason,
      cycles: result.cycles.length,
    });
    return result;
  };
  /** Ends play for a mob near home: the paused task is active again (see mobPause). */
  const waitOutMob = (taskId: string, reasons: string): PlayResult => {
    deps.repos.tasks.setStatus(taskId, 'active');
    deps.repos.memory.appendJournal(
      taskId,
      `a mob came near (${reasons}): the agent waited offline for it to leave`,
    );
    return {
      ...done(`a mob is near the player (${reasons}): waiting offline for it to leave`),
      mobNearby: reasons,
    };
  };
  /** System 1's decision in the latest cycle (for mobPause). */
  let lastDecision: DecisionResult | null = null;
  const done = (stopReason: string, night: WorldTime | null = null): PlayResult => ({
    stopReason,
    night,
    mobNearby: null,
    sessions,
    questsCompleted,
    progress,
    elapsedMs: now() - started,
  });

  // GTNH start: look around once before settling (scouting.ts), when the agent can explore.
  if (deps.scouting !== undefined) {
    const due = scoutingDue(deps.repos, deps.scouting);
    if (due.kind === 'stop') return done(due.reason);
    if (due.kind === 'scout') {
      const stop = hooks.stopRequested();
      if (stop !== null) return done(stop);
      const clock = (await deps.time?.()) ?? null;
      if (clock !== null && isDark(clock)) return done(nightReason(clock), clock);
      const scout = adoptScoutTask(deps.repos);
      emit({ kind: 'scout', ...scout, chunksSeen: deps.scouting.chunksSeen() });
      const session = sessions + 1;
      const r = await runScoutSession({
        scouting: deps.scouting,
        limits: limits.session,
        session: deps.session,
        stopRequested: hooks.stopRequested,
        onCycle: (c, index) => {
          lastDecision = c.decision ?? null;
          emit(cycleEvent(deps.repos, session, c, index));
        },
      });
      sessions = session;
      lastStop = r.session.stopReason;
      emit({
        kind: 'session-end',
        session,
        stopKind: r.session.stopKind,
        stopReason: r.session.stopReason,
        cycles: r.session.cycles.length,
      });
      if (r.dark !== null) return done(nightReason(r.dark), r.dark);
      const mob = mobPause(r.session.stopKind, lastDecision);
      if (mob !== null) return waitOutMob(SCOUT_TASK_ID, mob);
      if (r.session.stopKind === 'stop-requested' && !r.scouted) return done(r.session.stopReason);
      if (!CONTINUE_AFTER.has(r.session.stopKind)) return done(r.session.stopReason);
      finishScoutTask(deps.repos);
    }
  }

  for (;;) {
    const stop = hooks.stopRequested();
    if (stop !== null) return done(stop);
    if (now() - started >= limits.maxMinutes * 60_000) {
      return done(`reached the limit of ${limits.maxMinutes} minutes`);
    }
    if (sessions >= limits.maxSessions) {
      return done(`reached the limit of ${limits.maxSessions} sessions`);
    }

    const clock = (await deps.time?.()) ?? null;
    if (clock !== null && nightSoon(clock)) {
      if (deps.shelter === undefined) {
        if (isDark(clock)) return done(nightReason(clock), clock);
      } else {
        const status = await deps.shelter('night');
        if (status === null)
          return done(`${nightReason(clock)}: the shelter cannot be checked`, clock);
        if (status.sheltered) {
          emit({
            kind: 'night',
            message: `sheltered: waiting for the morning (${untilSunrise(clock)} min)`,
          });
          const stop = await waitForMorning(deps, hooks, limits, started, now);
          if (stop !== null) return done(stop);
          emit({ kind: 'night', message: 'morning: leaving the shelter' });
          wakeNote =
            status.kind === 'pit'
              ? 'morning: the player is at the bottom of its night pit (natural walls, a roof ' +
                'above): code digs the roof and a staircase out before the day starts'
              : 'morning: the player is inside its night shelter (walls around it, a roof ' +
                'above): code digs one wall out before the day starts';
          continue;
        }
        if (status.problem !== null || shelterTries >= limits.maxStuckSessions) {
          const why = status.problem ?? `${shelterTries} sessions did not finish it`;
          return done(`${nightReason(clock)}; no shelter: ${why}`, clock);
        }
        shelterTries += 1;
        const pit = status.kind === 'pit';
        const result = await blueprintSession({
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
        if (result.stopKind === 'stop-requested' || result.stopKind === 'needs-attention') {
          return done(result.stopReason);
        }
        continue;
      }
    }
    if (shelterTries > 0) setKnownSteps(deps.repos, NIGHT_SHELTER_TASK_ID, null);
    shelterTries = 0;

    // Morning in last night's shelter (walls all around, roofed or not): dig out first, as a
    // person does. Code plans the way out (the pit: the roof, then a staircase; the box: one
    // wall, head level first) and runs it as known safe steps.
    if (deps.shelter !== undefined) {
      const status = await deps.shelter('morning');
      if (status !== null && status.walled && status.exit.length === 0) {
        return done(
          `the player is walled in, and code found no way out: ${status.problem ?? 'unknown'}`,
        );
      }
      if (status !== null && status.walled && status.exit.length > 0) {
        if (exitTries >= limits.maxStuckSessions) {
          return done(`the player could not dig out of its shelter in ${exitTries} sessions`);
        }
        exitTries += 1;
        const last = status.exit.at(-1)?.spec;
        const out = last?.type === 'MOVE_TO' ? last.args.target : undefined;
        const digs = status.exit.filter((s) => s.spec.type === 'DIG_BLOCK').length;
        const result = await blueprintSession({
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
          return done(result.stopReason);
        }
        // The next goal's planner learns that the walls are open: walks and EXPLORE that
        // failed from inside them say nothing about now.
        wakeNote =
          `morning: the player dug out of its night shelter` +
          (out === undefined ? '' : ` to (${out.x}, ${out.y}, ${out.z})`) +
          ': walking and EXPLORE work again; failures from inside its walls no longer apply';
        continue;
      }
    }
    exitTries = 0;

    // What to work on this round: the player's own goal, or the next quest.
    let current: {
      id: string;
      name: string;
      text: string;
      missing: Record<string, number>;
      /** Met by the observation after a cycle (null: it does not tell). */
      met: (after: GameState) => boolean | null;
      adopt: () => { taskId: string; created: boolean; status: string };
    };
    if (deps.goal !== undefined) {
      const inventory = await deps.inventory();
      if (inventory === null) return done('the inventory is unknown, so progress is unknown');
      const free = deps.goal;
      const missing = missingFor(free.requirements, inventory);
      if (total(missing) === 0) {
        reachGoal(deps.repos, free);
        return done(`the goal "${free.name}" is reached`);
      }
      current = {
        id: free.taskId,
        name: free.name,
        text: free.name,
        missing,
        met: (after) =>
          after.inventory.known
            ? total(missingFor(free.requirements, after.inventory.value.items)) === 0
            : null,
        adopt: () => adoptFreeGoal(deps.repos, free, missing),
      };
    } else {
      if (deps.questBook === undefined) {
        return done("quest goals need the server's quest book (Better Questing), and none is read");
      }
      const observed = await deps.questBook();
      if (!observed.questBook.known) {
        return done(
          `the server's quest book is unknown (${observed.questBook.reason}); quests count ` +
            'only as the server records them',
        );
      }
      if (!observed.inventory.known) {
        return done('the inventory is unknown, so progress is unknown');
      }
      const update = updateQuests(
        deps.repos,
        observed.questBook.value,
        { items: observed.inventory.value.items, freeSlots: freeSlotsOf(observed) },
        abilities,
        quests,
        new Date(now()),
      );
      progress = update.progress;
      for (const q of update.added) {
        questsCompleted.push(q.name);
        deps.repos.memory.appendJournal(`quest-${q.id}`, `QUEST "${q.name}" completed`);
        emit({
          kind: 'quest-completed',
          quest: q.name,
          completed: update.progress.completed,
          total: update.progress.total,
        });
      }

      // Quest-book clicks first, one per round: decided here from the server's records.
      const act = deps.questAction;
      const click = update.clicks.find(
        (c) => (failedClicks.get(clickKey(c)) ?? 0) < MAX_CLICK_FAILURES,
      );
      if (act !== undefined && click !== undefined) {
        const r = await act(click.spec, click.reason, questTaskId(click.quest.id));
        const ok = r.status === 'succeeded';
        if (!ok) failedClicks.set(clickKey(click), (failedClicks.get(clickKey(click)) ?? 0) + 1);
        emit({
          kind: 'quest-book',
          quest: click.quest.name,
          action: click.spec.type,
          ok,
          detail: r.outcome?.execution?.message ?? r.summary,
        });
        continue;
      }

      const goal = update.next;
      if (goal === null && update.pending.length > 0 && loopWaits < MAX_QUEST_LOOP_WAITS) {
        // Tasks all done: the server's quest loop completes the quest within a few seconds.
        loopWaits += 1;
        await sleep(QUEST_LOOP_WAIT_MS);
        continue;
      }
      loopWaits = 0;
      if (goal === null) {
        const due = update.clicks.map((c) => c.reason).slice(0, 3);
        const notes =
          due.length === 0
            ? []
            : act === undefined
              ? [
                  `${update.clicks.length} quest-book click(s) are due and quest-book clicks ` +
                    `are off (MC_ENABLE_QUEST_BOOK): ${due.join('; ')}`,
                ]
              : [`quest-book clicks failed ${MAX_CLICK_FAILURES} times: ${due.join('; ')}`];
        const waiting = update.waiting.map((w) => w.reason).slice(0, 3);
        const pending = update.pending.map(
          (q) => `the server has not completed "${q.name}" although its tasks are done`,
        );
        return done(
          ['no quest the agent can do is left', ...notes, ...waiting, ...pending.slice(0, 3)].join(
            '; ',
          ),
        );
      }
      current = {
        id: goal.quest.id,
        name: goal.quest.name,
        text: goal.text,
        missing: goal.missing,
        met: (after) => questMet(goal.quest, after, abilities),
        adopt: () => adoptGoal(deps.repos, goal),
      };
    }

    // Progress is fewer missing items for the same goal (read from the inventory, not
    // from what a session claims); moving to another goal resets the count.
    const missingNow = total(current.missing);
    if (last !== null && last.questId === current.id) {
      last.stuck = missingNow < last.missing ? 0 : last.stuck + 1;
      last.missing = missingNow;
      if (last.stuck >= limits.maxStuckSessions) {
        return done(
          `no progress on "${current.name}" in ${last.stuck} sessions in a row (last: ${lastStop})`,
        );
      }
    } else {
      last = { questId: current.id, missing: missingNow, stuck: 0 };
    }

    const adopted = current.adopt();
    if (adopted.status !== 'active') {
      return done(
        `the task ${adopted.taskId} for "${current.name}" is ${adopted.status}; ` +
          'it needs you (plan-approve, task-resume) before play goes on',
      );
    }
    emit({
      kind: 'goal',
      quest: current.name,
      goal: current.text,
      missing: current.missing,
      taskId: adopted.taskId,
      created: adopted.created,
    });
    if (wakeNote !== null) {
      deps.repos.memory.appendJournal(adopted.taskId, wakeNote);
      wakeNote = null;
    }

    // One session on this quest. It also ends as soon as an observation shows the quest's
    // items are all held, so the planner is never asked to do what is already done.
    let met = false;
    let dark: WorldTime | null = null;
    const session = sessions + 1;
    const result = await deps.session(limits.session, {
      stopRequested: () =>
        met
          ? `"${current.name}" is satisfied`
          : dark !== null
            ? nightReason(dark)
            : hooks.stopRequested(),
      onCycle: (r, index) => {
        lastDecision = r.decision ?? null;
        emit({
          kind: 'cycle',
          session,
          index,
          summary: r.summary,
          decision:
            r.decision === null || r.decision === undefined
              ? null
              : {
                  provider: r.decision.provider,
                  decision: r.decision.decision,
                  reasons: r.decision.reasonCodes,
                  confidence: r.decision.confidence,
                },
          newPlan:
            r.planner?.kind === 'plan-accepted' ? planOf(deps.repos, r.planner.planId) : null,
          detail: r.outcome?.execution?.message ?? null,
        });
        const after = r.outcome?.stateAfter;
        const metNow = after === undefined || after === null ? null : current.met(after);
        if (metNow !== null) met = metNow;
        // Shelter time (or dark, without shelters) ends the session in time to act on it.
        if (
          after?.time.known === true &&
          (deps.shelter === undefined ? isDark(after.time.value) : nightSoon(after.time.value))
        ) {
          dark = after.time.value;
        }
      },
    });
    sessions = session;
    lastStop = result.stopReason;
    // The world has moved on (a mob gone, items gathered): failed clicks may be tried again.
    failedClicks.clear();
    emit({
      kind: 'session-end',
      session,
      stopKind: result.stopKind,
      stopReason: result.stopReason,
      cycles: result.cycles.length,
    });

    // Interruptions are checkpoints too: the planner reads them in the task's journal.
    if (dark !== null || !['limit', 'task-finished'].includes(result.stopKind)) {
      deps.repos.memory.appendJournal(
        adopted.taskId,
        `interrupted: ${dark !== null ? nightReason(dark) : result.stopReason}`,
      );
    }
    if (dark !== null) {
      if (deps.shelter === undefined) return done(nightReason(dark), dark);
      continue; // the next round builds the shelter
    }
    if (result.stopKind === 'stop-requested' && !met) return done(result.stopReason);
    const mob = mobPause(result.stopKind, lastDecision);
    if (mob !== null) return waitOutMob(adopted.taskId, mob);
    if (!CONTINUE_AFTER.has(result.stopKind)) return done(result.stopReason);
  }
}

/** One human-readable line per play event, for the terminal. */
export function describePlayEvent(e: PlayEvent): string {
  switch (e.kind) {
    case 'quest-completed':
      return `QUEST DONE: "${e.quest}" (${e.completed}/${e.total})`;
    case 'scout':
      return `goal: scout the area before settling (${e.chunksSeen} chunk(s) seen so far)${e.created ? ' (new task)' : ''}`;
    case 'goal': {
      const missing = Object.entries(e.missing)
        .map(([item, n]) => `${n} ${item}`)
        .join(', ');
      return `goal: "${e.quest}"${missing === '' ? '' : ` - missing ${missing}`}${e.created ? ' (new task)' : ''}`;
    }
    case 'cycle': {
      const tag = `  [${e.session}.${e.index}]`;
      const lines: string[] = [];
      if (e.decision !== null) {
        lines.push(
          `${tag} SYSTEM 1 (${e.decision.provider}): ${e.decision.decision} ` +
            `[${e.decision.reasons.join(', ')}] confidence ${e.decision.confidence}`,
        );
      }
      if (e.newPlan !== null) {
        lines.push(`${tag} PLANNER new plan: ${e.newPlan.goal}`);
        lines.push(`        why: ${e.newPlan.explanation}`);
        for (const step of e.newPlan.steps) lines.push(`        ${step}`);
      }
      lines.push(
        `  [${e.session}.${e.index}] ${e.summary}${e.detail === null ? '' : ` (${e.detail})`}`,
      );
      return lines.join('\n');
    }
    case 'session-end':
      return `session ${e.session}: ${e.cycles} cycle(s); ${e.stopReason}`;
    case 'night':
      return `night: ${e.message}`;
    case 'quest-book':
      return `QUEST BOOK ${e.action} "${e.quest}": ${e.ok ? 'done' : 'FAILED'} (${e.detail})`;
  }
}
