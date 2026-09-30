import { describe, expect, it } from 'vitest';
import { ACTION_TYPES, type ActionSpec } from '../../src/domain/actions.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import { known, unknown } from '../../src/domain/known.ts';
import { classifyActionType } from '../../src/safety/forbidden-actions.ts';
import { isProtected } from '../../src/safety/protected-items.ts';
import {
  actionFingerprint,
  assessDangers,
  assessStateReliability,
  emptyFailureHistory,
  evaluateAction,
  evaluateStaticSpec,
  type FailureHistory,
} from '../../src/safety/safety-policy.ts';
import { action, makeState, safetyCtx } from '../fixtures/index.ts';

const codes = (
  spec: ActionSpec,
  state: GameState = makeState(),
  history: FailureHistory = emptyFailureHistory,
) => evaluateAction(action(spec), state, safetyCtx(), history).violations.map((v) => v.code);

describe('rule 1: coordinate boundary', () => {
  it('refuses MOVE_TO outside the boundary', () => {
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 300, y: 64, z: 0 }, tolerance: 1 } }),
    ).toContain('OUT_OF_BOUNDS');
  });

  it('refuses every world action while the player is outside the boundary or dimension', () => {
    const outside = makeState((w) => {
      w.player.position = { x: 1000, y: 64, z: 0 };
    });
    expect(assessDangers(outside, safetyCtx()).map((v) => v.code)).toContain('OUT_OF_BOUNDS');
    const r = evaluateAction(
      action({ type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } }),
      outside,
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.allowed).toBe(false);
    expect(r.requiresUserPause).toBe(true);

    const nether = makeState((w) => {
      w.player.dimension = 'the_nether';
    });
    expect(codes({ type: 'WAIT', args: { durationMs: 100 } }, nether)).toContain(
      'ACTION_NOT_ALLOWED_IN_DANGER',
    );
  });

  it('allows MOVE_TO inside the boundary', () => {
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 10, y: 64, z: 10 }, tolerance: 1 } }),
    ).toEqual([]);
  });

  it('refuses a MOVE_TO longer than maxMoveDistance', () => {
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 200, y: 64, z: 0 }, tolerance: 1 } }),
    ).toContain('MOVE_TOO_FAR');
  });
});

describe('rule 2: lava/void hazards', () => {
  const lava = { kind: 'lava' as const, position: { x: 12, y: 64, z: 10 } };

  it('refuses a MOVE_TO target near known lava', () => {
    const state = makeState((w) => {
      w.hazards = [lava];
      w.player.position = { x: 0, y: 64, z: 10 };
    });
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 10, y: 64, z: 10 }, tolerance: 1 } }, state),
    ).toContain('HAZARD_PROXIMITY');
  });

  it('treats the player standing near lava as a danger that allows only retreat', () => {
    const state = makeState((w) => {
      w.player.position = { x: 10, y: 64, z: 10 };
      w.hazards = [lava];
    });
    expect(assessDangers(state, safetyCtx()).map((v) => v.code)).toContain('HAZARD_PROXIMITY');
    expect(
      codes({ type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } }, state),
    ).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
    expect(
      codes({ type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } }, state),
    ).toEqual([]);
  });

  it('treats a lava/void flag without a position as a hazard', () => {
    const state = { ...makeState() };
    state.environmentHazards = known({
      scanRadius: 48,
      lavaNearby: false,
      voidNearby: true,
      hazards: [],
    });
    expect(assessDangers(state, safetyCtx()).map((v) => v.code)).toContain('HAZARD_PROXIMITY');
  });

  it('refuses a MOVE_TO whose destination was not covered by the hazard scan', () => {
    // The mock scans hazards 48 blocks around the player; with a 6-block avoidance radius a
    // 45-block move cannot be shown to be clear.
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 46, y: 64, z: 1 }, tolerance: 1 } }),
    ).toContain('MOVE_TOO_FAR');
    expect(
      codes({ type: 'MOVE_TO', args: { target: { x: 30, y: 64, z: 1 }, tolerance: 1 } }),
    ).toEqual([]);
  });
});

