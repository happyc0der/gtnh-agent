import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/persistence/database.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repositories.ts';
import { makeState, testClock } from '../fixtures/index.ts';

let dir: string;
let db: Db;
let repos: Repositories;

beforeEach(() => {
  // Isolated on-disk database per test (exercises WAL + file creation, not just :memory:).
  dir = mkdtempSync(join(tmpdir(), 'gtnh-agent-test-'));
  db = openDatabase(join(dir, 'nested', 'agent.sqlite'));
  repos = createRepositories(db, testClock());
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('apply once and are idempotent', () => {
    expect(runMigrations(db)).toEqual([]);
    const versions = db.prepare('SELECT version FROM schema_migrations').all();
    expect(versions).toEqual([{ version: 1 }]);
  });

  it('create every required table', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'tasks',
        'task_checkpoints',
        'state_snapshots',
        'action_logs',
        'agent_events',
        'safety_violations',
        'named_locations',
        'protected_items',
      ]),
    );
  });

  it('reject out-of-order migration lists', () => {
    const fresh = openDatabase(IN_MEMORY, []);
    expect(() => runMigrations(fresh, [...MIGRATIONS, ...MIGRATIONS])).toThrow(
      /strictly increasing/,
    );
  });
});

describe('repositories', () => {
  it('tasks: ensure is idempotent and keeps status; setStatus validates existence', () => {
    repos.tasks.ensure({ id: 't1', goal: 'g', subgoal: null, status: 'active' });
    repos.tasks.setStatus('t1', 'paused');
    const again = repos.tasks.ensure({ id: 't1', goal: 'g2', subgoal: 's', status: 'active' });
    expect(again).toMatchObject({ goal: 'g2', subgoal: 's', status: 'paused' });
    expect(() => repos.tasks.setStatus('missing', 'active')).toThrow();
  });

  it('checkpoints: sequence numbers increase per task', () => {
    repos.tasks.ensure({ id: 't1', goal: 'g', subgoal: null, status: 'active' });
    repos.checkpoints.add('t1', 'a', { n: 1 }, null);
    repos.checkpoints.add('t1', 'b', { n: 2 }, null);
    expect(repos.checkpoints.list('t1').map((c) => [c.seq, c.label, c.data])).toEqual([
      [1, 'a', { n: 1 }],
      [2, 'b', { n: 2 }],
    ]);
  });

  it('checkpoints: foreign key to tasks is enforced', () => {
    expect(() => repos.checkpoints.add('no-such-task', 'x', {}, null)).toThrow();
  });

  it('snapshots round-trip through schema validation', () => {
    const state = makeState();
    const id = repos.snapshots.insert('cyc_1', state);
    expect(repos.snapshots.get(id)).toEqual(state);
    expect(repos.snapshots.count()).toBe(1);
  });

  it('action logs: lifecycle updates and failure counting per task + fingerprint', () => {
    const base = {
      cycleId: 'c',
      origin: 'test',
      reason: 'r',
      action: {},
      validation: { ok: true },
    };
    repos.actions.insert({
      ...base,
      actionId: 'a1',
      taskId: 't1',
      actionType: 'WAIT',
      fingerprint: 'fp',
      status: 'proposed',
    });
    repos.actions.insert({
      ...base,
      actionId: 'a2',
      taskId: 't1',
      actionType: 'WAIT',
      fingerprint: 'fp',
      status: 'proposed',
    });
    repos.actions.insert({
      ...base,
      actionId: 'a3',
      taskId: 't2',
      actionType: 'WAIT',
      fingerprint: 'fp',
      status: 'proposed',
    });
    repos.actions.update('a1', { status: 'failed', execution: { ok: false } });
    repos.actions.update('a2', { status: 'verification_failed' });
    repos.actions.update('a3', { status: 'failed' });

    expect(repos.actions.countFailures('t1', 'fp')).toBe(2);
    expect(repos.actions.countFailures('t2', 'fp')).toBe(1);
    expect(repos.actions.countFailures(null, 'fp')).toBe(0);
    expect(repos.actions.get('a1')).toMatchObject({
      status: 'failed',
      execution: { ok: false },
      verification: null,
    });
    expect(repos.actions.failureSummary('t1', 5)).toEqual([
      { actionType: 'WAIT', fingerprint: 'fp', failures: 2 },
    ]);
    expect(() => repos.actions.update('nope', { status: 'failed' })).toThrow();
  });

  it('action logs: the status CHECK constraint rejects unknown statuses', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO action_logs VALUES ('x', NULL, NULL, 'WAIT', 'test', 'fp', 'r', '{}', 'yolo', NULL, NULL, NULL, 't', 't')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('safety violations, events, locations and protected items', () => {
    repos.violations.insertMany('c', 'a1', [
      { code: 'PROTECTED_ITEM', severity: 'pause', message: 'm', details: { item: 'x' } },
    ]);
    expect(repos.violations.recent(1)[0]).toMatchObject({
      code: 'PROTECTED_ITEM',
      details: { item: 'x' },
      actionId: 'a1',
    });

    repos.events.append('c', 'DECISION', { decision: 'EAT' });
    expect(repos.events.forCycle('c')).toMatchObject([
      { kind: 'DECISION', payload: { decision: 'EAT' } },
    ]);

    repos.locations.upsert('home', {
      dimension: 'overworld',
      position: { x: 1, y: 2, z: 3 },
      kind: 'safe',
      note: null,
    });
    expect(repos.locations.all().get('home')?.position).toEqual({ x: 1, y: 2, z: 3 });

    repos.protectedItems.syncFromConfig(['minecraft:diamond']);
    repos.protectedItems.add('minecraft:emerald', 'user said so', 'user');
    repos.protectedItems.syncFromConfig([]); // removal from config does not unprotect
    expect(repos.protectedItems.items()).toEqual(['minecraft:diamond', 'minecraft:emerald']);
  });

  it('transactions roll back every write on error', () => {
    expect(() =>
      repos.transaction(() => {
        repos.tasks.ensure({ id: 't9', goal: 'g', subgoal: null, status: 'active' });
        repos.events.append('c', 'ERROR', {});
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repos.tasks.get('t9')).toBeNull();
    expect(repos.events.forCycle('c')).toEqual([]);
  });
});
