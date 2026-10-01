import type { ActionSpecOf } from '../domain/actions.ts';
import { FORGE_ORE_DICTIONARY } from '../domain/ore-dictionary.ts';
import {
  logicResult,
  QUEST_TASK,
  type QuestBook,
  type QuestBookItem,
  type QuestBookQuest,
  type QuestLogic,
} from '../domain/quest-book.ts';
import { baseItem, certainlyCounts, heldFor, rewardSlotsNeeded } from '../domain/quest-items.ts';

/**
 * Goals for autonomous play, from GTNH's quest book. The SERVER's records (Better Questing,
 * read into GameState.questBook) say which quests are completed, active and claimed and how
 * far each task is; this module adds what the server does not: which quest to work on next,
 * what is still to get, and which quest-book clicks (claim, checkbox, submit) are due. It
 * follows Better Questing 3.7.15-GTNH (docs/gtnh-compatibility.md, "Quest book"):
 *
 *  - a quest unlocks by its prerequisite logic (AND, OR, XOR, ...) over COMPLETED
 *    prerequisites. Prerequisites in other chapters are quests of the data too (the closure),
 *    never assumed met;
 *  - it completes, in the server's quest loop, while active and unlocked, once its tasks
 *    satisfy its task logic (AND or OR over tasks that are complete or ignored: optional
 *    retrieval never blocks, and counts as done);
 *  - retrieval tasks count the items held, re-counted on an inventory change or a submit, and
 *    only while the quest is active; an item's count stays once it is met. Consume tasks count
 *    only what a submit hands in;
 *  - crafting tasks count crafts made WHILE the quest is active; holding the item never counts;
 *  - checkboxes are ticked, and rewards claimed, in the quest book.
 */

export interface QuestItem {
  /** Registry name, with @damage when the quest needs a specific non-zero damage. */
  item: string;
  count: number;
  /** An ore dictionary name the quest also accepts (the agent knows only Forge's own members). */
  oreDict: string | null;
  /** Any damage value accepted (quest damage 32767). */
  anyDamage: boolean;
}

export interface QuestTask {
  /** Better Questing's task index (what a checkbox click names). */
  index: number;
  type: string;
  /** Retrieval: a submit hands the items in (they leave the inventory). */
  consume: boolean;
  items: QuestItem[];
  /**
   * Crafting: crafts made before the quest became active count too, once a submit reads the
   * player's crafting statistics (allowCraftedFromStatistics). Otherwise only crafts made while
   * the quest is active count.
   */
  craftedBeforeCount: boolean;
}

export interface QuestReward {
  /** Better Questing's reward index. */
  index: number;
  type: string;
  /** A choice reward: the player picks exactly one of `items`. */
  choice: boolean;
  items: QuestItem[];
}

export interface Quest {
  /** questIDHigh:questIDLow, exact. */
  id: string;
  name: string;
  description: string;
  prerequisites: string[];
  /** How the prerequisites combine (Better Questing's questLogic). */
  prerequisiteLogic: QuestLogic;
  /** How the tasks combine (Better Questing's taskLogic). */
  taskLogic: QuestLogic;
  /** A main quest (the quest book draws it larger). */
  main: boolean;
  /** In the benchmark chapter; false for a prerequisite from another chapter. */
  inChapter: boolean;
  /** The chapter that lists the quest, or null (a hidden trigger quest). */
  chapter: string | null;
  /** Its tasks make progress even while it is locked (Better Questing's lockedProgress). */
  lockedProgress: boolean;
  tasks: QuestTask[];
  rewards: QuestReward[];
  layout: { x: number; y: number };
}

export const TASK = QUEST_TASK;

/** What the agent can obtain today, by registry name (damage ignored). */
export interface Abilities {
  /** Items it can gather (dig, pick up). */
  gather: ReadonlySet<string>;
  /** Items it can craft (inputs permitting). */
  craft: ReadonlySet<string>;
}

