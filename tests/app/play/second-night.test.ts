import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { nextKnownStep, setKnownSteps } from '../../../src/app/loop/known-steps.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
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
import type { ShelterStatus } from '../../../src/goals/shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: a follow that runs through two nights. The dusk and night
// notes were said once per command, so at the second dusk the bot left its owner for its
// shelter without a word. They are said each night now.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 60,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('following through two nights', () => {
  it('says so at each dusk and each night', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    let position: Position = { x: 0.5, y: 64, z: 0.5 };
    const heard: HeardCommand[] = [whisper('follow me')];
    const replies: string[] = [];
    const clock = { t: 0 };
    let time: WorldTime = worldTime(1_000, true);
    let followCycles = 0;
    let nights = 0;
    let stop: string | null = null;
    const step = (t: TravelTarget): TravelStep => {
      const d = Math.hypot(t.point.x - position.x, t.point.z - position.z);
      if (t.kind === 'near' && d <= t.within)
        return { kind: 'arrived', distance: Number(d.toFixed(1)) };
      return {
        kind: 'step',
        spec: {
          type: 'MOVE_TO',
          args: { target: { x: t.point.x - 1, y: 64, z: t.point.z }, tolerance: 1 },
        },
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
        playerAt: () => ({ x: 5.5, y: 64, z: 0.5 }),
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
    // Sheltered at once each dusk; out of it each morning.
    const shelter = (purpose?: 'night' | 'morning'): Promise<ShelterStatus> =>
      Promise.resolve({
        kind: 'pit',
        sheltered: purpose !== 'morning',
        steps: [],
        needs: {},
        problem: null,
        walled: false,
        exit: [],
      });
    const session: PlayDeps['session'] = (limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      let n = 0;
      const end = (
        stopKind: SessionResult['stopKind'],
        stopReason: string,
      ): Promise<SessionResult> =>
        Promise.resolve({
          cycles: [],
          stopReason,
          stopKind,
          taskId,
          taskStatus: 'active',
          elapsedMs: 1,
        });
      for (;;) {
        clock.t += 1_000;
        if (n >= limits.maxCycles) return end('limit', 'limit');
        const s = hooks.stopRequested();
        if (s !== null) return end('stop-requested', s);
        const known = taskId === null ? null : nextKnownStep(repos, taskId);
        if (known !== null && known.spec.type === 'MOVE_TO')
          position = { ...known.spec.args.target };
        if (taskId !== null) setKnownSteps(repos, taskId, null);
        n += 1;
        followCycles += 1;
        // Five follow cycles into each day, dusk comes.
        if (followCycles % 5 === 0) time = worldTime(11_000, true);
        hooks.onCycle(
          {
            summary: 'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> succeeded',
            status: 'succeeded',
            decision: { decision: 'EXECUTE_KNOWN_SAFE_STEP', reasonCodes: ['KNOWN_SAFE_STEP'] },
            outcome: {
              execution: { ok: true, message: 'walked' },
              stateAfter: {
                player: { position: { known: true, value: { ...position } } },
                time: { known: true, value: time },
              },
            },
          } as unknown as CycleResult,
          n,
        );
      }
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(time),
        shelter,
        session,
        sleep: (ms) => {
          clock.t += ms;
          // In the shelter: the night passes. After the second night, stop the test.
          if (time.phase !== 'day' || time.timeOfDay >= 11_000) {
            nights += 1;
            if (nights === 2) stop = 'test over';
            time = worldTime(1_000, true);
          }
          return Promise.resolve();
        },
        commands,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    expect(nights).toBe(2);
    expect(replies[0]).toBe('OK: following you');
    const dusk = 'It is getting dark: I shelter for the night, then I follow you';
    expect(replies.filter((r) => r === dusk)).toHaveLength(2);
    expect(replies.filter((r) => r.startsWith('It is night: I stay in my shelter'))).toHaveLength(
      2,
    );
  });
});
