import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../src/app/agent-loop.ts';
import type { SessionResult, SessionStopKind } from '../../src/app/live-session.ts';
import {
  checkPlayLimits,
  DEFAULT_PLAY_LIMITS,
  describePlayEvent,
  runPlay,
  type PlayDeps,
  type PlayEvent,
} from '../../src/app/play.ts';
import { completedQuests, questTaskId } from '../../src/app/quest-commands.ts';
import { worldTime, type GameState } from '../../src/domain/game-state.ts';
import type { QuestBook } from '../../src/domain/quest-book.ts';
import { TASK, type Quest, type QuestBookStep } from '../../src/goals/quest-goals.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repositories.ts';
import { systemClock } from '../../src/util/clock.ts';
import { makeState } from '../fixtures/index.ts';

const quest = (
  id: string,
  tasks: Quest['tasks'],
  prerequisites: string[] = [],
  rewards: Quest['rewards'] = [],
): Quest => ({
  id,
  name: `Q${id}`,
  description: '',
  prerequisites,
  prerequisiteLogic: 'AND',
  taskLogic: 'AND',
  main: true,
  inChapter: true,
  chapter: 'Test',
  lockedProgress: false,
  tasks,
  rewards,
  layout: { x: 0, y: Number(id) },
});
const stack = (item: string, count: number) => ({ item, count, oreDict: null, anyDamage: false });
const have = (item: string, count: number, consume = false) => ({
  index: 0,
  type: TASK.retrieval,
  consume,
  items: [stack(item, count)],
  craftedBeforeCount: false,
});
const checkbox = {
  index: 0,
  type: TASK.checkbox,
  consume: false,
  items: [],
  craftedBeforeCount: false,
};
const COOKIE = [
  { index: 0, type: 'bq_standard:item', choice: false, items: [stack('minecraft:cookie', 1)] },
];
// 1 (checkbox, a cookie to claim) -> 2 (100 sand) -> 3 (50 gravel)
const BOOK = [
  quest('1', [checkbox], [], COOKIE),
  quest('2', [have('minecraft:sand', 100)], ['1']),
  quest('3', [have('minecraft:gravel', 50)], ['2']),
];

/**
 * The server side: Better Questing's records for BOOK. Retrieval tasks of active quests are
 * counted when the inventory changes (after a session) or on a submit; checkboxes, submits
 * and claims are the quest-book clicks; a quest completes once all its tasks are done.
 */
interface World {
  inventory: Record<string, number>;
  /** What each session does to the inventory, and how it ends. */
  sessions: Array<{ gain?: Record<string, number>; stopKind?: SessionStopKind }>;
  calls: number;
  book?: Quest[];
  completed?: Set<string>;
  claimed?: Set<string>;
  /** Task completions, `${questId}#${taskIndex}`. */
  taskDone?: Set<string>;
  /** Quest-book clicks made, as "TYPE questId". */
  clicks?: string[];
  /** The server's quest book cannot be read. */
  noBook?: boolean;
  /** Every click fails. */
  clicksFail?: boolean;
}

const bookOfWorld = (w: World): Quest[] => w.book ?? BOOK;
const sets = (w: World) => {
  w.completed ??= new Set();
  w.claimed ??= new Set();
  w.taskDone ??= new Set();
  w.clicks ??= [];
  return { completed: w.completed, claimed: w.claimed, taskDone: w.taskDone, clicks: w.clicks };
};
const unlocked = (w: World, q: Quest): boolean =>
  q.prerequisites.every((p) => sets(w).completed.has(p));
const active = (w: World, q: Quest): boolean => unlocked(w, q) && !sets(w).completed.has(q.id);
const held = (w: World, item: string): number => w.inventory[item] ?? 0;

/** BQ's detect for one quest (inventory change, or a submit), then its completion check. */
function detect(w: World, q: Quest, submit: boolean): void {
  const { completed, taskDone } = sets(w);
  for (const t of q.tasks) {
    if (t.type !== TASK.retrieval || taskDone.has(`${q.id}#${t.index}`)) continue;
    if (t.consume && !submit) continue;
    if (t.items.every((i) => held(w, i.item) >= i.count)) {
      if (t.consume) for (const i of t.items) w.inventory[i.item] = held(w, i.item) - i.count;
      taskDone.add(`${q.id}#${t.index}`);
    }
  }
  if (q.tasks.every((t) => taskDone.has(`${q.id}#${t.index}`))) completed.add(q.id);
}

