import { describe, expect, it } from 'vitest';
import {
  adoptGoal,
  completedQuests,
  describeQuests,
  questTaskId,
  updateQuests,
} from '../../src/app/quest-commands.ts';
import { ItemNameSchema } from '../../src/domain/common.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import type { QuestBook, QuestBookQuest, QuestBookReward } from '../../src/domain/quest-book.ts';
import { AGE0_CHAPTER, AGE0_QUESTS } from '../../src/goals/age0-quests.ts';
import {
  BASE_ABILITIES,
  goalText,
  isDoable,
  isUnlocked,
  nextGoal,
  questBookSteps,
  questDepths,
  questRequirements,
  questView,
  remainingText,
  TASK,
  type Quest,
  type QuestItem,
  type QuestTask,
  type ServerQuests,
} from '../../src/goals/quest-goals.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { systemClock } from '../../src/util/clock.ts';
import { makeState } from '../fixtures/index.ts';

const item = (name: string, count: number, extra: Partial<QuestItem> = {}): QuestItem => ({
  item: name,
  count,
  oreDict: null,
  anyDamage: false,
  ...extra,
});
const task = (
  index: number,
  type: string,
  items: QuestItem[] = [],
  extra: Partial<QuestTask> = {},
): QuestTask => ({ index, type, consume: false, items, craftedBeforeCount: false, ...extra });
let y = 0;
const quest = (
  id: string,
  tasks: QuestTask[],
  prerequisites: string[] = [],
  extra: Partial<Quest> = {},
): Quest => ({
  id,
  name: `Quest ${id}`,
  description: '',
  prerequisites,
  prerequisiteLogic: 'AND',
  taskLogic: 'AND',
  main: true,
  inChapter: true,
  chapter: 'Test',
  lockedProgress: false,
  tasks,
  rewards: [],
  layout: { x: 0, y: y++ },
  ...extra,
});

/** The server's record of a quest: active and unlocked unless said otherwise. */
const rec = (
  q: Quest,
  extra: Partial<QuestBookQuest> & {
    complete?: number[];
    progress?: Record<number, number[]>;
  } = {},
): QuestBookQuest => {
  const { complete = [], progress = {}, ...rest } = extra;
  return {
    id: q.id,
    name: q.name,
    active: true,
    unlocked: true,
    completed: false,
    claimed: false,
    taskLogic: q.taskLogic,
    tasks: q.tasks.map((t) => ({
      index: t.index,
      type: t.type,
      complete: complete.includes(t.index),
      consume: t.consume,
      items: t.items,
      progress: progress[t.index] ?? t.items.map(() => 0),
    })),
    rewards: [],
    ...rest,
  };
};
const done = (q: Quest, rewards: QuestBookReward[] = []): QuestBookQuest =>
  rec(q, { active: false, completed: true, claimed: rewards.length === 0, tasks: [], rewards });
const serverOf = (...records: QuestBookQuest[]): ServerQuests =>
  new Map(records.map((r) => [r.id, r]));
const bookOf = (...records: QuestBookQuest[]): QuestBook => ({
  totalQuests: 3739,
  quests: records,
});

// start (checkbox) -> sand (128 sand, optional string) -> mortar (craft a GT mortar); hunting.
const START = quest('0:1', [task(0, TASK.checkbox)], ['0:999']);
const SAND = quest(
  '0:2',
  [
    task(0, TASK.retrieval, [item('minecraft:sand', 128)]),
    task(1, TASK.optionalRetrieval, [item('minecraft:string', 4)]),
  ],
  ['0:1'],
);
const MORTAR = quest(
  '0:3',
  [task(0, TASK.crafting, [item('gregtech:gt.metatool.01@24', 1)])],
  ['0:2'],
);
const HUNT = quest('0:4', [task(0, TASK.hunt)], ['0:1']);
const BOOK: Quest[] = [START, SAND, MORTAR, HUNT];

