import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, runMigrations, type Db } from '../../src/persistence/database.ts';
import { MIGRATIONS } from '../../src/persistence/migrations/index.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repositories.ts';
import type { Plan } from '../../src/planner/plan-schema.ts';
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
    expect(versions).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
      { version: 7 },
    ]);
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
    // An operator's own failed request does not count against the agent's attempts.
    repos.actions.insert({
      ...base,
      origin: 'user',
      actionId: 'a4',
      taskId: 't1',
      actionType: 'WAIT',
      fingerprint: 'fp',
      status: 'proposed',
    });
    // An action the client could not even try (NOT_IMPLEMENTED) is no failed attempt either.
    repos.actions.insert({
      ...base,
      actionId: 'a5',
      taskId: 't1',
      actionType: 'WAIT',
      fingerprint: 'fp',
      status: 'proposed',
    });
    repos.actions.update('a1', { status: 'failed', execution: { ok: false } });
    repos.actions.update('a2', { status: 'verification_failed' });
    repos.actions.update('a3', { status: 'failed' });
    repos.actions.update('a4', { status: 'failed' });
    repos.actions.update('a5', {
      status: 'failed',
      execution: { ok: false, code: 'NOT_IMPLEMENTED', message: 'not available', data: {} },
    });

    expect(repos.actions.countFailures('t1', 'fp')).toBe(2);
    expect(repos.actions.failureSummary('t1', 10)).toEqual([
      { actionType: 'WAIT', fingerprint: 'fp', failures: 3 },
    ]);
    expect(repos.actions.countFailures('t2', 'fp')).toBe(1);
    expect(repos.actions.countFailures(null, 'fp')).toBe(0);
    expect(repos.actions.get('a1')).toMatchObject({
      status: 'failed',
      execution: { ok: false },
      verification: null,
    });
    // The planner's failure summary is information, so it includes the operator's failure.
    expect(repos.actions.failureSummary('t1', 5)).toEqual([
      { actionType: 'WAIT', fingerprint: 'fp', failures: 3 },
    ]);
    expect(() => repos.actions.update('nope', { status: 'failed' })).toThrow();
  });

  it("action logs: the agent's recent meals, newest first (Spice of Life's history)", () => {
    const eat = (actionId: string, item: string, status: 'succeeded' | 'failed'): void => {
      repos.actions.insert({
        actionId,
        cycleId: 'c',
        taskId: 't1',
        actionType: 'EAT_FOOD',
        origin: 'deterministic-router',
        fingerprint: `EAT_FOOD:${item}`,
        reason: 'r',
        action: { type: 'EAT_FOOD', args: { item } },
        status: 'proposed',
        validation: { ok: true },
      });
      repos.actions.update(actionId, { status });
    };
    eat('m1', 'minecraft:apple', 'succeeded');
    eat('m2', 'minecraft:carrot', 'succeeded');
    eat('m3', 'minecraft:bread', 'failed'); // not eaten
    eat('m4', 'harvestcraft:strawberryItem', 'succeeded');
    repos.actions.insert({
      actionId: 'w1',
      cycleId: 'c',
      taskId: 't1',
      actionType: 'WAIT',
      origin: 'test',
      fingerprint: 'fp',
      reason: 'r',
      action: { type: 'WAIT', args: { durationMs: 100 } },
      status: 'succeeded',
      validation: { ok: true },
    });
    expect(repos.actions.recentMeals(20)).toEqual([
      'harvestcraft:strawberryItem',
      'minecraft:carrot',
      'minecraft:apple',
    ]);
    expect(repos.actions.recentMeals(2)).toEqual([
      'harvestcraft:strawberryItem',
      'minecraft:carrot',
    ]);
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

describe('plans', () => {
  const plan = (goal: string): Plan => ({
    goal,
    steps: [
      {
        step: 1,
        action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
        rationale: 'first look',
      },
      {
        step: 2,
        action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
        rationale: 'second look',
      },
    ],
    requiresUserApproval: false,
    explanation: 'test plan',
    failureHandling: {
      onStepFailure: 'PAUSE_AND_ASK_USER',
      maxRetriesPerStep: 1,
      escalationMessage: 'stop',
    },
  });

  beforeEach(() => {
    repos.tasks.ensure({ id: 'task-a', goal: 'A', subgoal: null, status: 'active' });
  });

  it('keeps at most one open plan per task (a new plan supersedes the old one)', () => {
    const first = repos.plans.create('task-a', plan('first'), 'pending_approval', 'mock');
    expect(repos.plans.openForTask('task-a')?.id).toBe(first.id);
    const second = repos.plans.create('task-a', plan('second'), 'active', 'mock');
    expect(repos.plans.get(first.id)).toMatchObject({
      status: 'superseded',
      statusReason: 'replaced by a newer plan',
    });
    expect(repos.plans.openForTask('task-a')?.id).toBe(second.id);
    expect(repos.plans.listOpen().map((p) => p.id)).toEqual([second.id]);
  });

  it('advances step by step, resets failures, and completes after the last step', () => {
    const p = repos.plans.create('task-a', plan('advance'), 'active', 'mock');
    expect(repos.plans.recordStepFailure(p.id)).toBe(1);
    expect(repos.plans.recordStepFailure(p.id)).toBe(2);
    expect(repos.plans.advance(p.id)).toMatchObject({
      nextStep: 1,
      stepFailures: 0,
      status: 'active',
    });
    expect(repos.plans.advance(p.id)).toMatchObject({
      nextStep: 2,
      status: 'completed',
      statusReason: 'all steps verified',
    });
    expect(repos.plans.openForTask('task-a')).toBeNull();
    expect(repos.plans.latestForTask('task-a')?.id).toBe(p.id);
  });

  it('does not advance a plan that stopped being active', () => {
    const p = repos.plans.create('task-a', plan('stopped'), 'active', 'mock');
    repos.plans.setStatus(p.id, 'rejected', 'no');
    expect(repos.plans.advance(p.id)).toMatchObject({ status: 'rejected', nextStep: 0 });
  });

  it('refuses invalid plans, unknown tasks and unknown plan ids', () => {
    const bad = { ...plan('bad'), steps: [] } as unknown as Plan;
    expect(() => repos.plans.create('task-a', bad, 'active', 'mock')).toThrow();
    expect(() => repos.plans.create('task-missing', plan('x'), 'active', 'mock')).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => repos.plans.setStatus(999, 'failed')).toThrow(/No plan 999/);
    expect(repos.plans.get(999)).toBeNull();
  });
});
