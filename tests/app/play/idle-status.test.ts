import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayLimits } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: with --listen, play that has nothing left it can do (its
// goal stuck) waits for commands; !status read the current task, still active, and said
// "working on: ..." the goal it had given up on.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 10,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('!status while play is idle', () => {
  it('says it is idle, and why, not "working on" a goal it has given up on', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    let sessions = 0;
    let sleeps = 0;
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
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
    const result = await runPlay(
      {
        repos,
        now: () => clock.t,
        goal: {
          taskId: 'goal-dirt',
          name: 'get 10 minecraft:dirt',
          requirements: { 'minecraft:dirt': 10 },
        },
        inventory: () => Promise.resolve({}),
        // Sessions that get nothing (the planner finds no dirt): no progress.
        session: (limits, hooks) => {
          sessions += 1;
          const cycles: SessionResult['cycles'] = [];
          for (let i = 0; i < limits.maxCycles; i++) {
            clock.t += 1_000;
            cycles.push({ cycleId: `c${i}`, summary: 'REQUEST_PLANNER -> MOVE_TO -> succeeded' });
            hooks.onCycle(
              {
                summary: 'x',
                status: 'succeeded',
                decision: null,
                outcome: null,
              } as unknown as CycleResult,
              i + 1,
            );
          }
          return Promise.resolve({
            cycles,
            stopReason: 'reached the limit of 3 cycles',
            stopKind: 'limit',
            taskId: repos.memory.getValue(CURRENT_TASK_KEY),
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
        sleep: (ms) => {
          clock.t += ms;
          sleeps += 1;
          // Five minutes on (two IDLE_RETRY_MS looks later), the owner asks.
          if (clock.t > 5 * 60_000 && heard.length === 0 && replies.length === 0) {
            heard.push(whisper('!status'));
          }
          return Promise.resolve();
        },
        commands,
        listen: true,
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(result.stopReason).toBe('reached the limit of 10 minutes');
    // Three sessions, then never again: every later look ends at once on "no progress".
    expect(sessions).toBe(3);
    expect(sleeps).toBeGreaterThan(10);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(
      /^at 0 64 0, health 20\/20, food 20\/20; idle \(no progress on "get 10 minecraft:dirt"/,
    );
  });
});
