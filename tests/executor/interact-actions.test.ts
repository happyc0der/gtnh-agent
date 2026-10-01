import { describe, expect, it } from 'vitest';
import type { MockFurnace, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig } from '../../src/config/env.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import type { BlockPosition } from '../../src/domain/common.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import { ActionExecutor } from '../../src/executor/action-executor.ts';
import { SqliteActionLog } from '../../src/executor/action-log.ts';
import { checkPreconditions } from '../../src/executor/preconditions.ts';
import { verifyPostcondition } from '../../src/executor/action-verifier.ts';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import { emptyFailureHistory, evaluateAction } from '../../src/safety/safety-policy.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { action, makeWorld, memoryRepos, safetyCtx } from '../fixtures/index.ts';

// The mock player stands at (1, 64, 1).
const FURNACE: BlockPosition = { x: 2, y: 64, z: 2 };
const DRIVE: BlockPosition = { x: 0, y: 64, z: 2 };
const FAR: BlockPosition = { x: 9, y: 64, z: 9 };

const furnace = (over: Partial<MockFurnace> = {}): MockFurnace => ({
  position: FURNACE,
  input: null,
  fuel: null,
  output: null,
  cookTicks: 0,
  burnTicksLeft: 0,
  fuelItemTicks: 0,
  ...over,
});

function withBlocks(more: (w: MockWorld) => void = () => undefined) {
  return (w: MockWorld): void => {
    w.furnaces = [furnace(), { ...furnace(), position: FAR }];
    w.interactables = [
      {
        position: DRIVE,
        block: 'appliedenergistics2:tile.BlockDrive',
        profile: null,
        windowSlots: 46,
        contents: [{ slot: 0, item: 'appliedenergistics2:item.cell', count: 1 }],
      },
    ];
    w.inventory.items['minecraft:planks'] = 10;
    more(w);
  };
}

/** The safety context with planks approved as fuel. */
const ctx = (now: Date = new Date('2026-01-01T12:00:00.000Z')) =>
  safetyCtx(
    defaultConfig({
      ...MOCK_CONFIG,
      safety: {
        ...MOCK_CONFIG.safety,
        approvedFuels: ['minecraft:coal', 'minecraft:planks'],
      },
    }),
    now,
  );

const interact = (position: BlockPosition): ActionSpec => ({
  type: 'INTERACT_BLOCK',
  args: { position },
});
const smelt = (
  quantity: number,
  fuelQuantity: number,
  fuel = 'minecraft:planks',
  input = 'minecraft:cobblestone',
  position = FURNACE,
): ActionSpec => ({ type: 'SMELT', args: { position, input, quantity, fuel, fuelQuantity } });
const take = (item = 'minecraft:stone', position = FURNACE): ActionSpec => ({
  type: 'TAKE_OUTPUT',
  args: { position, item },
});

const codes = (spec: ActionSpec, state: GameState, c = ctx()): string[] =>
  evaluateAction(action(spec), state, c, emptyFailureHistory).violations.map((v) => v.code);

