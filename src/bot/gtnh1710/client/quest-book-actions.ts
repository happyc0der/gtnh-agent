import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { rewardSlotsNeeded } from '../../../domain/quest-items.ts';
import { failed, ok, type ClientActionResult } from '../../minecraft-client.ts';
import {
  choiceRewardOf,
  claimRewardItems,
  describeQuestTasks,
  plainText,
  questBookRequestProblem,
  type BqOutbound,
  type QuestBookRequest,
} from '../better-questing.ts';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import { outbound } from '../packets.ts';
import type { WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { describeGain } from './shared.ts';

/**
 * Better Questing completes quests in its quest loop, every 60 of the player's ticks (3 s at 20
 * per second), and syncs changed quests every 20 ticks: a submit is judged after 8 s.
 */
const QUEST_SUBMIT_TIMEOUT_MS = 8_000;
/** A ticked box or a claim is synced back within 20 player ticks (1 s); 5 s is generous. */
const QUEST_SYNC_TIMEOUT_MS = 5_000;
/** The server echoes a reward choice at once. */
const QUEST_CHOICE_TIMEOUT_MS = 3_000;
/** Reward items arrive as slot updates on the server's next tick. */
const QUEST_REWARD_ITEMS_TIMEOUT_MS = 2_000;

/**
 * The quest book (Better Questing; see better-questing.ts): SUBMIT_QUEST, CHECK_QUEST_BOX and
 * CLAIM_QUEST_REWARD. The server's quest book itself is read by the connection (connection.ts).
 */
export class QuestBookActions {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
  }

  /** Why a quest-book click cannot be made now, or null. */
  #questBookBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.questBook.enabled) {
      return {
        reason: 'quest-book actions are disabled (MC_ENABLE_QUEST_BOOK)',
        code: 'NOT_IMPLEMENTED',
      };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    // The server's quest loop runs on the player's own ticks: without them nothing completes.
    if (!cfg.presenceTicks) {
      return refused('quest-book actions need presence ticks (MC_PRESENCE_TICKS)');
    }
    if (this.#core.haltReason !== null) return refused(`halted: ${this.#core.haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#core.walking || this.#core.exploring) return refused('the player is walking');
    if (this.#core.digging) return refused('the player is digging');
    if (this.#core.placing) return refused('the player is placing a block');
    if (this.#core.usingContainer) return refused('a chest or crafting operation is running');
    if (this.#core.fighting) return refused('the player is fighting');
    if (this.#core.questBookBusy) return refused('a quest-book action is already running');
    return null;
  }

  #sendQuestBook(message: BqOutbound): void {
    for (const p of outbound.questBook(message)) this.#core.send(p);
  }

  /**
   * SUBMIT_QUEST, CHECK_QUEST_BOX and CLAIM_QUEST_REWARD: the quest book's own clicks, sent
   * only after re-checking the server's quest book as it is now, and judged by the server's
   * next sync (the quest completed, the box ticked, the rewards claimed and in the inventory).
   */
  async questBookAction(req: QuestBookRequest): Promise<ClientActionResult> {
    const blocker = this.#questBookBlocker();
    if (blocker !== null)
      return failed(`not using the quest book: ${blocker.reason}`, blocker.code);
    const book = this.#world.questBook;
    const problem = questBookRequestProblem(book, this.#opts.questScope ?? [], req);
    if (problem !== null) return failed(`not using the quest book: ${problem}`, 'REFUSED');
    this.#core.questBookBusy = true;
    try {
      switch (req.kind) {
        case 'submit':
          return await this.#submitQuest(req.questId);
        case 'check':
          return await this.#checkQuestBox(req.questId, req.taskIndex);
        case 'claim':
          return await this.#claimQuest(req.questId, req.choice);
      }
    } finally {
      this.#core.questBookBusy = false;
    }
  }

  #questTimeout(ms: number): number {
    return this.#opts.questBookTimeoutMs ?? ms;
  }

  #questName(id: string): string {
    return `"${plainText(this.#world.questBook.config(id)?.name ?? id)}"`;
  }

  /** Inventory decreases since `before`, as "2 x minecraft:log". */
  #handedIn(before: Readonly<Record<string, number>> | null): string {
    const now = this.#world.inventoryItems();
    if (before === null || now === null) return '';
    return describeGain(
      Object.entries(before)
        .map(([item, n]): [string, number] => [item, n - (now[item] ?? 0)])
        .filter(([, d]) => d > 0),
    );
  }

  async #submitQuest(id: string): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    const before = this.#world.inventoryItems();
    this.#sendQuestBook({ kind: 'quest-action', action: 'detect', questIds: [id] });
    await this.#core.waitFor(() => book.completed(id), this.#questTimeout(QUEST_SUBMIT_TIMEOUT_MS));
    const handedIn = this.#handedIn(before);
    if (!book.completed(id)) {
      return failed(
        `the server did not record ${this.#questName(id)} as completed within ` +
          `${this.#questTimeout(QUEST_SUBMIT_TIMEOUT_MS) / 1000} s of the submit (tasks: ${describeQuestTasks(book, id)})` +
          (handedIn === '' ? '' : `; handed in: ${handedIn}`),
        'FAILED',
        { questId: id, handedIn },
      );
    }
    this.#core.log(`quest book: ${this.#questName(id)} completed after a submit`);
    return ok(
      `submitted ${this.#questName(id)}: the server records it as completed` +
        (handedIn === '' ? '' : ` (handed in ${handedIn})`),
      { questId: id, handedIn },
    );
  }

  async #checkQuestBox(id: string, taskIndex: number): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    this.#sendQuestBook({ kind: 'task-checkbox', questId: id, taskIndex });
    const done = (): boolean => book.taskComplete(id, taskIndex) || book.completed(id);
    await this.#core.waitFor(done, this.#questTimeout(QUEST_SYNC_TIMEOUT_MS));
    if (!done()) {
      return failed(
        `the server did not record checkbox ${taskIndex} of ${this.#questName(id)} as ticked`,
        'FAILED',
        { questId: id, taskIndex },
      );
    }
    return ok(`ticked checkbox ${taskIndex} of ${this.#questName(id)}`, { questId: id, taskIndex });
  }

  async #claimQuest(id: string, choice: number | null): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    const config = book.config(id);
    const expected = config === null ? 'unknown quest' : claimRewardItems(config, choice);
    if (typeof expected === 'string') {
      return failed(`not claiming ${this.#questName(id)}: ${expected}`, 'REFUSED');
    }
    if (config === null) return failed(`not claiming: unknown quest ${id}`, 'REFUSED');
    // Rewards that do not fit are dropped into the world: refuse without room for them.
    const storage = this.#world.playerStorage();
    if (storage === null) return failed('not claiming: the inventory is not known', 'REFUSED');
    const free = storage.filter((s) => s === null).length;
    const needed = rewardSlotsNeeded([...expected.values()].map((count) => ({ count })));
    if (free < needed) {
      return failed(
        `not claiming ${this.#questName(id)}: its rewards need ${needed} free slots, ${free} are free`,
        'REFUSED',
      );
    }
    const choiceReward = choiceRewardOf(config);
    if (choice !== null && choiceReward !== null && typeof choiceReward !== 'string') {
      const r = choiceReward.index;
      if (book.selection(id, r) !== choice) {
        this.#sendQuestBook({
          kind: 'choice-reward',
          questId: id,
          rewardIndex: r,
          selection: choice,
        });
        await this.#core.waitFor(
          () => book.selection(id, r) === choice,
          this.#questTimeout(QUEST_CHOICE_TIMEOUT_MS),
        );
        if (book.selection(id, r) !== choice) {
          return failed(
            `the server did not acknowledge choice ${choice} for ${this.#questName(id)}`,
            'FAILED',
            { questId: id },
          );
        }
      }
    }
    const before = this.#world.inventoryItems() ?? {};
    this.#sendQuestBook({ kind: 'quest-action', action: 'claim', questIds: [id] });
    await this.#core.waitFor(() => book.claimed(id), this.#questTimeout(QUEST_SYNC_TIMEOUT_MS));
    if (!book.claimed(id)) {
      return failed(
        `the server did not record the rewards of ${this.#questName(id)} as claimed`,
        'FAILED',
        { questId: id },
      );
    }
    // The items arrive as slot updates (usually before the sync): wait for all of them.
    const gains = (): Array<[string, number]> => {
      const now = this.#world.inventoryItems() ?? {};
      return [...new Set([...Object.keys(now), ...expected.keys()])]
        .map((item): [string, number] => [item, (now[item] ?? 0) - (before[item] ?? 0)])
        .filter(([, d]) => d !== 0);
    };
    const complete = (): boolean =>
      [...expected].every(([item, n]) => gains().some(([g, d]) => g === item && d >= n));
    await this.#core.waitFor(complete, this.#questTimeout(QUEST_REWARD_ITEMS_TIMEOUT_MS));
    const gained = describeGain(gains());
    this.#core.log(`quest book: claimed ${this.#questName(id)}: ${gained || 'no items'}`);
    return ok(`claimed the rewards of ${this.#questName(id)}: ${gained || 'no items'}`, {
      questId: id,
      gained,
    });
  }
}
