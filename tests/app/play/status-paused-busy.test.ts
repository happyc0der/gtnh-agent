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
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY, QUESTS_OFF_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 24, 2026-10-05: BUSY_TASKS come after `off` (paused / quests off) in statusText. The night pit, the
// way out and a starving food trip run while paused or with quests off, so !status then says
// "paused: ..." / "quests are off: ..." while the bot digs or forages.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

function commandDeps(heard: HeardCommand[], replies: string[], food: number): CommandDeps {
  return {
    take: () => heard.splice(0),
    waiting: () => heard.length > 0,
    reply: (_to, text) => void replies.push(text),
    clearInterrupt: () => undefined,
    view: () => ({
      position: { x: 0.5, y: 64, z: 0.5 },
      dimension: 'overworld',
      health: 20,
      food,
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

describe('!status while the bot digs its pit after a stop', () => {
  it('names the shelter it is making', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let pitSessions = 0;
    let stop: string | null = null;
    const dig: ShelterStep = {
      spec: { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig down',
    } as unknown as ShelterStep;
    // The first pit session: the owner says stop (the dig is interrupted), then asks !status.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      pitSessions += 1;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      // The second pit session: the test is over (the stop and !status were answered between).
      if (pitSessions >= 2) {
        stop = 'test over';
        return Promise.resolve({
          cycles: [],
          stopReason: 'test over',
          stopKind: 'stop-requested',
          taskId,
          taskStatus: 'active',
          elapsedMs: 1,
        } satisfies SessionResult);
      }
      heard.push({ sender: OWNER, text: '!stop', via: 'whisper' });
      heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
      const summary = 'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> failed';
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
        cycles: [{ cycleId: 'c', summary }],
        stopReason: `stopped after: ${summary}`,
        stopKind: 'cycle-failed',
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(12_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: false,
            steps: [dig],
            needs: {},
            problem: null,
            walled: false,
            exit: [],
          }),
        session,
        sleep: () => Promise.resolve(),
        commands: commandDeps(heard, replies, 20),
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    const status = replies.find((r) => r.startsWith('at '));
    expect(status).toMatch(/Night is coming|shelter/);
  });

  it('a starving food trip with quests off names the food trip', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    repos.memory.setValue(QUESTS_OFF_KEY, `${OWNER} said quests off`);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let sessions = 0;
    let stop: string | null = null;
    const session: PlayDeps['session'] = (limits, hooks) => {
      sessions += 1;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      // The owner asks while it forages (urgent: the trip is not cut short for it).
      if (sessions === 1) heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
      else stop = 'test over';
      const cycles: SessionResult['cycles'] = [];
      for (let i = 0; i < limits.maxCycles; i++) {
        cycles.push({ cycleId: `c${i}`, summary: 'x' });
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
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        food: {
          now: () => Promise.resolve({ hunger: 4, carried: 0, eatBelow: 14, starveBelow: 6 }),
          of: () => null,
        },
        session,
        sleep: () => Promise.resolve(),
        commands: commandDeps(heard, replies, 4),
        listen: true,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    const status = replies.find((r) => r.startsWith('at '));
    expect(status).toMatch(/Get food/);
  });
});
