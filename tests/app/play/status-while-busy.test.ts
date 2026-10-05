import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import { worldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: with --listen and nothing of its own to do (play.idle set),
// a !status said "idle (...)" while the bot dug its night pit or made a food trip. The night's,
// the morning's and a food trip's tasks come first now.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('!status while it digs its night pit, idle by day', () => {
  it('does not say "idle (...)"', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    let pitDone = false;
    let stop: string | null = null;
    const dig: ShelterStep = {
      spec: {
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 61, z: 0 }, item: 'minecraft:dirt' },
      },
      text: 'dig down',
    };
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => {
        replies.push(text);
        stop = 'test over';
      },
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => null,
      }),
      step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
      owners: [OWNER],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const session: PlayDeps['session'] = (_limits, hooks) => {
      clock.t += 1_000;
      // The owner asks while it digs.
      heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      if (taskId !== null) {
        setKnownSteps(repos, taskId, null);
        repos.tasks.setStatus(taskId, 'completed');
      }
      pitDone = true;
      const summary = 'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded';
      hooks.onCycle(
        { summary, status: 'succeeded', decision: null, outcome: null } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary }],
        stopReason: 'the task is completed',
        stopKind: 'task-finished',
        taskId,
        taskStatus: 'completed',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        // Day for 30 s (no quest book: idle with --listen), then dusk.
        time: () => Promise.resolve(worldTime(clock.t < 30_000 ? 1_000 : 12_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: pitDone,
            steps: pitDone ? [] : [dig],
            needs: {},
            problem: null,
            walled: pitDone,
            exit: [],
          }),
        session,
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
        commands,
        listen: true,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    expect(replies[0]).toMatch(/^at 0 64 0/);
    expect(replies[0]).not.toMatch(/idle \(/);
  });

  it('nor on a food trip (a path the parent answered "working on: Get food...")', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    let stop: string | null = null;
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => {
        replies.push(text);
        stop = 'test over';
      },
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 10,
        inventory: {},
        playerAt: () => null,
      }),
      step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
      owners: [OWNER],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const hungry = () => clock.t >= 10_000;
    const session: PlayDeps['session'] = (limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      const cycles: SessionResult['cycles'] = [];
      for (;;) {
        clock.t += 1_000;
        if (cycles.length >= limits.maxCycles) {
          return Promise.resolve({
            cycles,
            stopReason: 'limit',
            stopKind: 'limit',
            taskId,
            taskStatus: 'active',
            elapsedMs: 1,
          } satisfies SessionResult);
        }
        const s = hooks.stopRequested();
        if (s !== null) {
          return Promise.resolve({
            cycles,
            stopReason: s,
            stopKind: 'stop-requested',
            taskId,
            taskStatus: 'active',
            elapsedMs: 1,
          } satisfies SessionResult);
        }
        cycles.push({ cycleId: `c${cycles.length}`, summary: 'x' });
        hooks.onCycle(
          {
            summary: 'x',
            status: 'succeeded',
            decision: null,
            outcome: null,
          } as unknown as CycleResult,
          cycles.length,
        );
        if (cycles.length === 1) heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
      }
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        food: {
          now: () =>
            Promise.resolve({
              hunger: hungry() ? 10 : 20,
              carried: 0,
              eatBelow: 14,
              starveBelow: 6,
            }),
          of: () => null,
        },
        session,
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
        commands,
        listen: true,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    expect(replies[0]).not.toMatch(/idle \(/);
  });
});