/**
 * Items the digging ability yields from its allowlisted blocks (src/domain/blocks.ts), bare
 * handed: sand, gravel, clay (4 clay balls), dirt and grass (dirt), logs, leaves (saplings,
 * apples). Stone needs a pickaxe, so cobblestone is not here; nor is flint, which GTNH's gravel
 * never drops (IguanaTweaks removeFlintDrop, see docs/gtnh-compatibility.md): the quest
 * "Where's the Flint?" asks for flint CRAFTED from gravel.
 */
export const BASE_ABILITIES: Abilities = {
  gather: new Set([
    'minecraft:sand',
    'minecraft:gravel',
    'minecraft:clay_ball',
    'minecraft:dirt',
    'minecraft:log',
    'minecraft:log2',
    'minecraft:sapling',
    'minecraft:apple',
  ]),
  craft: new Set(),
};

// ---------------------------------------------------------------------------
// The server's records
// ---------------------------------------------------------------------------

/** The server's records of the quests the agent tracks, by id (from GameState.questBook). */
export type ServerQuests = ReadonlyMap<string, QuestBookQuest>;

export function serverQuests(book: QuestBook): ServerQuests {
  return new Map(book.quests.map((q) => [q.id, q]));
}

/** Quests the server records as completed by the player. */
export function completedIds(server: ServerQuests): Set<string> {
  return new Set([...server.values()].filter((q) => q.completed).map((q) => q.id));
}

/** Better Questing's isUnlocked: the prerequisite logic over completed prerequisites. */
export function isUnlocked(quest: Quest, completed: ReadonlySet<string>): boolean {
  const pre = quest.prerequisites;
  if (pre.length === 0) return true;
  return logicResult(
    quest.prerequisiteLogic,
    pre.filter((p) => completed.has(p)).length,
    pre.length,
  );
}

// ---------------------------------------------------------------------------
// Tasks and quests, as the server and the inventory show them
// ---------------------------------------------------------------------------

/** Items that would satisfy a quest item: the item itself, or a known ore dictionary member. */
function candidates(i: QuestItem): string[] {
  const members =
    i.oreDict === null ? [] : (FORGE_ORE_DICTIONARY[i.oreDict] ?? []).map((m) => m.item);
  return [baseItem(i.item), ...members];
}

function obtainable(i: QuestItem, sets: ReadonlyArray<ReadonlySet<string>>): boolean {
  return candidates(i).some((name) => sets.some((s) => s.has(name)));
}

const add = (into: Record<string, number>, item: string, n: number): void => {
  into[item] = (into[item] ?? 0) + n;
};

export interface TaskView {
  task: QuestTask;
  /** Better Questing counts it as done without doing it (optional retrieval). */
  ignored: boolean;
  /** The server records it as complete (or it is ignored). */
  done: boolean;
  /** Still to get: retrieval items not held, crafting items not yet crafted while active. */
  missing: Record<string, number>;
  /** Not done, but a submit completes it now: every item it still needs is held. */
  submittable: boolean;
  /** An unticked checkbox: a click in the quest book. */
  checkbox: boolean;
  /** The agent's abilities can finish it (a checkbox they can; hunting they cannot). */
  doable: boolean;
}

/** The server's count for each item of a task (0 for items it has not counted). */
function progressOf(server: QuestBookQuest | undefined, index: number): readonly number[] {
  return server?.tasks.find((t) => t.index === index)?.progress ?? [];
}

/**
 * Each task of a quest: done (by the server's record), what is missing (the server's count,
 * then the inventory), whether a submit would complete it, and whether the agent can do it.
 */
