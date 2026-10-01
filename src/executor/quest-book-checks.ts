import type { Postcondition } from '../domain/actions.ts';
import type { GameState } from '../domain/game-state.ts';
import { isKnownOreMember } from '../domain/ore-dictionary.ts';
import { QUEST_TASK, type QuestBookQuest } from '../domain/quest-book.ts';
import { baseItem, rewardSlotsNeeded } from '../domain/quest-items.ts';
import type { QuestBookAction } from '../safety/quest-book-rules.ts';
import type { VerificationCheck } from './action-verifier.ts';

/**
 * Feasibility and verification for the quest-book actions. Everything is read from the
 * observation's questBook: the SERVER's records (Better Questing), never the agent's own.
 */

function questIn(state: GameState, id: string): QuestBookQuest | null {
  return state.questBook.known
    ? (state.questBook.value.quests.find((q) => q.id === id) ?? null)
    : null;
}

/**
 * The items a claim gives: every item reward's items, and the selected item of the choice
 * reward. A string when the choice does not fit the rewards.
 */
export function claimedItems(
  quest: QuestBookQuest,
  choice: number | null,
): Array<{ item: string; count: number }> | string {
  const choices = quest.rewards.filter((r) => r.choice);
  if (choices.length > 1) return `"${quest.name}" has more than one choice reward`;
  const choiceReward = choices[0];
  if (choiceReward === undefined && choice !== null) {
    return `"${quest.name}" has no choice reward: choice must be null`;
  }
  if (choiceReward !== undefined && (choice === null || choice >= choiceReward.items.length)) {
    return `"${quest.name}" has a choice reward: choose one of its ${choiceReward.items.length} items (0-${choiceReward.items.length - 1})`;
  }
  return quest.rewards.flatMap((r) => {
    if (!r.choice) return r.items.map((i) => ({ item: i.item, count: i.count }));
    const picked = choice === null ? undefined : r.items[choice];
    return picked === undefined ? [] : [{ item: picked.item, count: picked.count }];
  });
}

/** Why the quest-book action cannot succeed from this state (empty: it can). */
export function questBookPreconditions(action: QuestBookAction, state: GameState): string[] {
  const id = action.args.questId;
  if (!state.questBook.known) return [`the quest book is not observed: ${state.questBook.reason}`];
  const quest = questIn(state, id);
  if (quest === null) return [`quest ${id} is not in the observed quest book`];
  switch (action.type) {
    case 'SUBMIT_QUEST':
      if (quest.completed) return [`"${quest.name}" is already completed`];
      if (quest.tasks.length > 0 && quest.tasks.every((t) => t.complete)) {
        return [`every task of "${quest.name}" is done: the server completes it by itself`];
      }
      return state.inventory.known ? [] : ['inventory is unknown'];
    case 'CHECK_QUEST_BOX': {
      if (quest.completed) return [`"${quest.name}" is already completed`];
      const task = quest.tasks.find((t) => t.index === action.args.taskIndex);
      if (task === undefined) return [`"${quest.name}" lists no task ${action.args.taskIndex}`];
      if (task.type !== QUEST_TASK.checkbox) {
        return [`task ${task.index} of "${quest.name}" is ${task.type}, not a checkbox`];
      }
      return task.complete ? [`the checkbox of "${quest.name}" is already ticked`] : [];
    }
    case 'CLAIM_QUEST_REWARD': {
      if (!quest.completed) return [`"${quest.name}" is not completed`];
      if (quest.claimed) return [`the rewards of "${quest.name}" are already claimed`];
      const items = claimedItems(quest, action.args.choice);
      if (typeof items === 'string') return [items];
      if (!state.inventory.known) return ['inventory is unknown'];
      const inv = state.inventory.value;
      const free = inv.capacitySlots - inv.usedSlots;
      const needed = rewardSlotsNeeded(items);
      return free >= needed
        ? []
        : [
            `the rewards of "${quest.name}" need ${needed} free inventory slots and ${free} are free ` +
              '(rewards that do not fit are dropped)',
          ];
    }
  }
}

type QuestPostcondition = Extract<
  Postcondition,
  { kind: 'QUEST_COMPLETED' | 'QUEST_TASK_CHECKED' | 'QUEST_REWARD_CLAIMED' }
>;

const describeChanges = (changes: Array<[string, number]>): string =>
  changes
    .slice(0, 5)
    .map(([item, d]) => `${item} ${d > 0 ? '+' : ''}${d}`)
    .join(', ');

