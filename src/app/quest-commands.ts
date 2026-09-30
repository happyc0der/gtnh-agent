import { z } from 'zod';
import { AGE0_QUESTS } from '../goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  newlyCompleted,
  nextGoal,
  questProgress,
  type Abilities,
  type Goal,
  type Quest,
  type QuestProgress,
} from '../goals/quest-goals.ts';
import { CURRENT_TASK_KEY } from '../persistence/memory-repository.ts';
import type { Repositories } from '../persistence/repositories.ts';

/**
 * The agent's quest book: which Age 0 quests it has completed (kept in agent memory), and
 * the quest goal it works on as its current task. Completing a quest here is the agent's
 * own bookkeeping; it never touches the server's quest book.
 */
export const QUESTS_COMPLETED_KEY = 'quests.age0.completed';

/** The task id of a quest goal. */
export const questTaskId = (questId: string): string => `quest-${questId}`;

const CompletedSchema = z.array(z.string().min(1).max(64));

export function completedQuests(repos: Repositories): Set<string> {
  const raw = repos.memory.getValue(QUESTS_COMPLETED_KEY);
  return new Set(raw === null ? [] : CompletedSchema.parse(JSON.parse(raw)));
}

export interface QuestUpdate {
  /** Quests completed by this update, in completion order. */
  added: Quest[];
  progress: QuestProgress;
  next: Goal | null;
}

/**
 * Completes every quest whose prerequisites and tasks are now satisfied by `inventory`
 * (checkboxes at once), closes their quest tasks, and picks the next goal.
 */
export function updateQuests(
  repos: Repositories,
  inventory: Readonly<Record<string, number>>,
  abilities: Abilities = BASE_ABILITIES,
  quests: readonly Quest[] = AGE0_QUESTS,
): QuestUpdate {
  const completed = completedQuests(repos);
  const addedIds = newlyCompleted(quests, completed, inventory);
  if (addedIds.length > 0) {
    repos.transaction(() => {
      repos.memory.setValue(QUESTS_COMPLETED_KEY, JSON.stringify([...completed, ...addedIds]));
      for (const id of addedIds) {
        const taskId = questTaskId(id);
        const task = repos.tasks.get(taskId);
        if (task === null || task.status === 'completed') continue;
        repos.tasks.setStatus(taskId, 'completed');
        const open = repos.plans.openForTask(taskId);
        if (open !== null) repos.plans.setStatus(open.id, 'completed', 'the quest is complete');
        if (repos.memory.getValue(CURRENT_TASK_KEY) === taskId) {
          repos.memory.setValue(CURRENT_TASK_KEY, null);
        }
      }
    });
    for (const id of addedIds) completed.add(id);
  }
  const byId = new Map(quests.map((q) => [q.id, q]));
  return {
    added: addedIds.map((id) => byId.get(id) as Quest),
    progress: questProgress(quests, completed, abilities),
    next: nextGoal(quests, completed, inventory, abilities),
  };
}

/**
 * Makes the goal the current task (created active, or brought up to date with what is
 * still missing). The planner then plans for it; no plan is written here.
 */
export function adoptGoal(repos: Repositories, goal: Goal): { taskId: string; created: boolean } {
  const taskId = questTaskId(goal.quest.id);
  const existing = repos.tasks.get(taskId);
  repos.transaction(() => {
    repos.tasks.ensure({ id: taskId, goal: goal.text, subgoal: goal.subgoal, status: 'active' });
    if (existing !== null && existing.status !== 'active') repos.tasks.setStatus(taskId, 'active');
    repos.memory.setValue(CURRENT_TASK_KEY, taskId);
  });
  return { taskId, created: existing === null };
}

/** The quest book as the agent sees it, for the CLI. */
export function describeQuests(
  repos: Repositories,
  inventory: Readonly<Record<string, number>> | null,
  quests: readonly Quest[] = AGE0_QUESTS,
): Record<string, unknown> {
  const completed = completedQuests(repos);
  // Quests the next update would record (not recorded here: this only describes).
  const pending = inventory === null ? [] : newlyCompleted(quests, completed, inventory);
  const after = new Set([...completed, ...pending]);
  const next = inventory === null ? null : nextGoal(quests, after, inventory);
  return {
    chapter: 'Tier 0 Stone Age',
    progress: questProgress(quests, completed),
    completed: quests.filter((q) => completed.has(q.id)).map((q) => q.name),
    ...(pending.length > 0
      ? { satisfiedNotRecorded: quests.filter((q) => pending.includes(q.id)).map((q) => q.name) }
      : {}),
    next:
      next === null
        ? inventory === null
          ? 'unknown: no live inventory observed yet (run with --live)'
          : 'nothing the agent can do yet'
        : { quest: next.quest.name, goal: next.text, missing: next.missing },
    currentTask: repos.memory.getValue(CURRENT_TASK_KEY),
  };
}
