import { AGE0_QUESTS } from '../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  missingItems,
  type Abilities,
  type Quest,
  type QuestProgress,
} from '../goals/quest-goals.ts';
import { needsCraftingTable, RECIPE_IDS, RECIPES } from '../domain/recipes.ts';
import type { WorldTime } from '../domain/game-state.ts';
import type { Repositories } from '../persistence/repositories.ts';
import type { CycleResult } from './agent-loop.ts';
import {
  checkLimits,
  DEFAULT_SESSION_LIMITS,
  type SessionLimits,
  type SessionResult,
  type SessionStopKind,
} from './live-session.ts';
import { adoptGoal, updateQuests } from './quest-commands.ts';
import {
  adoptScoutTask,
  finishScoutTask,
  runScoutSession,
  scoutingDue,
  type Scouting,
} from './scouting.ts';

/**
 * Autonomous play: the agent works through the Age 0 quest book by itself. Each round it
 * reads its inventory, records the quests that are now satisfied, takes the next quest as
 * its current task, and runs one bounded session on it. In the session the configured
 * decision maker and planner choose what to do; every action is still validated, executed
 * and verified exactly like any other. Between sessions it checks progress.
 *
 * It stops, and says why, when:
 *  - no quest it can do is left, or its inventory cannot be read;
 *  - a session asks for a human (an approval, a safety stop) or the quest's task was
 *    paused, blocked or closed by someone else (it never resumes those by itself);
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
   * Play stopped because it is getting dark: the agent cannot shelter yet (no block
   * placing), so it leaves the surface before the mobs come. The clock at that moment.
   */
  night: WorldTime | null;
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
 * recipes it can craft (2x2 always; 3x3 only when a crafting table is configured). GTNH
 * removes the vanilla crafting-table recipe, so the table itself is never counted.
 */
export function liveAbilities(hasCraftingTable: boolean): Abilities {
  const craft = RECIPE_IDS.filter((id) => id !== 'crafting_table')
    .map((id) => RECIPES[id])
    .filter((r) => hasCraftingTable || !needsCraftingTable(r))
    .map((r) => r.result.item.replace(/@\d+$/, ''));
  return { gather: BASE_ABILITIES.gather, craft: new Set(craft) };
}

/** Evening or night: hostile mobs come out, and the agent has no shelter yet. */
export const isDark = (t: WorldTime): boolean => t.phase === 'evening' || t.phase === 'night';

function nightReason(t: WorldTime): string {
  return (
    `it is ${t.phase} (${t.minutesUntilDay} min until sunrise): the agent cannot shelter yet ` +
    '(no block placing), so it leaves before the mobs come'
  );
}

const total = (missing: Record<string, number>): number =>
  Object.values(missing).reduce((n, c) => n + c, 0);

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
  /** Missing items of the quest worked on last, and sessions in a row without fewer. */
  let last: { questId: string; missing: number; stuck: number } | null = null;
  const emit = (e: PlayEvent): void => hooks.onEvent?.(e);
  const done = (stopReason: string, night: WorldTime | null = null): PlayResult => ({
    stopReason,
    night,
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
        onCycle: (c, index) => emit(cycleEvent(deps.repos, session, c, index)),
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
    if (clock !== null && isDark(clock)) return done(nightReason(clock), clock);

    const inventory = await deps.inventory();
    if (inventory === null) return done('the inventory is unknown, so quest progress is unknown');
    const update = updateQuests(deps.repos, inventory, abilities, quests);
    progress = update.progress;
    for (const q of update.added) {
      questsCompleted.push(q.name);
      emit({
        kind: 'quest-completed',
        quest: q.name,
        completed: update.progress.completed,
        total: update.progress.total,
      });
    }
    const goal = update.next;
    if (goal === null) return done('no quest the agent can do is left');

    // Progress is fewer missing items for the same quest (read from the inventory, not
    // from what a session claims); moving to another quest resets the count.
    const missingNow = total(goal.missing);
    if (last !== null && last.questId === goal.quest.id) {
      last.stuck = missingNow < last.missing ? 0 : last.stuck + 1;
      last.missing = missingNow;
      if (last.stuck >= limits.maxStuckSessions) {
        return done(
          `no progress on "${goal.quest.name}" in ${last.stuck} sessions in a row (last: ${lastStop})`,
        );
      }
    } else {
      last = { questId: goal.quest.id, missing: missingNow, stuck: 0 };
    }

    const adopted = adoptGoal(deps.repos, goal);
    if (adopted.status !== 'active') {
      return done(
        `the task ${adopted.taskId} for "${goal.quest.name}" is ${adopted.status}; ` +
          'it needs you (plan-approve, task-resume) before play goes on',
      );
    }
    emit({
      kind: 'goal',
      quest: goal.quest.name,
      goal: goal.text,
      missing: goal.missing,
      taskId: adopted.taskId,
      created: adopted.created,
    });

    // One session on this quest. It also ends as soon as an observation shows the quest's
    // items are all held, so the planner is never asked to do what is already done.
    let met = false;
    let dark: WorldTime | null = null;
    const session = sessions + 1;
    const result = await deps.session(limits.session, {
      stopRequested: () =>
        met
          ? `the quest "${goal.quest.name}" is satisfied`
          : dark !== null
            ? nightReason(dark)
            : hooks.stopRequested(),
      onCycle: (r, index) => {
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
        if (after?.inventory.known === true) {
          met = total(missingItems(goal.quest, after.inventory.value.items)) === 0;
        }
        if (after?.time.known === true && isDark(after.time.value)) dark = after.time.value;
      },
    });
    sessions = session;
    lastStop = result.stopReason;
    emit({
      kind: 'session-end',
      session,
      stopKind: result.stopKind,
      stopReason: result.stopReason,
      cycles: result.cycles.length,
    });

    if (dark !== null) return done(nightReason(dark), dark);
    if (result.stopKind === 'stop-requested' && !met) return done(result.stopReason);
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
  }
}
