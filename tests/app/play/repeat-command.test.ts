import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep, TravelTarget } from '../../../src/app/play/owner-travel.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayLimits,
} from '../../../src/app/play/play.ts';
import type { Position } from '../../../src/domain/common.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: the owner repeats "come here" (to hurry it, say), and
// the bot said it came "instead of: come to you".
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('"come here" twice', () => {
  it('is acknowledged without "instead of" itself', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    let position: Position = { x: 0.5, y: 64, z: 0.5 };
    const owner: Position = { x: 30.5, y: 64, z: 0.5 };
    const heard: HeardCommand[] = [whisper('come here')];
    const replies: string[] = [];
    let cycles = 0;
    const step = (t: TravelTarget): TravelStep => {
      const d = Math.hypot(t.point.x - position.x, t.point.z - position.z);
      if (t.kind === 'near' && d <= t.within)
        return { kind: 'arrived', distance: Number(d.toFixed(1)) };
      // Ten blocks at a time toward the owner.
      const to = { x: Math.min(position.x + 10, t.point.x - 1), y: 64, z: 0.5 };
      return {
        kind: 'step',
        spec: { type: 'MOVE_TO', args: { target: to, tolerance: 1 } },
        text: 'walk',
        distance: Number(d.toFixed(1)),
      };
    };
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { ...position },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => ({ ...owner }),
      }),
      step,
      owners: [OWNER],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const session: PlayDeps['session'] = (limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      let n = 0;
      for (;;) {
        if (
          n >= limits.maxCycles ||
          taskId === null ||
          repos.tasks.get(taskId)?.status !== 'active'
        ) {
          return Promise.resolve({
            cycles: [],
            stopReason: 'limit',
            stopKind: 'limit',
            taskId,
            taskStatus: 'active',
            elapsedMs: 1,
          });
        }
        const stop = hooks.stopRequested();
        if (stop !== null) {
          return Promise.resolve({
            cycles: [],
            stopReason: stop,
            stopKind: 'stop-requested',
            taskId,
            taskStatus: 'active',
            elapsedMs: 1,
          });
        }
        const s = nextKnownStep(repos, taskId);
        if (s !== null && s.spec.type === 'MOVE_TO') position = { ...s.spec.args.target };
        setKnownSteps(repos, taskId, null);
        n += 1;
        cycles += 1;
        hooks.onCycle(
          {
            summary: 'ok',
            status: 'succeeded',
            decision: null,
            outcome: null,
          } as unknown as CycleResult,
          n,
        );
        if (cycles === 1) heard.push(whisper('come here'));
      }
    };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session,
        sleep: () => Promise.resolve(),
        commands,
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(replies).toEqual([
      'OK: coming to you',
      'OK: coming to you',
      'Done: here, 1 block from you',
    ]);
  });
});
