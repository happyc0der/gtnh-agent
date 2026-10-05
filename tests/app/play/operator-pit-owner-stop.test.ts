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
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 25, 2026-10-05: an owner whispers "!stop" while the bot digs its night pit, as the operator's stop
// file appears (the dig is interrupted). 50522c3 answered the owner's stop between the pit's
// sessions (whileSheltered: "OK: stopped. I wait for !resume ..."); 0e9f3a6 skips that when
// hooks.stopRequested() is set, and leave()'s endOwnerCommands cancels the queued !stop with
// no reply (it tells only action commands' senders). Is the owner's stop answered at all?
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('owner !stop during the pit, operator stop at the same time', () => {
  it('the owner hears something', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: Array<[string, string]> = [];
    let stopFile = false;
    const dig: ShelterStep = {
      spec: { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig down',
    } as unknown as ShelterStep;
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (to, text) => void replies.push([to, text]),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => ({ x: 3.5, y: 64, z: 0.5 }),
      }),
      step: (): TravelStep => ({ kind: 'arrived', distance: 1 }),
      owners: [OWNER],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    const session: PlayDeps['session'] = (_limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      heard.push({ sender: OWNER, text: '!stop', via: 'whisper' });
      stopFile = true;
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
        commands,
      },
      LIMITS,
      {
        stopRequested: () => (stopFile ? 'the stop file ./data/STOP exists' : null),
        operatorStopped: () => stopFile,
      },
    );
    expect(replies.filter(([to]) => to === OWNER)).not.toHaveLength(0);
  });
});
