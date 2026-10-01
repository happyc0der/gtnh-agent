import { AGE0_QUESTS } from '../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  missingItems,
  missingText,
  type Abilities,
  type Quest,
  type QuestProgress,
} from '../goals/quest-goals.ts';
import { needsCraftingTable, RECIPE_IDS, RECIPES } from '../domain/recipes.ts';
import type { WorldTime } from '../domain/game-state.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
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
  /**
   * A goal of the player's own instead of the quest book: items to have (item -> count).
   * Play pursues it like a quest (the planner gets its route) and ends when it is reached.
   */
  goal?: FreeGoal;
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
    if (inventory === null) return done('the inventory is unknown, so progress is unknown');

    // What to work on this round: the player's own goal, or the next quest.
    let current: {
      id: string;
      name: string;
      text: string;
      missing: Record<string, number>;
      missingWith: (inv: Readonly<Record<string, number>>) => number;
      adopt: () => { taskId: string; created: boolean; status: string };
    };
    if (deps.goal !== undefined) {
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
        missingWith: (inv) => total(missingFor(free.requirements, inv)),
        adopt: () => adoptFreeGoal(deps.repos, free, missing),
      };
    } else {
      const update = updateQuests(deps.repos, inventory, abilities, quests);
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
      const goal = update.next;
      if (goal === null) return done('no quest the agent can do is left');
      current = {
        id: goal.quest.id,
        name: goal.quest.name,
        text: goal.text,
        missing: goal.missing,
        missingWith: (inv) => total(missingItems(goal.quest, inv)),
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
          met = current.missingWith(after.inventory.value.items) === 0;
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

    // Interruptions are checkpoints too: the planner reads them in the task's journal.
    if (dark !== null || !['limit', 'task-finished'].includes(result.stopKind)) {
      deps.repos.memory.appendJournal(
        adopted.taskId,
        `interrupted: ${dark !== null ? nightReason(dark) : result.stopReason}`,
      );
    }
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
