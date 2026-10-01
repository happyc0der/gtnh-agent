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
import { SCOUT_TASK_ID } from '../../src/app/scouting.ts';
import { worldTime } from '../../src/domain/game-state.ts';
import { TASK, type Quest } from '../../src/goals/quest-goals.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repositories.ts';
import { systemClock } from '../../src/util/clock.ts';

const quest = (id: string, tasks: Quest['tasks'], prerequisites: string[] = []): Quest => ({
  id,
  name: `Q${id}`,
  description: '',
  prerequisites,
  prerequisiteLogic: 'AND',
  main: true,
  tasks,
  layout: { x: 0, y: Number(id) },
});
const have = (item: string, count: number) => ({
  type: TASK.retrieval,
  consume: false,
  items: [{ item, count, oreDict: null, anyDamage: false }],
});
// 1 (checkbox) -> 2 (100 sand) -> 3 (50 gravel)
const BOOK = [
  quest('1', [{ type: TASK.checkbox, consume: false, items: [] }]),
  quest('2', [have('minecraft:sand', 100)], ['1']),
  quest('3', [have('minecraft:gravel', 50)], ['2']),
];

interface World {
  inventory: Record<string, number>;
  /** What each session does to the inventory, and how it ends. */
  sessions: Array<{ gain?: Record<string, number>; stopKind?: SessionStopKind }>;
  calls: number;
}

function deps(repos: Repositories, world: World, clock = { t: 0 }): PlayDeps {
  return {
    repos,
    quests: BOOK,
    now: () => clock.t,
    inventory: () => Promise.resolve({ ...world.inventory }),
    session: (_limits, hooks): Promise<SessionResult> => {
      const plan = world.sessions[world.calls] ?? {};
      world.calls += 1;
      clock.t += 60_000;
      for (const [item, n] of Object.entries(plan.gain ?? {})) {
        world.inventory[item] = (world.inventory[item] ?? 0) + n;
      }
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
  it('works through the quests in order and stops when nothing doable is left', async () => {
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
    expect([...completedQuests(repos)]).toEqual(['1', '2', '3']);
    expect(repos.tasks.get(questTaskId('2'))?.status).toBe('completed');
    const goals = events.filter((e) => e.kind === 'goal').map((e) => describePlayEvent(e));
    expect(goals).toEqual([
      'goal: "Q2" - missing 100 minecraft:sand (new task)',
      'goal: "Q2" - missing 40 minecraft:sand',
      'goal: "Q3" - missing 50 minecraft:gravel (new task)',
    ]);
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
        ...deps(repos, { inventory: {}, sessions: [], calls: 0 }),
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
