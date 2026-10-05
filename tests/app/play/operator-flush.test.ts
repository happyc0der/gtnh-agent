import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import { DEFAULT_PLAY_LIMITS, runPlay } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// An independent review, 2026-10-05: an operator stop ends the owners' commands, but one
// whispered while the last replies went out was stored afterwards and ran unannounced at the
// next play. It ends with play too now.
describe('operator stop, then a whisper during the last replies', () => {
  it('does not leave an action command queued for the next play', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: string[] = [];
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
      step: () => ({ kind: 'refused', reason: 'x' }),
      owners: ['DankAxon'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
      // While "Stopped: my operator stopped play" goes out, the owner asks for something new.
      flush: () => {
        heard.push({ sender: 'DankAxon', text: '!get 64 logs', via: 'whisper' });
        return Promise.resolve();
      },
    };
    // A command was running when the operator ran `cli halt` (the stop file).
    const running = repos.commands.add({
      source: 'chat',
      sender: 'DankAxon',
      rawText: '!follow',
      command: { verb: 'follow', player: null },
    });
    repos.commands.start(running.id, 'OK: following you');
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => Promise.resolve(),
        commands,
      },
      DEFAULT_PLAY_LIMITS,
      {
        stopRequested: () => 'the stop file STOP exists',
        operatorStopped: () => true,
      },
    );
    expect(repos.commands.get(running.id)?.status).toBe('cancelled');
    // The !get heard while play went ends with play too.
    expect(repos.commands.queued().map((c) => c.rawText)).toEqual([]);
  });
});