describe('observation coverage', () => {
  it('fails closed when the entity or hazard scan is smaller than the configured radius', () => {
    const base = makeState();
    const narrowThreats: GameState = {
      ...base,
      nearbyThreats: known({
        scanRadius: 8,
        hostileCount: 0,
        nearestHostileDistance: null,
        unclassifiedCount: 0,
        nearestUnclassifiedDistance: null,
      }),
    };
    expect(assessStateReliability(narrowThreats, safetyCtx()).map((v) => v.message)).toContain(
      'Entity scan covers 8 blocks, less than the threat radius 10',
    );
    const narrowHazards: GameState = {
      ...base,
      environmentHazards: known({
        scanRadius: 4,
        lavaNearby: false,
        voidNearby: false,
        hazards: [],
      }),
    };
    expect(assessStateReliability(narrowHazards, safetyCtx()).map((v) => v.code)).toEqual([
      'STATE_UNKNOWN',
    ]);
  });
});

describe('hostile and unidentified entities', () => {
  it('an unidentified entity inside the threat radius is a danger, like a hostile', () => {
    const state = makeState((w) => {
      w.player.position = { x: 20, y: 64, z: 20 };
      w.unclassified = [{ x: 24, y: 64, z: 20 }];
    });
    expect(assessDangers(state, safetyCtx()).map((v) => v.code)).toEqual([
      'UNCLASSIFIED_ENTITY_NEARBY',
    ]);
    expect(
      codes({ type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } }, state),
    ).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
    expect(
      codes({ type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } }, state),
    ).toEqual([]);
  });

  it('entities beyond the threat radius are not a danger', () => {
    const state = makeState((w) => {
      w.hostiles = [{ x: 14, y: 64, z: 1 }];
      w.unclassified = [{ x: 1, y: 64, z: 14 }];
    });
    expect(assessDangers(state, safetyCtx())).toEqual([]);
  });
});

describe('rule 3: health and hunger thresholds', () => {
  it('flags low health and low hunger as dangers', () => {
    const state = makeState((w) => {
      w.player.health = 4;
      w.player.hunger = 2;
    });
    expect(assessDangers(state, safetyCtx()).map((v) => v.code)).toEqual([
      'LOW_HEALTH',
      'LOW_HUNGER',
    ]);
  });

  it('allows eating but not other work while vitals are low', () => {
    const state = makeState((w) => {
      w.player.hunger = 2;
    });
    expect(codes({ type: 'EAT_FOOD', args: { item: 'minecraft:bread' } }, state)).toEqual([]);
    expect(
      codes({ type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } }, state),
    ).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
  });

  it('respects configured thresholds', () => {
    const ctx = safetyCtx();
    const state = makeState((w) => {
      w.player.health = 12;
    });
    expect(assessDangers(state, ctx)).toEqual([]);
    expect(
      assessDangers(state, { ...ctx, config: { ...ctx.config, minHealth: 15 } }).map((v) => v.code),
    ).toEqual(['LOW_HEALTH']);
  });
});

