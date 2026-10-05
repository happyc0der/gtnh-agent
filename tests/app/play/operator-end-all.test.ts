import { describe, expect, it } from 'vitest';
import type { CommandDeps } from '../../../src/app/play/commands.ts';
import { DEFAULT_PLAY_LIMITS, runPlay } from '../../../src/app/play/play.ts';
import type { HeardCommand } from '../../../src/domain/owner-commands.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';

// Review 25, 2026-10-05: endOwnerCommands after an operator stop: who is told what, and what ends.
describe('operator stop ends every command, each told once at most', () => {
  it('replies and statuses', async () => {
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    const heard: HeardCommand[] = [];
    const replies: Array<[string, string]> = [];
    let flushes = 0;
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
      step: () => ({ kind: 'refused', reason: 'x' }),
      owners: ['A', 'B'],
      homeName: 'home',
      configLocations: new Map(),
      boundary: {
        min: { x: -256, y: 0, z: -256 },
        max: { x: 256, y: 255, z: 256 },
        allowedDimensions: ['overworld'],
      },
      translate: () => Promise.resolve({ ok: false, reason: 'no model' }),
      flush: () => {
        flushes += 1;
        if (flushes === 1) {
          heard.push({ sender: 'A', text: '!pause', via: 'whisper' });
          heard.push({ sender: 'B', text: '!home', via: 'whisper' });
        }
        return Promise.resolve();
      },
    };
    const running = repos.commands.add({
      source: 'chat',
      sender: 'A',
      rawText: '!follow',
      command: { verb: 'follow', player: null },
    });
    repos.commands.start(running.id, 'OK: following you');
    repos.commands.add({
      source: 'chat',
      sender: 'B',
      rawText: '!come',
      command: { verb: 'come' },
    });
    repos.commands.add({
      source: 'chat',
      sender: 'A',
      rawText: '!status',
      command: { verb: 'status' },
    });
    repos.commands.add({ source: 'chat', sender: 'B', rawText: 'come here pls', command: null });
    await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        session: () => Promise.reject(new Error('no session expected')),
        sleep: () => Promise.resolve(),
        commands,
      },
      DEFAULT_PLAY_LIMITS,
      { stopRequested: () => 'the stop file STOP exists', operatorStopped: () => true },
    );
    expect(repos.commands.queued()).toEqual([]);
    expect(repos.commands.running()).toBeNull();
    // Each action command's sender told once per command; nobody told twice for one command.
    const perSender = (s: string): number => replies.filter(([to]) => to === s).length;
    expect(perSender('A')).toBe(2); // the follow, and the !pause heard during the flush
    expect(perSender('B')).toBe(2); // the come, and the !home heard during the flush
  });
});
