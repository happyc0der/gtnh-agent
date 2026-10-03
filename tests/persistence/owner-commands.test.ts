import { describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { testClock } from '../fixtures/index.ts';

const open = () => {
  const db = openDatabase(IN_MEMORY);
  return { db, repos: createRepositories(db, testClock()) };
};

describe('owner commands in the database', () => {
  it('queue, run and finish, with the bot replies kept', () => {
    const { repos } = open();
    const come = repos.commands.add({
      source: 'chat',
      sender: 'DankAxon',
      rawText: '!come',
      command: { verb: 'come' },
    });
    const nl = repos.commands.add({
      source: 'cli',
      sender: 'DankAxon',
      rawText: 'bring me some wood',
      command: null,
    });
    expect(come).toMatchObject({ id: 1, status: 'queued', command: { verb: 'come' }, reply: null });
    expect(repos.commands.queued().map((c) => c.id)).toEqual([1, 2]);
    expect(repos.commands.hasQueuedAfter(0)).toBe(true);
    expect(repos.commands.hasQueuedAfter(2)).toBe(false);

    repos.commands.setCommand(nl.id, { verb: 'get', count: 20, item: 'minecraft:log' });
    expect(repos.commands.get(nl.id)?.command).toEqual({
      verb: 'get',
      count: 20,
      item: 'minecraft:log',
    });

    repos.commands.start(come.id, 'OK: coming to you');
    expect(repos.commands.running()).toMatchObject({ id: 1, reply: 'OK: coming to you' });
    expect(repos.commands.running()?.startedAt).not.toBeNull();
    repos.commands.setReply(come.id, 'On my way');
    repos.commands.finish(come.id, 'done', 'Done: here, 2 blocks from you');
    expect(repos.commands.running()).toBeNull();
    expect(repos.commands.get(come.id)).toMatchObject({
      status: 'done',
      reply: 'Done: here, 2 blocks from you',
    });
    expect(repos.commands.get(come.id)?.finishedAt).not.toBeNull();
    expect(repos.commands.recent(10).map((c) => c.id)).toEqual([2, 1]);
  });

  it('finds a stop queued from the command line (a running play interrupts the action for it)', () => {
    const { repos } = open();
    repos.commands.add({
      source: 'chat',
      sender: 'A_b',
      rawText: '!stop',
      command: { verb: 'stop' },
    });
    expect(repos.commands.queuedVerb('stop', 'cli')).toBeNull();
    const stop = repos.commands.add({
      source: 'cli',
      sender: 'A_b',
      rawText: 'stop',
      command: { verb: 'stop' },
    });
    expect(repos.commands.queuedVerb('stop', 'cli')?.id).toBe(stop.id);
    expect(repos.commands.queuedVerb('stop', 'cli', stop.id)).toBeNull();
  });

  it('refuses what is not a command, and re-validates rows on read', () => {
    const { db, repos } = open();
    expect(() =>
      repos.commands.add({
        source: 'chat',
        sender: 'A_b',
        rawText: 'x',
        command: { verb: 'goto', x: 1, y: 999, z: 2 },
      }),
    ).toThrow();
    expect(() => repos.commands.finish(42, 'done', 'x')).toThrow(/No owner command 42/);
    const row = repos.commands.add({ source: 'chat', sender: 'A_b', rawText: 'x', command: null });
    db.prepare('UPDATE owner_commands SET command_json = ? WHERE id = ?').run(
      '{"verb":"op","player":"Mallory"}',
      row.id,
    );
    expect(() => repos.commands.get(row.id)).toThrow();
  });

  it('named locations can be forgotten (waypoint delete)', () => {
    const { repos } = open();
    repos.locations.upsert('base', {
      dimension: 'overworld',
      position: { x: 1, y: 64, z: 2 },
      kind: 'other',
      note: null,
    });
    expect(repos.locations.delete('base')).toBe(true);
    expect(repos.locations.delete('base')).toBe(false);
    expect(repos.locations.all().has('base')).toBe(false);
  });
});
