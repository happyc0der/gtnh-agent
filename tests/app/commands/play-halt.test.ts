import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// cli play with play itself mocked: it goes offline for the night, and the operator halts
// during that wait (the stop file).
const h = vi.hoisted(() => ({ stopFile: '', calls: 0 }));
vi.mock('../../../src/app/play/live-play.ts', () => ({
  runLivePlay: async () => {
    const { worldTime } = await import('../../../src/domain/game-state.ts');
    h.calls += 1;
    writeFileSync(h.stopFile, 'halt');
    return {
      stopReason: 'it is night (7 min until sunrise): without a shelter the agent leaves',
      night: worldTime(15_000, true),
      mobNearby: null,
      sessions: 1,
      questsCompleted: [],
      progress: null,
      elapsedMs: 1_000,
      info: { closedReason: null },
    };
  },
}));

const { playCommand } = await import('../../../src/app/commands/cli-runs.ts');
const { defaultConfig } = await import('../../../src/config/env.ts');
const { openDatabase } = await import('../../../src/persistence/database.ts');
const { createRepositories } = await import('../../../src/persistence/repositories.ts');
const { systemClock } = await import('../../../src/util/clock.ts');

let dir = '';
afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('cli play: the operator stops play while the bot waits offline', () => {
  it("ends the owners' commands with it, as a stop while online does", async () => {
    // An independent review, 2026-10-05: play's leave() ends them, but a halt during an
    // offline night (common in the desert) left the command to come back at the next play.
    dir = mkdtempSync(join(tmpdir(), 'play-halt-'));
    h.stopFile = join(dir, 'STOP');
    const dbPath = join(dir, 'agent.sqlite');
    const db = openDatabase(dbPath);
    const repos = createRepositories(db, systemClock);
    const cmd = repos.commands.add({
      source: 'chat',
      sender: 'DankAxon',
      rawText: '!get 8 logs',
      command: { verb: 'get', item: 'minecraft:log', count: 8 },
    });
    repos.commands.start(cmd.id, 'OK: getting minecraft:log until I have 8 (I have 0)');
    db.close();
    const config = defaultConfig({
      minecraft: { owners: ['DankAxon'], movement: { stopFile: h.stopFile } },
    });
    const printed: unknown[] = [];
    const code = await playCommand({
      command: 'play',
      args: [],
      values: { live: true, minutes: '60', 'max-cycles': '20', listen: true } as never,
      config,
      configFile: null,
      dbPath,
      print: (v) => void printed.push(v),
      log: undefined,
    });
    expect(code).toBe(0);
    expect(h.calls).toBe(1);
    expect(JSON.stringify(printed)).toMatch(/stopped while waiting for sunrise/);
    const after = openDatabase(dbPath);
    try {
      expect(createRepositories(after, systemClock).commands.get(cmd.id)).toMatchObject({
        status: 'cancelled',
        reply: 'Stopped: my operator stopped play',
      });
    } finally {
      after.close();
    }
  });
});
