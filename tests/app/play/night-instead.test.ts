import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayLimits } from '../../../src/app/play/play.ts';
import { worldTime } from '../../../src/domain/game-state.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: "(instead of: <itself>)" was dropped from the day's ack
// only; the night note still listed the identical command.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 30,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('"come here" twice at night', () => {
  it('the second note has no "(instead of: come to you)"', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [whisper('come here'), whisper('come here')];
    const replies: string[] = [];
    let stop: string | null = null;
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
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        time: () => Promise.resolve(worldTime(18_000, true)),
        shelter: () =>
          Promise.resolve({
            kind: 'pit',
            sheltered: true,
            steps: [],
            needs: {},
            problem: null,
            walled: true,
            exit: [],
          }),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => {
          stop = 'test over';
          return Promise.resolve();
        },
        commands,
      },
      LIMITS,
      { stopRequested: () => stop },
    );
    expect(replies.some((r) => r.includes('(instead of: come to you)'))).toBe(false);
  });
});
