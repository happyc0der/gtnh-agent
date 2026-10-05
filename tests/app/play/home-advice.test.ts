import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import type { TravelStep } from '../../../src/app/play/owner-travel.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayLimits } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: agent.config.json defines locations.home, so home is the
// config's. Asked to delete it, the bot said to move it with !sethome, which then refused.
const OWNER = 'DankAxon';
const whisper = (text: string): HeardCommand => ({ sender: OWNER, text, via: 'whisper' });
const LIMITS: PlayLimits = {
  ...DEFAULT_PLAY_LIMITS,
  maxMinutes: 5,
  session: { maxCycles: 3, maxMinutes: 5, pauseMs: 0 },
};

describe('home set in agent.config.json', () => {
  it('is to be changed there, both replies say', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard = [whisper('!waypoint delete home'), whisper('!sethome')];
    const replies: string[] = [];
    const commands: CommandDeps = {
      take: () => heard.splice(0),
      waiting: () => heard.length > 0,
      reply: (_to, text) => void replies.push(text),
      clearInterrupt: () => undefined,
      view: () => ({
        position: { x: 0.5, y: 106, z: 0.5 },
        dimension: 'overworld',
        health: 20,
        food: 20,
        inventory: {},
        playerAt: () => null,
      }),
      step: (): TravelStep => ({ kind: 'refused', reason: 'x' }),
      owners: [OWNER],
      homeName: 'home',
      configLocations: new Map([
        [
          'home',
          {
            dimension: 'overworld',
            position: { x: -8.5, y: 106, z: -6.5 },
            kind: 'safe' as const,
            note: 'desert spawn',
          },
        ],
      ]),
      boundary: {
        min: { x: -256, y: 40, z: -256 },
        max: { x: 256, y: 160, z: 256 },
        allowedDimensions: ['overworld'],
      },
    };
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => Promise.resolve(),
        commands,
      },
      LIMITS,
      { stopRequested: () => null },
    );
    expect(replies).toEqual([
      'Failed: home is where I retreat to, set in agent.config.json (locations): change it there',
      'Failed: home is set in agent.config.json (locations): change it there',
    ]);
  });
});
