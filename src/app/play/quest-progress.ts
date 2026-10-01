import { z } from 'zod';
import { AGE0_CHAPTER, AGE0_QUESTS } from '../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  completedIds,
  nextGoal,
  questBookSteps,
  questProgress,
  serverQuests,
  type Abilities,
  type Goal,
  type Quest,
  type QuestBookStep,
  type QuestProgress,
} from '../goals/quest-goals.ts';
import type { GameState } from '../domain/game-state.ts';
import type { QuestBook } from '../domain/quest-book.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
import type { Repositories } from '../persistence/repositories.ts';
import type { TaskStatus } from '../domain/tasks.ts';

/**
 * The Age 0 quest book as the SERVER records it (Better Questing, GameState.questBook), and
 * the quest goal the agent works on as its current task. Which quests are completed is never
 * the agent's own judgement: it is what the server's quest book says. The last observation of
 * it is kept in agent memory, so the CLI can show it without a connection.
 */
export const QUESTS_SERVER_KEY = 'quests.age0.server';

/** The task id of a quest goal. */
export const questTaskId = (questId: string): string => `quest-${questId}`;

const ServerRecordSchema = z.strictObject({
  /** When the server's quest book was observed (ISO 8601). */
  observedAt: z.string().min(1).max(64),
  /** Closure quests the server records as completed, in quest-book order. */
  completed: z.array(z.string().min(1).max(64)),
});
export type ServerRecord = z.infer<typeof ServerRecordSchema>;

/** The last observation of the server's quest book kept in memory, or null. */
export function serverRecord(repos: Repositories): ServerRecord | null {
  const raw = repos.memory.getValue(QUESTS_SERVER_KEY);
  return raw === null ? null : ServerRecordSchema.parse(JSON.parse(raw));
}

/** The quests the server recorded as completed at the last observation (empty if none). */
export function completedQuests(repos: Repositories): Set<string> {
  return new Set(serverRecord(repos)?.completed ?? []);
}

/** Closes a quest's task once the server records the quest as completed. */
function closeQuestTask(repos: Repositories, questId: string): void {
  const taskId = questTaskId(questId);
  const task = repos.tasks.get(taskId);
  if (task === null || task.status === 'completed') return;
  repos.tasks.setStatus(taskId, 'completed');
  const open = repos.plans.openForTask(taskId);
  if (open !== null) repos.plans.setStatus(open.id, 'completed', 'the quest is complete');
  if (repos.memory.getValue(CURRENT_TASK_KEY) === taskId) {
    repos.memory.setValue(CURRENT_TASK_KEY, null);
  }
}

export interface QuestUpdate {
  /** Quests the server records as completed since the last observation, in quest-book order. */
  added: Quest[];
  progress: QuestProgress;
  next: Goal | null;
  /** Quest-book clicks due now (claims, checkbox ticks, submits), in order. */
  clicks: QuestBookStep[];
  /** Due claims that wait (no room in the inventory, ...). */
  waiting: Array<{ quest: Quest; reason: string }>;
  /** Quests whose tasks are all done, waiting for the server's quest loop to complete them. */
  pending: Quest[];
}

/**
 * Records the server's quest book: quests it now records as completed (the first
 * observation is the baseline: nothing is "added"), closes their quest tasks, and works out
 * the next goal and the quest-book clicks due.
 */
export function updateQuests(
  repos: Repositories,
  book: QuestBook,
  inventory: { items: Readonly<Record<string, number>>; freeSlots: number | null },
  abilities: Abilities = BASE_ABILITIES,
  quests: readonly Quest[] = AGE0_QUESTS,
  now: Date = new Date(),
): QuestUpdate {
  const server = serverQuests(book);
  const done = completedIds(server);
  const completed = quests.filter((q) => done.has(q.id));
  const before = serverRecord(repos);
  const added = before === null ? [] : completed.filter((q) => !before.completed.includes(q.id));
  repos.transaction(() => {
    repos.memory.setValue(
      QUESTS_SERVER_KEY,
      JSON.stringify({ observedAt: now.toISOString(), completed: completed.map((q) => q.id) }),
    );
    for (const q of completed) closeQuestTask(repos, q.id);
  });
  const { steps, waiting, pending } = questBookSteps(
    quests,
    server,
    inventory.items,
    inventory.freeSlots,
  );
  return {
    added,
    progress: questProgress(quests, done, abilities),
    next: nextGoal(quests, server, inventory.items, abilities),
    clicks: steps,
    waiting,
    pending,
  };
}

