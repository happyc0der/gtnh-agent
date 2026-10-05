import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import { DEFAULT_PLAY_LIMITS, runPlay } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { OWNER_PAUSED_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 24, 2026-10-05: 50522c3's leave() cancels only ACTION commands heard during the flush after an
// operator stop. An instant one (a !stop, here) stays queued, and the next `cli play` (which
// clears owner_paused when it starts: "a fresh play") takes it first and pauses itself.
describe('operator stop, then "!stop" whispered during the last replies', () => {
  it('the next play is not paused by it', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
    let flushes = 0;
    const commands = (): CommandDeps => ({
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
      step: () => ({ kind: 'refused', reason: 'x' }),
      owners: ['DankAxon'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
      flush: () => {
        flushes += 1;
        if (flushes === 1) heard.push({ sender: 'DankAxon', text: '!stop', via: 'whisper' });
        return Promise.resolve();
      },
    });
    const running = repos.commands.add({
      source: 'chat',
      sender: 'DankAxon',
      rawText: '!follow',
      command: { verb: 'follow', player: null },
    });
    repos.commands.start(running.id, 'OK: following you');
    // Play 1: the operator's `cli halt`.
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => Promise.resolve(),
        commands: commands(),
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => 'the stop file STOP exists', operatorStopped: () => true },
    );
    // Play 2, days later: `cli play` clears owner_paused as it starts (cli-runs.ts).
    repos.memory.setValue(OWNER_PAUSED_KEY, null);
    replies.length = 0;
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => Promise.resolve(),
        commands: commands(),
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => null },
    );
    expect(repos.memory.getValue(OWNER_PAUSED_KEY)).toBeNull();
  });
});
