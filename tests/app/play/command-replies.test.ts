import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { SessionResult, SessionStopKind } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep, TravelTarget } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import type { Position } from '../../../src/domain/common.ts';
import { worldTime, type WorldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: a command given at night replaces the running one only in
// the morning, and the running one's night note came after the new one's, promising the old
// command; with two owners, the older one's command ended without a word to its sender.
const OWNER = 'DankAxon';
const OWNER2 = 'Keshav';
const whisper = (text: string, sender = OWNER): HeardCommand => ({ sender, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};
const open = (): Repositories => createRepositories(openDatabase(IN_MEMORY), systemClock);

interface Sim {
  position: Position;
  heard: HeardCommand[];
  replies: string[];
  time: WorldTime | null;
  clock: { t: number };
  sleeps: number;
  onSleep?: (n: number) => void;
}

function fakeStep(sim: Sim, t: TravelTarget): TravelStep {
  const g = t.point;
  const d = Math.hypot(g.x - sim.position.x, g.z - sim.position.z);
  const distance = Number(d.toFixed(1));
  if (t.kind === 'near' ? d <= t.within : d <= 1.5) return { kind: 'arrived', distance };
  const to = { x: t.kind === 'near' ? g.x - 1 : g.x, y: g.y ?? 64, z: g.z };
  return {
    kind: 'step',
    spec: { type: 'MOVE_TO', args: { target: to, tolerance: 1 } },
    text: `walk to ${to.x} ${to.z}`,
    distance,
  };
}

function commandDeps(sim: Sim): CommandDeps {
  return {
    take: () => sim.heard.splice(0),
    waiting: () => sim.heard.length > 0,
    reply: (to, text) => void sim.replies.push(`${to}: ${text}`),
    clearInterrupt: () => undefined,
    view: () => ({
      position: { ...sim.position },
      dimension: 'overworld',
      health: 20,
      food: 20,
      inventory: {},
      playerAt: (name) => (name === OWNER || name === OWNER2 ? { x: 10.5, y: 64, z: 0.5 } : null),
    }),
    step: (t) => fakeStep(sim, t),
    owners: [OWNER, OWNER2],
    homeName: 'home',
    configLocations: new Map(),
    boundary: {
      min: { x: -256, y: 0, z: -256 },
      max: { x: 256, y: 255, z: 256 },
      allowedDimensions: ['overworld'],
    },
  };
}

/** Every session walks its known step and completes its task. */
function fakeSession(repos: Repositories, sim: Sim): PlayDeps['session'] {
  return (limits, hooks) => {
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
      sim.clock.t += 1_000;
      const status = taskId === null ? null : (repos.tasks.get(taskId)?.status ?? null);
      if (taskId === null || status === null) return end('no-task', 'no task');
      if (status === 'completed') return end('task-finished', 'the task is completed');
      if (status !== 'active') return end('task-halted', `the task is ${status}`);
      if (cycles.length >= limits.maxCycles) return end('limit', 'limit');
      const stop = hooks.stopRequested();
      if (stop !== null) return end('stop-requested', stop);
      const step = nextKnownStep(repos, taskId);
      if (step !== null && step.spec.type === 'MOVE_TO')
        sim.position = { ...step.spec.args.target };
      setKnownSteps(repos, taskId, null);
      repos.tasks.setStatus(taskId, 'completed');
      cycles.push({ cycleId: `c${cycles.length}`, summary: 'ok' });
      hooks.onCycle(
        {
          summary: 'ok',
          status: 'succeeded',
          decision: null,
          outcome: null,
        } as unknown as CycleResult,
        cycles.length,
      );
    }
  };
}

function deps(repos: Repositories, sim: Sim, over: Partial<PlayDeps> = {}): PlayDeps {
  return {
    repos,
    now: () => sim.clock.t,
    inventory: () => Promise.resolve({}),
    session: fakeSession(repos, sim),
    sleep: (ms) => {
      sim.clock.t += ms;
      sim.sleeps += 1;
      sim.onSleep?.(sim.sleeps);
      return Promise.resolve();
    },
    commands: commandDeps(sim),
    ...over,
  };
}

const sheltered = {
  kind: 'pit' as const,
  sheltered: true,
  steps: [],
  needs: {},
  problem: null,
  walled: false,
  exit: [],
};

describe('replies when one command replaces another', () => {
  it("at night: the new command's note says what it replaces, and the old one's is not said", async () => {
    const repos = open();
    // Running since the day: !goto 20 64 0.
    const r = repos.commands.add({
      source: 'chat',
      sender: OWNER,
      rawText: '!goto 20 64 0',
      command: { verb: 'goto', x: 20, y: 64, z: 0 },
    });
    repos.commands.start(r.id, 'OK: going to 20 64 0');
    // Heard at dusk (during the pit's session, say), before the night's first look.
    const sim: Sim = {
      position: { x: 0.5, y: 64, z: 0.5 },
      heard: [whisper('!goto -20 64 0')],
      replies: [],
      time: worldTime(18_000, true),
      clock: { t: 0 },
      sleeps: 0,
    };
    sim.onSleep = () => {
      sim.time = worldTime(1_000, true);
    };
    await runPlay(
      deps(repos, sim, {
        time: () => Promise.resolve(sim.time),
        shelter: () => Promise.resolve(sheltered),
      }),
      LIMITS,
      { stopRequested: () => null },
    );
    expect(sim.replies).toEqual([
      `${OWNER}: It is night: I stay in my shelter until morning (in about 5 min), then I go to -20 64 0 (instead of: go to 20 64 0)`,
      `${OWNER}: OK: going to -20 64 0 (instead of: go to 20 64 0)`,
      `${OWNER}: Done: at -20 64 0`,
    ]);
  });

  it('two owners: the one whose command another replaces is told', async () => {
    const repos = open();
    const sim: Sim = {
      position: { x: 0.5, y: 64, z: 0.5 },
      heard: [whisper('!goto 20 64 0', OWNER), whisper('!goto -20 64 0', OWNER2)],
      replies: [],
      time: null,
      clock: { t: 0 },
      sleeps: 0,
    };
    await runPlay(deps(repos, sim), LIMITS, { stopRequested: () => null });
    expect(sim.replies.filter((x) => x.startsWith(`${OWNER}:`))).toEqual([
      `${OWNER}: Stopped: ${OWNER2} asked me to go to -20 64 0 instead`,
    ]);
    expect(sim.replies).toContain(`${OWNER2}: OK: going to -20 64 0 (instead of: go to 20 64 0)`);
    expect(repos.commands.get(1)).toMatchObject({ status: 'cancelled' });
  });

  it('another owner\'s !come is named as theirs, not as "come to you"', async () => {
    // An independent review, 2026-10-05: the replaced owner read "asked me to come to you".
    const repos = open();
    const sim: Sim = {
      position: { x: 0.5, y: 64, z: 0.5 },
      heard: [whisper('!goto 20 64 0', OWNER), whisper('!come', OWNER2)],
      replies: [],
      time: null,
      clock: { t: 0 },
      sleeps: 0,
    };
    await runPlay(deps(repos, sim), LIMITS, { stopRequested: () => null });
    expect(sim.replies.filter((x) => x.startsWith(`${OWNER}:`))).toEqual([
      `${OWNER}: Stopped: ${OWNER2} asked me to come to ${OWNER2} instead`,
    ]);
    // By night, the new command's note names the old one as its sender's.
    const night = open();
    const r = night.commands.add({
      source: 'chat',
      sender: OWNER,
      rawText: '!come',
      command: { verb: 'come' },
    });
    night.commands.start(r.id, 'OK: coming to you');
    const dark: Sim = {
      position: { x: 0.5, y: 64, z: 0.5 },
      heard: [whisper('!goto -20 64 0', OWNER2)],
      replies: [],
      time: worldTime(18_000, true),
      clock: { t: 0 },
      sleeps: 0,
    };
    dark.onSleep = () => {
      dark.time = worldTime(1_000, true);
    };
    await runPlay(
      deps(night, dark, {
        time: () => Promise.resolve(dark.time),
        shelter: () => Promise.resolve(sheltered),
      }),
      LIMITS,
      { stopRequested: () => null },
    );
    expect(dark.replies[0]).toBe(
      `${OWNER2}: It is night: I stay in my shelter until morning (in about 5 min), then I go to -20 64 0 (instead of: come to ${OWNER})`,
    );
  });
});