export function taskViews(
  quest: Quest,
  server: QuestBookQuest | undefined,
  inventory: Readonly<Record<string, number>>,
  abilities: Abilities = BASE_ABILITIES,
): TaskView[] {
  return quest.tasks.map((task) => {
    const done = server?.tasks.find((t) => t.index === task.index)?.complete ?? false;
    const progress = progressOf(server, task.index);
    const base = { task, ignored: false, done, missing: {}, submittable: false, checkbox: false };
    switch (task.type) {
      case TASK.optionalRetrieval:
        return { ...base, ignored: true, done: true, doable: true };
      case TASK.checkbox:
        return { ...base, checkbox: !done, doable: true };
      case TASK.retrieval: {
        if (done) return { ...base, doable: true };
        const missing: Record<string, number> = {};
        task.items.forEach((item, i) => {
          const counted = progress[i] ?? 0;
          if (counted >= item.count) return; // Better Questing keeps a count once it is met
          // A submit re-counts what is held; a consume task keeps what was handed in before.
          const need = task.consume ? item.count - counted : item.count;
          const held = heldFor(inventory, item);
          if (held < need) add(missing, item.item, need - held);
        });
        const doable = task.items.every(
          (item) =>
            missing[item.item] === undefined ||
            obtainable(item, [abilities.gather, abilities.craft]),
        );
        return { ...base, missing, submittable: Object.keys(missing).length === 0, doable };
      }
      case TASK.crafting: {
        if (done) return { ...base, doable: true };
        const missing: Record<string, number> = {};
        task.items.forEach((item, i) => {
          const counted = progress[i] ?? 0;
          if (counted < item.count) add(missing, item.item, item.count - counted);
        });
        const doable = task.items.every(
          (item, i) => (progress[i] ?? 0) >= item.count || obtainable(item, [abilities.craft]),
        );
        return { ...base, missing, doable };
      }
      default:
        // Hunting, locations, fluids...: beyond the agent's abilities until the server says done.
        return { ...base, doable: done };
    }
  });
}

export interface QuestView {
  quest: Quest;
  server: QuestBookQuest | undefined;
  completed: boolean;
  claimed: boolean;
  /** In the server's active set: its tasks make progress. */
  active: boolean;
  /** Its prerequisites are met (the server's view, else the data's over its completions). */
  unlocked: boolean;
  tasks: TaskView[];
  /** The open tasks the agent works on: all of them (AND), or the cheapest doable one (OR). */
  focus: TaskView[];
  /** Ticking its checkboxes and a submit would satisfy its task logic now. */
  completableNow: boolean;
  /** Its task logic is satisfied without a submit (only checkbox ticks, or nothing, left). */
  completableWithoutSubmit: boolean;
  /** What is still to get for the focus tasks. */
  missing: Record<string, number>;
  /** The agent can finish it: every remaining task (AND), or one (OR). */
  doable: boolean;
}

const total = (missing: Record<string, number>): number =>
  Object.values(missing).reduce((n, c) => n + c, 0);

export function questView(
  quest: Quest,
  server: ServerQuests,
  inventory: Readonly<Record<string, number>>,
  abilities: Abilities = BASE_ABILITIES,
  completed: ReadonlySet<string> = completedIds(server),
): QuestView {
  const record = server.get(quest.id);
  const tasks = taskViews(quest, record, inventory, abilities);
  const n = tasks.length;
  const count = (ok: (t: TaskView) => boolean): number => tasks.filter(ok).length;
  const logic = quest.taskLogic;
  const open = tasks.filter((t) => !t.done);
  let focus: TaskView[];
  let doable: boolean;
  if (logic === 'OR') {
    const anyDone = tasks.some((t) => t.done);
    const best = open
      .filter((t) => t.doable)
      .sort((a, b) => total(a.missing) - total(b.missing))[0];
    focus = anyDone || best === undefined ? [] : [best];
    doable = anyDone || best !== undefined;
  } else {
    // AND (all of the data but seven OR quests); other logics are never chosen as goals.
    focus = open;
    doable = logic === 'AND' && open.every((t) => t.doable);
  }
  const missing: Record<string, number> = {};
  for (const t of focus) for (const [item, k] of Object.entries(t.missing)) add(missing, item, k);
  return {
    quest,
    server: record,
    completed: record?.completed ?? false,
    claimed: record?.claimed ?? false,
    active: record?.active ?? false,
    unlocked: record?.unlocked ?? isUnlocked(quest, completed),
    tasks,
    focus,
    completableNow: logicResult(
      logic,
      count((t) => t.done || t.checkbox || t.submittable),
      n,
    ),
    completableWithoutSubmit: logicResult(
      logic,
      count((t) => t.done || t.checkbox),
      n,
    ),
    missing,
    doable,
  };
}

