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
import { worldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY, OWNER_PAUSED_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 25, 2026-10-05: statusText now puts an active get-food task before `off`, guarded
// only by play.idle === null, not by whether the trip actually runs. A food trip that is NOT
// urgent (hungry, not starving) stops when an owner pauses play (foodRound needs starving or
// autonomy on), yet !status says "working on: Get food ..." instead of "paused: ...".
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

function commandDeps(heard: HeardCommand[], replies: string[]): CommandDeps {
  return {
    take: () => heard.splice(0),
    waiting: () => heard.length > 0,
    reply: (_to, text) => void replies.push(text),
    clearInterrupt: () => undefined,
    view: () => ({
      position: { x: 0.5, y: 64, z: 0.5 },
      dimension: 'overworld',
      health: 20,
      food: 9,
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
}

describe('!status after !pause stops a (non-urgent) food trip', () => {
  it.each(['!pause', '!stop', '!quests off'])(
    'after %s: says paused / quests off (as 50522c3 did), not "working on: Get food"',
    async (word) => {
      const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
      const heard: HeardCommand[] = [];
      const replies: string[] = [];
      let sessions = 0;
      const session: PlayDeps['session'] = (_limits, hooks) => {
        sessions += 1;
        const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
        // The owner pauses play during the food trip, and asks for its status.
        heard.push({ sender: OWNER, text: word, via: 'whisper' });
        heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
        const why = hooks.stopRequested() ?? 'x';
        return Promise.resolve({
          cycles: [],
          stopReason: why,
          stopKind: 'stop-requested',
          taskId,
          taskStatus: 'active',
          elapsedMs: 1,
        } satisfies SessionResult);
      };
      const result = await runPlay(
        {
          repos,
          inventory: () => Promise.resolve({}),
          // Hungry with nothing to eat (food due), but not starving (food 9 >= 6).
          food: {
            now: () => Promise.resolve({ hunger: 9, carried: 0, eatBelow: 14, starveBelow: 6 }),
            of: () => null,
          },
          session,
          sleep: () => Promise.resolve(),
          commands: commandDeps(heard, replies),
        },
        LIMITS,
        { stopRequested: () => null },
      );
      // Play is paused: no food trip after the pause (one session only), and play ended paused.
      expect(sessions).toBe(1);
      if (word !== '!quests off') expect(repos.memory.getValue(OWNER_PAUSED_KEY)).not.toBeNull();
      expect(result.stopReason).toMatch(/^(paused|quests are off)/);
      const status = replies.find((r) => r.startsWith('at ')) ?? '';
      expect(status).toMatch(/paused: DankAxon said|quests are off: DankAxon said/);
    },
  );

  it('at night, sheltered at the first look with the food task current: says sheltered', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let ticks = 6_000; // day
    let stop: string | null = null;
    let looks = 0;
    const session: PlayDeps['session'] = (_limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      // The food session sees dusk (shelter time) in its cycle.
      ticks = 11_500;
      hooks.onCycle(
        {
          summary: 'x',
          status: 'succeeded',
          decision: null,
          outcome: {
            status: 'succeeded',
            stateAfter: { time: { known: true, value: worldTime(11_500, true) } },
          },
        } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary: 'x' }],
        stopReason: 'x',
        stopKind: 'stop-requested',
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(ticks, true)),
        // Already sheltered (an enclosed spot): no blueprint session, so the food task stays current.
        shelter: () => {
          looks += 1;
          if (looks === 1) heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
          if (looks >= 2) stop = 'test over';
          return Promise.resolve({
            kind: 'pit',
            sheltered: true,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: [],
          });
        },
        food: {
          now: () => Promise.resolve({ hunger: 9, carried: 0, eatBelow: 14, starveBelow: 6 }),
          of: (s) => (s.time === undefined ? null : null),
        },
        session,
        sleep: () => Promise.resolve(),
        commands: commandDeps(heard, replies),
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    const status = replies.find((r) => r.startsWith('at ')) ?? '';
    expect(status).toMatch(/sheltered for the night/);
  });
});
