import type { Action } from '../domain/actions.ts';
import type { GameState } from '../domain/game-state.ts';
import { mayBeTakenFor } from '../domain/quest-items.ts';
import type { SafetyViolation } from '../domain/safety.ts';
import { isProtected } from './protected-items.ts';

export type QuestBookAction = Extract<
  Action,
  { type: 'SUBMIT_QUEST' | 'CHECK_QUEST_BOX' | 'CLAIM_QUEST_REWARD' }
>;

/**
 * Safety rules for the quest-book clicks (docs/action-contract.md):
 *  - only for quests the observation lists: the quests the agent tracks (the Age 0 closure)
 *    that the server's own quest book knows;
 *  - SUBMIT_QUEST and CHECK_QUEST_BOX only while the server lists the quest as ACTIVE and it
 *    is unlocked (Better Questing progresses nothing else; its checkbox handler would tick a
 *    locked quest's box anyway, which no player can do in the GUI);
 *  - SUBMIT_QUEST never while a protected item could be consumed. A consume task takes items
 *    of the same registry name (any damage, for damageable items), or anything its ore
 *    dictionary name covers, which the agent cannot list: then ANY protected item held
 *    refuses the submit.
 */
export function questBookViolations(
  action: QuestBookAction,
  state: GameState,
  protectedItems: ReadonlySet<string>,
): SafetyViolation[] {
  const id = action.args.questId;
  if (!state.questBook.known) {
    return [
      {
        code: 'UNKNOWN_TARGET',
        severity: 'pause',
        message:
          `The quest book is not observed (${state.questBook.reason}); no quest-book action is possible`.slice(
            0,
            500,
          ),
        details: { questId: id },
      },
    ];
  }
  const quest = state.questBook.value.quests.find((q) => q.id === id);
  if (quest === undefined) {
    return [
      {
        code: 'UNKNOWN_TARGET',
        severity: 'pause',
        message: `Quest ${id} is not one the agent tracks (the Age 0 closure), or the server's quest book does not have it`,
        details: { questId: id },
      },
    ];
  }
  const v: SafetyViolation[] = [];
  if (
    action.type !== 'CLAIM_QUEST_REWARD' &&
    !quest.completed &&
    (!quest.active || !quest.unlocked)
  ) {
    v.push({
      code: 'QUEST_NOT_ACTIVE',
      severity: 'block',
      message: `Quest "${quest.name}" is ${quest.active ? 'locked' : 'not active'} on the server: its tasks cannot progress now`,
      details: { questId: id, active: quest.active, unlocked: quest.unlocked },
    });
  }
  if (action.type === 'SUBMIT_QUEST' && state.inventory.known) {
    const held = Object.keys(state.inventory.value.items).filter((name) =>
      isProtected(name, protectedItems),
    );
    for (const task of quest.tasks) {
      if (!task.consume || task.complete) continue;
      for (const item of task.items) {
        const risky = held.find((name) => mayBeTakenFor(item, name));
        if (risky === undefined) continue;
        v.push({
          code: 'PROTECTED_ITEM',
          severity: 'pause',
          message:
            item.oreDict === null
              ? `Submitting "${quest.name}" could hand in protected item ${risky} (task ${task.index} consumes ${item.item})`
              : `Submitting "${quest.name}" could hand in protected item ${risky}: task ${task.index} consumes anything in ore dictionary "${item.oreDict}", which the agent cannot list`,
          details: { questId: id, item: risky, taskIndex: task.index, oreDict: item.oreDict },
        });
      }
    }
  }
  return v;
}