/** Longest chain of prerequisites below each quest (0 for a root). */
export function questDepths(quests: readonly Quest[]): Map<string, number> {
  const byId = new Map(quests.map((q) => [q.id, q]));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const d = depth.get(id);
    if (d !== undefined) return d;
    if (stack.has(id)) return 0; // a cycle in the data: cut it
    stack.add(id);
    const pre = (byId.get(id)?.prerequisites ?? []).filter((p) => byId.has(p));
    const value = pre.length === 0 ? 0 : 1 + Math.max(...pre.map((p) => visit(p, stack)));
    stack.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const q of quests) visit(q.id, new Set());
  return depth;
}

// ---------------------------------------------------------------------------
// The next goal
// ---------------------------------------------------------------------------

export interface Goal {
  quest: Quest;
  view: QuestView;
  /** Still to get for the quest (item -> count). */
  missing: Record<string, number>;
  /**
   * What to HAVE, for the planner's route (src/goals/route.ts): for retrieval, the held items
   * that count (exact names) plus the rest under the quest's own item names; for crafting, what
   * is held plus what is still to craft, so the route asks for exactly the crafts left.
   */
  requirements: Record<string, number>;
  /** The quest as a task goal (stable; at most 300 characters, the task goal limit). */
  text: string;
  /** The quest's remaining tasks by the server's count, or null when nothing is left. */
  subgoal: string | null;
}

/** The quest's requirement in one line: 'Age 0 quest "X": have 8 minecraft:dirt; ...'. */
export function goalText(quest: Quest): string {
  const parts = quest.tasks.flatMap((t) => {
    const list = t.items.map((i) => `${i.count} ${i.item}`).join(', ');
    switch (t.type) {
      case TASK.retrieval:
        return [t.consume ? `hand in ${list}` : `have ${list}`];
      case TASK.crafting:
        return [`craft ${list}`];
      case TASK.checkbox:
        return ['tick its checkbox'];
      case TASK.optionalRetrieval:
        return [];
      default:
        return [t.type.replace(/^bq_standard:/, '')];
    }
  });
  const want =
    parts.length === 0 ? 'claim it' : parts.join(quest.taskLogic === 'OR' ? ' OR ' : '; ');
  return `Age 0 quest "${quest.name}": ${want}`.slice(0, 300);
}

/** "still missing: 3 minecraft:dirt, ...", or null when nothing is. */
export function missingText(missing: Record<string, number>): string | null {
  const list = Object.entries(missing).map(([item, n]) => `${n} ${item}`);
  return list.length === 0 ? null : `still missing: ${list.join(', ')}`.slice(0, 300);
}

/** The quest's open tasks as the server counts them, for the planner (the task's subgoal). */
export function remainingText(view: QuestView): string | null {
  const parts = view.tasks.flatMap((t) => {
    if (t.done) return [];
    const list = Object.entries(t.missing)
      .map(([item, n]) => `${n} more ${item}`)
      .join(', ');
    switch (t.task.type) {
      case TASK.retrieval:
        return [
          list === ''
            ? 'all held: a submit completes it'
            : t.task.consume
              ? `get ${list} (handed in at the quest book)`
              : `get ${list}`,
        ];
      case TASK.crafting:
        return [`craft ${list} (only crafts made now count, not items held)`];
      case TASK.checkbox:
        return ['tick its checkbox'];
      default:
        return [t.task.type.replace(/^bq_standard:/, '')];
    }
  });
  if (parts.length === 0) return null;
  const joiner = view.quest.taskLogic === 'OR' ? ' OR ' : '; ';
  return `remaining by the server's count: ${parts.join(joiner)}`.slice(0, 300);
}

