import { describe, expect, it } from 'vitest';
import type { MockMob, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig, type AgentConfig } from '../../src/config/env.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import { GameStateSchema, type GameState } from '../../src/domain/game-state.ts';
import { known } from '../../src/domain/known.ts';
import { fightProblems } from '../../src/safety/combat-checks.ts';
import {
  assessStateReliability,
  emptyFailureHistory,
  evaluateAction,
} from '../../src/safety/safety-policy.ts';
import { MOCK_CONFIG } from '../../src/app/mock/scenarios.ts';
import { action, makeState, safetyCtx } from '../fixtures/index.ts';

// The mock player stands at (1, 64, 1) with 20 health and food 18.
const at = (x: number, z: number) => ({ x, y: 64, z });
const zombie = (id: number, x: number, z: number, health: number | null = 20): MockMob => ({
  id,
  type: 'minecraft:Zombie',
  category: 'hostile',
  position: at(x, z),
  health,
});
const creeper = (id: number, x: number, z: number): MockMob => ({
  ...zombie(id, x, z),
  type: 'minecraft:Creeper',
});
const cow = (id: number, x: number, z: number, over: Partial<MockMob> = {}): MockMob => ({
  id,
  type: 'minecraft:Cow',
  category: 'passive',
  position: at(x, z),
  health: 10,
  ...over,
});
const attack = (entityId: number): ActionSpec => ({ type: 'ATTACK_ENTITY', args: { entityId } });

function codes(
  spec: ActionSpec,
  mutate: (w: MockWorld) => void,
  opts: { taskId?: string | null; origin?: 'user'; config?: AgentConfig } = {},
): string[] {
  const a = { ...action(spec, opts.taskId === undefined ? 'task-test' : opts.taskId) };
  const candidate = opts.origin === undefined ? a : { ...a, origin: opts.origin };
  return evaluateAction(
    candidate,
    makeState(mutate),
    safetyCtx(opts.config),
    emptyFailureHistory,
  ).violations.map((v) => v.code);
}

describe('ATTACK_ENTITY: whom', () => {
  it('a hostile that is the only danger may be fought back', () => {
    expect(codes(attack(1), (w) => void (w.mobs = [zombie(1, 3, 1)]))).toEqual([]);
  });

  it('a farm animal, for a task, when no hostile is near', () => {
    expect(codes(attack(2), (w) => void (w.mobs = [cow(2, 3, 1)]))).toEqual([]);
  });

  it.each<[string, MockMob, string[]]>([
    [
      'a player',
      { id: 5, type: 'player', category: 'player', position: at(3, 1), health: 20 },
      ['NOT_ATTACKABLE'],
    ],
    [
      'a villager',
      { id: 5, type: 'minecraft:Villager', category: 'passive', position: at(3, 1), health: 20 },
      ['NOT_ATTACKABLE'],
    ],
    [
      'an iron golem',
      {
        id: 5,
        type: 'minecraft:VillagerGolem',
        category: 'passive',
        position: at(3, 1),
        health: 100,
      },
      ['NOT_ATTACKABLE'],
    ],
    ['a named cow', cow(5, 3, 1, { owned: true }), ['NOT_ATTACKABLE']],
    ['a cow whose owner is not known', cow(5, 3, 1, { owned: null }), ['NOT_ATTACKABLE']],
    ['a calf', cow(5, 3, 1, { baby: true }), ['NOT_ATTACKABLE']],
    // A creeper is also a reason not to fight at all now.
    ['a creeper', creeper(5, 3, 1), ['NOT_ATTACKABLE']],
    ['an enderman', { ...zombie(5, 3, 1), type: 'minecraft:Enderman' }, ['NOT_ATTACKABLE']],
  ])('never %s (and asks)', (_what, target, expected) => {
    const r = evaluateAction(
      action(attack(5)),
      makeState((w) => void (w.mobs = [target])),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(expected);
    expect(r.requiresUserPause).toBe(true);
  });

  it('never an unidentified entity: it is a danger that only a retreat answers', () => {
    // The mock lists `unclassified` positions as entities 9500, 9501, ...
    expect(codes(attack(9500), (w) => void (w.unclassified = [at(3, 1)]))).toEqual([
      'ACTION_NOT_ALLOWED_IN_DANGER',
      'NOT_ATTACKABLE',
    ]);
  });

  it('an entity that is no longer observed is a stale step, not a dangerous one', () => {
    const r = evaluateAction(
      action(attack(42)),
      makeState((w) => void (w.mobs = [zombie(1, 3, 1)])),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => v.code)).toEqual(['TARGET_GONE']);
    expect(r.requiresUserPause).toBe(false);
  });

  it('farm animals only for a task or a person, and no hunting while hostiles are near', () => {
    const cowOnly = (w: MockWorld): void => void (w.mobs = [cow(2, 3, 1)]);
    expect(codes(attack(2), cowOnly, { taskId: null })).toEqual(['NOT_ATTACKABLE']);
    expect(codes(attack(2), cowOnly, { taskId: null, origin: 'user' })).toEqual([]);
    expect(codes(attack(2), (w) => void (w.mobs = [cow(2, 3, 1), zombie(1, 6, 1)]))).toEqual([
      'UNSAFE_ATTACK',
    ]);
  });

  it('inside the work area only', () => {
    const config = defaultConfig({
      ...MOCK_CONFIG,
      safety: { ...MOCK_CONFIG.safety, boundary: { max: { x: 2, y: 255, z: 256 } } },
    });
    expect(codes(attack(1), (w) => void (w.mobs = [zombie(1, 3, 1)]), { config })).toEqual([
      'OUT_OF_BOUNDS',
    ]);
  });
});