/** Postcondition checks against the server's records in the new observation. */
export function verifyQuestBook(
  post: QuestPostcondition,
  before: GameState,
  after: GameState,
): VerificationCheck[] {
  if (!after.questBook.known) {
    return [{ name: 'quest-book-known', passed: false, detail: after.questBook.reason }];
  }
  const was = questIn(before, post.questId);
  const now = questIn(after, post.questId);
  if (now === null) {
    return [{ name: 'quest-listed', passed: false, detail: `${post.questId} is not listed` }];
  }
  const checks: VerificationCheck[] = [];
  const changes = (): Array<[string, number]> | null => {
    if (!before.inventory.known || !after.inventory.known) return null;
    const b = before.inventory.value.items;
    const a = after.inventory.value.items;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .map((name): [string, number] => [name, (a[name] ?? 0) - (b[name] ?? 0)])
      .filter(([, d]) => d !== 0);
  };
  switch (post.kind) {
    case 'QUEST_COMPLETED': {
      checks.push({
        name: 'quest-completed',
        passed: now.completed,
        detail: now.completed
          ? `the server records "${now.name}" as completed`
          : `the server does not record "${now.name}" as completed (tasks: ${now.tasks
              .map((t) => `${t.index} ${t.complete ? 'done' : `[${t.progress.join(',')}]`}`)
              .join('; ')})`,
      });
      // Only consume tasks may take items, and only what they still needed.
      const entries = (was?.tasks ?? [])
        .filter((t) => t.consume && !t.complete)
        .flatMap((t) =>
          t.items.map((item, i) => ({
            item,
            left: Math.max(0, item.count - (t.progress[i] ?? 0)),
          })),
        );
      const delta = changes();
      if (delta === null) {
        checks.push({ name: 'only-handed-in-items', passed: false, detail: 'inventory unknown' });
        break;
      }
      const taken = delta.filter(([, d]) => d < 0);
      const allowed = (name: string): boolean =>
        entries.some(
          (e) =>
            baseItem(name) === baseItem(e.item.item) ||
            (e.item.oreDict !== null && isKnownOreMember(e.item.oreDict, name)),
        );
      const unexpected = taken.filter(([name]) => !allowed(name));
      const total = taken.reduce((n, [, d]) => n - d, 0);
      const most = entries.reduce((n, e) => n + e.left, 0);
      checks.push({
        name: 'only-handed-in-items',
        passed: unexpected.length === 0 && total <= most,
        detail:
          taken.length === 0
            ? 'no item left the inventory'
            : unexpected.length > 0
              ? `items left that no consume task asks for: ${describeChanges(unexpected)}`
              : `${total} item(s) handed in (consume tasks needed at most ${most}): ${describeChanges(taken)}`,
      });
      break;
    }
    case 'QUEST_TASK_CHECKED': {
      const task = now.tasks.find((t) => t.index === post.taskIndex);
      checks.push({
        name: 'task-checked',
        passed: now.completed || task?.complete === true,
        detail: now.completed
          ? `"${now.name}" is completed`
          : `task ${post.taskIndex} of "${now.name}" is ${task?.complete === true ? 'done' : 'not done'}`,
      });
      break;
    }
    case 'QUEST_REWARD_CLAIMED': {
      checks.push({
        name: 'reward-claimed',
        passed: now.claimed,
        detail: now.claimed ? 'the server records the rewards as claimed' : 'not claimed',
      });
      const expected = was === null ? 'quest not listed before' : claimedItems(was, post.choice);
      const delta = changes();
      if (typeof expected === 'string' || delta === null) {
        checks.push({
          name: 'reward-items',
          passed: false,
          detail: typeof expected === 'string' ? expected : 'inventory unknown',
        });
        break;
      }
      const want = new Map<string, number>();
      for (const e of expected) want.set(e.item, (want.get(e.item) ?? 0) + e.count);
      const got = new Map(delta);
      const names = [...new Set([...want.keys(), ...got.keys()])];
      const wrong = names.filter((name) => (want.get(name) ?? 0) !== (got.get(name) ?? 0));
      checks.push({
        name: 'reward-items',
        passed: wrong.length === 0,
        detail:
          wrong.length === 0
            ? `gained exactly ${describeChanges([...want])}`
            : `expected ${describeChanges([...want])}; observed ${describeChanges(delta)}`,
      });
      break;
    }
  }
  return checks;
}