function serverBook(w: World): QuestBook {
  const { completed, claimed, taskDone } = sets(w);
  return {
    totalQuests: 3739,
    quests: bookOfWorld(w).map((q) => {
      const isDone = completed.has(q.id);
      const isClaimed = isDone && (claimed.has(q.id) || q.rewards.length === 0);
      return {
        id: q.id,
        name: q.name,
        active: active(w, q),
        unlocked: unlocked(w, q),
        completed: isDone,
        claimed: isClaimed,
        taskLogic: q.taskLogic,
        tasks: active(w, q)
          ? q.tasks.map((t) => ({
              index: t.index,
              type: t.type,
              complete: taskDone.has(`${q.id}#${t.index}`),
              consume: t.consume,
              items: t.items,
              progress: t.items.map((i) => (taskDone.has(`${q.id}#${t.index}`) ? i.count : 0)),
            }))
          : [],
        rewards: isDone && !isClaimed ? q.rewards.map((r) => ({ ...r, selected: null })) : [],
      };
    }),
  };
}

const inventoryOf = (w: World) => ({
  known: true as const,
  value: {
    items: { ...w.inventory },
    usedSlots: Object.keys(w.inventory).length,
    capacitySlots: 36,
  },
});

function click(w: World, spec: QuestBookStep['spec']): boolean {
  const { completed, claimed, taskDone, clicks } = sets(w);
  clicks.push(`${spec.type} ${spec.args.questId}`);
  const q = bookOfWorld(w).find((x) => x.id === spec.args.questId);
  if (w.clicksFail === true || q === undefined) return false;
  switch (spec.type) {
    case 'CHECK_QUEST_BOX':
      taskDone.add(`${q.id}#${spec.args.taskIndex}`);
      if (q.tasks.every((t) => taskDone.has(`${q.id}#${t.index}`))) completed.add(q.id);
      return true;
    case 'SUBMIT_QUEST':
      detect(w, q, true);
      return completed.has(q.id);
    case 'CLAIM_QUEST_REWARD':
      claimed.add(q.id);
      for (const r of q.rewards) {
        for (const i of r.items) w.inventory[i.item] = held(w, i.item) + i.count;
      }
      return true;
  }
}

function deps(repos: Repositories, world: World, clock = { t: 0 }): PlayDeps {
  return {
    repos,
    quests: bookOfWorld(world),
    now: () => clock.t,
    inventory: () => Promise.resolve({ ...world.inventory }),
    questBook: () =>
      Promise.resolve({
        questBook:
          world.noBook === true
            ? { known: false, reason: 'the server does not run Better Questing' }
            : { known: true, value: serverBook(world) },
        inventory: inventoryOf(world),
      }),
    questAction: (spec) => {
      const ok = click(world, spec);
      return Promise.resolve({
        status: ok ? 'succeeded' : 'failed',
        summary: `QUEST BOOK -> ${spec.type} -> ${ok ? 'succeeded' : 'failed'}`,
        outcome: null,
      } as unknown as CycleResult);
    },
    session: (_limits, hooks): Promise<SessionResult> => {
      const plan = world.sessions[world.calls] ?? {};
      world.calls += 1;
      clock.t += 60_000;
      const activeNow = bookOfWorld(world).filter((q) => active(world, q));
      for (const [item, n] of Object.entries(plan.gain ?? {})) {
        world.inventory[item] = held(world, item) + n;
      }
      // The inventory changed: Better Questing re-counts the active quests.
      if (Object.keys(plan.gain ?? {}).length > 0)
        for (const q of activeNow) detect(world, q, false);
      hooks.onCycle({ summary: 'REQUEST_PLANNER -> DIG_BLOCK -> succeeded' } as CycleResult, 1);
      const stopKind = plan.stopKind ?? 'limit';
      return Promise.resolve({
        cycles: [{ cycleId: `c${world.calls}`, summary: 'x' }],
        stopReason: `stop: ${stopKind}`,
        stopKind,
        taskId: repos.memory.getValue(CURRENT_TASK_KEY),
        taskStatus: 'active',
        elapsedMs: 1,
      });
    },
  };
}

