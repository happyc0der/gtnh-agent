import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 24, 2026-10-05: an urgent (starving) food trip does not look at commandWaiting, so an owner's stop
// cuts its session short only through the client's interrupt (data.interrupted). foodRound
// counts that session as one "that found no food": three stops ("stay here") end the trip.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('stops during a starving food trip', () => {
  it('do not count as food sessions that found nothing', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let sessions = 0;
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 4,
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
    // Each food session: the owner says "stay here" (a stop); the walk in progress is halted.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      sessions += 1;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      heard.push({ sender: OWNER, text: 'stop', via: 'whisper' });
      const summary = 'REQUEST_PLANNER -> MOVE_TO -> failed';
      hooks.onCycle(
        {
          summary,
          status: 'failed',
          decision: null,
          outcome: {
            status: 'failed',
            execution: {
              ok: false,
              message: 'halted: stopped by DankAxon',
              data: { interrupted: true },
            },
          },
        } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: `c${sessions}`, summary }],
        stopReason: `stopped after: ${summary}`,
        stopKind: 'cycle-failed',
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    const result = await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        food: {
          now: () => Promise.resolve({ hunger: 4, carried: 0, eatBelow: 14, starveBelow: 6 }),
          of: () => null,
        },
        session,
        sleep: () => Promise.resolve(),
        commands,
      },
      { ...LIMITS, maxSessions: 6 },
      { stopRequested: () => null },
    );
    expect(result.stopReason).not.toMatch(/found no food/);
  });
});
