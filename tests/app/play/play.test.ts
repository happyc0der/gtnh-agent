import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult, SessionStopKind } from '../../../src/app/loop/live-session.ts';
import {
  checkPlayLimits,
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayEvent,
} from '../../../src/app/play/play.ts';
import { describePlayEvent } from '../../../src/app/play/narration.ts';
import {
  EXIT_RETRY_MS,
  MOB_SHELTER_MAX_MS,
  MOB_SHELTER_POLL_MS,
  MORNING_UNKNOWN_LOOKS,
  nightSoon,
  untilSunrise,
  SHELTER_LEAD_MINUTES,
} from '../../../src/app/play/night.ts';
import { IDLE_POLL_MS } from '../../../src/app/play/commands.ts';
import { mobPause } from '../../../src/app/play/play-state.ts';
import type { DecisionResult } from '../../../src/domain/decisions.ts';
import { FOOD_TASK_ID } from '../../../src/domain/food.ts';
import { NIGHT_PIT_WINDOW_MINUTES, nightPitTime } from '../../../src/domain/night-shelter.ts';
import { completedQuests, questTaskId } from '../../../src/app/play/quest-progress.ts';
import { nextKnownStep } from '../../../src/app/loop/known-steps.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import type { ShelterStatus } from '../../../src/goals/shelter.ts';
import { SCOUT_TASK_ID } from '../../../src/app/play/scouting.ts';
import { worldTime, type GameState } from '../../../src/domain/game-state.ts';
import type { QuestBook } from '../../../src/domain/quest-book.ts';
import { TASK, type Quest, type QuestBookStep } from '../../../src/goals/quest-goals.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY, NIGHT_SHELTER_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { makeState } from '../../fixtures/index.ts';

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
/** A way out of the pit: the roof, then a walk out. */
const EXIT: ShelterStep[] = [
  {
    spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
    text: 'dig the minecraft:dirt at (0, 63, 0) (the roof)',
  },
  {
    spec: { type: 'MOVE_TO', args: { target: { x: 3.5, y: 64, z: 0.5 }, tolerance: 0.5 } },
    text: 'walk out to (3, 64, 0)',
  },
];
/** A session whose first step fails (a dig refused, a walk stopped): the task goes on. */
function failedSession(
  repos: Repositories,
  hooks: Parameters<PlayDeps['session']>[1],
): Promise<SessionResult> {
  const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
  hooks.onCycle(
    {
      summary: 'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> failed',
      decision: {
        decision: 'EXECUTE_KNOWN_SAFE_STEP',
        confidence: 0.8,
        reasonCodes: ['KNOWN_SAFE_STEP'],
        factsUsed: {},
        requiresHumanConfirmation: false,
        provider: 'deterministic-router',
      },
    } as unknown as CycleResult,
    1,
  );
  return Promise.resolve({
    cycles: [{ cycleId: 'c', summary: 'failed' }],
    stopReason: 'stopped after: EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> failed',
    stopKind: 'cycle-failed',
    taskId,
    taskStatus: 'active',
    elapsedMs: 1,
  });
}
/** The night was spent in a shelter (nightRound records it): the morning digs out of it. */
const nightSpent = (repos: Repositories): void =>
  repos.memory.setValue(NIGHT_SHELTER_KEY, '2026-10-05T04:00:00.000Z');

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

  it("ends a session on a cycle's fresh observation that shows the quest done", async () => {
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world);
    const seen: Array<string | null | undefined> = [];
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
            // Before System 1 decides: not yet, then the server's update shows it done.
            seen.push(hooks.stopOnState?.(state({ 'minecraft:sand': 99 })));
            seen.push(hooks.stopOnState?.(state({ 'minecraft:sand': 100 })));
            seen.push(hooks.stopRequested());
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      noStop,
    );
    expect(seen).toEqual([null, '"Q2" is satisfied', '"Q2" is satisfied']);
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
    // Dusk's look, the look that finds it sheltered, the wait's own look, then the morning's.
    expect(purposes.slice(0, 4)).toEqual(['night', 'night', 'night', 'morning']);
    // Out in the morning: tonight's shelter is done with.
    expect(repos.memory.getValue(NIGHT_SHELTER_KEY)).toBeNull();
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

  it('says a shelter misses only what the inventory lacks', async () => {
    // Seen in the live logs: "missing 1 minecraft:dirt" with 72 dirt carried.
    const world: World = {
      inventory: { 'minecraft:dirt': 9 },
      sessions: [{ stopKind: 'needs-attention' }],
      calls: 0,
    };
    const events: PlayEvent[] = [];
    await runPlay(
      {
        ...deps(open(), world),
        time: () => Promise.resolve(worldTime(11_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: false,
            steps: [
              {
                spec: {
                  type: 'PLACE_BLOCK' as const,
                  args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' as const },
                },
                text: 'place minecraft:dirt at (0, 63, 0): the roof',
              },
            ],
            needs: { 'minecraft:dirt': 1 },
            problem: null,
            walled: false,
            exit: [],
          }),
      },
      DEFAULT_PLAY_LIMITS,
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e))).toEqual([
      'goal: "shelter for the night"',
    ]);
  });

  it('never asks the planner for a shelter: open, with no step from code, it goes offline', async () => {
    // Seen live 2026-10-04: a pit with its roof back but a wall open had no step left, and the
    // session's planner dug the pit's walls.
    const world: World = { inventory: { 'minecraft:dirt': 9 }, sessions: [], calls: 0 };
    const result = await runPlay(
      {
        ...deps(open(), world),
        time: () => Promise.resolve(worldTime(12_400, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled: false,
            exit: [],
          }),
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.stopReason).toMatch(
      /no shelter: it is open, and code has no step that closes it$/,
    );
    expect(result.night).toMatchObject({ phase: 'evening' });
    expect(world.calls).toBe(0);
  });

  it('in the morning digs out of the shelter first (code-made steps), then plays on', async () => {
    const repos = open();
    nightSpent(repos);
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
            // Its last step verified, the way out's task is complete (known-steps.ts).
            repos.tasks.setStatus('leave-shelter', 'completed');
            return base
              .session(limits, hooks)
              .then((r) => ({ ...r, taskStatus: 'completed' as const }));
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
    expect(repos.memory.getValue(NIGHT_SHELTER_KEY)).toBeNull();
  });

  it('a goal session paused for a mob in the cycle that sees dusk waits the mob out first', async () => {
    // An independent review, 2026-10-04: dusk was checked first, so the task the pause had left
    // paused stayed paused, and the next play stopped for a person.
    const repos = open();
    const goal = {
      taskId: 'goal-dirt',
      name: 'get 10 minecraft:dirt',
      requirements: { 'minecraft:dirt': 10 },
    };
    const result = await runPlay(
      {
        repos,
        now: () => 0,
        goal,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(1_000, true)), // day as each round starts
        sleep: () => Promise.resolve(),
        session: (_limits, hooks): Promise<SessionResult> => {
          const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
          if (taskId !== null) repos.tasks.setStatus(taskId, 'paused'); // as a pause leaves it
          hooks.onCycle(
            {
              summary: 'PAUSE_AND_ASK_USER -> paused',
              status: 'paused',
              decision: {
                decision: 'PAUSE_AND_ASK_USER',
                confidence: 0.95,
                reasonCodes: ['HOSTILES_NEARBY', 'UNDER_ATTACK'],
                factsUsed: {},
                requiresHumanConfirmation: true,
                provider: 'deterministic-router',
              },
              // The pause's own observation: the evening has just begun.
              outcome: {
                stateAfter: {
                  time: { known: true, value: worldTime(12_100, true) },
                  inventory: { known: false },
                },
              },
            } as unknown as CycleResult,
            1,
          );
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: 'paused' }],
            stopReason: 'needs attention after: PAUSE_AND_ASK_USER',
            stopKind: 'needs-attention',
            taskId,
            taskStatus: 'paused',
            elapsedMs: 1,
          });
        },
      },
      { ...DEFAULT_PLAY_LIMITS, session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 } },
      noStop,
    );
    expect(result.mobNearby).toBe('HOSTILES_NEARBY, UNDER_ATTACK');
    expect(repos.tasks.get('goal-dirt')?.status).toBe('active');
  });

  it('in the morning, a mob pause while digging out waits offline (UNDER_ATTACK)', async () => {
    // Hurt with a mob near, half dug out: offline at once, as any session's mob pause is.
    const repos = open();
    nightSpent(repos);
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world);
    const exit: ShelterStep[] = [
      {
        spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
        text: 'dig the minecraft:dirt at (0, 63, 0) (the roof)',
      },
    ];
    const result = await runPlay(
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
            walled: true,
            exit,
          }),
        session: (_limits, hooks) => {
          const pause = {
            summary: 'PAUSE_AND_ASK_USER -> paused',
            decision: {
              decision: 'PAUSE_AND_ASK_USER',
              reasonCodes: ['HOSTILES_NEARBY', 'UNDER_ATTACK'],
            },
          };
          hooks.onCycle(pause as unknown as CycleResult, 1);
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: pause.summary }],
            stopReason: 'paused',
            stopKind: 'needs-attention',
            taskId: repos.memory.getValue(CURRENT_TASK_KEY),
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      noStop,
    );
    expect(result.mobNearby).toBe('HOSTILES_NEARBY, UNDER_ATTACK');
  });

  it('in the morning waits sealed in its shelter while hostiles are near, then digs out', async () => {
    const repos = open();
    nightSpent(repos);
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    let walled = true;
    let looks = 0;
    const exit: ShelterStep[] = [
      {
        spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
        text: 'dig the minecraft:dirt at (0, 63, 0) (the roof)',
      },
    ];
    const base = deps(repos, world);
    const events: PlayEvent[] = [];
    const sleeps: number[] = [];
    await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(1_000, true)), // morning
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        shelter: () => {
          looks += 1;
          return Promise.resolve({
            kind: 'pit',
            sheltered: walled,
            steps: [],
            needs: {},
            problem: null,
            walled,
            exit: walled ? exit : [],
            // A zombie about the pit for the first three looks; then it has burnt.
            hostiles: looks <= 3 ? '1 hostile(s), nearest at 4.0 blocks' : null,
          });
        },
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'leave-shelter') walled = false;
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    // No session (nothing System 1 would refuse, no exit try spent) while it waits: one look
    // every MOB_SHELTER_POLL_MS, then the way out, then the day's goal.
    expect(sleeps).toEqual([MOB_SHELTER_POLL_MS, MOB_SHELTER_POLL_MS, MOB_SHELTER_POLL_MS]);
    expect(
      events
        .filter((e) => e.kind === 'night' || e.kind === 'goal')
        .map((e) => describePlayEvent(e)),
    ).toEqual([
      'night: morning: hostiles near the shelter (1 hostile(s), nearest at 4.0 blocks): waiting inside for them to go',
      'night: morning: no hostile near any more: leaving the shelter',
      'goal: "leave the shelter"',
      'goal: "Q2" - missing 100 minecraft:sand (new task)',
    ]);
  });

  it('waits offline once hostiles have stayed near the sealed shelter for MOB_SHELTER_MAX_MS', async () => {
    // A mob in a cave beside the pit, or a creeper, may stay all day (seen live 2026-10-04).
    const repos = open();
    nightSpent(repos);
    const clock = { t: 0 };
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world, clock);
    const result = await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(1_000, true)), // morning
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: true,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: [],
            hostiles:
              '1 hostile(s), nearest at 4.0 blocks: minecraft:Zombie 4 blocks away, 3 below',
          }),
      },
      DEFAULT_PLAY_LIMITS,
      noStop,
    );
    expect(result.mobNearby).toBe(
      '1 hostile(s), nearest at 4.0 blocks: minecraft:Zombie 4 blocks away, 3 below',
    );
    expect(result.stopReason).toMatch(
      /^hostiles stayed near the sealed shelter for 5 min .*: waiting offline for them to leave$/,
    );
    expect(clock.t).toBeGreaterThanOrEqual(MOB_SHELTER_MAX_MS);
    expect(world.calls).toBe(0); // no session: nothing System 1 would refuse ran
  });

  it('stops and says so when walled in with no way out', async () => {
    const repos = open();
    nightSpent(repos);
    const result = await runPlay(
      {
        ...deps(repos, { inventory: {}, sessions: [], calls: 0 }),
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

  it('each night gives the next morning all its tries to dig out again', async () => {
    // An independent review, 2026-10-05: three exit sessions that failed one morning left none
    // for any morning after, for the whole run (with --listen, play idles in the pit).
    const repos = open();
    nightSpent(repos);
    let phase: 'day1' | 'night' | 'day2' = 'day1';
    const exits = { day1: 0, night: 0, day2: 0 };
    let polls = 0;
    const status = (purpose: 'night' | 'morning'): ShelterStatus =>
      purpose === 'night'
        ? {
            kind: 'pit',
            sheltered: true,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: [],
          }
        : {
            kind: 'pit',
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: EXIT,
          };
    const result = await runPlay(
      {
        repos,
        now: () => 0, // EXIT_RETRY_MS never passes: only the night gives tries back
        listen: true,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(phase === 'night' ? 15_000 : 1_000, true)),
        shelter: (purpose = 'night') => Promise.resolve(status(purpose)),
        session: (_limits, hooks) => {
          const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
          if (taskId === 'leave-shelter') exits[phase] += 1;
          return failedSession(repos, hooks);
        },
        // Idle in the pit after day 1's tries (IDLE_POLL_MS polls): the night comes. Waiting for
        // the morning in the pit (5 s polls): the morning comes.
        sleep: (ms) => {
          polls += 1;
          if (phase === 'day1' && exits.day1 >= 3 && ms === IDLE_POLL_MS) phase = 'night';
          else if (phase === 'night' && ms === 5_000) phase = 'day2';
          return Promise.resolve();
        },
      },
      DEFAULT_PLAY_LIMITS,
      // (A bound, so that a morning with no try left fails the test instead of idling forever.)
      { stopRequested: () => (exits.day2 >= 1 ? 'test over' : polls > 200 ? 'no try' : null) },
    );
    expect(exits).toEqual({ day1: 3, night: 0, day2: 1 });
    expect(result.stopReason).toBe('test over');
  });

  it('a way out given up is tried again EXIT_RETRY_MS later the same day', async () => {
    const repos = open();
    nightSpent(repos);
    const clock = { t: 0 };
    let exits = 0;
    const result = await runPlay(
      {
        repos,
        now: () => clock.t,
        listen: true,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(1_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit' as const,
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: EXIT,
          }),
        session: (_limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'leave-shelter') exits += 1;
          clock.t += 1_000;
          return failedSession(repos, hooks);
        },
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
      },
      DEFAULT_PLAY_LIMITS,
      {
        stopRequested: () =>
          exits >= 4 ? 'test over' : clock.t > 3 * EXIT_RETRY_MS ? 'no try again' : null,
      },
    );
    expect(result.stopReason).toBe('test over');
    expect(exits).toBe(4); // three, then one more once EXIT_RETRY_MS had passed
    expect(clock.t).toBeGreaterThanOrEqual(EXIT_RETRY_MS);
  });

  it('one morning look that cannot tell gives no tries back before EXIT_RETRY_MS', async () => {
    // An independent review, 2026-10-05: a look with the inventory or a chunk unknown reset
    // the tries, and three more ran at once.
    const repos = open();
    nightSpent(repos);
    const clock = { t: 0 };
    let exits = 0;
    let unknown = false;
    await runPlay(
      {
        repos,
        now: () => clock.t,
        listen: true,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(1_000, true)),
        shelter: () => {
          if (exits === 3 && !unknown) {
            unknown = true;
            return Promise.resolve(null);
          }
          return Promise.resolve({
            kind: 'pit' as const,
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: EXIT,
          });
        },
        session: (_limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'leave-shelter') exits += 1;
          clock.t += 1_000;
          return failedSession(repos, hooks);
        },
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => (clock.t > EXIT_RETRY_MS / 2 || exits >= 6 ? 'test over' : null) },
    );
    expect(unknown).toBe(true);
    expect(exits).toBe(3);
  });

  it('a morning look that cannot tell looks again a moment later: no session from inside the pit', async () => {
    // An independent review, 2026-10-05: play went on to the command and goal rounds at once,
    // whose sessions then ran from inside the pit.
    const run = async (unknownLooks: number): Promise<string[]> => {
      const repos = open();
      nightSpent(repos);
      const seen: string[] = [];
      let looks = 0;
      await runPlay(
        {
          repos,
          now: () => 0,
          inventory: () => Promise.resolve({}),
          time: () => Promise.resolve(worldTime(1_000, true)),
          shelter: () => {
            looks += 1;
            return Promise.resolve(
              looks <= unknownLooks
                ? null
                : {
                    kind: 'pit' as const,
                    sheltered: false,
                    steps: [],
                    needs: {},
                    problem: null,
                    walled: true,
                    exit: EXIT,
                  },
            );
          },
          session: (_limits, hooks) => {
            seen.push(`session ${String(repos.memory.getValue(CURRENT_TASK_KEY))}`);
            return failedSession(repos, hooks);
          },
          sleep: (ms) => {
            seen.push(`sleep ${ms}`);
            return Promise.resolve();
          },
        },
        DEFAULT_PLAY_LIMITS,
        { stopRequested: () => (seen.some((s) => s.startsWith('session')) ? 'test over' : null) },
      );
      return seen;
    };
    const poll = `sleep ${MOB_SHELTER_POLL_MS}`;
    expect(await run(2)).toEqual([poll, poll, 'session leave-shelter']);
    // Not known for MORNING_UNKNOWN_LOOKS looks in a row: play goes on to the other rounds
    // (here: with no quest and no --listen, play ends), never polling for good.
    expect(await run(1_000)).toEqual(Array(MORNING_UNKNOWN_LOOKS).fill(poll));
  });

  it('out of the shelter, a way out that stopped short is closed: no "working on" it all day', async () => {
    // Seen live 2026-10-05: a dig of the way out was refused (a drop's walk had broken that
    // block already), the bot was out all the same, and !status said "working on: Morning: dig
    // your way out of the night shelter" while it idled.
    const repos = open();
    nightSpent(repos);
    let walled = true;
    let polls = 0;
    await runPlay(
      {
        repos,
        now: () => 0,
        listen: true,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(1_000, true)),
        sleep: () => {
          polls += 1;
          return Promise.resolve();
        },
        shelter: () =>
          Promise.resolve({
            kind: 'pit' as const,
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled,
            exit: walled ? EXIT : [],
          }),
        session: (): Promise<SessionResult> => {
          walled = false; // out after all, the session stopped for a person
          return Promise.resolve({
            cycles: [{ cycleId: 'c1', summary: 'DIG_BLOCK -> rejected [NOT_DIGGABLE]' }],
            stopReason: 'needs attention after: DIG_BLOCK -> rejected [NOT_DIGGABLE]',
            stopKind: 'needs-attention',
            taskId: repos.memory.getValue(CURRENT_TASK_KEY),
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => (polls >= 20 ? 'test over' : null) },
    );
    expect(repos.tasks.get('leave-shelter')?.status).toBe('completed');
    expect(repos.memory.getValue(NIGHT_SHELTER_KEY)).toBeNull();
  });

  it('by day, a night task a night spent offline left active is over', async () => {
    // An independent review, 2026-10-05: after a dusk that ended offline, the night task stayed
    // active with stale steps, and !status said "working on: Night is coming..." all day.
    const repos = open();
    repos.tasks.ensure({
      id: 'night-shelter',
      goal: 'Night is coming',
      subgoal: null,
      status: 'active',
    });
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    await runPlay(
      { ...deps(repos, world), time: () => Promise.resolve(worldTime(6_000, true)) },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      noStop,
    );
    expect(repos.tasks.get('night-shelter')?.status).toBe('completed');
  });

  it('a shaft a walk dug by day is no shelter to leave: no way out without a night in it', async () => {
    // An independent review, 2026-10-05: at the bottom of a !goto's shaft at noon, play ran
    // "leave the shelter", undoing the command.
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const purposes: string[] = [];
    const events: PlayEvent[] = [];
    await runPlay(
      {
        ...deps(repos, world),
        time: () => Promise.resolve(worldTime(6_000, true)), // noon
        shelter: (purpose) => {
          purposes.push(purpose ?? 'night');
          return Promise.resolve({
            kind: 'box',
            sheltered: false,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: EXIT,
          });
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(purposes).toEqual([]);
    expect(events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e))).toEqual([
      'goal: "Q2" - missing 100 minecraft:sand (new task)',
    ]);
  });

  it('the night wait looks at the shelter again: a roof that went is put back', async () => {
    // An independent review, 2026-10-05: the wait never looked again, so a roof an Enderman
    // took or a wall a blast opened went unseen until the morning.
    const repos = open();
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world);
    let tick = 15_000; // night
    let roofed = true;
    let sleeps = 0;
    const roof: ShelterStep = {
      spec: {
        type: 'PLACE_BLOCK',
        args: { position: { x: 0, y: 63, z: 0 }, item: 'minecraft:dirt' },
      },
      text: 'place minecraft:dirt at (0, 63, 0): the roof, against the ground beside it',
    };
    const events: PlayEvent[] = [];
    const tasks: string[] = [];
    await runPlay(
      {
        ...base,
        time: () => Promise.resolve(worldTime(tick, true)),
        shelter: (purpose) =>
          Promise.resolve(
            purpose === 'morning'
              ? {
                  kind: 'pit',
                  sheltered: false,
                  steps: [],
                  needs: {},
                  problem: null,
                  walled: false,
                  exit: [],
                }
              : {
                  kind: 'pit',
                  sheltered: roofed,
                  steps: roofed ? [] : [roof],
                  needs: roofed ? {} : { 'minecraft:dirt': 1 },
                  problem: null,
                  walled: true,
                  exit: [],
                },
          ),
        sleep: () => {
          sleeps += 1;
          if (sleeps === 1) roofed = false; // an Enderman took the roof
          if (sleeps === 3) tick = 1_000; // the morning
          return Promise.resolve();
        },
        session: (limits, hooks) => {
          const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
          tasks.push(taskId ?? 'none');
          if (taskId === 'night-shelter') roofed = true;
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(events.filter((e) => e.kind === 'night').map((e) => describePlayEvent(e))).toEqual([
      'night: sheltered: waiting for the morning (7.5 min)',
      'night: the shelter no longer shelters: its walls or roof are open',
      'night: sheltered: waiting for the morning (7.5 min)',
      'night: morning: leaving the shelter',
    ]);
    expect(tasks[0]).toBe('night-shelter');
  });

  it('a pit cut short by a time jump (day came meanwhile) goes on to the morning, not offline', async () => {
    // An independent review, 2026-10-05: someone slept; DIG_DOWN, refused by day, stopped the
    // pit for a person, and play went offline for 11 minutes in daylight with the dusk's clock.
    const repos = open();
    let tick = 11_500; // shelter time
    let walled = true;
    const pitStep: ShelterStep = {
      spec: { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig down: the minecraft:grass under the feet at (0, 63, 0)',
    };
    const tasks: string[] = [];
    const result = await runPlay(
      {
        repos,
        now: () => 0,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(tick, true)),
        sleep: () => Promise.resolve(),
        shelter: (purpose) =>
          Promise.resolve(
            purpose === 'morning'
              ? {
                  kind: 'pit',
                  sheltered: false,
                  steps: [],
                  needs: {},
                  problem: null,
                  walled,
                  exit: walled ? EXIT : [],
                }
              : {
                  kind: 'pit',
                  sheltered: false,
                  steps: [pitStep],
                  needs: {},
                  problem: null,
                  walled: false,
                  exit: [],
                },
          ),
        session: (_limits, hooks): Promise<SessionResult> => {
          const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
          tasks.push(taskId ?? 'none');
          if (taskId === 'night-shelter') {
            tick = 1_000; // a time jump: the morning
            return Promise.resolve({
              cycles: [{ cycleId: 'c1', summary: 'DIG_DOWN -> rejected [NIGHT_PIT_ONLY]' }],
              stopReason: 'needs attention after: DIG_DOWN -> rejected [NIGHT_PIT_ONLY]',
              stopKind: 'needs-attention',
              taskId,
              taskStatus: 'paused',
              elapsedMs: 1,
            });
          }
          if (taskId === 'leave-shelter') walled = false;
          return failedSession(repos, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 3 },
      noStop,
    );
    expect(result.night).toBeNull();
    expect(tasks.slice(0, 2)).toEqual(['night-shelter', 'leave-shelter']);
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
    expect(mobPause('needs-attention', null)).toBeNull();
    // An answer to a mob that failed (a retreat with no way home, or refused as a repeated
    // failure; a fight back): waited out offline too (seen live 2026-10-04: the bot stayed
    // where its retreats failed and was killed).
    const retreat = { ...pause(['HOSTILES_NEARBY']), decision: 'RETREAT_HOME' as const };
    expect(mobPause('needs-attention', retreat)).toBe('HOSTILES_NEARBY');
    expect(mobPause('cycle-failed', retreat)).toBe('HOSTILES_NEARBY');
    expect(
      mobPause('cycle-failed', { ...pause(['UNCLASSIFIED_ENTITY_NEARBY']), decision: 'DEFEND' }),
    ).toBe('UNCLASSIFIED_ENTITY_NEARBY');
    // Not one that went, nor a retreat for something else.
    expect(mobPause('non-task-decision', retreat)).toBeNull();
    expect(
      mobPause('cycle-failed', { ...pause(['LOW_HEALTH']), decision: 'RETREAT_HOME' }),
    ).toBeNull();
  });
});

describe('food trips', () => {
  /** Approved foods the test counts as carried, one hunger point each. */
  const FOODS = ['harvestcraft:strawberryItem', 'minecraft:carrot'];
  const carriedIn = (items: Readonly<Record<string, number>>): number =>
    FOODS.reduce((n, f) => n + (items[f] ?? 0), 0);
  /** The food dependency over the test world: its food level, and the foods it holds. */
  const foodDeps = (world: World, hunger: { level: number }): NonNullable<PlayDeps['food']> => ({
    now: () =>
      Promise.resolve({
        hunger: hunger.level,
        carried: carriedIn(world.inventory),
        eatBelow: 14,
        starveBelow: 6,
      }),
    of: (state) =>
      state.player.hunger.known && state.inventory.known
        ? {
            hunger: state.player.hunger.value,
            carried: carriedIn(state.inventory.value.items),
            eatBelow: 14,
            starveBelow: 6,
          }
        : null,
  });
  /** An observation with food level `level` and the world's inventory. */
  const observed = (world: World, level: number): GameState => ({
    ...makeState((w) => void (w.player.hunger = level)),
    inventory: inventoryOf(world),
  });
  const cycle = (after: GameState): CycleResult =>
    ({ summary: 'x', outcome: { stateAfter: after } }) as unknown as CycleResult;

  it('hungry with nothing to eat, by day: gets about a day of food first, then the quest goes on', async () => {
    const repos = open();
    const world: World = {
      inventory: {},
      sessions: [
        { gain: { 'harvestcraft:strawberryItem': 6, 'minecraft:carrot': 4 } },
        { gain: { 'minecraft:sand': 100 } },
        { gain: { 'minecraft:gravel': 50 } },
      ],
      calls: 0,
    };
    const tasks: Array<string | null> = [];
    const base = deps(repos, world);
    const events: PlayEvent[] = [];
    const result = await runPlay(
      {
        ...base,
        food: foodDeps(world, { level: 9 }),
        session: (limits, hooks) => {
          tasks.push(repos.memory.getValue(CURRENT_TASK_KEY));
          return base.session(limits, hooks);
        },
      },
      DEFAULT_PLAY_LIMITS,
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(tasks).toEqual([FOOD_TASK_ID, questTaskId('2'), questTaskId('3')]);
    expect(result.questsCompleted).toEqual(['Q1', 'Q2', 'Q3']);
    expect(repos.tasks.get(FOOD_TASK_ID)?.status).toBe('completed');
    expect(repos.memory.journal(FOOD_TASK_ID).at(-1)?.text).toBe(
      'food trip over: 10 hunger points of food carried',
    );
    expect(
      events
        .filter((e) => e.kind === 'food' || (e.kind === 'goal' && e.taskId === FOOD_TASK_ID))
        .map((e) => describePlayEvent(e)),
    ).toEqual([
      'food: food 9/20 and nothing to eat: getting food first',
      'goal: "food: 0/10 hunger points carried" (new task)',
      'food: trip over: 10 hunger points of food carried',
    ]);
  });

  it('a quest session ends as soon as an observation shows the agent hungry with nothing to eat', async () => {
    const repos = open();
    const hunger = { level: 18 };
    const world: World = {
      inventory: {},
      sessions: [{ stopKind: 'stop-requested' }, { gain: { 'harvestcraft:strawberryItem': 10 } }],
      calls: 0,
    };
    const base = deps(repos, world);
    const seen: Array<string | null> = [];
    await runPlay(
      {
        ...base,
        food: foodDeps(world, hunger),
        session: (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === questTaskId('2')) {
            hooks.onCycle(cycle(observed(world, 18)), 1);
            seen.push(hooks.stopRequested());
            hunger.level = 9; // the food bar went down while working
            hooks.onCycle(cycle(observed(world, 9)), 2);
            seen.push(hooks.stopRequested());
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 2 },
      noStop,
    );
    expect(seen).toEqual([null, 'hungry (food 9/20) with nothing to eat: getting food first']);
    // The next round went for food.
    expect(repos.tasks.get(FOOD_TASK_ID)?.status).toBe('active');
    expect(world.calls).toBe(2);
  });

  it('hungry at the start: food before scouting (a food trip explores for food itself)', async () => {
    const repos = open();
    const world: World = {
      inventory: {},
      sessions: [{ gain: { 'harvestcraft:strawberryItem': 10 } }],
      calls: 0,
    };
    const tasks: Array<string | null> = [];
    const base = deps(repos, world);
    const events: PlayEvent[] = [];
    await runPlay(
      {
        ...base,
        scouting: { chunksSeen: () => 10 },
        food: foodDeps(world, { level: 2 }),
        session: (limits, hooks) => {
          tasks.push(repos.memory.getValue(CURRENT_TASK_KEY));
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxSessions: 1 },
      { ...noStop, onEvent: (e) => events.push(e) },
    );
    expect(tasks).toEqual([FOOD_TASK_ID]);
    expect(events.filter((e) => e.kind === 'scout')).toEqual([]);
    expect(describePlayEvent(events.find((e) => e.kind === 'food') as PlayEvent)).toBe(
      'food: food 2/20 and nothing to eat: food before scouting',
    );
  });

  it('counts a fuller food bar as progress (what it gathers it eats), and gives up after sessions with none', async () => {
    const repos = open();
    const hunger = { level: 9 };
    const world: World = { inventory: {}, sessions: [], calls: 0 };
    const base = deps(repos, world);
    const result = await runPlay(
      {
        ...base,
        food: foodDeps(world, hunger),
        session: (limits, hooks) => {
          // The first session: three foods gathered and eaten at once (food 9 -> 12).
          if (world.calls === 0) {
            hunger.level = 12;
            hooks.onCycle(cycle(observed(world, 12)), 1);
          }
          return base.session(limits, hooks);
        },
      },
      { ...DEFAULT_PLAY_LIMITS, maxStuckSessions: 2 },
      noStop,
    );
    expect(world.calls).toBe(3);
    expect(result.stopReason).toBe(
      'hungry (food 12/20) with nothing to eat, and 2 food sessions in a row found no food and ' +
        'no new ground (last: stop: limit)',
    );
  });
});