const open = () => createRepositories(openDatabase(IN_MEMORY), systemClock);
const noStop = { stopRequested: () => null };

describe('autonomous play', () => {
  it('works through the quests in order, by the server records, and stops when nothing doable is left', async () => {
    const repos = open();
    const world: World = {
      inventory: {},
      sessions: [
        { gain: { 'minecraft:sand': 60 } },
        { gain: { 'minecraft:sand': 40 } },
        { gain: { 'minecraft:gravel': 50 } },
      ],
      calls: 0,
    };
    const events: PlayEvent[] = [];
    const result = await runPlay(deps(repos, world), DEFAULT_PLAY_LIMITS, {
      ...noStop,
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe('no quest the agent can do is left');
    expect(result.questsCompleted).toEqual(['Q1', 'Q2', 'Q3']);
    expect(result.sessions).toBe(3);
    expect(result.progress).toMatchObject({ total: 3, completed: 3 });
    expect([...completedQuests(repos)]).toEqual(['1', '2', '3']);
    expect(repos.tasks.get(questTaskId('2'))?.status).toBe('completed');
    // The quest-book clicks were play's own: the checkbox, then the reward.
    expect(world.clicks).toEqual(['CHECK_QUEST_BOX 1', 'CLAIM_QUEST_REWARD 1']);
    expect(world.inventory['minecraft:cookie']).toBe(1);
    const lines = events
      .filter((e) => e.kind === 'goal' || e.kind === 'quest-book')
      .map((e) => describePlayEvent(e));
    expect(lines).toEqual([
      'QUEST BOOK CHECK_QUEST_BOX "Q1": done (QUEST BOOK -> CHECK_QUEST_BOX -> succeeded)',
      'QUEST BOOK CLAIM_QUEST_REWARD "Q1": done (QUEST BOOK -> CLAIM_QUEST_REWARD -> succeeded)',
      'goal: "Q2" - missing 100 minecraft:sand (new task)',
      'goal: "Q2" - missing 40 minecraft:sand',
      'goal: "Q3" - missing 50 minecraft:gravel (new task)',
    ]);
  });

  it("gives the planner the quest's remaining tasks by the server's count, and its route", async () => {
    const repos = open();
    const world: World = { inventory: { 'minecraft:sand': 30 }, sessions: [], calls: 0 };
    await runPlay(deps(repos, world), { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 }, noStop);
    const task = repos.tasks.get(questTaskId('2'));
    expect(task).toMatchObject({
      goal: 'Age 0 quest "Q2": have 100 minecraft:sand',
      subgoal: "remaining by the server's count: get 70 more minecraft:sand",
    });
    expect(repos.memory.taskRequirements(questTaskId('2'))).toEqual({ 'minecraft:sand': 100 });
  });

  it('counts a quest only when the server records it: items held are not enough', async () => {
    // A consume quest: the items are held, but only a submit hands them in.
    const book = [quest('1', [have('minecraft:log', 2, true)])];
    const clicksOff = deps(open(), {
      inventory: { 'minecraft:log': 2 },
      sessions: [],
      calls: 0,
      book,
    });
    delete clicksOff.questAction;
    const off = await runPlay(clicksOff, DEFAULT_PLAY_LIMITS, noStop);
    expect(off.questsCompleted).toEqual([]);
    expect(off.stopReason).toBe(
      'no quest the agent can do is left; 1 quest-book click(s) are due and quest-book clicks ' +
        'are off (MC_ENABLE_QUEST_BOOK): submit "Q1": everything it needs is held',
    );
    // With quest-book clicks on, play submits it itself and the server completes it.
    const world: World = { inventory: { 'minecraft:log': 2 }, sessions: [], calls: 0, book };
    const on = await runPlay(deps(open(), world), DEFAULT_PLAY_LIMITS, noStop);
    expect(world.clicks).toEqual(['SUBMIT_QUEST 1']);
    expect(on.questsCompleted).toEqual(['Q1']);
    expect(world.inventory['minecraft:log']).toBe(0);
  });

  it('tries a failing quest-book click twice, then gives up on it', async () => {
    const world: World = { inventory: {}, sessions: [], calls: 0, clicksFail: true };
    const events: PlayEvent[] = [];
    const result = await runPlay(deps(open(), world), DEFAULT_PLAY_LIMITS, {
      ...noStop,
      onEvent: (e) => events.push(e),
    });
    expect(world.clicks).toEqual(['CHECK_QUEST_BOX 1', 'CHECK_QUEST_BOX 1']);
    expect(result.stopReason).toBe(
      'no quest the agent can do is left; quest-book clicks failed 2 times: tick the checkbox ' +
        'of "Q1" (the rest of the quest is done or ready)',
    );
    expect(events.filter((e) => e.kind === 'quest-book' && !e.ok)).toHaveLength(2);
  });

  it("stops when the server's quest book cannot be read", async () => {
    const result = await runPlay(
      deps(open(), { inventory: {}, sessions: [], calls: 0, noBook: true }),
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.stopReason).toBe(
      "the server's quest book is unknown (the server does not run Better Questing); quests " +
        'count only as the server records them',
    );
  });

  it('ends a session as soon as an observation shows the quest done or a click due', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world);
    const seen: Array<string | null> = [];
    await runPlay(
      {
        ...base,
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === questTaskId('2')) {
            const state = (items: Record<string, number>): GameState => {
              world.inventory = items;
              return {
                ...makeState(),
                inventory: inventoryOf(world),
                questBook: { known: true, value: serverBook(world) },
              };
            };
            const cycle = (after: GameState): CycleResult =>
              ({ summary: 'x', outcome: { stateAfter: after } }) as unknown as CycleResult;
            hooks.onCycle(cycle(state({ 'minecraft:sand': 99 })), 1);
            seen.push(hooks.stopRequested());
            // 100 sand held, not yet counted by the server: a submit is due.
            hooks.onCycle(cycle(state({ 'minecraft:sand': 100 })), 2);
            seen.push(hooks.stopRequested());
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      noStop,
    );
    expect(seen).toEqual([null, '"Q2" is satisfied']);
  });

  it('gives up on a quest after sessions without progress', async () => {
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const result = await runPlay(
      deps(open(), world),
      { ...DEFAULT_PLAY_LIMITS, maxStuckSessions: 2 },
      noStop,
    );
    expect(result.stopReason).toBe(
      'no progress on "Q2" in 2 sessions in a row (last: stop: limit)',
    );
    expect(world.calls).toBe(2);
  });

  it('stops for a human, and never resumes a paused quest task', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [{ stopKind: 'needs-attention' }], calls: 0 };
    expect((await runPlay(deps(repos, world), DEFAULT_PLAY_LIMITS, noStop)).stopReason).toBe(
      'stop: needs-attention',
    );
    repos.tasks.setStatus(questTaskId('2'), 'paused');
    const again = await runPlay(deps(repos, world), DEFAULT_PLAY_LIMITS, noStop);
    expect(again.stopReason).toMatch(/^the task quest-2 for "Q2" is paused; it needs you/);
    expect(world.calls).toBe(1);
  });

  it('keeps playing after a failed cycle or a detour, and honours the limits and the stop file', async () => {
    const world: World = {
      inventory: {},
      sessions: [
        { stopKind: 'cycle-failed', gain: { 'minecraft:sand': 10 } },
        { stopKind: 'non-task-decision', gain: { 'minecraft:sand': 10 } },
        { gain: { 'minecraft:sand': 10 } },
      ],
      calls: 0,
    };
    const clock = { t: 0 };
    const limited = await runPlay(
      deps(open(), world, clock),
      { ...DEFAULT_PLAY_LIMITS, maxMinutes: 3 },
      noStop,
    );
    expect(limited.stopReason).toBe('reached the limit of 3 minutes');
    expect(world.calls).toBe(3);

    let stop: string | null = null;
    const stopped = await runPlay(
      deps(open(), { inventory: {}, sessions: [], calls: 0 }),
      DEFAULT_PLAY_LIMITS,
      {
        stopRequested: () => stop,
        onEvent: (e) => {
          if (e.kind === 'session-end') stop = 'the stop file exists';
        },
      },
    );
    expect(stopped).toMatchObject({ stopReason: 'the stop file exists', sessions: 1 });
  });

  it('stops before the dark (no shelter yet) and says when the sun rises', async () => {
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const result = await runPlay(
      { ...deps(open(), world), time: () => Promise.resolve(worldTime(12_400, true)) },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.stopReason).toMatch(/^it is evening \(9\.7 min until sunrise\)/);
    expect(result.night).toMatchObject({ phase: 'evening' });
    expect(world.calls).toBe(0);
  });

  it('pursues a goal of its own (any items), with its route, until the items are held', async () => {
    const repos = open();
    const world: World = {
      inventory: { 'minecraft:log': 1 },
      sessions: [{ gain: { 'minecraft:log': 1 } }, { gain: { 'minecraft:log': 1 } }],
      calls: 0,
    };
    const goal = {
      taskId: 'goal-minecraft:log-3',
      name: 'get 3 minecraft:log',
      requirements: { 'minecraft:log': 3 },
    };
    const events: PlayEvent[] = [];
    const result = await runPlay({ ...deps(repos, world), goal }, DEFAULT_PLAY_LIMITS, {
      ...noStop,
      onEvent: (e) => events.push(e),
    });
    expect(result.stopReason).toBe('the goal "get 3 minecraft:log" is reached');
    expect(world.calls).toBe(2);
    // The planner's route comes from the task's requirements.
    expect(repos.memory.taskRequirements(goal.taskId)).toEqual({ 'minecraft:log': 3 });
    expect(repos.tasks.get(goal.taskId)?.status).toBe('completed');
    expect(repos.memory.journal(goal.taskId).at(-1)?.text).toBe(
      'GOAL "get 3 minecraft:log" reached',
    );
    expect(events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e))).toEqual([
      'goal: "get 3 minecraft:log" - missing 2 minecraft:log (new task)',
      'goal: "get 3 minecraft:log" - missing 1 minecraft:log',
    ]);
  });

  it('at dusk builds the shelter (the planner gets the blueprint), then waits inside for the morning', async () => {
    const repos = open();
    const world: World = {
      inventory: { 'minecraft:sand': 20, 'minecraft:cobblestone': 2 },
      sessions: [],
      calls: 0,
    };
    let sheltered = false;
    let tick = 11_000; // 1.7 min before night: shelter time
    const status = () => ({
      sheltered,
      todo: sheltered
        ? []
        : [
            {
              position: { x: 1, y: 64, z: 0 },
              role: 'feet wall' as const,
              item: 'minecraft:sand',
            },
          ],
      needs: sheltered ? {} : { 'minecraft:sand': 1 },
      problem: null,
    });
    const events: PlayEvent[] = [];
    const base = deps(repos, world);
    const result = await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(tick, true)),
        shelter: () => Promise.resolve(status()),
        sleep: () => {
          tick = 100; // the night passes: morning
          return Promise.resolve();
        },
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'night-shelter') {
            expect(repos.memory.taskBlueprint('night-shelter')).toEqual([
              '1. place minecraft:sand at (1, 64, 0) (feet wall)',
            ]);
            sheltered = true;
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    const night = events.filter((e) => e.kind === 'night').map((e) => describePlayEvent(e));
    expect(night).toEqual([
      'night: sheltered: waiting for the morning (10.8 min)',
      'night: morning: leaving the shelter',
    ]);
    // The morning goal's journal says how to get out.
    expect(repos.memory.journal('quest-2').at(-1)?.text).toMatch(
      /^morning: the player is inside its night shelter/,
    );
    expect(result.night).toBeNull();
  });

  it('checks its limits', () => {
    expect(checkPlayLimits(DEFAULT_PLAY_LIMITS)).toBeNull();
    expect(checkPlayLimits({ ...DEFAULT_PLAY_LIMITS, maxMinutes: 600 })).toBe(
      'max minutes must be 1-480',
    );
    expect(checkPlayLimits({ ...DEFAULT_PLAY_LIMITS, maxStuckSessions: 0 })).toBe(
      'max stuck sessions must be 1-20',
    );
  });
});
