import { describe, expect, it } from 'vitest';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 25, 2026-10-05: play.idle = null as a food trip starts. With --listen, a goal stuck (idle), then
// hungry with no food to be found: does anything run back to back, or re-run the stuck goal?
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 60,
  maxSessions: 1000,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('idle cleared by a food trip', () => {
  it('no tight loop; the stuck goal is not re-run', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const clock = { t: 1_000_000 };
    const start = clock.t;
    const byTask = new Map<string, number>();
    let sleeps = 0;
    let rounds = 0;
    const commands: CommandDeps = {
      take: () => [],
      waiting: () => false,
      reply: () => undefined,
      clearInterrupt: () => void (rounds += 1),
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 9,
        inventory: {},
        playerAt: () => null,
      }),
      step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
      owners: ['DankAxon'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const session: PlayDeps['session'] = () => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY) ?? 'none';
      byTask.set(taskId, (byTask.get(taskId) ?? 0) + 1);
      clock.t += 20_000;
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary: 'x' }],
        stopReason: 'reached the limit of 3 cycles',
        stopKind: 'limit',
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        goal: {
          taskId: 'goal-x',
          name: 'get 1 minecraft:diamond',
          requirements: { 'minecraft:diamond': 1 },
        },
        // Hungry (no food found) 3 minutes in, after the goal was given up.
        food: {
          now: () =>
            Promise.resolve(
              clock.t - start >= 3 * 60_000
                ? { hunger: 9, carried: 0, eatBelow: 14, starveBelow: 6 }
                : { hunger: 20, carried: 0, eatBelow: 14, starveBelow: 6 },
            ),
          of: () => null,
        },
        session,
        sleep: (ms) => {
          sleeps += 1;
          clock.t += ms;
          return Promise.resolve();
        },
        commands,
        listen: true,
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(byTask.get('goal-x')).toBe(3);
    expect(byTask.get('get-food')).toBe(3);
    // The idle wait still paused between looks: no rounds back to back.
    expect(sleeps).toBeGreaterThan(0);
  });
});
