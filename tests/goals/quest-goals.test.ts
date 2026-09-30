import { describe, expect, it } from 'vitest';
import {
  adoptGoal,
  completedQuests,
  describeQuests,
  questTaskId,
  updateQuests,
} from '../../src/app/quest-commands.ts';
import { AGE0_QUESTS } from '../../src/goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  goalText,
  isDoable,
  missingItems,
  newlyCompleted,
  nextGoal,
  questDepths,
  TASK,
  type Quest,
  type QuestItem,
} from '../../src/goals/quest-goals.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { systemClock } from '../../src/util/clock.ts';

const item = (name: string, count: number, anyDamage = false): QuestItem => ({
  item: name,
  count,
  oreDict: null,
  anyDamage,
});
let y = 0;
const quest = (
  id: string,
  tasks: Quest['tasks'],
  prerequisites: string[] = [],
  extra: Partial<Quest> = {},
): Quest => ({
  id,
  name: `Quest ${id}`,
  description: '',
  prerequisites,
  prerequisiteLogic: 'AND',
  main: true,
  tasks,
  layout: { x: 0, y: y++ },
  ...extra,
});
const checkbox = { type: TASK.checkbox, consume: false, items: [] };
const retrieve = (...items: QuestItem[]) => ({ type: TASK.retrieval, consume: false, items });
const craft = (...items: QuestItem[]) => ({ type: TASK.crafting, consume: false, items });
const optional = (...items: QuestItem[]) => ({
  type: TASK.optionalRetrieval,
  consume: false,
  items,
});

// start (checkbox) -> sand (128 sand) -> mortar (craft a GT mortar), and a hunting quest.
const BOOK: Quest[] = [
  quest('0:1', [checkbox], ['0:999']), // a prerequisite in another chapter
  quest(
    '0:2',
    [retrieve(item('minecraft:sand', 128)), optional(item('minecraft:string', 4))],
    ['0:1'],
  ),
  quest('0:3', [craft(item('gregtech:gt.metatool.01@24', 1))], ['0:2']),
  quest('0:4', [{ type: 'bq_standard:hunt', consume: false, items: [] }], ['0:1']),
];

describe('quest goals', () => {
  it('completes checkboxes at once and picks the first doable quest', () => {
    const done = new Set(newlyCompleted(BOOK, new Set(), {}));
    expect([...done]).toEqual(['0:1']);
    const goal = nextGoal(BOOK, done, { 'minecraft:sand': 28 });
    expect(goal?.quest.id).toBe('0:2');
    expect(goal?.missing).toEqual({ 'minecraft:sand': 100 });
    expect(goal?.text).toBe('Age 0 quest "Quest 0:2": have 128 minecraft:sand');
    expect(goal?.subgoal).toBe('still missing: 100 minecraft:sand');
  });

  it('never blocks on optional items, never picks what it cannot do', () => {
    expect(missingItems(BOOK[1]!, { 'minecraft:sand': 128 })).toEqual({});
    expect(isDoable(BOOK[2]!)).toBe(false); // no crafting yet
    expect(
      isDoable(BOOK[2]!, { ...BASE_ABILITIES, craft: new Set(['gregtech:gt.metatool.01']) }),
    ).toBe(true);
    expect(isDoable(BOOK[3]!)).toBe(false); // hunting
    const done = new Set(['0:1', '0:2']);
    expect(nextGoal(BOOK, done, {})).toBeNull();
  });

  it('completes a quest once its items are held, then what it unlocks', () => {
    const inv = { 'minecraft:sand': 130, 'gregtech:gt.metatool.01@24': 1 };
    expect(newlyCompleted(BOOK, new Set(), inv)).toEqual(['0:1', '0:2', '0:3']);
    // Not before its prerequisite: without the sand, the mortar quest stays open.
    expect(newlyCompleted(BOOK, new Set(['0:1']), { 'gregtech:gt.metatool.01@24': 1 })).toEqual([]);
  });

  it('counts any damage only when the quest allows it', () => {
    const logs = quest('0:9', [retrieve(item('minecraft:log', 10, true))]);
    expect(missingItems(logs, { 'minecraft:log@2': 6, 'minecraft:log': 4 })).toEqual({});
    const oak = quest('0:10', [retrieve(item('minecraft:log', 10))]);
    expect(missingItems(oak, { 'minecraft:log@2': 6, 'minecraft:log': 4 })).toEqual({
      'minecraft:log': 6,
    });
  });

  it('OR prerequisites need only one', () => {
    const q = quest('0:20', [checkbox], ['0:2', '0:3'], { prerequisiteLogic: 'OR' });
    expect(newlyCompleted([...BOOK, q], new Set(['0:1', '0:2']), {})).toEqual(['0:20']);
  });
});