describe('rule 4: protected items', () => {
  it.each<ActionSpec>([
    { type: 'EAT_FOOD', args: { item: 'minecraft:diamond' } },
    {
      type: 'DEPOSIT_ITEM',
      args: { containerId: 'chest.main', item: 'minecraft:diamond', quantity: 1 },
    },
    {
      type: 'WITHDRAW_ITEM',
      args: { containerId: 'chest.main', item: 'minecraft:nether_star', quantity: 1 },
    },
    {
      type: 'REFUEL_KNOWN_GENERATOR',
      args: { generatorId: 'gen.1', fuelItem: 'minecraft:diamond', quantity: 1 },
    },
  ])('refuses $type with a protected item', (spec) => {
    const r = evaluateAction(action(spec), makeState(), safetyCtx(), emptyFailureHistory);
    expect(r.violations.map((v) => v.code)).toContain('PROTECTED_ITEM');
    expect(r.requiresUserPause).toBe(true);
  });

  it('protects every metadata variant of a protected base id', () => {
    expect(isProtected('gregtech:gt.metaitem.01@32', new Set(['gregtech:gt.metaitem.01']))).toBe(
      true,
    );
    expect(isProtected('gregtech:gt.metaitem.01', new Set(['gregtech:gt.metaitem.01@32']))).toBe(
      false,
    );
  });

  it('only eats approved food and burns approved fuel', () => {
    expect(codes({ type: 'EAT_FOOD', args: { item: 'minecraft:rotten_flesh' } })).toContain(
      'NOT_APPROVED_FOOD',
    );
    expect(
      codes({
        type: 'REFUEL_KNOWN_GENERATOR',
        args: { generatorId: 'gen.1', fuelItem: 'minecraft:log', quantity: 1 },
      }),
    ).toContain('NOT_APPROVED_FUEL');
  });
});

describe('rule 5: no world/base modification', () => {
  it.each([
    'PLACE_BLOCK',
    'BREAK_BLOCK',
    'USE_WRENCH',
    'CONFIGURE_CABLE',
    'BUILD_MULTIBLOCK',
    'DROP_ITEM',
    'ATTACK_ENTITY',
    'USE_LAVA_BUCKET',
    'RUN_SHELL_COMMAND',
  ])('%s is forbidden', (type) => {
    expect(classifyActionType(type)).toBe('forbidden');
    const r = evaluateAction(
      { ...action({ type: 'WAIT', args: { durationMs: 100 } }), type },
      makeState(),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['FORBIDDEN_MODIFICATION']);
  });

  it('every allowlisted type classifies as allowlisted', () => {
    for (const t of ACTION_TYPES) expect(classifyActionType(t)).toBe('allowlisted');
  });

  it('cannot deposit into a machine (containers must be known storage)', () => {
    expect(
      codes({
        type: 'DEPOSIT_ITEM',
        args: { containerId: 'machine.macerator.1', item: 'minecraft:dirt', quantity: 1 },
      }),
    ).toContain('UNKNOWN_TARGET');
  });
});

describe('rule 6: repeated failures', () => {
  const spec: ActionSpec = { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } };
  const failingHistory = (n: number): FailureHistory => ({
    countFailures: (taskId, fp) =>
      taskId === 'task-test' && fp === actionFingerprint(spec) ? n : 0,
  });

  it('allows up to the limit, then escalates', () => {
    expect(codes(spec, makeState(), failingHistory(1))).toEqual([]);
    const r = evaluateAction(action(spec), makeState(), safetyCtx(), failingHistory(2));
    expect(r.violations.map((v) => v.code)).toEqual(['REPEATED_FAILURE']);
    expect(r.requiresUserPause).toBe(true);
  });

  it('fingerprints are independent of argument key order', () => {
    const a = actionFingerprint({
      type: 'DEPOSIT_ITEM',
      args: { containerId: 'c', item: 'minecraft:dirt', quantity: 1 },
    });
    const b = actionFingerprint({
      type: 'DEPOSIT_ITEM',
      args: { quantity: 1, item: 'minecraft:dirt', containerId: 'c' },
    });
    expect(a).toBe(b);
  });
});

describe('rule 7: unsupported or malformed actions', () => {
  it.each([
    ['unknown type', { type: 'TELEPORT', args: {} }],
    ['not an object', 'MOVE_TO 0 64 0'],
    ['null', null],
    ['missing metadata', { type: 'WAIT', args: { durationMs: 100 } }],
  ])('%s fails closed with a pause', (_n, candidate) => {
    const r = evaluateAction(candidate, makeState(), safetyCtx(), emptyFailureHistory);
    expect(r.allowed).toBe(false);
    expect(r.requiresUserPause).toBe(true);
    expect(r.violations[0]?.code).toBe('UNSUPPORTED_ACTION');
  });
});