describe('quest goals: Better Questing logic', () => {
  it('unlocks by the prerequisite logic over completed quests (AND, OR, XOR)', () => {
    const and = quest('0:30', [], ['0:1', '0:2']);
    const or = quest('0:31', [], ['0:1', '0:2'], { prerequisiteLogic: 'OR' });
    const xor = quest('0:32', [], ['0:1', '0:2'], { prerequisiteLogic: 'XOR' });
    expect([and, or, xor].map((q) => isUnlocked(q, new Set(['0:1'])))).toEqual([false, true, true]);
    // XOR: completing the second prerequisite locks it again, for good.
    expect([and, or, xor].map((q) => isUnlocked(q, new Set(['0:1', '0:2'])))).toEqual([
      true,
      true,
      false,
    ]);
    expect(isUnlocked(quest('0:33', []), new Set())).toBe(true);
  });

  it('counts retrieval by what is held, keeps a met count, and never waits for optional items', () => {
    const fresh = questView(SAND, serverOf(rec(SAND)), { 'minecraft:sand': 100 });
    expect(fresh.missing).toEqual({ 'minecraft:sand': 28 });
    expect(fresh.completableNow).toBe(false);
    const held = questView(SAND, serverOf(rec(SAND)), { 'minecraft:sand': 128 });
    expect(held).toMatchObject({ missing: {}, completableNow: true });
    expect(held.completableWithoutSubmit).toBe(false); // the server has not counted it yet
    // The server counted 128 once: that stays, even with the sand gone.
    const counted = questView(SAND, serverOf(rec(SAND, { progress: { 0: [128] } })), {});
    expect(counted.missing).toEqual({});
  });

  it('counts consume tasks by what was handed in, and lists what is still to hand in', () => {
    const logs = quest('0:40', [
      task(0, TASK.retrieval, [item('minecraft:log', 2, { oreDict: 'logWood' })], {
        consume: true,
      }),
    ]);
    const view = questView(logs, serverOf(rec(logs, { progress: { 0: [1] } })), {});
    expect(view.missing).toEqual({ 'minecraft:log': 1 });
    // Birch logs are logWood (Forge registers every log damage): one is enough now.
    const birch = questView(logs, serverOf(rec(logs, { progress: { 0: [1] } })), {
      'minecraft:log@2': 1,
    });
    expect(birch).toMatchObject({ missing: {}, completableNow: true });
  });

  it('counts crafting tasks only by the server: holding the item does not count', () => {
    const view = questView(MORTAR, serverOf(rec(MORTAR)), { 'gregtech:gt.metatool.01@24': 1 });
    expect(view.missing).toEqual({ 'gregtech:gt.metatool.01@24': 1 });
    expect(view.completableNow).toBe(false);
    const crafted = questView(MORTAR, serverOf(rec(MORTAR, { progress: { 0: [1] } })), {});
    expect(crafted.missing).toEqual({});
  });

  it('task logic OR: one task is enough, and the cheapest doable one is the focus', () => {
    const creosote = quest(
      '0:41',
      [
        task(0, TASK.retrieval, [item('Railcraft:fluid.creosote.bucket', 1)]),
        task(1, TASK.retrieval, [item('minecraft:dirt', 2)]),
      ],
      [],
      { taskLogic: 'OR' },
    );
    const view = questView(creosote, serverOf(rec(creosote)), { 'minecraft:dirt': 1 });
    expect(view.focus.map((t) => t.task.index)).toEqual([1]);
    expect(view.missing).toEqual({ 'minecraft:dirt': 1 });
    expect(view.doable).toBe(true);
    const oneDone = questView(creosote, serverOf(rec(creosote, { complete: [0] })), {});
    expect(oneDone).toMatchObject({ missing: {}, completableWithoutSubmit: true });
    // An OR quest with a checkbox is finished by the tick alone.
    const skip = quest(
      '0:42',
      [task(0, TASK.crafting, [item('Forestry:coinBag', 1)]), task(1, TASK.checkbox)],
      [],
      {
        taskLogic: 'OR',
      },
    );
    expect(questView(skip, serverOf(rec(skip)), {}).completableNow).toBe(true);
  });

  it('knows what the agent cannot do: unknown crafts, hunting', () => {
    expect(isDoable(MORTAR)).toBe(false);
    expect(
      isDoable(MORTAR, { ...BASE_ABILITIES, craft: new Set(['gregtech:gt.metatool.01']) }),
    ).toBe(true);
    expect(isDoable(HUNT)).toBe(false);
    expect(isDoable(SAND)).toBe(true);
    // GTNH gravel never drops flint: flint is crafted, not gathered.
    expect(BASE_ABILITIES.gather.has('minecraft:flint')).toBe(false);
  });
});