describe('the Age 0 quest book (GTNH 2.8.4)', () => {
  it('has 92 quests with exact, unique ids', () => {
    expect(AGE0_QUESTS).toHaveLength(92);
    expect(new Set(AGE0_QUESTS.map((q) => q.id)).size).toBe(92);
    // Newer quests use whole 64-bit ids: they must survive extraction exactly.
    expect(AGE0_QUESTS.some((q) => /^-?\d{16,}:-?\d{16,}$/.test(q.id))).toBe(true);
    for (const q of AGE0_QUESTS) expect(goalText(q).length).toBeLessThanOrEqual(300);
  });

  it('starts with "Ready, Set, Go!" and a gathering quest', () => {
    const start = new Set(newlyCompleted(AGE0_QUESTS, new Set(), {}));
    const names = AGE0_QUESTS.filter((q) => start.has(q.id)).map((q) => q.name);
    expect(names).toContain('Ready, Set, Go!');
    const goal = nextGoal(AGE0_QUESTS, start, {});
    expect(goal?.quest.name).toMatch(/: The Gathering$/);
    expect(Math.max(...questDepths(AGE0_QUESTS).values())).toBeGreaterThan(10);
  });
});

describe('the agent quest book', () => {
  const open = () => createRepositories(openDatabase(IN_MEMORY), systemClock);

  it('records completions, adopts the next goal as the current task, closes it when done', () => {
    const repos = open();
    const first = updateQuests(repos, {}, BASE_ABILITIES, BOOK);
    expect(first.added.map((q) => q.id)).toEqual(['0:1']);
    expect(first.next?.quest.id).toBe('0:2');
    const { taskId, created } = adoptGoal(repos, first.next!);
    expect(created).toBe(true);
    expect(taskId).toBe(questTaskId('0:2'));
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBe(taskId);
    expect(repos.tasks.get(taskId)).toMatchObject({
      status: 'active',
      subgoal: 'still missing: 128 minecraft:sand',
    });

    // Some sand later: same task, updated subgoal.
    const mid = updateQuests(repos, { 'minecraft:sand': 100 }, BASE_ABILITIES, BOOK);
    expect(mid.added).toEqual([]);
    expect(adoptGoal(repos, mid.next!).created).toBe(false);
    expect(repos.tasks.get(taskId)?.subgoal).toBe('still missing: 28 minecraft:sand');

    // All of it: the quest completes, its task closes, nothing doable is left.
    const end = updateQuests(repos, { 'minecraft:sand': 128 }, BASE_ABILITIES, BOOK);
    expect(end.added.map((q) => q.id)).toEqual(['0:2']);
    expect(end.next).toBeNull();
    expect(repos.tasks.get(taskId)?.status).toBe('completed');
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBeNull();
    expect([...completedQuests(repos)]).toEqual(['0:1', '0:2']);
    expect(describeQuests(repos, {}, BOOK)).toMatchObject({
      progress: { total: 4, completed: 2 },
      next: 'nothing the agent can do yet',
    });
  });
});
