import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../src/app/agent-loop.ts';
import type { SessionResult, SessionStopKind } from '../../src/app/live-session.ts';
import {
  checkPlayLimits,
  DEFAULT_PLAY_LIMITS,
  describePlayEvent,
  mobPause,
  nightSoon,
  untilSunrise,
  runPlay,
  SHELTER_LEAD_MINUTES,
  type PlayDeps,
  type PlayEvent,
} from '../../src/app/play.ts';
import type { DecisionResult } from '../../src/domain/decisions.ts';
import { NIGHT_PIT_WINDOW_MINUTES, nightPitTime } from '../../src/domain/night-shelter.ts';
import { completedQuests, questTaskId } from '../../src/app/quest-commands.ts';
import { nextKnownStep } from '../../src/app/known-steps.ts';
import type { ShelterStep } from '../../src/domain/night-shelter.ts';
import type { ShelterStatus } from '../../src/goals/shelter.ts';
import { SCOUT_TASK_ID } from '../../src/app/scouting.ts';
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

  it('tries a refused click again once a session has run (the danger may be gone)', async () => {
    const book = [
      quest('1', [checkbox], [], COOKIE),
      quest('5', [have('minecraft:sand', 100)]), // a second root: something to do meanwhile
    ];
    const world: World = { inventory: {}, sessions: [], calls: 0, book, clicksFail: true };
    const base = deps(open(), world);
    await runPlay(
      {
        ...base,
        session: (limits, hooks) => {
          world.clicksFail = false; // the session dealt with it
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      noStop,
    );
    expect(world.clicks?.slice(0, 4)).toEqual([
      'CHECK_QUEST_BOX 1',
      'CHECK_QUEST_BOX 1',
      'CHECK_QUEST_BOX 1', // after the session: done
      'CLAIM_QUEST_REWARD 1',
    ]);
    expect(world.completed?.has('1')).toBe(true);
  });

  it("waits for the server's quest loop when a quest's tasks are all done", async () => {
    // The checkbox is ticked; the server's loop has not completed the quest yet.
    const world: World = { inventory: {}, sessions: [], calls: 0, taskDone: new Set(['1#0']) };
    let waits = 0;
    const result = await runPlay(
      {
        ...deps(open(), world),
        sleep: () => {
          waits += 1;
          sets(world).completed.add('1'); // the quest loop ran
          return Promise.resolve();
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      noStop,
    );
    expect(waits).toBe(1);
    expect(world.clicks).toEqual(['CLAIM_QUEST_REWARD 1']); // no submit, no second tick
    expect(result.questsCompleted).toEqual(['Q1']);

    // A loop that never completes it: play gives up after a few waits and says so.
    const stuck: World = { inventory: {}, sessions: [], calls: 0, taskDone: new Set(['1#0']) };
    let stuckWaits = 0;
    const r = await runPlay(
      {
        ...deps(open(), stuck),
        sleep: () => {
          stuckWaits += 1;
          return Promise.resolve();
        },
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(stuckWaits).toBe(5);
    expect(r.stopReason).toBe(
      'no quest the agent can do is left; the server has not completed "Q1" although its ' +
        'tasks are done',
    );
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

  it('at dusk digs the night pit as code-made known steps, then waits inside for the morning', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    let sheltered = false;
    let tick = 11_000; // 1.7 min before night: shelter time
    const pitSteps: ShelterStep[] = [
      {
        spec: { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
        text: 'dig down: the minecraft:grass under the feet at (0, 63, 0)',
      },
      {
        spec: {
          type: 'PLACE_BLOCK',
          args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' },
        },
        text: 'place minecraft:dirt at (0, 63, 0): the roof, against the ground beside it',
      },
    ];
    const status = (purpose?: 'night' | 'morning'): ShelterStatus => ({
      kind: 'pit',
      sheltered,
      steps: sheltered ? [] : pitSteps,
      needs: sheltered ? {} : { 'minecraft:dirt': 1 },
      problem: null,
      walled: purpose === 'morning' ? false : sheltered,
      exit: [],
    });
    const purposes: string[] = [];
    const events: PlayEvent[] = [];
    const base = deps(repos, world);
    const result = await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(tick, true)),
        shelter: (purpose) => {
          purposes.push(purpose ?? 'none');
          return Promise.resolve(status(purpose));
        },
        sleep: () => {
          tick = 100; // the night passes: morning
          return Promise.resolve();
        },
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'night-shelter') {
            // The planner's route, and the same steps as actions for code to run.
            expect(repos.memory.taskBlueprint('night-shelter')).toEqual([
              '1. dig down: the minecraft:grass under the feet at (0, 63, 0)',
              '2. place minecraft:dirt at (0, 63, 0): the roof, against the ground beside it',
            ]);
            expect(nextKnownStep(repos, 'night-shelter')).toMatchObject({
              spec: pitSteps[0]?.spec,
              index: 0,
              total: 2,
            });
            expect(limits.maxCycles).toBe(6);
            sheltered = true;
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e))[0]).toBe(
      'goal: "shelter for the night" - missing 1 minecraft:dirt',
    );
    const night = events.filter((e) => e.kind === 'night').map((e) => describePlayEvent(e));
    expect(night).toEqual([
      'night: sheltered: waiting for the morning (10.8 min)',
      'night: morning: leaving the shelter',
    ]);
    expect(purposes.slice(0, 3)).toEqual(['night', 'night', 'morning']);
    // The night's steps are cleared in the morning; the next goal's journal says what happened.
    expect(nextKnownStep(repos, 'night-shelter')).toBeNull();
    expect(repos.memory.journal('quest-2').at(-1)?.text).toMatch(
      /^morning: the player is at the bottom of its night pit/,
    );
    expect(result.night).toBeNull();
  });

  it('counts sessions that see new ground as progress (exploring for a block gathers none)', async () => {
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(open(), world);
    let chunks = 100; // scouting is done; each session sees 5 more chunks
    const result = await runPlay(
      {
        ...base,
        scouting: { chunksSeen: () => chunks },
        session: (limits, hooks) => {
          chunks += 5;
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxStuckSessions: 2, maxSessions: 4 },
      noStop,
    );
    expect(result.stopReason).toBe('reached the limit of 4 sessions');
  });

  it('sleeps until the next sunrise: from a day with night soon, through the evening and night', () => {
    // Seen live: two minutes before dusk with no shelter possible, play slept 15 s (the day's
    // minutesUntilDay is 0) and came back, again and again, until the evening.
    const soon = worldTime(10_800, true);
    expect(nightSoon(soon)).toBe(true);
    expect(soon.minutesUntilDay).toBe(0);
    expect(untilSunrise(soon)).toBe(11);
    expect(untilSunrise(worldTime(18_000, true))).toBe(5);
  });

  it("starts on the shelter inside DIG_DOWN's time window, so the pit is never refused for the hour", () => {
    expect(SHELTER_LEAD_MINUTES).toBeLessThanOrEqual(NIGHT_PIT_WINDOW_MINUTES);
    for (let tick = 0; tick < 24_000; tick += 50) {
      const t = worldTime(tick, true);
      if (nightSoon(t)) expect(nightPitTime(t), `tick ${tick}`).toBe(true);
    }
    // Dawn and the rest of the day are outside it.
    expect(nightPitTime(worldTime(23_500, true))).toBe(false);
    expect(nightPitTime(worldTime(6_000, true))).toBe(false);
  });

  it('leaves before the dark when a shelter step stops for a person (a refusal)', async () => {
    const repos = open();
    const world: World = {
      inventory: { 'minecraft:sand': 20, 'minecraft:cobblestone': 2 },
      sessions: [{ stopKind: 'needs-attention' }],
      calls: 0,
    };
    const clock = worldTime(11_000, true); // 1.7 min before night
    const result = await runPlay(
      {
        ...deps(repos, world),
        time: () => Promise.resolve(clock),
        shelter: () =>
          Promise.resolve({
            kind: 'box' as const,
            sheltered: false,
            steps: [
              {
                spec: {
                  type: 'PLACE_BLOCK' as const,
                  args: { position: { x: 1, y: 66, z: 0 }, item: 'minecraft:sand' as const },
                },
                text: 'place minecraft:sand: (1, 66, 0)',
              },
            ],
            needs: { 'minecraft:sand': 1 },
            problem: null,
            walled: true,
            exit: [],
          }),
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    // cli play then waits offline until sunrise instead of ending.
    expect(result.night).toEqual(clock);
    expect(result.stopReason).toMatch(/no shelter: stop: needs-attention/);
  });

  it('goes offline for the night when no shelter can be made (the night fallback)', async () => {
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const result = await runPlay(
      {
        ...deps(open(), world),
        time: () => Promise.resolve(worldTime(12_400, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'box',
            sheltered: false,
            steps: [],
            needs: {},
            problem: 'no pit (stone); no box (open ground)',
            walled: false,
            exit: [],
          }),
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.stopReason).toMatch(/no shelter: no pit \(stone\); no box \(open ground\)$/);
    expect(result.night).toMatchObject({ phase: 'evening' });
    expect(world.calls).toBe(0);
  });

  it('in the morning digs out of the shelter first (code-made steps), then plays on', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    let walled = true;
    const exit: ShelterStep[] = [
      {
        spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
        text: 'dig the minecraft:dirt at (0, 63, 0) (the roof)',
      },
      {
        spec: { type: 'MOVE_TO', args: { target: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
        text: 'walk out to (3, 64, 0)',
      },
    ];
    const base = deps(repos, world);
    const events: PlayEvent[] = [];
    await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(1_000, true)), // morning
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled,
            exit: walled ? exit : [],
          }),
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'leave-shelter') {
            expect(repos.memory.taskBlueprint('leave-shelter')).toEqual([
              '1. dig the minecraft:dirt at (0, 63, 0) (the roof)',
              '2. walk out to (3, 64, 0)',
            ]);
            expect(nextKnownStep(repos, 'leave-shelter')?.spec).toEqual(exit[0]?.spec);
            walled = false;
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e))).toEqual([
      'goal: "leave the shelter"',
      'goal: "Q2" - missing 100 minecraft:sand (new task)',
    ]);
    expect(repos.memory.journal('quest-2').at(-1)?.text).toBe(
      'morning: the player dug out of its night shelter to (3.5, 64, 0.5): walking and EXPLORE work again; failures from inside its walls no longer apply',
    );
  });

  it('stops and says so when walled in with no way out', async () => {
    const result = await runPlay(
      {
        ...deps(open(), { inventory: {}, sessions: [], calls: 0 }),
        time: () => Promise.resolve(worldTime(1_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: false,
            steps: [],
            needs: {},
            problem: 'step 1, upper block (1, 63, 0): minecraft:stone is not on the dig allowlist',
            walled: true,
            exit: [],
          }),
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.stopReason).toMatch(
      /^the player is walled in, and code found no way out: step 1, upper block/,
    );
  });

  it('scouts once first when it can explore and little is seen, then plays the quests', async () => {
    const repos = open();
    let chunks = 10;
    const world: World = {
      inventory: {},
      sessions: [
        {}, // scouting
        { gain: { 'minecraft:sand': 100 } },
        { gain: { 'minecraft:gravel': 50 } },
      ],
      calls: 0,
    };
    const base = deps(repos, world);
    const events: PlayEvent[] = [];
    const result = await runPlay(
      {
        ...base,
        scouting: { chunksSeen: () => chunks },
        session: (limits, hooks) => {
          if (world.calls === 0) {
            // The scouting session's task is scouting; play's quests come after it.
            expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBe(SCOUT_TASK_ID);
            chunks = 80;
          }
          return base.session(limits, hooks);
        },
      },
      DEFAULT_PLAY_LIMITS,
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events[0]).toEqual({
      kind: 'scout',
      taskId: SCOUT_TASK_ID,
      created: true,
      chunksSeen: 10,
    });
    expect(describePlayEvent(events[0] as PlayEvent)).toBe(
      'goal: scout the area before settling (10 chunk(s) seen so far) (new task)',
    );
    expect(result).toMatchObject({ sessions: 3, questsCompleted: ['Q1', 'Q2', 'Q3'] });
    expect(repos.tasks.get(SCOUT_TASK_ID)?.status).toBe('completed');
    // Once is enough: a completed scouting task is never redone.
    chunks = 10;
    const again = await runPlay(
      {
        // The same server (its quest records), a new play.
        ...deps(repos, { ...world, sessions: [], calls: 0 }),
        scouting: { chunksSeen: () => chunks },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      noStop,
    );
    expect(again.stopReason).toBe('no quest the agent can do is left');
  });

  it('does not scout when enough is seen, and stops if the scouting task needs a human', async () => {
    const seen = { inventory: {}, sessions: [], calls: 0 };
    const events: PlayEvent[] = [];
    await runPlay(
      { ...deps(open(), seen), scouting: { chunksSeen: () => 60 } },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events.some((e) => e.kind === 'scout')).toBe(false);

    const repos = open();
    repos.tasks.ensure({ id: SCOUT_TASK_ID, goal: 'scout', subgoal: null, status: 'paused' });
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const r = await runPlay(
      { ...deps(repos, world), scouting: { chunksSeen: () => 0 } },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(r.stopReason).toMatch(/^the scouting task scout-area is paused; it needs you/);
    expect(world.calls).toBe(0);
  });

  it('stops scouting when it gets dark, and goes on with it the next day', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const evening = (_l: unknown, hooks: Parameters<PlayDeps['session']>[1]) => {
      world.calls += 1;
      hooks.onCycle(
        {
          summary: 'REQUEST_PLANNER -> EXPLORE -> succeeded',
          outcome: { stateAfter: { time: { known: true, value: worldTime(12_400, true) } } },
        } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: 'c1', summary: 'x' }],
        stopReason: 'stop: it is evening',
        stopKind: 'stop-requested' as const,
        taskId: SCOUT_TASK_ID,
        taskStatus: 'active',
        elapsedMs: 1,
      });
    };
    const r = await runPlay(
      { ...deps(repos, world), scouting: { chunksSeen: () => 30 }, session: evening },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(r.night).toMatchObject({ phase: 'evening' });
    expect(repos.tasks.get(SCOUT_TASK_ID)?.status).toBe('active'); // resumed at sunrise
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

describe('a mob near home', () => {
  const pause = (codes: string[]): DecisionResult =>
    ({
      decision: 'PAUSE_AND_ASK_USER',
      confidence: 1,
      reasonCodes: codes,
      factsUsed: {},
      requiresHumanConfirmation: true,
      provider: 'deterministic-router',
    }) as DecisionResult;

  it('is waited out: the paused task is active again, and play says why', async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const result = await runPlay(
      {
        ...deps(repos, world),
        session: (_limits, hooks): Promise<SessionResult> => {
          const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
          hooks.onCycle(
            {
              summary: 'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused',
              decision: pause(['UNCLASSIFIED_ENTITY_NEARBY', 'ALREADY_AT_SAFE_LOCATION']),
            } as CycleResult,
            1,
          );
          if (taskId !== null) repos.tasks.setStatus(taskId, 'paused'); // as the agent loop does
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: 'x' }],
            stopReason: 'needs attention after: PAUSE_AND_ASK_USER',
            stopKind: 'needs-attention',
            taskId,
            taskStatus: 'paused',
            elapsedMs: 1,
          });
        },
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.mobNearby).toBe('UNCLASSIFIED_ENTITY_NEARBY, ALREADY_AT_SAFE_LOCATION');
    expect(result.stopReason).toMatch(/waiting offline for it to leave/);
    expect(repos.tasks.get(questTaskId('2'))?.status).toBe('active');
    expect(repos.memory.journal(questTaskId('2')).map((e) => e.text)).toContainEqual(
      expect.stringContaining('waited offline'),
    );
  });

  it('only a pause for a mob near, with at most the home codes besides, is waited out', () => {
    expect(
      mobPause('needs-attention', pause(['HOSTILES_NEARBY', 'ALREADY_AT_SAFE_LOCATION'])),
    ).toBe('HOSTILES_NEARBY, ALREADY_AT_SAFE_LOCATION');
    expect(
      mobPause(
        'needs-attention',
        pause(['HOSTILES_NEARBY', 'CREEPER_NEARBY', 'ALREADY_AT_SAFE_LOCATION']),
      ),
    ).toBe('HOSTILES_NEARBY, CREEPER_NEARBY, ALREADY_AT_SAFE_LOCATION');
    expect(mobPause('needs-attention', pause(['HUNGRY', 'NO_APPROVED_FOOD']))).toBeNull();
    expect(mobPause('needs-attention', pause(['HOSTILES_NEARBY', 'LOW_HEALTH']))).toBeNull();
    expect(mobPause('cycle-failed', pause(['HOSTILES_NEARBY']))).toBeNull();
    expect(
      mobPause('needs-attention', { ...pause(['HOSTILES_NEARBY']), decision: 'RETREAT_HOME' }),
    ).toBeNull();
    expect(mobPause('needs-attention', null)).toBeNull();
  });
});
