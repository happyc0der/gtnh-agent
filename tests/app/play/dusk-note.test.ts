import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { setKnownSteps } from '../../../src/app/loop/known-steps.ts';
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

// An independent review, 2026-10-05: commands were answered after every night-pit session, so
// at dusk, while the bot still dug, a waiting command was told "It is night: I stay in my shelter
// until morning, then I ..." (no minutes), which used up the night's note; and if the pit then
// failed, the owner heard "I stay in my shelter" and then "I have no shelter here". Commands are
// answered between pit sessions only after a stop cut one short, in true words.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('the night note while the pit is being dug', () => {
  it('is said once the bot is sheltered, with the minutes, not mid-dig', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [whisper('follow me')];
    const timeline: string[] = [];
    const clock = { t: 0 };
    let pitDone = false;
    let stop: string | null = null;
    const dig: ShelterStep = {
      spec: {
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 61, z: 0 }, item: 'minecraft:dirt' },
      },
      text: 'dig down',
    };
    const shelter = (): Promise<ShelterStatus> =>
      Promise.resolve({
        kind: 'pit',
        sheltered: pitDone,
        steps: pitDone ? [] : [dig],
        needs: {},
        problem: null,
        walled: pitDone,
        exit: [],
      });
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void timeline.push(`reply: ${text}`),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 64, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => ({ x: 5.5, y: 64, z: 0.5 }),
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
    // The pit, dug in one session.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      clock.t += 1_000;
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      if (taskId !== null) {
        setKnownSteps(repos, taskId, null);
        repos.tasks.setStatus(taskId, 'completed');
      }
      pitDone = true;
      const summary = 'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded';
      hooks.onCycle(
        { summary, status: 'succeeded', decision: null, outcome: null } as unknown as CycleResult,
        1,
      );
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary }],
        stopReason: 'the task is completed',
        stopKind: 'task-finished',
        taskId,
        taskStatus: 'completed',
        elapsedMs: 1,
      } satisfies SessionResult);
    };
    await runPlay(
      {
        repos,
        now: () => clock.t,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(12_000, true)), // dusk
        shelter,
        session,
        sleep: (ms) => {
          clock.t += ms;
          stop = 'test over'; // one look in the shelter is enough
          return Promise.resolve();
        },
        commands,
      },
      LIMITS,
      {
        stopRequested: () => stop,
        onEvent: (e) => {
          if (e.kind === 'night') timeline.push(`night: ${e.message}`);
        },
      },
    );
    const note = timeline.findIndex((l) => l.startsWith('reply: It is night'));
    const sheltered = timeline.findIndex((l) => l.startsWith('night: sheltered'));
    expect(note).toBeGreaterThan(sheltered);
    expect(timeline[note]).toContain('(in about 10 min)');
  });

  it('a pit that fails: the owner is not first promised a night in the shelter', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [whisper('follow me')];
    const replies: string[] = [];
    const dig: ShelterStep = {
      spec: {
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 61, z: 0 }, item: 'minecraft:dirt' },
      },
      text: 'dig down',
    };
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
        playerAt: () => ({ x: 5.5, y: 64, z: 0.5 }),
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
    // The dig is refused (a person must look): no shelter tonight.
    const session: PlayDeps['session'] = (_limits, hooks) => {
      const taskId = repos.memory.getValue(CURRENT_TASK_KEY);
      const summary = 'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> rejected';
      hooks.onCycle(
        { summary, status: 'rejected', decision: null, outcome: null } as unknown as CycleResult,
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
      { stopRequested: () => null },
    );
    expect(result.night).not.toBeNull();
    expect(replies.some((r) => r.startsWith('It is night: I stay in my shelter'))).toBe(false);
  });
});