describe('the safety policy for block interactions', () => {
  const state = makeWorld(withBlocks()).state;

  it('allows observed blocks the action may use', () => {
    expect(codes(interact(FURNACE), state)).toEqual([]);
    expect(codes(interact(DRIVE), state)).toEqual([]);
    expect(codes(smelt(4, 2), state)).toEqual([]);
    expect(codes(take(), state)).toEqual([]);
  });

  it('refuses blocks the observation does not list, or of the wrong kind (stale: replanned)', () => {
    expect(codes(interact({ x: 3, y: 64, z: 3 }), state)).toEqual(['NOT_INTERACTABLE']);
    expect(codes(smelt(1, 1, 'minecraft:planks', 'minecraft:cobblestone', DRIVE), state)).toEqual([
      'NOT_INTERACTABLE',
    ]);
    expect(codes(take('minecraft:stone', DRIVE), state)).toEqual(['NOT_INTERACTABLE']);
  });

  it('fuel must be approved (when any is added), never protected, never lava', () => {
    expect(codes(smelt(1, 1, 'minecraft:stick'), state)).toEqual(['NOT_APPROVED_FUEL']);
    expect(codes(smelt(1, 0, 'minecraft:stick'), state)).toEqual([]);
    expect(codes(smelt(1, 1, 'minecraft:diamond'), state)).toEqual(
      expect.arrayContaining(['PROTECTED_ITEM']),
    );
    expect(codes(smelt(1, 0, 'minecraft:planks', 'minecraft:diamond'), state)).toEqual([
      'PROTECTED_ITEM',
    ]);
    expect(codes(smelt(1, 1, 'minecraft:lava_bucket'), state)).toEqual(
      expect.arrayContaining(['FORBIDDEN_MODIFICATION']),
    );
    expect(codes(take('minecraft:diamond'), state)).toEqual(['PROTECTED_ITEM']);
  });

  it('the block must be inside the boundary; nothing is opened in danger or blind', () => {
    const small = safetyCtx(
      defaultConfig({
        ...MOCK_CONFIG,
        safety: {
          ...MOCK_CONFIG.safety,
          boundary: { min: { x: -10, y: 0, z: -10 }, max: { x: 2, y: 255, z: 10 } },
        },
      }),
      new Date('2026-01-01T12:00:00.000Z'),
    );
    expect(codes(interact(FURNACE), state, small)).toEqual(['OUT_OF_BOUNDS']);
    const danger = makeWorld(withBlocks((w) => w.hostiles.push({ x: 3, y: 64, z: 3 }))).state;
    expect(codes(interact(FURNACE), danger)).toEqual(['ACTION_NOT_ALLOWED_IN_DANGER']);
    const blind = makeWorld(withBlocks((w) => w.unobservable.push('blocks'))).state;
    expect(codes(interact(FURNACE), blind)).toContain('UNKNOWN_TARGET');
  });

  it('a block whose profile is never opened is refused even if a state lists it', () => {
    if (!state.interactables.known) throw new Error('interactables unknown');
    const trapped: GameState = {
      ...state,
      interactables: {
        known: true,
        value: {
          ...state.interactables.value,
          blocks: [
            ...state.interactables.value.blocks,
            {
              profile: 'trapped_chest',
              block: 'minecraft:trapped_chest',
              position: { x: 1, y: 64, z: 3 },
            },
          ],
        },
      },
    };
    expect(codes(interact({ x: 1, y: 64, z: 3 }), trapped)).toEqual(['NOT_INTERACTABLE']);
  });
});

describe('preconditions', () => {
  it('reach from the eyes, enough items (input and fuel together), room for the output', () => {
    const { state } = makeWorld(withBlocks());
    const pre = (spec: ActionSpec, s = state) =>
      checkPreconditions(action(spec), s, ctx()).failures;
    expect(pre(interact(FURNACE))).toEqual([]);
    expect(pre(interact(FAR))[0]).toMatch(/blocks from the eyes \(reach 4.5\)/);
    expect(pre(smelt(64, 10))).toEqual([]);
    expect(pre(smelt(64, 11))).toEqual(['inventory holds 10 minecraft:planks, need 11']);
    // The same item as input and fuel: both together must be there.
    expect(pre(smelt(5, 6, 'minecraft:planks', 'minecraft:planks'))).toEqual([
      'inventory holds 10 minecraft:planks, need 11',
    ]);
    const full = makeWorld(
      withBlocks((w) => {
        w.inventory.capacitySlots = 4;
      }),
    ).state;
    expect(pre(take(), full)).toEqual(['inventory is full (no empty slot for the furnace output)']);
  });
});

