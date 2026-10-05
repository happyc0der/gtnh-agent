import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult, SessionStopKind } from '../../../src/app/loop/live-session.ts';
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
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: a session that gathered and was then cut short by a quick
// question (or dusk, or hunger) "counted neither way", so its progress never reset the
// no-progress count: two slow sessions before it and one after failed the command. Progress now
// always counts; only a session with none is left out when cut short.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};
const planned = {
  decision: 'REQUEST_PLANNER',
  confidence: 0.8,
  reasonCodes: ['PLAN_STEP'],
  factsUsed: {},
  requiresHumanConfirmation: false,
  provider: 'test',
};

interface World {
  inventory: Record<string, number>;
  heard: HeardCommand[];
  replies: string[];
  clock: { t: number };
}

function commandDeps(w: World): CommandDeps {
  return {
    take: () => w.heard.splice(0),
    waiting: () => w.heard.length > 0,
    reply: (_to, text) => void w.replies.push(text),
    clearInterrupt: () => undefined,
    view: () => ({
      position: { x: 0.5, y: 64, z: 0.5 },
      dimension: 'overworld',
      health: 20,
      food: 20,
      inventory: { ...w.inventory },
      playerAt: () => null,
    }),
    step: (): TravelStep => ({ kind: 'refused', reason: 'no travel here' }),
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

/**
 * Sessions 1, 2, 4, 5 gather nothing; session 3 gathers 3 at its first cycle, then the owner
 * asks !status (the session ends at its next stop check); sessions 6+ gather 2 a cycle.
 */
function sessionOf(repos: Repositories, w: World, item: string): PlayDeps['session'] {
  let sessionNo = 0;
  return (limits, hooks) => {
    sessionNo += 1;
    const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
    const cycles: SessionResult['cycles'] = [];
    const end = (stopKind: SessionStopKind, stopReason: string): Promise<SessionResult> =>
      Promise.resolve({
        cycles,
        stopReason,
        stopKind,
        taskId,
        taskStatus: 'active',
        elapsedMs: 1,
      });
    for (;;) {
      w.clock.t += 1_000;
      if (cycles.length >= limits.maxCycles) return end('limit', 'limit');
      const stop = hooks.stopRequested();
      if (stop !== null) return end('stop-requested', stop);
      const gain = sessionNo === 3 && cycles.length === 0 ? 3 : sessionNo >= 6 ? 2 : 0;
      if (gain > 0) w.inventory[item] = (w.inventory[item] ?? 0) + gain;
      cycles.push({ cycleId: `s${sessionNo}c${cycles.length}`, summary: 'x' });
      hooks.onCycle(
        {
          summary: 'x',
          status: 'succeeded',
          decision: planned,
          outcome: null,
        } as unknown as CycleResult,
        cycles.length,
      );
      if (sessionNo === 3 && cycles.length === 1) w.heard.push(whisper('!status'));
    }
  };
}

describe('progress in a cut-short session', () => {
  it('an owner !get: 3 logs gathered before a !status still count as progress', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const w: World = {
      inventory: {},
      heard: [whisper('!get 16 logs')],
      replies: [],
      clock: { t: 0 },
    };
    await runPlay(
      {
        repos,
        now: () => w.clock.t,
        inventory: () => Promise.resolve({ ...w.inventory }),
        session: sessionOf(repos, w, 'minecraft:log'),
        sleep: (ms) => {
          w.clock.t += ms;
          return Promise.resolve();
        },
        commands: commandDeps(w),
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(w.replies.some((r) => r.includes('no progress'))).toBe(false);
    expect(repos.commands.get(1)?.status).toBe('done');
  });

  it("play's own goal: 3 dirt gathered before a !status still count as progress", async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const w: World = { inventory: {}, heard: [], replies: [], clock: { t: 0 } };
    const result = await runPlay(
      {
        repos,
        now: () => w.clock.t,
        inventory: () => Promise.resolve({ ...w.inventory }),
        session: sessionOf(repos, w, 'minecraft:dirt'),
        sleep: (ms) => {
          w.clock.t += ms;
          return Promise.resolve();
        },
        commands: commandDeps(w),
        goal: {
          taskId: 'goal-dirt',
          name: 'get 10 minecraft:dirt',
          requirements: { 'minecraft:dirt': 10 },
        },
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(result.stopReason).not.toMatch(/no progress/);
    expect(result.stopReason).toMatch(/is reached/);
  });
});
