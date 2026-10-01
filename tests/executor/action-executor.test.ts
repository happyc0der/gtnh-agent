import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import { mintValidatedAction, type ValidatedAction } from '../../src/domain/validated-action.ts';
import { ActionExecutor } from '../../src/executor/action-executor.ts';
import { SqliteActionLog } from '../../src/executor/action-log.ts';
import { checkPreconditions } from '../../src/executor/preconditions.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { action, makeWorld, memoryRepos, safetyCtx } from '../fixtures/index.ts';

async function setup(mutate: (w: MockWorld) => void = () => undefined) {
  const { client, clock, state } = makeWorld(mutate);
  await client.connect();
  const repos = memoryRepos(clock);
  const executor = new ActionExecutor({
    client,
    log: new SqliteActionLog(repos),
    history: repos.actions,
    clock,
    newId: sequentialIds(),
  });
  const run = (candidate: unknown) =>
    executor.execute(candidate, state, safetyCtx(undefined, clock.now()), 'cyc_test');
  return { client, repos, state, run };
}

describe('ActionExecutor', () => {
  it('validates, executes, verifies and persists a successful action', async () => {
    const { client, repos, run } = await setup((w) => void (w.player.hunger = 10));
    const a = action({ type: 'EAT_FOOD', args: { item: 'minecraft:bread' } });
    const out = await run(a);

    expect(out.status).toBe('succeeded');
    expect(out.verification?.verified).toBe(true);
    expect(client.world.player.hunger).toBe(15);
    expect(client.performed).toHaveLength(1);

    const log = repos.actions.get(a.actionId);
    expect(log?.status).toBe('succeeded');
    expect(log?.validation).toMatchObject({ ok: true });
    expect(log?.execution).toMatchObject({ ok: true, code: 'OK' });
    expect(log?.verification).toMatchObject({ verified: true });
    expect(repos.events.forCycle('cyc_test').map((e) => e.kind)).toEqual([
      'PROPOSAL',
      'VALIDATION',
      'EXECUTION',
      'VERIFICATION',
    ]);
  });

  it('rejects unsafe actions without touching the client, and logs the violation', async () => {
    const { client, repos, run } = await setup();
    const a = action({
      type: 'DEPOSIT_ITEM',
      args: { containerId: 'chest.main', item: 'minecraft:diamond', quantity: 1 },
    });
    const out = await run(a);

    expect(out.status).toBe('rejected');
    expect(client.performed).toHaveLength(0);
    expect(repos.actions.get(a.actionId)?.status).toBe('rejected');
    expect(repos.violations.recent(5).map((v) => v.code)).toEqual(['PROTECTED_ITEM']);
  });

  it('rejects and logs malformed, non-allowlisted candidates', async () => {
    const { client, repos, run } = await setup();
    const out = await run({
      actionId: 'act_evil',
      type: 'BREAK_BLOCK',
      args: { x: 0, y: 64, z: 0 },
    });
    expect(out.status).toBe('rejected');
    expect(out.validation.violations[0]?.code).toBe('FORBIDDEN_MODIFICATION');
    expect(client.performed).toHaveLength(0);
    expect(repos.actions.get('act_evil')).toMatchObject({
      status: 'rejected',
      actionType: 'BREAK_BLOCK',
    });
  });

  it('blocks on failed preconditions (out of reach)', async () => {
    const { client, run } = await setup((w) => void (w.player.position = { x: 20, y: 64, z: 20 }));
    const out = await run(
      action({ type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } }),
    );
    expect(out.status).toBe('rejected');
    expect(out.validation.preconditionFailures[0]).toMatch(/blocks away/);
    expect(client.performed).toHaveLength(0);
  });

  it('explores in the mock world: validated, walked straight, verified', async () => {
    const { client, run } = await setup();
    const out = await run(action({ type: 'EXPLORE', args: { toward: 'south', maxDistance: 24 } }));
    expect(out.status).toBe('succeeded');
    expect(client.world.player.position).toEqual({ x: 1, y: 64, z: 25 });
  });

  it('records client failures as failed', async () => {
    const { client, repos, run } = await setup();
    client.failNext('INSPECT_MACHINE', 'GUI did not open');
    const a = action({ type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } });
    const out = await run(a);
    expect(out.status).toBe('failed');
    expect(out.verification?.verified).toBe(false);
    expect(
      repos.actions.countFailures('task-test', repos.actions.get(a.actionId)?.fingerprint ?? ''),
    ).toBe(1);
  });

  it('catches a client that reports success without doing anything', async () => {
    const { client, run } = await setup();
    client.silentNoop('DEPOSIT_ITEM');
    const out = await run(
      action({
        type: 'DEPOSIT_ITEM',
        args: { containerId: 'chest.main', item: 'minecraft:cobblestone', quantity: 64 },
      }),
    );
    expect(out.status).toBe('verification_failed');
    expect(out.verification?.checks.find((c) => c.name === 'player-inventory-delta')?.passed).toBe(
      false,
    );
  });

  it('turns a throwing client into a failed action', async () => {
    const { client, run } = await setup();
    client.perform = () => Promise.reject(new Error('socket closed'));
    const out = await run(action({ type: 'WAIT', args: { durationMs: 100 } }));
    expect(out.status).toBe('failed');
    expect(out.execution?.message).toMatch(/socket closed/);
  });
});

