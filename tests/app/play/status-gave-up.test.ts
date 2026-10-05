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
import { CURRENT_TASK_KEY, NIGHT_SHELTER_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 24, 2026-10-05: 50522c3 puts BUSY_TASKS (night shelter, leave shelter, food) before play.idle in
// !status. But when play has GIVEN UP on that very task (food trip: no food in 3 sessions; the
// way out: 3 tries), the task is left active and current, and play waits idle (--listen):
// !status now says "working on: ..." the task play gave up on, which is what 061ef56 fixed.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

function commandDeps(heard: HeardCommand[], replies: string[], onReply: () => void): CommandDeps {
  return {
    take: () => heard.splice(0),
    waiting: () => heard.length > 0,
    reply: (_to, text) => {
      replies.push(text);
      onReply();
    },
    clearInterrupt: () => undefined,
    view: () => ({
      position: { x: 0.5, y: 61, z: 0.5 },
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
}

/** A session of `cycles` cycles that gets nothing, its task left active. */
function emptySession(
  repos: Repositories,
  clock: { t: number },
  count: { n: number },
  failed = false,
): PlayDeps['session'] {
  return (limits, hooks) => {
    count.n += 1;
    const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
    const cycles: SessionResult['cycles'] = [];
    const n = failed ? 1 : limits.maxCycles;
    for (let i = 0; i < n; i++) {
      clock.t += 1_000;
      cycles.push({ cycleId: `c${count.n}-${i}`, summary: 'x' });
      hooks.onCycle(
        {
          summary: 'x',
          status: failed ? 'failed' : 'succeeded',
          decision: null,
          outcome: failed
            ? { status: 'failed', execution: { ok: false, message: 'the block did not break' } }
            : null,
        } as unknown as CycleResult,
        i + 1,
      );
    }
    return Promise.resolve({
      cycles,
      stopReason: failed ? 'stopped after: x' : 'reached the limit of 3 cycles',
      stopKind: failed ? 'cycle-failed' : 'limit',
      taskId,
      taskStatus: 'active',
      elapsedMs: 1,
    } satisfies SessionResult);
  };
}

describe('!status after play gave up on its own busy task (--listen)', () => {
  it('a food trip that found no food in 3 sessions: idle (why), not "working on: Get food"', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    const sessions = { n: 0 };
    let stop: string | null = null;
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        food: {
          now: () => Promise.resolve({ hunger: 10, carried: 0, eatBelow: 14, starveBelow: 6 }),
          of: () => null,
        },
        session: emptySession(repos, clock, sessions),
        sleep: (ms) => {
          clock.t += ms;
          // After the third food session, play waits for commands: the owner asks.
          if (sessions.n >= 3 && heard.length === 0 && replies.length === 0) {
            heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
          }
          return Promise.resolve();
        },
        commands: commandDeps(heard, replies, () => {
          stop = 'test over';
        }),
        listen: true,
      },
      LIMITS,
      {
        stopRequested: () => stop,
        onEvent: (e) => {
          if (e.kind === 'idle' || (e.kind === 'command' && e.message.startsWith('at ')))
            console.log('EVENT', e.kind, e.message.slice(0, 120));
        },
      },
    );
    expect(sessions.n).toBe(3);
    expect(replies[0]).toMatch(/idle \(hungry/);
  });

  it('a way out that failed 3 times: idle (why), not "working on: Morning: dig your way out"', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    repos.memory.setValue(NIGHT_SHELTER_KEY, new Date(0).toISOString());
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    const sessions = { n: 0 };
    let stop: string | null = null;
    const roof: ShelterStep = {
      spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig the roof',
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(1_000, true)), // morning
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: true,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: [roof],
          }),
        session: emptySession(repos, clock, sessions, true),
        sleep: (ms) => {
          clock.t += ms;
          if (sessions.n >= 3 && heard.length === 0 && replies.length === 0) {
            heard.push({ sender: OWNER, text: '!status', via: 'whisper' });
          }
          return Promise.resolve();
        },
        commands: commandDeps(heard, replies, () => {
          stop = 'test over';
        }),
        listen: true,
      },
      LIMITS,
      {
        stopRequested: () => stop,
        onEvent: (e) => {
          if (e.kind === 'idle' || (e.kind === 'command' && e.message.startsWith('at ')))
            console.log('EVENT', e.kind, e.message.slice(0, 120));
        },
      },
    );
    expect(sessions.n).toBe(3);
    expect(replies[0]).toMatch(/idle \(the player could not dig out/);
  });
});