/** What the focus tasks ask the inventory to HAVE (see Goal.requirements). */
export function questRequirements(
  view: QuestView,
  inventory: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of view.focus) {
    const progress = progressOf(view.server, t.task.index);
    t.task.items.forEach((item, i) => {
      const counted = progress[i] ?? 0;
      if (counted >= item.count) return;
      if (t.task.type === TASK.crafting) {
        add(out, item.item, (inventory[item.item] ?? 0) + item.count - counted);
        return;
      }
      if (t.task.type !== TASK.retrieval) return;
      let left = t.task.consume ? item.count - counted : item.count;
      for (const [name, held] of Object.entries(inventory)) {
        if (left <= 0) break;
        if (held <= 0 || !certainlyCounts(item, name)) continue;
        const use = Math.min(held, left);
        add(out, name, use);
        left -= use;
      }
      if (left > 0) add(out, item.item, left);
    });
  }
  return out;
}

/**
 * The next quest to work on: active and unlocked on the server, not completed, within the
 * agent's abilities, and not one that quest-book clicks alone finish (questBookSteps makes
 * those). Shallowest first (closest to the start of the book), main quests before side
 * quests, then quest-book layout. Null when nothing doable is left.
 */
export function nextGoal(
  quests: readonly Quest[],
  server: ServerQuests,
  inventory: Readonly<Record<string, number>>,
  abilities: Abilities = BASE_ABILITIES,
): Goal | null {
  const completed = completedIds(server);
  const depth = questDepths(quests);
  const view = quests
    .map((q) => questView(q, server, inventory, abilities, completed))
    .filter((v) => !v.completed && v.active && v.unlocked && v.doable && !v.completableNow)
    .sort(
      (a, b) =>
        (depth.get(a.quest.id) ?? 0) - (depth.get(b.quest.id) ?? 0) ||
        Number(b.quest.main) - Number(a.quest.main) ||
        a.quest.layout.y - b.quest.layout.y ||
        a.quest.layout.x - b.quest.layout.x,
    )[0];
  if (view === undefined) return null;
  return {
    quest: view.quest,
    view,
    missing: view.missing,
    requirements: questRequirements(view, inventory),
    text: goalText(view.quest),
    subgoal: remainingText(view),
  };
}

// ---------------------------------------------------------------------------
// Quest-book clicks, decided in code
// ---------------------------------------------------------------------------

export interface QuestBookStep {
  quest: Quest;
  spec: ActionSpecOf<'SUBMIT_QUEST' | 'CHECK_QUEST_BOX' | 'CLAIM_QUEST_REWARD'>;
  reason: string;
}

/**
 * The choice reward's item to pick: the first one an unfinished quest of the closure asks for
 * (by registry name), else the first. Deterministic, never left to a model.
 */
export function chooseReward(
  items: readonly QuestBookItem[],
  quests: readonly Quest[],
  completed: ReadonlySet<string>,
): number {
  const wanted = new Set(
    quests
      .filter((q) => !completed.has(q.id))
      .flatMap((q) => q.tasks.flatMap((t) => t.items.map((i) => baseItem(i.item)))),
  );
  const index = items.findIndex((i) => wanted.has(baseItem(i.item)));
  return index === -1 ? 0 : index;
}

export interface QuestBookSteps {
  steps: QuestBookStep[];
  /** Due claims that cannot be made now, and why. */
  waiting: Array<{ quest: Quest; reason: string }>;
  /**
   * Quests whose tasks are all done by the server's records, waiting for its quest loop to
   * complete them (every 60 of the player's ticks): nothing to click.
   */
  pending: Quest[];
}

/**
 * The quest-book clicks due now, in order: claims (completed quests with unclaimed rewards,
 * when the inventory has room for them), checkbox ticks (when the ticks, plus a submit, would
 * complete the quest), then submits (a submit completes the quest now: items to hand in, or
 * items held from before the quest was active, which the server has not counted). Only closure
 * quests, and for ticks and submits only quests the server lists as active and unlocked. A
 * quest whose tasks are all done is left to the server's quest loop (`pending`). The play loop
 * makes the first click, observes again, and asks again.
 */
