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

// Review 24, 2026-10-05: the operator's stop file appears while the bot digs its night pit; the dig in
// progress fails, and 50522c3's perform() tags it data.interrupted (stop file). nightRound then
// treats it like an owner's stop: refunds the try and answers commands between sessions with
// "It is getting dark: I am making my shelter for the night, and in the morning I ...", and only
// then sees the stop and ends play, whose leave() cancels the same command ("Stopped: my operator
// stopped play"). Two contradictory whispers in a row.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('operator stop file during the night pit, a command running', () => {
  it('is not promised the morning: only told that play stopped', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let stopFile = false;
    const dig: ShelterStep = {
      spec: { type: 'DIG_DOWN', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig down',
    } as unknown as ShelterStep;
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
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
    // The owner's follow, running since the day.
    const running = repos.commands.add({
      source: 'chat',
      sender: OWNER,
      rawText: '!follow',
      command: { verb: 'follow', player: null },
    });
    repos.commands.start(running.id, 'OK: following you');
    // The pit's dig: the operator runs `cli halt` mid-dig; the client refuses on the stop file.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
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
              message: 'the stop file ./data/STOP exists',
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
        time: () => Promise.resolve(worldTime(12_000, true)), // dusk
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
    expect(repos.commands.get(running.id)?.status).toBe('cancelled');
    // The contradiction: a promise for the morning, then the cancel.
    const promise = replies.findIndex((r) => r.includes('in the morning I follow you'));
    expect(promise).toBe(-1);
  });
});
