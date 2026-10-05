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
  type TunnelRequest,
} from '../../../src/app/play/play.ts';
import type { TunnelPlan } from '../../../src/bot/gtnh1710/tunnel.ts';
import type { Position } from '../../../src/domain/common.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: "!status", "!help", "!waypoints" whispered one after
// another while a "!get 16 logs" runs. Each ends the get's session at its next cycle
// (commandWaiting); a session cut short so, with nothing gathered yet (it was walking to a tree),
// counted as a session "without progress", and three such questions failed the get. A session a
// new command (any whisper), dusk or hunger cuts short now counts neither way.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};
const open = (): Repositories => createRepositories(openDatabase(IN_MEMORY), systemClock);

interface World {
  position: Position;
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
      position: { ...w.position },
      dimension: 'overworld',
      health: 20,
      food: 20,
      inventory: { ...w.inventory },
      playerAt: (name) => (name === OWNER ? { x: 10.5, y: 64, z: 0.5 } : null),
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

function deps(repos: Repositories, w: World, session: PlayDeps['session']): PlayDeps {
  return {
    repos,
    now: () => w.clock.t,
    inventory: () => Promise.resolve({ ...w.inventory }),
    session,
    sleep: (ms) => {
      w.clock.t += ms;
      return Promise.resolve();
    },
    commands: commandDeps(w),
  };
}

const planned = {
  decision: 'REQUEST_PLANNER',
  confidence: 0.8,
  reasonCodes: ['PLAN_STEP'],
  factsUsed: {},
  requiresHumanConfirmation: false,
  provider: 'test',
};

describe("an owner's quick questions during a goal", () => {
  it('three questions that each cut a session short do not fail a !get', async () => {
    const repos = open();
    const w: World = {
      position: { x: 0.5, y: 64, z: 0.5 },
      inventory: {},
      heard: [whisper('!get 16 logs')],
      replies: [],
      clock: { t: 0 },
    };
    const questions = ['!status', '!help', '!waypoints'];
    let sessionNo = 0;
    // A goal session as runSession runs it: the stop check before every cycle; the first cycle
    // of each session walks to the next tree (nothing gathered), each one after digs a log.
    const session: PlayDeps['session'] = (limits, hooks) => {
      sessionNo += 1;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      const cycles: SessionResult['cycles'] = [];
      const end = (stopKind: SessionStopKind, stopReason: string): Promise<SessionResult> =>
        Promise.resolve({
          cycles,
          stopReason,
          stopKind,
          taskId,
          taskStatus: taskId === null ? null : (repos.tasks.get(taskId)?.status ?? null),
          elapsedMs: 1,
        });
      for (;;) {
        w.clock.t += 1_000;
        if (cycles.length >= limits.maxCycles) return end('limit', 'limit');
        const stop = hooks.stopRequested();
        if (stop !== null) return end('stop-requested', stop);
        if (cycles.length > 0) {
          w.inventory['minecraft:log'] = (w.inventory['minecraft:log'] ?? 0) + 1;
        }
        const summary =
          cycles.length === 0
            ? 'REQUEST_PLANNER -> MOVE_TO -> succeeded'
            : 'REQUEST_PLANNER -> DIG_BLOCK -> succeeded';
        cycles.push({ cycleId: `s${sessionNo}c${cycles.length}`, summary });
        hooks.onCycle(
          {
            summary,
            status: 'succeeded',
            decision: planned,
            outcome: null,
          } as unknown as CycleResult,
          cycles.length,
        );
        // While it walks to a tree, the owner asks something (sessions 2 to 4).
        if (cycles.length === 1 && sessionNo >= 2 && sessionNo <= 4) {
          w.heard.push(whisper(questions[sessionNo - 2] ?? '!status'));
        }
      }
    };
    await runPlay(deps(repos, w, session), LIMITS, { stopRequested: () => null });
    // The questions were answered...
    expect(w.replies[0]).toBe('OK: getting minecraft:log until I have 16 (I have 0)');
    expect(w.replies[1]).toMatch(
      /^at 0 64 0, health 20\/20, food 20\/20; doing: get minecraft:log/,
    );
    expect(w.replies[2]).toMatch(/^!stop !pause/);
    expect(w.replies[3]).toBe('No waypoints yet: say !waypoint <name> where you want one');
    // ...and the get went on to the end.
    expect(w.replies.at(-1)).toBe('Done: I have 16 minecraft:log');
    expect(repos.commands.get(1)?.status).toBe('done');
    expect(w.inventory['minecraft:log']).toBeGreaterThanOrEqual(16);
  });

  it("nor play's own goal (quests, --needs)", async () => {
    // goal-round.ts stuckOn counted a session an owner's command cut short like any other.
    const repos = open();
    const w: World = {
      position: { x: 0.5, y: 64, z: 0.5 },
      inventory: {},
      heard: [],
      replies: [],
      clock: { t: 0 },
    };
    let sessionNo = 0;
    const session: PlayDeps['session'] = (limits, hooks) => {
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
        if (cycles.length > 0) {
          w.inventory['minecraft:dirt'] = (w.inventory['minecraft:dirt'] ?? 0) + 1;
        }
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
        if (cycles.length === 1 && sessionNo >= 2 && sessionNo <= 4)
          w.heard.push(whisper('!status'));
      }
    };
    const result = await runPlay(
      {
        ...deps(repos, w, session),
        goal: {
          taskId: 'goal-dirt',
          name: 'get 10 minecraft:dirt',
          requirements: { 'minecraft:dirt': 10 },
        },
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(w.replies).toHaveLength(3);
    expect(result.stopReason).not.toMatch(/no progress/);
    expect(w.inventory['minecraft:dirt']).toBeGreaterThanOrEqual(10);
  });

  it('nor a tunnel', async () => {
    // tunnelRound: run.stuck counted a session a new command cut short before its first step.
    const repos = open();
    const w: World = {
      position: { x: 0.5, y: 64, z: 0.5 },
      inventory: {},
      heard: [whisper('!tunnel east 20')],
      replies: [],
      clock: { t: 0 },
    };
    const tunnel = (req: TunnelRequest): Promise<TunnelPlan> => {
      const done = Math.floor(w.position.x) - req.start.x;
      const target = { x: req.start.x + done + 1 + 0.5, y: req.start.y, z: req.start.z + 0.5 };
      return Promise.resolve({
        ok: true,
        done,
        steps: [{ spec: { type: 'MOVE_TO', args: { target, tolerance: 0.5 } }, text: 'step on' }],
        problem: null,
      });
    };
    let sessionNo = 0;
    const questions = ['!status', '!help', '!waypoints'];
    // A dig session: the stop check first; sessions 2-4 find the owner's question waiting (it
    // came while the round planned the next cells), the others step one cell on.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      sessionNo += 1;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      if (sessionNo >= 2 && sessionNo <= 4) w.heard.push(whisper(questions[sessionNo - 2] ?? ''));
      const stop = hooks.stopRequested();
      if (stop !== null) {
        return Promise.resolve({
          cycles: [],
          stopReason: stop,
          stopKind: 'stop-requested' as const,
          taskId,
          taskStatus: 'active',
          elapsedMs: 1,
        });
      }
      const step = taskId === null ? null : nextKnownStep(repos, taskId);
      if (step !== null && step.spec.type === 'MOVE_TO') w.position = { ...step.spec.args.target };
      if (taskId !== null) {
        setKnownSteps(repos, taskId, null);
        repos.tasks.setStatus(taskId, 'completed');
      }
      hooks.onCycle(
        {
          summary: 'ok',
          status: 'succeeded',
          decision: null,
          outcome: null,
        } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: `s${sessionNo}`, summary: 'ok' }],
        stopReason: 'the task is completed',
        stopKind: 'task-finished' as const,
        taskId,
        taskStatus: 'completed',
        elapsedMs: 1,
      });
    };
    // (This fake planner never says the tunnel is done: the test ends after 10 sessions.)
    await runPlay({ ...deps(repos, w, session), tunnel }, LIMITS, {
      stopRequested: () => (sessionNo >= 10 ? 'test over' : null),
    });
    expect(w.replies.some((r) => r.includes('no progress'))).toBe(false);
    expect(repos.commands.get(1)?.status).not.toBe('failed');
    expect(w.position.x).toBeGreaterThan(5);
  });
});