describe('ATTACK_ENTITY: when', () => {
  it('not with low health or food (the router retreats instead)', () => {
    const z = (w: MockWorld): void => void (w.mobs = [zombie(1, 3, 1)]);
    // Above the danger threshold (10) but below the fighting one (14).
    expect(
      codes(attack(1), (w) => {
        z(w);
        w.player.health = 12;
      }),
    ).toEqual(['UNSAFE_ATTACK']);
    // Below the danger threshold: no action but a retreat is allowed.
    expect(
      codes(attack(1), (w) => {
        z(w);
        w.player.health = 8;
      }),
    ).toEqual(['ACTION_NOT_ALLOWED_IN_DANGER', 'UNSAFE_ATTACK']);
    // HungerOverhaul stops healing below food 8.
    expect(
      codes(attack(1), (w) => {
        z(w);
        w.player.hunger = 7;
      }),
    ).toEqual(['UNSAFE_ATTACK']);
  });

  it('not with a creeper (or a hostile that might be one) anywhere in the scan', () => {
    expect(codes(attack(1), (w) => void (w.mobs = [zombie(1, 3, 1), creeper(2, 1, 15)]))).toEqual([
      'UNSAFE_ATTACK',
    ]);
    const unknownHostile: MockMob = { ...zombie(2, 1, 15), type: 'SpecialMobs#200' };
    expect(codes(attack(1), (w) => void (w.mobs = [zombie(1, 3, 1), unknownHostile]))).toEqual([
      'UNSAFE_ATTACK',
    ]);
  });

  it('not when overwhelmed: more hostiles than it fights at once', () => {
    const three = (w: MockWorld): void =>
      void (w.mobs = [zombie(1, 3, 1), zombie(2, -2, 1), zombie(3, 1, 5)]);
    expect(codes(attack(1), three)).toEqual(['UNSAFE_ATTACK']);
    const config = defaultConfig({
      ...MOCK_CONFIG,
      safety: { ...MOCK_CONFIG.safety, combat: { maxHostilesToFight: 3 } },
    });
    expect(codes(attack(1), three, { config })).toEqual([]);
  });

  it('not near lava, and never while outside the work area', () => {
    expect(
      codes(attack(1), (w) => {
        w.mobs = [zombie(1, 3, 1)];
        w.hazards = [{ kind: 'lava', position: at(1, 4) }];
      }),
    ).toEqual(['ACTION_NOT_ALLOWED_IN_DANGER']);
  });

  it('not with a protected weapon in the inventory (the client might strike with it)', () => {
    const config = defaultConfig({
      ...MOCK_CONFIG,
      safety: { protectedItems: ['minecraft:diamond_axe'] },
    });
    const r = codes(
      attack(1),
      (w) => {
        w.mobs = [zombie(1, 3, 1)];
        w.inventory.items['minecraft:diamond_axe'] = 1;
      },
      { config },
    );
    expect(r).toEqual(['PROTECTED_ITEM']);
  });

  it('names every reason a fight is unsafe now', () => {
    const state = makeState((w) => {
      w.mobs = [zombie(1, 3, 1), zombie(2, 2, 3), zombie(3, -1, 1), creeper(4, 10, 10)];
      w.unclassified = [at(4, 4)];
      w.player.health = 11;
      w.player.hunger = 6;
    });
    expect(fightProblems(state, safetyCtx().config).map((p) => p.code)).toEqual([
      'CREEPER_NEARBY',
      'TOO_MANY_HOSTILES',
      'UNCLASSIFIED_NEARBY',
      'LOW_HEALTH',
      'LOW_HUNGER',
    ]);
  });
});

describe('entity details must agree with the threat counts', () => {
  it('a listed hostile the counts do not know of is inconsistent', () => {
    const base = makeState((w) => void (w.mobs = [zombie(1, 3, 1)]));
    if (!base.nearbyEntities.known) throw new Error('entities unknown');
    const listed = base.nearbyEntities.value.entities;
    const extra: GameState = {
      ...base,
      nearbyEntities: known({
        ...base.nearbyEntities.value,
        entities: [...listed, ...listed.map((e) => ({ ...e, id: e.id + 1 }))],
      }),
    };
    expect(assessStateReliability(extra, safetyCtx()).map((v) => v.message)).toContain(
      'nearbyEntities lists 2 hostile(s), nearbyThreats counts 1',
    );
    expect(assessStateReliability(base, safetyCtx())).toEqual([]);
  });

  it('snapshots stored before combat existed still parse, with entities unknown', () => {
    const old = structuredClone(makeState()) as unknown as {
      nearbyEntities?: unknown;
      player: { weapon?: unknown };
    };
    delete old.nearbyEntities;
    delete old.player.weapon;
    const parsed = GameStateSchema.parse(old);
    expect(parsed.nearbyEntities).toEqual({
      known: false,
      reason: 'not reported by this observation',
    });
    expect(parsed.player.weapon.known).toBe(false);
  });
});