/**
 * Makes the goal the current task: created active, or brought up to date with what is
 * still to do (the subgoal: the quest's remaining tasks by the server's count) and what to
 * have (the requirements: the planner's route). An existing task keeps its status: a quest
 * task that was paused, blocked or closed stays that way (only a human resumes it), and the
 * caller sees the status. The planner then plans for it; no plan is written here.
 */
export function adoptGoal(
  repos: Repositories,
  goal: Goal,
): { taskId: string; created: boolean; status: TaskStatus } {
  const taskId = questTaskId(goal.quest.id);
  const existing = repos.tasks.get(taskId);
  const task = repos.transaction(() => {
    const t = repos.tasks.ensure({
      id: taskId,
      goal: goal.text,
      subgoal: goal.subgoal,
      status: 'active',
    });
    repos.memory.setTaskRequirements(taskId, goal.requirements);
    if (t.status === 'active') repos.memory.setValue(CURRENT_TASK_KEY, taskId);
    return t;
  });
  return { taskId, created: existing === null, status: task.status };
}

/** Free inventory slots in an observation (null when the inventory is unknown). */
export function freeSlotsOf(state: Pick<GameState, 'inventory'>): number | null {
  return state.inventory.known
    ? state.inventory.value.capacitySlots - state.inventory.value.usedSlots
    : null;
}

/**
 * The quest book for the CLI: from `state` (a live observation, or the latest stored
 * snapshot) when its quest book is known, else the last observation kept in memory. Progress
 * counts the chapter's quests only, as the server records them.
 */
export function describeQuests(
  repos: Repositories,
  state: Pick<GameState, 'questBook' | 'inventory' | 'timestamp'> | null,
  quests: readonly Quest[] = AGE0_QUESTS,
): Record<string, unknown> {
  const names = (ids: ReadonlySet<string>, inChapter: boolean): string[] =>
    quests.filter((q) => ids.has(q.id) && q.inChapter === inChapter).map((q) => q.name);
  const currentTask = repos.memory.getValue(CURRENT_TASK_KEY);
  const why =
    state === null ? 'no observation' : state.questBook.known ? null : state.questBook.reason;
  if (state === null || !state.questBook.known) {
    const record = serverRecord(repos);
    const completed = new Set(record?.completed ?? []);
    return {
      chapter: AGE0_CHAPTER,
      source:
        record === null
          ? `none: the server's quest book has not been observed (${why ?? 'unknown'}); run with --live`
          : `the server's quest book as observed at ${record.observedAt}`,
      progress: questProgress(quests, completed),
      completed: names(completed, true),
      completedOutside: names(completed, false),
      next: 'unknown: run with --live to read the server quest book',
      currentTask,
    };
  }
  const book = state.questBook.value;
  const server = serverQuests(book);
  const completed = completedIds(server);
  const items = state.inventory.known ? state.inventory.value.items : {};
  const next = nextGoal(quests, server, items);
  const { steps, waiting, pending } = questBookSteps(quests, server, items, freeSlotsOf(state));
  const active = new Set(
    quests
      .filter((q) => server.get(q.id)?.active === true && !completed.has(q.id))
      .map((q) => q.id),
  );
  return {
    chapter: AGE0_CHAPTER,
    source: `the server's quest book (Better Questing), observed at ${state.timestamp}`,
    progress: questProgress(quests, completed),
    completed: names(completed, true),
    completedOutside: names(completed, false),
    active: quests.filter((q) => active.has(q.id)).map((q) => q.name),
    unclaimed: quests
      .filter((q) => server.get(q.id)?.completed === true && server.get(q.id)?.claimed === false)
      .map((q) => q.name),
    dueClicks: steps.map((s) => s.reason),
    ...(waiting.length > 0 ? { waiting: waiting.map((w) => w.reason) } : {}),
    ...(pending.length > 0 ? { completingOnServer: pending.map((q) => q.name) } : {}),
    next:
      next === null
        ? 'nothing the agent can do yet'
        : { quest: next.quest.name, goal: next.text, remaining: next.subgoal },
    currentTask,
  };
}
