import { describe, expect, it } from 'vitest';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import { defaultConfig } from '../../src/config/env.ts';
import { ACTION_TYPES, type ActionSpec } from '../../src/domain/actions.ts';
import type { PlaceableItem } from '../../src/domain/blocks.ts';
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

  it('never crafts with a protected ingredient (any kind the recipe may use counts)', () => {
    const ctx = safetyCtx(
      defaultConfig({ safety: { protectedItems: ['minecraft:planks@3', 'minecraft:coal'] } }),
    );
    const craft = (recipe: 'sticks' | 'torch_charcoal' | 'planks_oak'): string[] =>
      evaluateAction(
        action({ type: 'CRAFT_ITEM', args: { recipe, times: 1, craftingTableId: null } }),
        makeState(),
        ctx,
        emptyFailureHistory,
      ).violations.map((v) => v.code);
    // Sticks may use jungle planks (@3), which are protected: refused as a whole.
    expect(craft('sticks')).toContain('PROTECTED_ITEM');
    // Protecting minecraft:coal protects charcoal (minecraft:coal@1) too.
    expect(craft('torch_charcoal')).toContain('PROTECTED_ITEM');
    expect(craft('planks_oak')).toEqual([]);
  });

  it('refuses crafting at a crafting table the state does not know', () => {
    expect(
      codes({
        type: 'CRAFT_ITEM',
        args: { recipe: 'chest', times: 1, craftingTableId: 'table.unknown' },
      }),
    ).toContain('UNKNOWN_TARGET');
    expect(
      codes({
        type: 'CRAFT_ITEM',
        args: { recipe: 'chest', times: 1, craftingTableId: 'table.main' },
      }),
    ).toEqual([]);
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

describe('protected items with real GTNH 2.8.4 registry names', () => {
  // Names taken from the live GTNH registry (FML ModIdData) and the bot's real inventory.
  const protectedList = [
    'gregtech:gt.metaitem.01', // every GT meta item variant (@damage)
    'dreamcraft:item.EngravedQuantumChip',
    'BuildCraft|Core:engineBlock', // '|' in the namespace
    'Natura:N Crops@3', // a space in the name, one exact variant
    'questbook:ItemQuestBook', // the starter book the bot carries
  ];
  const ctx = () => ({ ...safetyCtx(), protectedItems: new Set(protectedList) });
  const deposit = (item: string) =>
    evaluateAction(
      action({ type: 'DEPOSIT_ITEM', args: { containerId: 'chest.main', item, quantity: 1 } }),
      makeState(),
      ctx(),
      emptyFailureHistory,
    ).violations.map((v) => v.code);

  it('accepts these names in the config schema', () => {
    expect(
      defaultConfig({ safety: { protectedItems: protectedList } }).safety.protectedItems,
    ).toEqual(protectedList);
  });

  it.each([
    'gregtech:gt.metaitem.01@32600',
    'gregtech:gt.metaitem.01',
    'dreamcraft:item.EngravedQuantumChip',
    'BuildCraft|Core:engineBlock',
    'Natura:N Crops@3',
    'questbook:ItemQuestBook',
  ])('refuses to move %s', (item) => {
    expect(deposit(item)).toContain('PROTECTED_ITEM');
  });

  it.each(['gregtech:gt.metaitem.02@32600', 'Natura:N Crops@4', 'Natura:N Crops'])(
    'does not over-match %s',
    (item) => {
      expect(deposit(item)).not.toContain('PROTECTED_ITEM');
    },
  );
});

describe('rule 5: no world/base modification', () => {
  it.each([
    'PLACE_TNT',
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

  it.each([
    'DIG',
    'dig_block',
    'DIG_BLOCKS',
    'DIG_AREA',
    'MINE_BLOCK',
    'BREAK_BLOCK',
    'DIG_BLOCK ',
  ])('only exactly DIG_BLOCK is exempt from the DIG keyword: %j stays forbidden', (type) => {
    expect(classifyActionType(type)).toBe('forbidden');
    const r = evaluateAction(
      { ...action({ type: 'WAIT', args: { durationMs: 100 } }), type },
      makeState(),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['FORBIDDEN_MODIFICATION']);
  });

  it.each([
    'PLACE',
    'place_block',
    'PLACE_BLOCKS',
    'PLACE_STRUCTURE',
    'PLACE_BLOCK ',
    'BUILD_WALL',
  ])('only exactly PLACE_BLOCK is exempt from the PLACE keyword: %j stays forbidden', (type) => {
    expect(classifyActionType(type)).toBe('forbidden');
    const r = evaluateAction(
      { ...action({ type: 'WAIT', args: { durationMs: 100 } }), type },
      makeState(),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['FORBIDDEN_MODIFICATION']);
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

describe("DIG_BLOCK: only observed, allowlisted blocks, never the player's support", () => {
  // The mock player stands at (1, 64, 1); dirt at (2, 64, 1) is listed next to it.
  const dig = (x: number, y: number, z: number): ActionSpec => ({
    type: 'DIG_BLOCK',
    args: { position: { x, y, z } },
  });

  it('allows a listed diggable block in a safe state', () => {
    expect(codes(dig(2, 64, 1))).toEqual([]);
  });

  it('refuses (and asks) for a block the observation does not list as diggable', () => {
    const r = evaluateAction(action(dig(3, 64, 0)), makeState(), safetyCtx(), emptyFailureHistory);
    expect(r.violations.map((v) => v.code)).toEqual(['NOT_DIGGABLE']);
    expect(r.requiresUserPause).toBe(true);
    // The ground under the feet is never listed, so it is never diggable either.
    expect(codes(dig(1, 63, 1))).toEqual(['NOT_DIGGABLE']);
  });

  it('refuses when nearby blocks are not observed', () => {
    const blind = makeState((w) => void (w.unobservable = ['blocks']));
    expect(codes(dig(2, 64, 1), blind)).toEqual(['UNKNOWN_TARGET']);
  });

  it("refuses sand over the head, a block with gravel on it, and the player's own cells", () => {
    const state = makeState((w) => {
      w.resourceBlocks.push(
        { block: 'minecraft:sand', position: { x: 1, y: 66, z: 1 } },
        { block: 'minecraft:gravel', position: { x: 2, y: 65, z: 1 } },
        { block: 'minecraft:dirt', position: { x: 0, y: 64, z: 0 } },
      );
    });
    expect(codes(dig(1, 66, 1), state)).toEqual(['UNSAFE_DIG']);
    expect(codes(dig(2, 64, 1), state)).toEqual(['UNSAFE_DIG']);
    // (0, 64, 0) is a cell the player's body overlaps (it straddles four columns).
    expect(codes(dig(0, 64, 0), state)).toEqual(['UNSAFE_DIG']);
    // Gravel itself, with nothing above it, may be dug.
    expect(codes(dig(2, 65, 1), state)).toEqual([]);
  });

  it('keeps the dug block clear of known hazards and inside the boundary', () => {
    const lava = makeState((w) => {
      w.hazards = [{ kind: 'lava', position: { x: 2, y: 64, z: 7 } }];
    });
    expect(assessDangers(lava, safetyCtx())).toEqual([]); // the player is 6.1 blocks away
    expect(codes(dig(2, 64, 1), lava)).toEqual(['HAZARD_PROXIMITY']);
    const edge = makeState((w) => {
      w.player.position = { x: 255, y: 64, z: 1 };
      w.resourceBlocks.push({ block: 'minecraft:dirt', position: { x: 256, y: 64, z: 1 } });
    });
    expect(codes(dig(256, 64, 1), edge)).toEqual(['OUT_OF_BOUNDS']);
  });

  it('is not allowed during danger', () => {
    const state = makeState((w) => void (w.hostiles = [{ x: 4, y: 64, z: 1 }]));
    expect(codes(dig(2, 64, 1), state)).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
  });
});

describe('PLACE_BLOCK: only observed placeable cells, never the body, nothing that falls on it', () => {
  // The mock player stands at (1, 64, 1), eyes at (1, 65.62, 1); the cell on top of the dirt
  // at (2, 64, 1) next to it, (2, 65, 1), is placeable and holds sand up.
  const place = (
    x: number,
    y: number,
    z: number,
    item: PlaceableItem = 'minecraft:cobblestone',
  ): ActionSpec => ({ type: 'PLACE_BLOCK', args: { position: { x, y, z }, item } });

  it('allows a listed placeable cell in a safe state', () => {
    expect(codes(place(2, 65, 1))).toEqual([]);
    expect(codes(place(2, 65, 1, 'minecraft:sand'))).toEqual([]);
  });

  it('refuses (and asks) for a cell the observation does not list as placeable', () => {
    // The chest's own cell, and the cell the player's head is in.
    const r = evaluateAction(
      action(place(3, 64, 0)),
      makeState(),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['NOT_PLACEABLE']);
    expect(r.requiresUserPause).toBe(true);
    expect(codes(place(1, 65, 1))).toEqual(['NOT_PLACEABLE']);
  });

  it('refuses when nearby blocks are not observed', () => {
    const blind = makeState((w) => void (w.unobservable = ['blocks']));
    expect(codes(place(2, 65, 1), blind)).toEqual(['UNKNOWN_TARGET']);
  });

  it("refuses the player's own cells even when listed (the server would not stop it)", () => {
    const state = makeState();
    if (!state.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const listed: GameState = {
      ...state,
      nearbyBlocks: known({
        ...state.nearbyBlocks.value,
        placeable: [{ position: { x: 1, y: 65, z: 1 }, takesFalling: false }],
      }),
    };
    expect(codes(place(1, 65, 1), listed)).toEqual(['UNSAFE_PLACE']);
  });

  it('refuses sand or gravel over the head or where nothing holds it up', () => {
    // With a block beside it, the cell right over the head is placeable, but not for sand.
    const overhead = makeState((w) => {
      w.resourceBlocks.push({ block: 'minecraft:dirt', position: { x: 2, y: 66, z: 1 } });
    });
    expect(codes(place(1, 66, 1, 'minecraft:sand'), overhead)).toEqual(['UNSAFE_PLACE']);
    expect(codes(place(1, 66, 1), overhead)).toEqual([]);
    // Beside the dirt with nothing under it: gravel would fall.
    expect(codes(place(2, 64, 2, 'minecraft:gravel'))).toEqual(['UNSAFE_PLACE']);
    expect(codes(place(2, 64, 2))).toEqual([]);
  });

  it('keeps the cell clear of known hazards and inside the boundary', () => {
    const lava = makeState((w) => {
      w.hazards = [{ kind: 'lava', position: { x: 2, y: 65, z: 7 } }];
    });
    expect(assessDangers(lava, safetyCtx())).toEqual([]); // the player is 6.2 blocks away
    expect(codes(place(2, 65, 1), lava)).toEqual(['HAZARD_PROXIMITY']);
    const edge = makeState((w) => {
      w.player.position = { x: 255, y: 64, z: 1 };
      w.resourceBlocks.push({ block: 'minecraft:dirt', position: { x: 256, y: 64, z: 1 } });
    });
    expect(codes(place(256, 65, 1), edge)).toEqual(['OUT_OF_BOUNDS']);
  });

  it('never places a protected item, and is not allowed during danger', () => {
    const ctx = safetyCtx(
      defaultConfig({ ...MOCK_CONFIG, safety: { protectedItems: ['minecraft:planks'] } }),
    );
    expect(
      evaluateAction(
        action(place(2, 65, 1, 'minecraft:planks@3')),
        makeState(),
        ctx,
        emptyFailureHistory,
      ).violations.map((v) => v.code),
    ).toEqual(['PROTECTED_ITEM']);
    const state = makeState((w) => void (w.hostiles = [{ x: 4, y: 64, z: 1 }]));
    expect(codes(place(2, 65, 1), state)).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
  });
});

describe('EXPLORE: inside the boundary, bounded, only in daylight', () => {
  const explore = (
    toward: Extract<ActionSpec, { type: 'EXPLORE' }>['args']['toward'],
    maxDistance = 64,
  ): ActionSpec => ({ type: 'EXPLORE', args: { toward, maxDistance } });
  const at = (timeOfDay: number) => makeState((w) => void (w.timeOfDay = timeOfDay));

  it('allows a direction, or a point inside the boundary, in daylight', () => {
    expect(codes(explore('north'))).toEqual([]);
    expect(codes(explore({ x: 200, z: -100 }, 96))).toEqual([]);
    // Unscanned ground is what exploring is for: no hazard-scan coverage rule, unlike MOVE_TO.
    expect(codes(explore({ x: 250, z: 250 }, 96))).toEqual([]);
    expect(codes(explore('south'), at(23_500))).toEqual([]); // dawn
  });

  it('refuses a point outside the boundary, in plans too (static check)', () => {
    expect(codes(explore({ x: 300, z: 0 }))).toContain('OUT_OF_BOUNDS');
    expect(evaluateStaticSpec(explore({ x: 0, z: -257 }), safetyCtx()).map((v) => v.code)).toEqual([
      'OUT_OF_BOUNDS',
    ]);
    expect(evaluateStaticSpec(explore('north_west'), safetyCtx())).toEqual([]);
  });

  it('refuses in the evening, at night, and when the time of day is unknown', () => {
    expect(codes(explore('north'), at(12_500))).toEqual(['NOT_DAYTIME']);
    expect(codes(explore('north'), at(18_000))).toEqual(['NOT_DAYTIME']);
    const noClock: GameState = { ...makeState(), time: unknown('no time update yet') };
    expect(codes(explore('north'), noClock)).toEqual(['STATE_UNKNOWN']);
    // An escape is never refused for the dark: a retreat is not an EXPLORE.
    const retreat: ActionSpec = { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } };
    expect(codes(retreat, at(18_000))).toEqual([]);
  });

  it('is not allowed during danger', () => {
    const state = makeState((w) => void (w.hostiles = [{ x: 4, y: 64, z: 1 }]));
    expect(codes(explore('west'), state)).toContain('ACTION_NOT_ALLOWED_IN_DANGER');
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

  it('does not stop an action a human requested directly (every other rule still applies)', () => {
    const byUser = { ...action(spec), origin: 'user' as const };
    expect(evaluateAction(byUser, makeState(), safetyCtx(), failingHistory(5)).violations).toEqual(
      [],
    );
    const unsafe = {
      ...action({ type: 'MOVE_TO', args: { target: { x: 9999, y: 64, z: 0 }, tolerance: 1 } }),
      origin: 'user' as const,
    };
    expect(
      evaluateAction(unsafe, makeState(), safetyCtx(), failingHistory(5)).violations.map(
        (v) => v.code,
      ),
    ).toContain('OUT_OF_BOUNDS');
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
