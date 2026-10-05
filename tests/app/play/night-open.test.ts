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
import type { ShelterStatus } from '../../../src/goals/shelter.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: at midnight the owner digs into the bot's sealed pit, stands
// in the opening and whispers "come". The bot tries to close the wall again; the placement is
// refused (an entity is in or next to the cell), so it goes offline until sunrise, and the owner
// was told "It is getting dark and I have no shelter here". Now the reply says what happened.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('the owner opens the night pit', () => {
  it('is told the shelter is open and could not be closed, not that it is getting dark', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    const clock = { t: 0 };
    let looks = 0;
    const wall: ShelterStep = {
      spec: {
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 61, z: 0 }, item: 'minecraft:dirt' },
      },
      text: 'close the wall (1, 61, 0)',
    };
    // First look: sealed in. The owner digs in while the bot waits: the wall is open after.
    const shelter = (): Promise<ShelterStatus> => {
      looks += 1;
      if (looks === 1) heard.push(whisper('come'));
      const open = looks > 1;
      return Promise.resolve({
        kind: 'pit',
        sheltered: !open,
        steps: open ? [wall] : [],
        needs: open ? { 'minecraft:dirt': 1 } : {},
        problem: null,
        walled: !open,
        exit: [],
      });
    };
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 61, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: { 'minecraft:dirt': 3 },
        playerAt: () => ({ x: 1.5, y: 61, z: 0.5 }),
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
    // The placement that would close the wall is refused: the owner stands in the opening.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      clock.t += 1_000;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      const summary = 'EXECUTE_KNOWN_SAFE_STEP -> PLACE_BLOCK -> rejected';
      hooks.onCycle(
        {
          summary,
          status: 'rejected',
          needsUserAttention: true,
          decision: {
            decision: 'EXECUTE_KNOWN_SAFE_STEP',
            confidence: 1,
            reasonCodes: ['KNOWN_SAFE_STEP'],
            factsUsed: {},
            requiresHumanConfirmation: false,
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
        taskStatus: 'blocked',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    const result = await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({ 'minecraft:dirt': 3 }),
        time: () => Promise.resolve(worldTime(18_000, true)), // midnight
        shelter,
        session,
        sleep: (ms) => {
          clock.t += ms;
          return Promise.resolve();
        },
        commands,
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(result.night).not.toBeNull();
    expect(replies).toEqual([
      'It is night: I stay in my shelter until morning (in about 5 min), then I come to you',
      'My shelter is open and I could not close it: I go offline until sunrise',
    ]);
  });
});
