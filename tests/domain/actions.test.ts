import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  ActionSchema,
  ActionSpecSchema,
  createAction,
  expectedPostconditionFor,
  type ActionSpec,
} from '../../src/domain/actions.ts';
import { GameStateSchema } from '../../src/domain/game-state.ts';
import { makeState } from '../fixtures/index.ts';

const deps = { newId: (p: string) => `${p}_0001`, now: () => new Date('2026-01-01T00:00:00.000Z') };

const oneOfEach: ActionSpec[] = [
  { type: 'OBSERVE_STATE', args: {} },
  { type: 'MOVE_TO', args: { target: { x: 1, y: 64, z: 1 }, tolerance: 1 } },
  { type: 'WAIT', args: { durationMs: 1000 } },
  { type: 'EAT_FOOD', args: { item: 'minecraft:bread' } },
  { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } },
  { type: 'OPEN_CONTAINER', args: { containerId: 'chest.main' } },
  {
    type: 'DEPOSIT_ITEM',
    args: { containerId: 'chest.main', item: 'minecraft:dirt', quantity: 1 },
  },
  {
    type: 'WITHDRAW_ITEM',
    args: { containerId: 'chest.main', item: 'minecraft:dirt', quantity: 1 },
  },
  { type: 'INSPECT_MACHINE', args: { machineId: 'm1' } },
  {
    type: 'REFUEL_KNOWN_GENERATOR',
    args: { generatorId: 'g1', fuelItem: 'minecraft:coal', quantity: 1 },
  },
  { type: 'DIG_BLOCK', args: { position: { x: -8, y: 200, z: -11 } } },
  { type: 'PAUSE_AND_ASK_USER', args: { question: 'ok?' } },
];

describe('action model', () => {
  it('covers exactly the allowlist', () => {
    expect(oneOfEach.map((s) => s.type).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('createAction attaches metadata and the code-derived postcondition', () => {
    for (const spec of oneOfEach) {
      const a = createAction({ spec, reason: 'r', origin: 'test', taskId: null }, deps);
      expect(a.actionId).toBe('act_0001');
      expect(a.expectedPostcondition).toEqual(expectedPostconditionFor(spec));
      expect(ActionSchema.safeParse(a).success).toBe(true);
    }
  });

  it.each([
    ['unknown type', { type: 'PLACE_BLOCK', args: {} }],
    ['extra field', { type: 'WAIT', args: { durationMs: 100, extra: 1 } }],
    ['wait too long', { type: 'WAIT', args: { durationMs: 3_600_000 } }],
    [
      'zero quantity',
      { type: 'DEPOSIT_ITEM', args: { containerId: 'c', item: 'minecraft:dirt', quantity: 0 } },
    ],
    ['bad item id', { type: 'EAT_FOOD', args: { item: 'bread; rm -rf /' } }],
    [
      'non-finite coordinate',
      { type: 'MOVE_TO', args: { target: { x: Infinity, y: 64, z: 0 }, tolerance: 1 } },
    ],
    [
      'huge refuel',
      {
        type: 'REFUEL_KNOWN_GENERATOR',
        args: { generatorId: 'g', fuelItem: 'minecraft:coal', quantity: 65 },
      },
    ],
    [
      'a dig at a point, not a block',
      { type: 'DIG_BLOCK', args: { position: { x: 1.5, y: 64, z: 0 } } },
    ],
    ['a dig above the world', { type: 'DIG_BLOCK', args: { position: { x: 1, y: 256, z: 0 } } }],
    [
      'a dig with extra args',
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 64, z: 0 }, radius: 3 } },
    ],
    [
      'breaking by another name',
      { type: 'BREAK_BLOCK', args: { position: { x: 1, y: 64, z: 0 } } },
    ],
  ])('rejects %s', (_name, spec) => {
    expect(ActionSpecSchema.safeParse(spec).success).toBe(false);
    expect(() =>
      createAction({ spec: spec as ActionSpec, reason: 'r', origin: 'test', taskId: null }, deps),
    ).toThrow();
  });

  it('rejects an unknown origin', () => {
    const a = createAction(
      { spec: oneOfEach[0] as ActionSpec, reason: 'r', origin: 'test', taskId: null },
      deps,
    );
    expect(ActionSchema.safeParse({ ...a, origin: 'llm-direct' }).success).toBe(false);
  });
});

describe('game state schema', () => {
  it('accepts a mock observation and rejects extra fields', () => {
    const state = makeState();
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(GameStateSchema.safeParse({ ...state, surprise: true }).success).toBe(false);
  });

  it('represents unobservable values explicitly', () => {
    const state = makeState((w) => {
      w.unobservable = ['health'];
    });
    expect(state.player.health).toEqual({ known: false, reason: 'mock: health hidden' });
    expect(state.power.availableEUt.known).toBe(false);
  });

  it('reads a snapshot stored before nearbyBlocks existed as "nearby blocks unknown"', () => {
    const older: Record<string, unknown> = { ...makeState() };
    delete older['nearbyBlocks'];
    const parsed = GameStateSchema.parse(older);
    expect(parsed.nearbyBlocks).toEqual({
      known: false,
      reason: 'not reported by this observation',
    });
  });

  it('lists only allowlisted blocks as diggable resources', () => {
    const state = makeState();
    if (!state.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const withStone = {
      ...state,
      nearbyBlocks: {
        known: true,
        value: {
          ...state.nearbyBlocks.value,
          resources: [{ block: 'minecraft:stone', position: { x: 0, y: 64, z: 0 } }],
        },
      },
    };
    expect(GameStateSchema.safeParse(withStone).success).toBe(false);
  });
});
