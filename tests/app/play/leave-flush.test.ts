import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import { DEFAULT_PLAY_LIMITS, runPlay } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: when play ended, the client sent the last replies (a line
// a second, up to 4 s) and only then closed; what an owner whispered meanwhile (a stop, say) was
// heard by nobody and lost. Play now sends them itself, then stores what came meanwhile.
describe('play going: the last replies, then what the owners said meanwhile', () => {
  it('stores a whisper heard while the last replies go out', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [{ sender: 'DankAxon', text: '!status', via: 'whisper' }];
    const replies: string[] = [];
    let flushes = 0;
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
        playerAt: () => null,
      }),
      step: () => ({ kind: 'refused', reason: 'x' }),
      owners: ['DankAxon'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
      // While the last replies go out, the owner whispers a stop.
      flush: () => {
        flushes += 1;
        heard.push({ sender: 'DankAxon', text: 'stop', via: 'whisper' });
        return Promise.resolve();
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
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => null },
    );
    expect(flushes).toBe(1);
    expect(replies[0]).toMatch(/^at 0 64 0, health 20\/20/);
    // Kept for the next play, which takes it first.
    expect(repos.commands.recent(5).map((c) => [c.rawText, c.status])).toEqual([
      ['stop', 'queued'],
      ['!status', 'done'],
    ]);
  });
});