describe('ValidatedAction token', () => {
  it('the client refuses forged or unminted tokens', async () => {
    const { client } = makeWorld();
    await client.connect();
    const a = action({ type: 'WAIT', args: { durationMs: 100 } });
    const forged = {
      action: a,
      resolvedTarget: null,
      validatedAt: new Date().toISOString(),
    } as unknown as ValidatedAction;
    expect(() => client.perform(forged)).toThrow(/not minted/);
  });

  it('minted tokens are frozen copies', () => {
    const a = action({ type: 'WAIT', args: { durationMs: 100 } });
    const token = mintValidatedAction(a, null, new Date());
    expect(Object.isFrozen(token.action)).toBe(true);
    (a.args as { durationMs: number }).durationMs = 60_000;
    expect(token.action.args).toEqual({ durationMs: 100 });
  });
});

describe('preconditions', () => {
  const pre = (spec: ActionSpec, mutate: (w: MockWorld) => void = () => undefined) =>
    checkPreconditions(action(spec), makeWorld(mutate).state, safetyCtx());

  it('resolve safe locations to a target', () => {
    expect(
      pre({ type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } }).resolvedTarget,
    ).toEqual({ x: 0, y: 64, z: 0 });
  });

  it('require items, reach, known containers and free space', () => {
    expect(pre({ type: 'EAT_FOOD', args: { item: 'minecraft:cooked_beef' } }).failures).toContain(
      'no minecraft:cooked_beef in inventory',
    );
    expect(
      pre({
        type: 'DEPOSIT_ITEM',
        args: { containerId: 'chest.main', item: 'minecraft:coal', quantity: 99 },
      }).ok,
    ).toBe(false);
    expect(
      pre({
        type: 'WITHDRAW_ITEM',
        args: { containerId: 'chest.main', item: 'minecraft:dirt', quantity: 1 },
      }).ok,
    ).toBe(false);
    expect(pre({ type: 'OPEN_CONTAINER', args: { containerId: 'nope' } }).ok).toBe(false);
    expect(
      pre(
        { type: 'EAT_FOOD', args: { item: 'minecraft:bread' } },
        (w) => void (w.player.hunger = 20),
      ).failures,
    ).toContain('player is not hungry');
  });

  it('EXPLORE needs the position, and a point target at least 2 blocks away', () => {
    expect(pre({ type: 'EXPLORE', args: { toward: 'east', maxDistance: 16 } }).ok).toBe(true);
    expect(
      pre({ type: 'EXPLORE', args: { toward: { x: 2, z: 1.5 }, maxDistance: 16 } }).failures,
    ).toEqual(['the EXPLORE target is only 1.1 blocks away']);
    expect(
      pre(
        { type: 'EXPLORE', args: { toward: 'east', maxDistance: 16 } },
        (w) => void (w.unobservable = ['position']),
      ).failures,
    ).toEqual(['player position is unknown']);
  });

  it('a dig needs the block within reach of the eyes and room for the drop', () => {
    const dig = (x: number, y: number, z: number): ActionSpec => ({
      type: 'DIG_BLOCK',
      args: { position: { x, y, z } },
    });
    expect(pre(dig(2, 64, 1)).ok).toBe(true);
    // The player stands at (1, 64, 1): eyes at y 65.62. Reach is measured to block centres.
    expect(pre(dig(-2, 64, 4)).ok).toBe(true); // 4.44 blocks
    expect(pre(dig(-2, 64, 5)).failures).toEqual([
      'block (-2, 64, 5) is 5.3 blocks from the eyes (reach 4.5)',
    ]);
    const full = pre(dig(2, 64, 1), (w) => {
      w.inventory.capacitySlots = 5;
    });
    expect(full.failures).toEqual(['inventory is full (no room for the drop)']);
  });

  it('crafting needs the ingredients, and a known crafting table within reach for 3x3', () => {
    const craft = (
      recipe: 'planks_oak' | 'chest',
      times: number,
      craftingTableId: string | null,
    ): ActionSpec => ({ type: 'CRAFT_ITEM', args: { recipe, times, craftingTableId } });
    const withLogs = (w: MockWorld): void => {
      Object.assign(w.inventory.items, {
        'minecraft:log': 3,
        'minecraft:log@2': 2,
        'minecraft:planks@1': 4,
        'minecraft:flint': 1,
      });
    };
    expect(pre(craft('planks_oak', 3, null), withLogs).ok).toBe(true);
    expect(pre(craft('planks_oak', 4, null), withLogs).failures).toEqual([
      'inventory holds 3 of minecraft:log, need 4 for 4 x planks_oak',
    ]);
    // Any mix of log and plank kinds counts toward the chest's needs.
    expect(pre(craft('chest', 1, 'table.main'), withLogs).ok).toBe(true);
    expect(pre(craft('chest', 1, null), withLogs).failures).toEqual([
      'chest needs a crafting table (its pattern does not fit 2x2)',
    ]);
    expect(pre(craft('chest', 1, 'table.nope'), withLogs).failures).toEqual([
      'crafting table table.nope is not known',
    ]);
    const far = pre(craft('chest', 1, 'table.main'), (w) => {
      withLogs(w);
      w.player.position = { x: 20, y: 64, z: 20 };
    });
    expect(far.failures[0]).toMatch(/crafting table table.main is .* blocks away/);
  });
});