describe('rule 8: postconditions cannot be weakened', () => {
  it('rejects an action whose declared postcondition differs from the derived one', () => {
    const a = action({ type: 'EAT_FOOD', args: { item: 'minecraft:bread' } });
    const tampered = { ...a, expectedPostcondition: { kind: 'STATE_OBSERVED' } };
    const r = evaluateAction(tampered, makeState(), safetyCtx(), emptyFailureHistory);
    expect(r.violations.map((v) => v.code)).toContain('INVALID_POSTCONDITION');
  });
});

describe('rule 9: unknown, stale or inconsistent state fails closed', () => {
  const work: ActionSpec = { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } };

  it('stale', () => {
    const ctx = safetyCtx(undefined, new Date(Date.parse('2026-01-01T12:00:00.000Z') + 60_000));
    const r = evaluateAction(action(work), makeState(), ctx, emptyFailureHistory);
    expect(r.violations.map((v) => v.code)).toEqual(['STATE_STALE']);
  });

  it('from the future', () => {
    const ctx = safetyCtx(undefined, new Date(Date.parse('2026-01-01T12:00:00.000Z') - 10_000));
    expect(assessStateReliability(makeState(), ctx).map((v) => v.code)).toEqual([
      'STATE_INCONSISTENT',
    ]);
  });

  it.each([
    'position',
    'dimension',
    'health',
    'hunger',
    'inventory',
    'threats',
    'hazards',
  ] as const)('unknown %s', (field) => {
    const state = makeState((w) => {
      w.unobservable = [field];
    });
    expect(codes(work, state)).toEqual(['STATE_UNKNOWN']);
  });

  it('inconsistent inventory / threats / ids', () => {
    const base = makeState();
    const badInventory: GameState = {
      ...base,
      inventory: known({ items: { 'minecraft:dirt': 1 }, usedSlots: 40, capacitySlots: 36 }),
    };
    expect(assessStateReliability(badInventory, safetyCtx()).map((v) => v.code)).toContain(
      'STATE_INCONSISTENT',
    );

    const badThreats: GameState = {
      ...base,
      nearbyThreats: known({
        scanRadius: 16,
        hostileCount: 2,
        nearestHostileDistance: null,
        unclassifiedCount: 0,
        nearestUnclassifiedDistance: null,
      }),
    };
    expect(assessStateReliability(badThreats, safetyCtx()).map((v) => v.code)).toContain(
      'STATE_INCONSISTENT',
    );

    const dupIds: GameState = { ...base, machines: [...base.machines, ...base.machines] };
    expect(assessStateReliability(dupIds, safetyCtx()).map((v) => v.code)).toContain(
      'STATE_INCONSISTENT',
    );
  });

  it('still permits pausing and observing when state is unreliable', () => {
    const state = { ...makeState(), inventory: unknown('adapter cannot read inventory') };
    expect(codes({ type: 'PAUSE_AND_ASK_USER', args: { question: 'help' } }, state)).toEqual([]);
    expect(codes({ type: 'OBSERVE_STATE', args: {} }, state)).toEqual([]);
  });
});

describe('rule 10: safe defaults', () => {
  it('default config protects boundaries, requires approvals and caps retries', () => {
    const { config } = safetyCtx();
    expect(config.boundary.allowedDimensions).toEqual(['overworld']);
    expect(config.maxFailuresPerActionPerTask).toBe(2);
    expect(config.maxStateAgeMs).toBeLessThanOrEqual(5_000);
    expect(config.approvedFoods.length).toBeGreaterThan(0);
  });

  it('static checks catch unsafe plan steps without live state', () => {
    const v = evaluateStaticSpec(
      { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'nowhere' } },
      safetyCtx(),
    );
    expect(v.map((x) => x.code)).toEqual(['UNKNOWN_TARGET']);
  });
});
