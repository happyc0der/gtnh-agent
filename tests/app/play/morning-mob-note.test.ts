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
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 24, 2026-10-05: morning, sealed in, System 1 pauses for hostiles
// (SHELTERED) during the way out; morningRound's shelteredPause branch runs whileSheltered with
// play.sheltered null and neither leaving nor making set, so a command whispered then is told
// "It is night: I stay in my shelter until morning, then I ..." in the morning.
const OWNER = 'DankAxon';
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('a command whispered while the morning way out pauses for hostiles', () => {
  it('is not told it is night', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    repos.memory.setValue(NIGHT_SHELTER_KEY, new Date(0).toISOString());
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let stop: string | null = null;
    const roof: ShelterStep = {
      spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 63, z: 0 } } },
      text: 'dig the roof',
    };
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => {
        replies.push(text);
        stop = 'test over';
      },
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 61, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => ({ x: 3.5, y: 64, z: 0.5 }),
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
    const session: PlayDeps['session'] = (_limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      heard.push({ sender: OWNER, text: '!come', via: 'whisper' });
      const summary = 'PAUSE_AND_ASK_USER -> PAUSE_AND_ASK_USER -> paused';
      hooks.onCycle(
        {
          summary,
          status: 'paused',
          decision: {
            decision: 'PAUSE_AND_ASK_USER',
            reasonCodes: ['HOSTILES_NEARBY', 'SHELTERED'],
            confidence: 1,
            factsUsed: {},
            requiresHumanConfirmation: true,
            provider: 'test',
          },
          outcome: null,
        } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary }],
        stopReason: `needs attention after: ${summary}`,
        stopKind: 'needs-attention',
        taskId,
        taskStatus: 'paused',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
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
            sealed: true,
            hostiles: null,
          }),
        session,
        sleep: () => Promise.resolve(),
        commands,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    expect(replies[0]).not.toMatch(/^It is night/);
  });
});