describe('quest goals: the next goal and the quest-book clicks', () => {
  it('works on what the server lists as active and unlocked, shallowest first', () => {
    // The data says SAND is unlocked once START is done, but the server decides.
    const notActive = serverOf(done(START), rec(SAND, { active: false }), rec(MORTAR));
    expect(nextGoal(BOOK, notActive, {})).toBeNull();
    const server = serverOf(done(START), rec(SAND), rec(MORTAR, { unlocked: false }), rec(HUNT));
    const goal = nextGoal(BOOK, server, { 'minecraft:sand': 28 });
    expect(goal?.quest.id).toBe('0:2');
    expect(goal?.missing).toEqual({ 'minecraft:sand': 100 });
    expect(goal?.text).toBe('Age 0 quest "Quest 0:2": have 128 minecraft:sand');
    expect(goal?.subgoal).toBe("remaining by the server's count: get 100 more minecraft:sand");
    expect(goal?.requirements).toEqual({ 'minecraft:sand': 128 });
    // All the sand held: a submit finishes it, so it is a click, not a goal.
    expect(nextGoal(BOOK, server, { 'minecraft:sand': 128 })).toBeNull();
  });

  it('asks the route for exactly what counts: held ore-dictionary items, crafts left', () => {
    const sticks = quest('0:50', [
      task(0, TASK.retrieval, [item('minecraft:log', 5, { oreDict: 'logWood' })]),
      task(1, TASK.crafting, [item('minecraft:crafting_table', 2)]),
    ]);
    const server = serverOf(rec(sticks, { progress: { 1: [1] } }));
    const inventory = { 'minecraft:log@2': 3, 'minecraft:crafting_table': 1 };
    const view = questView(sticks, server, inventory);
    expect(questRequirements(view, inventory)).toEqual({
      'minecraft:log@2': 3, // birch counts as logWood
      'minecraft:log': 2, // the rest, under the quest's own name
      'minecraft:crafting_table': 2, // one held + one still to craft
    });
    expect(remainingText(view)).toBe(
      "remaining by the server's count: get 2 more minecraft:log; craft 1 more minecraft:crafting_table (only crafts made now count, not items held)",
    );
  });

  it('decides the clicks in code: claims, then ticks, then submits', () => {
    const reward: QuestBookReward[] = [
      {
        index: 0,
        type: 'bq_standard:choice',
        choice: true,
        items: [item('minecraft:cookie', 1), item('minecraft:sand', 16)],
        selected: null,
      },
    ];
    const boxed = quest('0:60', [
      task(0, TASK.retrieval, [item('minecraft:dirt', 8)]),
      task(1, TASK.checkbox),
    ]);
    const server = serverOf(
      done(START, reward),
      rec(SAND),
      rec(boxed),
      rec(HUNT, { active: false }),
    );
    const book = [...BOOK, boxed];
    const inventory = { 'minecraft:sand': 128, 'minecraft:dirt': 8 };
    const { steps, waiting } = questBookSteps(book, server, inventory, 30);
    expect(waiting).toEqual([]);
    expect(steps.map((s) => s.spec)).toEqual([
      // The choice: the sand an unfinished quest asks for, not the cookie.
      { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:1', choice: 1 } },
      { type: 'CHECK_QUEST_BOX', args: { questId: '0:60', taskIndex: 1 } },
      { type: 'SUBMIT_QUEST', args: { questId: '0:2' } },
    ]);
    // Without the dirt the checkbox waits (ticking it would not finish the quest).
    const noDirt = questBookSteps(book, server, { 'minecraft:sand': 128 }, 30);
    expect(noDirt.steps.map((s) => s.spec.type)).toEqual(['CLAIM_QUEST_REWARD', 'SUBMIT_QUEST']);
    // No room for the rewards: the claim waits (Better Questing drops what does not fit).
    const full = questBookSteps(book, server, inventory, 2);
    expect(full.steps.map((s) => s.spec.type)).toEqual(['CHECK_QUEST_BOX', 'SUBMIT_QUEST']);
    expect(full.waiting.map((w) => w.reason)).toEqual([
      'claiming "Quest 0:1" needs 3 free inventory slots (2 free)',
    ]);
  });

  it("leaves a quest whose tasks are all done to the server's quest loop (no click)", () => {
    const server = serverOf(done(START), rec(SAND, { complete: [0] }));
    const { steps, pending } = questBookSteps(BOOK, server, {}, 30);
    expect(steps).toEqual([]);
    expect(pending).toEqual([SAND]);
    // Nor is it a goal: there is nothing left to get.
    expect(nextGoal(BOOK, server, {})).toBeNull();
  });
});

describe('the Age 0 quest book (GTNH 2.8.4, the world database)', () => {
  const byName = (name: string): Quest => {
    const q = AGE0_QUESTS.find((x) => x.name === name);
    if (q === undefined) throw new Error(`no quest ${name}`);
    return q;
  };

  it('is the 92-quest chapter plus the 14 quests it needs from other chapters', () => {
    expect(AGE0_CHAPTER).toBe('Tier 0 - Stone Age');
    expect(AGE0_QUESTS).toHaveLength(106);
    expect(AGE0_QUESTS.filter((q) => q.inChapter)).toHaveLength(92);
    expect(new Set(AGE0_QUESTS.map((q) => q.id)).size).toBe(106);
    // Newer quests use whole 64-bit ids: they must survive extraction exactly.
    expect(AGE0_QUESTS.some((q) => /^-?\d{16,}:-?\d{16,}$/.test(q.id))).toBe(true);
    // The closure: every prerequisite is in the data.
    const ids = new Set(AGE0_QUESTS.map((q) => q.id));
    for (const q of AGE0_QUESTS) for (const p of q.prerequisites) expect(ids.has(p)).toBe(true);
    for (const q of AGE0_QUESTS) expect(goalText(q).length).toBeLessThanOrEqual(300);
    expect(Math.max(...questDepths(AGE0_QUESTS).values())).toBeGreaterThan(10);
    // Every item is a valid inventory name: task requirements and routes are stored by it.
    const items = AGE0_QUESTS.flatMap((q) => [
      ...q.tasks.flatMap((t) => t.items),
      ...q.rewards.flatMap((r) => r.items),
    ]);
    expect(items.filter((i) => !ItemNameSchema.safeParse(i.item).success)).toEqual([]);
  });

  it('lists the outside prerequisites: the first-night chain, the smeltery choice, a trigger', () => {
    const outside = AGE0_QUESTS.filter((q) => !q.inChapter).map((q) => q.name);
    expect(outside).toEqual(
      expect.arrayContaining([
        'Your First Night',
        "Sticks 'n Stones",
        "Where's the Flint?",
        'Crafting Time',
        'SO...TIRED...MUST...SLEEP...',
        'You Are Not Prepared!!!',
        'You Are Not Prepared... But They Are',
        'You Are Now Prepared, Hopefully!',
        'Trigger: Loot Game',
      ]),
    );
    // The smeltery: two mutually exclusive quests (XOR), either one unlocks the next (OR).
    expect(byName('You Are Not Prepared!!!').prerequisiteLogic).toBe('XOR');
    expect(byName('You Are Not Prepared... But They Are').prerequisiteLogic).toBe('XOR');
    expect(byName('You Are Now Prepared, Hopefully!').prerequisiteLogic).toBe('OR');
    // A consume task in the chain: two logs are handed in.
    expect(byName("Sticks 'n Stones").tasks[1]).toMatchObject({ consume: true });
    expect(AGE0_QUESTS.filter((q) => q.taskLogic === 'OR').map((q) => q.name)).toContain(
      'Creosote',
    );
  });

  it('starts a fresh player on "Your First Night": 8 dirt', () => {
    const first = byName('Your First Night');
    const server = serverOf(
      ...AGE0_QUESTS.map((q) =>
        rec(q, {
          active: q.prerequisites.length === 0,
          unlocked: q.prerequisites.length === 0,
        }),
      ),
    );
    const goal = nextGoal(AGE0_QUESTS, server, {});
    expect(goal?.quest.id).toBe(first.id);
    expect(goal?.missing).toEqual({ 'minecraft:dirt': 8 });
    // "Ready, Set, Go!" (in the chapter) waits behind the bed of the first-night chain.
    expect(isUnlocked(byName('Ready, Set, Go!'), new Set([first.id]))).toBe(false);
  });
});

describe('the server quest book in agent memory', () => {
  const open = () => createRepositories(openDatabase(IN_MEMORY), systemClock);
  const at = new Date('2026-09-30T12:00:00.000Z');

  it('scores only what the server records, adopts the next goal, closes it when done', () => {
    const repos = open();
    const book = (sand: QuestBookQuest): QuestBook =>
      bookOf(done(START), sand, rec(MORTAR, { active: false, unlocked: false }), rec(HUNT));
    // The first observation is the baseline: nothing is "added".
    const first = updateQuests(
      repos,
      book(rec(SAND)),
      { items: {}, freeSlots: 30 },
      BASE_ABILITIES,
      BOOK,
      at,
    );
    expect(first.added).toEqual([]);
    expect(first.progress).toMatchObject({ total: 4, completed: 1 });
    expect(first.next?.quest.id).toBe('0:2');
    const { taskId, created } = adoptGoal(repos, first.next!);
    expect(created).toBe(true);
    expect(taskId).toBe(questTaskId('0:2'));
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBe(taskId);
    expect(repos.tasks.get(taskId)).toMatchObject({
      status: 'active',
      subgoal: "remaining by the server's count: get 128 more minecraft:sand",
    });
    expect(repos.memory.taskRequirements(taskId)).toEqual({ 'minecraft:sand': 128 });

    // Holding all the sand is not completing it: only the server's record is.
    const held = updateQuests(
      repos,
      book(rec(SAND)),
      { items: { 'minecraft:sand': 128 }, freeSlots: 30 },
      BASE_ABILITIES,
      BOOK,
      at,
    );
    expect(held.added).toEqual([]);
    expect(held.clicks.map((c) => c.spec.type)).toEqual(['SUBMIT_QUEST']);
    expect(repos.tasks.get(taskId)?.status).toBe('active');

    // The server records it: the quest is added, its task closes.
    const end = updateQuests(
      repos,
      book(done(SAND)),
      { items: {}, freeSlots: 30 },
      BASE_ABILITIES,
      BOOK,
      at,
    );
    expect(end.added.map((q) => q.id)).toEqual(['0:2']);
    expect(end.next).toBeNull();
    expect(repos.tasks.get(taskId)?.status).toBe('completed');
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBeNull();
    expect([...completedQuests(repos)]).toEqual(['0:1', '0:2']);
  });

  it('describes the quest book from an observation, or from memory without one', () => {
    const repos = open();
    expect(describeQuests(repos, null, BOOK)).toMatchObject({
      progress: { total: 4, completed: 0 },
      next: 'unknown: run with --live to read the server quest book',
    });
    const book = bookOf(done(START), rec(SAND), rec(HUNT));
    const state: GameState = { ...makeState(), questBook: { known: true, value: book } };
    expect(describeQuests(repos, state, BOOK)).toMatchObject({
      progress: { total: 4, completed: 1 },
      completed: ['Quest 0:1'],
      active: ['Quest 0:2', 'Quest 0:4'],
      next: {
        quest: 'Quest 0:2',
        remaining: "remaining by the server's count: get 128 more minecraft:sand",
      },
    });
    updateQuests(repos, book, { items: {}, freeSlots: 30 }, BASE_ABILITIES, BOOK, at);
    expect(describeQuests(repos, null, BOOK)).toMatchObject({
      source: "the server's quest book as observed at 2026-09-30T12:00:00.000Z",
      completed: ['Quest 0:1'],
    });
  });
});
