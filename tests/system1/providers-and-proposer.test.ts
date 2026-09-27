import { describe, expect, it } from 'vitest';
import type { DecisionResult } from '../../src/domain/decisions.ts';
import { proposeAction } from '../../src/system1/action-proposer.ts';
import {
  DeterministicDecisionProvider,
  SafetyFirstDecisionProvider,
  type DecisionProvider,
} from '../../src/system1/decision-provider.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { MockDecisionProvider } from '../../src/system1/mock-decision-provider.ts';
import { makeState, routerCtx } from '../fixtures/index.ts';

describe('decision providers', () => {
  it('DeterministicDecisionProvider wraps the router', async () => {
    const state = makeState();
    expect(await new DeterministicDecisionProvider().decide(state, routerCtx())).toEqual(
      routeDecision(state, routerCtx()),
    );
  });

  it('MockDecisionProvider replays its script and repeats the last decision', async () => {
    const mock = new MockDecisionProvider([{ ...base('EAT') }, { ...base('WAIT_FOR_MACHINE') }]);
    const state = makeState();
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await mock.decide(state, routerCtx())).decision);
    expect(got).toEqual(['EAT', 'WAIT_FOR_MACHINE', 'WAIT_FOR_MACHINE']);
    expect(mock.calls).toHaveLength(3);
  });

  describe('SafetyFirstDecisionProvider', () => {
    it('lets code-level safety override a model decision', async () => {
      const provider = new SafetyFirstDecisionProvider(
        MockDecisionProvider.always('EXECUTE_KNOWN_SAFE_STEP'),
      );
      const lava = makeState((w) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.hazards = [{ kind: 'lava', position: { x: 31, y: 64, z: 30 } }];
      });
      const d = await provider.decide(lava, routerCtx());
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.provider).toBe('safety-first(mock-decision-provider)');
    });

    it('uses the inner decision when nothing is unsafe', async () => {
      const provider = new SafetyFirstDecisionProvider(
        MockDecisionProvider.always('WAIT_FOR_MACHINE'),
      );
      expect((await provider.decide(makeState(), routerCtx())).decision).toBe('WAIT_FOR_MACHINE');
    });

    it('turns invalid or throwing providers into PAUSE', async () => {
      const invalid: DecisionProvider = {
        name: 'bad',
        decide: () => Promise.resolve({ decision: 'LAUNCH_ROCKET' } as unknown as DecisionResult),
      };
      const throwing: DecisionProvider = {
        name: 'boom',
        decide: () => Promise.reject(new Error('model offline')),
      };
      for (const inner of [invalid, throwing]) {
        const d = await new SafetyFirstDecisionProvider(inner).decide(makeState(), routerCtx());
        expect(d.decision).toBe('PAUSE_AND_ASK_USER');
        expect(d.reasonCodes).toEqual(['PROVIDER_OUTPUT_INVALID']);
      }
    });
  });
});

describe('proposeAction', () => {
  const ctx = routerCtx();

  it('EAT -> EAT_FOOD with the first approved food', () => {
    const p = proposeAction(base('EAT'), makeState(), ctx);
    expect(p).toMatchObject({
      kind: 'action',
      spec: { type: 'EAT_FOOD', args: { item: 'minecraft:bread' } },
    });
  });

  it('EMPTY_INVENTORY approaches the dump container first when out of reach', () => {
    const far = makeState((w) => void (w.player.position = { x: 30, y: 64, z: 0 }));
    expect(proposeAction(base('EMPTY_INVENTORY'), far, ctx)).toMatchObject({
      spec: { type: 'MOVE_TO' },
    });
  });

  it('EMPTY_INVENTORY never deposits protected, food or fuel items', () => {
    const state = makeState((w) => {
      w.inventory.items = {
        'minecraft:diamond': 64,
        'minecraft:bread': 64,
        'minecraft:coal': 64,
        'minecraft:dirt': 3,
      };
    });
    expect(proposeAction(base('EMPTY_INVENTORY'), state, ctx)).toMatchObject({
      spec: { type: 'DEPOSIT_ITEM', args: { item: 'minecraft:dirt', quantity: 3 } },
    });
  });

  it('REFUEL_GENERATOR caps the quantity at routing.refuelQuantity', () => {
    const state = makeState((w) => void ((w.generators[0] as { fuel: object }).fuel = {}));
    expect(proposeAction(base('REFUEL_GENERATOR'), state, ctx)).toMatchObject({
      spec: {
        type: 'REFUEL_KNOWN_GENERATOR',
        args: { generatorId: 'gen.1', fuelItem: 'minecraft:coal', quantity: 8 },
      },
    });
  });

  it('REQUEST_PLANNER asks for the planner instead of an action', () => {
    expect(proposeAction(base('REQUEST_PLANNER'), makeState(), ctx).kind).toBe('planner');
  });

  it('a decision that cannot be realized becomes a pause', () => {
    const noFood = makeState((w) => void delete w.inventory.items['minecraft:bread']);
    expect(proposeAction(base('EAT'), noFood, ctx)).toMatchObject({
      spec: { type: 'PAUSE_AND_ASK_USER' },
    });
    const noStep = makeState((w) => void (w.recipe = null));
    expect(proposeAction(base('EXECUTE_KNOWN_SAFE_STEP'), noStep, ctx)).toMatchObject({
      spec: { type: 'PAUSE_AND_ASK_USER' },
    });
  });
});

function base(decision: DecisionResult['decision']): DecisionResult {
  return {
    decision,
    confidence: 0.9,
    reasonCodes: ['MOCK_DECISION'],
    factsUsed: {},
    requiresHumanConfirmation: false,
    provider: 'test',
  };
}