export function questBookSteps(
  quests: readonly Quest[],
  server: ServerQuests,
  inventory: Readonly<Record<string, number>>,
  freeSlots: number | null,
): QuestBookSteps {
  const completed = completedIds(server);
  const claims: QuestBookStep[] = [];
  const ticks: QuestBookStep[] = [];
  const submits: QuestBookStep[] = [];
  const waiting: Array<{ quest: Quest; reason: string }> = [];
  const pending: Quest[] = [];
  for (const quest of quests) {
    const record = server.get(quest.id);
    if (record === undefined) continue;
    if (record.completed) {
      if (record.claimed) continue;
      const choices = record.rewards.filter((r) => r.choice);
      const choiceReward = choices[0];
      if (choices.length > 1) {
        waiting.push({ quest, reason: `"${quest.name}" has more than one choice reward` });
        continue;
      }
      const choice =
        choiceReward === undefined ? null : chooseReward(choiceReward.items, quests, completed);
      const items = record.rewards.flatMap((r) => {
        const picked = r.items[choice ?? 0];
        return r.choice ? (picked === undefined ? [] : [picked]) : r.items;
      });
      const needed = rewardSlotsNeeded(items);
      if (freeSlots === null || freeSlots < needed) {
        waiting.push({
          quest,
          reason: `claiming "${quest.name}" needs ${needed} free inventory slots (${freeSlots ?? 'unknown'} free)`,
        });
        continue;
      }
      claims.push({
        quest,
        spec: { type: 'CLAIM_QUEST_REWARD', args: { questId: quest.id, choice } },
        reason: `claim the rewards of "${quest.name}"${choice === null ? '' : ` (choice ${choice})`}`,
      });
      continue;
    }
    if (!record.active) continue;
    const view = questView(quest, server, inventory, BASE_ABILITIES, completed);
    if (!view.unlocked || !view.completableNow) continue;
    const box = view.tasks.find((t) => t.checkbox);
    if (box !== undefined) {
      ticks.push({
        quest,
        spec: { type: 'CHECK_QUEST_BOX', args: { questId: quest.id, taskIndex: box.task.index } },
        reason: `tick the checkbox of "${quest.name}" (the rest of the quest is done or ready)`,
      });
      continue;
    }
    if (view.completableWithoutSubmit) {
      pending.push(quest);
      continue;
    }
    submits.push({
      quest,
      spec: { type: 'SUBMIT_QUEST', args: { questId: quest.id } },
      reason: `submit "${quest.name}": everything it needs is held`,
    });
  }
  return { steps: [...claims, ...ticks, ...submits], waiting, pending };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** True when the agent's abilities cover every required task (AND) or one (OR). */
export function isDoable(quest: Quest, abilities: Abilities = BASE_ABILITIES): boolean {
  return questView(quest, new Map(), {}, abilities, new Set()).doable;
}

export interface QuestProgress {
  /** The benchmark chapter: its quests, and how many the server records as completed. */
  total: number;
  completed: number;
  main: { total: number; completed: number };
  /** Quests from other chapters that the chapter needs. */
  outside: { total: number; completed: number };
  /** Chapter quests the agent's abilities cover (whether or not they are unlocked yet). */
  doable: number;
}

export function questProgress(
  quests: readonly Quest[],
  completed: ReadonlySet<string>,
  abilities: Abilities = BASE_ABILITIES,
): QuestProgress {
  const chapter = quests.filter((q) => q.inChapter);
  const mains = chapter.filter((q) => q.main);
  const outside = quests.filter((q) => !q.inChapter);
  const done = (list: readonly Quest[]): number => list.filter((q) => completed.has(q.id)).length;
  return {
    total: chapter.length,
    completed: done(chapter),
    main: { total: mains.length, completed: done(mains) },
    outside: { total: outside.length, completed: done(outside) },
    doable: chapter.filter((q) => isDoable(q, abilities)).length,
  };
}
