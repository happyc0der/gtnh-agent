import { z } from 'zod';
import { ItemNameSchema } from './common.ts';

/**
 * GTNH's quest book (Better Questing 3.7.15-GTNH) as the SERVER records it for this player.
 * The live client reads it from Better Questing's own sync messages (see
 * src/bot/gtnh1710/better-questing.ts and docs/gtnh-compatibility.md, "Quest book"); it is
 * the only source the "Finish Age 0" benchmark is scored from.
 */

/**
 * A quest id: Better Questing's quest UUID as `questIDHigh:questIDLow` (the two signed 64-bit
 * halves in decimal). Old quests have high 0 and a small low (`0:1852`).
 */
export const QuestIdSchema = z
  .string()
  .regex(/^-?\d{1,19}:-?\d{1,19}$/, 'expected questIDHigh:questIDLow')
  .refine((id) => {
    const halves = id.split(':').map((h) => BigInt(h));
    return halves.every((h) => BigInt.asIntN(64, h) === h);
  }, 'quest id halves must be signed 64-bit numbers');
export type QuestId = z.infer<typeof QuestIdSchema>;

/** Better Questing's EnumLogic, used for prerequisites (questLogic) and tasks (taskLogic). */
export const QUEST_LOGICS = ['AND', 'NAND', 'OR', 'NOR', 'XOR', 'XNOR'] as const;
export const QuestLogicSchema = z.enum(QUEST_LOGICS);
export type QuestLogic = z.infer<typeof QuestLogicSchema>;

/**
 * EnumLogic.getResult(inputs, total), exactly as Better Questing 3.7.15-GTNH computes it
 * (verified in the jar's bytecode): `n` of `total` inputs are true.
 *   AND n >= total; NAND n < total; OR n > 0; NOR n == 0; XOR n == 1; XNOR n == total - 1.
 */
export function logicResult(logic: QuestLogic, n: number, total: number): boolean {
  switch (logic) {
    case 'AND':
      return n >= total;
    case 'NAND':
      return n < total;
    case 'OR':
      return n > 0;
    case 'NOR':
      return n === 0;
    case 'XOR':
      return n === 1;
    case 'XNOR':
      return n === total - 1;
  }
}

/** Better Questing task types the agent knows by name (bq_standard). */
export const QUEST_TASK = {
  retrieval: 'bq_standard:retrieval',
  optionalRetrieval: 'bq_standard:optional_retrieval',
  crafting: 'bq_standard:crafting',
  checkbox: 'bq_standard:checkbox',
  hunt: 'bq_standard:hunt',
} as const;

/** Better Questing reward types the agent knows by name (bq_standard). */
export const QUEST_REWARD = {
  item: 'bq_standard:item',
  choice: 'bq_standard:choice',
} as const;

/** The quest-book actions: GUI clicks a player makes in the quest book. */
export const QUEST_BOOK_ACTION_TYPES = [
  'SUBMIT_QUEST',
  'CHECK_QUEST_BOX',
  'CLAIM_QUEST_REWARD',
] as const;

export function isQuestBookActionType(type: string): boolean {
  return (QUEST_BOOK_ACTION_TYPES as readonly string[]).includes(type);
}

/** An item a task asks for or a reward gives, in the agent's inventory naming. */
export const QuestBookItemSchema = z.strictObject({
  /** Registry name, with @damage when a specific non-zero damage is required. */
  item: ItemNameSchema,
  count: z.int().min(1).max(1_000_000),
  /** An ore dictionary name the server also accepts (the agent cannot resolve these). */
  oreDict: z.string().min(1).max(100).nullable(),
  /** Any damage value (damage 32767 in the quest). */
  anyDamage: z.boolean(),
});
export type QuestBookItem = z.infer<typeof QuestBookItemSchema>;

export const QuestBookTaskSchema = z.strictObject({
  /** Better Questing's task index: what task_checkbox names. */
  index: z.int().min(0).max(1023),
  type: z.string().min(1).max(64),
  /** The server records this task as complete for the player. */
  complete: z.boolean(),
  /** Retrieval tasks: a submit REMOVES the matching items from the inventory. */
  consume: z.boolean(),
  items: z.array(QuestBookItemSchema).max(32),
  /**
   * Per item, what the server has counted so far: retrieval tasks count items held (or handed
   * in, for consume tasks); crafting tasks count crafts made while the quest was active.
   */
  progress: z.array(z.int().min(0).max(1_000_000_000)).max(32),
});
export type QuestBookTask = z.infer<typeof QuestBookTaskSchema>;

export const QuestBookRewardSchema = z.strictObject({
  /** Better Questing's reward index: what choice_reward names. */
  index: z.int().min(0).max(1023),
  type: z.string().min(1).max(64),
  /** A choice reward gives exactly one of `items`: the one selected. */
  choice: z.boolean(),
  items: z.array(QuestBookItemSchema).max(32),
  /** The selection the server acknowledged (choice rewards), or null. */
  selected: z.int().min(0).max(1023).nullable(),
});
export type QuestBookReward = z.infer<typeof QuestBookRewardSchema>;

export const QuestBookQuestSchema = z.strictObject({
  id: QuestIdSchema,
  name: z.string().max(100),
  /**
   * In the server's active set (cache_sync activeQuests): only active quests make progress
   * from crafts and inventory changes, and only they complete in the server's quest loop.
   */
  active: z.boolean(),
  /** Its prerequisites are met (Better Questing's isUnlocked, from the server's records). */
  unlocked: z.boolean(),
  /** The server records the quest as completed by the player. */
  completed: z.boolean(),
  /** Completed and its rewards claimed, or completed with nothing to claim. */
  claimed: z.boolean(),
  taskLogic: QuestLogicSchema,
  /** The tasks with the server's progress; listed while the quest is active and not completed. */
  tasks: z.array(QuestBookTaskSchema).max(32),
  /** The rewards; listed while the quest is completed and not claimed. */
  rewards: z.array(QuestBookRewardSchema).max(16),
});
export type QuestBookQuest = z.infer<typeof QuestBookQuestSchema>;

export const QuestBookSchema = z.strictObject({
  /** Quests in the server's whole quest book. */
  totalQuests: z.int().min(0).max(100_000),
  /** The quests the agent tracks (the Age 0 closure) that the server knows, in scope order. */
  quests: z.array(QuestBookQuestSchema).max(512),
});
export type QuestBook = z.infer<typeof QuestBookSchema>;