describe('executing and verifying with the mock world', () => {
  async function setup(more: (w: MockWorld) => void = () => undefined) {
    const { client, clock } = makeWorld(withBlocks(more));
    await client.connect();
    const repos = memoryRepos(clock);
    const executor = new ActionExecutor({
      client,
      log: new SqliteActionLog(repos),
      history: repos.actions,
      clock,
      newId: sequentialIds(),
    });
    const run = (spec: ActionSpec) =>
      executor.execute(action(spec), client.snapshot(), ctx(clock.now()), 'cyc_test');
    return { client, clock, repos, run };
  }
  it('smelts: SMELT verified, the furnace cooks while the clock runs, TAKE_OUTPUT verified', async () => {
    const { client, run } = await setup();
    const loaded = await run(smelt(4, 2));
    expect(loaded.status).toBe('succeeded');
    expect(
      loaded.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(
      expect.arrayContaining([
        'PASS inventory-delta minecraft:cobblestone',
        'PASS inventory-delta minecraft:planks',
        'PASS other-items-unchanged',
        'PASS furnace-open',
        'PASS furnace-holds-input',
      ]),
    );
    expect(client.world.inventory.items['minecraft:cobblestone']).toBe(60);
    const furnaceSeen = (s: GameState | null) =>
      s?.interactables.known === true
        ? s.interactables.value.blocks.find((b) => b.profile === 'furnace')?.furnace
        : undefined;
    // Seen while its window was open: lit, the first plank burning, one left.
    expect(furnaceSeen(loaded.stateAfter)).toMatchObject({
      burning: true,
      seen: { input: { count: 4 }, fuel: { item: 'minecraft:planks', count: 1 } },
    });

    // 25 s later (510 ticks): 2 smelted, the second plank burning. The window was closed,
    // so the contents are the ones last seen (with their time); `burning` is current.
    await run({ type: 'WAIT', args: { durationMs: 25_000 } });
    expect(furnaceSeen(client.snapshot())).toMatchObject({
      burning: true,
      seen: { input: { count: 4 } },
    });

    // 2 planks burn 600 ticks: 3 of the 4 smelted, then the fire goes out.
    await run({ type: 'WAIT', args: { durationMs: 20_000 } });
    expect(furnaceSeen(client.snapshot())?.burning).toBe(false);
    const took = await run(take());
    expect(took.status).toBe('succeeded');
    expect(took.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`)).toEqual(
      expect.arrayContaining([
        'PASS client-took',
        'PASS inventory-delta minecraft:stone',
        'PASS other-items-unchanged',
        'PASS furnace-open',
      ]),
    );
    expect(client.world.inventory.items['minecraft:stone']).toBe(3);
    expect(client.world.furnaces?.[0]).toMatchObject({
      input: { item: 'minecraft:cobblestone', count: 1 },
      output: null,
    });
    // Seen again with the window open: what is left in it.
    expect(furnaceSeen(took.stateAfter)?.seen).toMatchObject({ input: { count: 1 }, output: null });
  });

  it('a client that reports success but moves nothing fails verification', async () => {
    const { client, run } = await setup();
    client.silentNoop('SMELT');
    const out = await run(smelt(4, 2));
    expect(out.status).toBe('verification_failed');
    expect(out.verification?.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(
      expect.arrayContaining(['inventory-delta minecraft:cobblestone']),
    );
  });

  it('INTERACT_BLOCK on an observe-only block: looked at, closed, verified', async () => {
    const { run } = await setup();
    const out = await run(interact(DRIVE));
    expect(out.status).toBe('succeeded');
    expect(out.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`)).toEqual(
      expect.arrayContaining(['PASS window-seen', 'PASS window-profile', 'PASS window-state']),
    );
    expect(out.stateAfter?.blockWindow).toMatchObject({ profile: null, open: false });
  });

  it('the verifier fails closed without the window or with the wrong counts', () => {
    const { state, client } = makeWorld(withBlocks());
    const a = action(take());
    const after = client.snapshot();
    const v = verifyPostcondition({
      action: a,
      before: state,
      after,
      execution: {
        ok: true,
        code: 'OK',
        message: 'took',
        data: { item: 'minecraft:stone', taken: 2 },
      },
      ctx: ctx(),
    });
    expect(v.verified).toBe(false);
    expect(v.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual([
      'inventory-delta minecraft:stone',
      'furnace-open',
    ]);
  });
});
