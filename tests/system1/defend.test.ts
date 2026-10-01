import { describe, expect, it } from 'vitest';
import type { MockMob, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import {
  DECISION_SYSTEM_PROMPT,
  ModelDecisionSchema,
  summarizeForDecision,
} from '../../src/llm/ollama-decision-provider.ts';
import { proposeAction } from '../../src/system1/action-proposer.ts';
import {
  isBindingRouterDecision,
  SafetyFirstDecisionProvider,
} from '../../src/system1/decision-provider.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { MockDecisionProvider } from '../../src/system1/mock-decision-provider.ts';
import type { RouterContext } from '../../src/system1/state-queries.ts';
import { makeState, routerCtx } from '../fixtures/index.ts';

// Home is (0, 64, 0); the mock player starts there, at (1, 64, 1).
const AWAY = { x: 20, y: 64, z: 20 };
const near = (dx: number, dz: number, from = AWAY) => ({ x: from.x + dx, y: 64, z: from.z + dz });
const zombie = (id: number, p: { x: number; y: number; z: number }, health = 20): MockMob => ({
  id,
  type: 'minecraft:Zombie',
  category: 'hostile',
  position: p,
  health,
});
const skeleton = (id: number, p: { x: number; y: number; z: number }): MockMob => ({
  ...zombie(id, p),
  type: 'minecraft:Skeleton',
});
const creeper = (id: number, p: { x: number; y: number; z: number }): MockMob => ({
  ...zombie(id, p),
  type: 'SpecialMobs.DeathCreeper',
});
const IRON_AXE = { item: 'minecraft:iron_axe', damage: 6 };

const combat = (): RouterContext => ({ ...routerCtx(), combatEnabled: true });
const route = (mutate: (w: MockWorld) => void, ctx: RouterContext = combat()) =>
  routeDecision(makeState(mutate), ctx);
/** No safe location configured at all. */
const noHome = () => {
  const ctx = combat();
  return { ...ctx, safety: { ...ctx.safety, locations: new Map() } };
};

describe('DEFEND: fight back only when retreating is impossible or worse', () => {
  it('without combat enabled nothing changes: retreat, or pause', () => {
    const away = (w: MockWorld): void => {
      w.player.position = AWAY;
      w.mobs = [zombie(1, near(1, 1))];
    };
    expect(route(away, routerCtx()).decision).toBe('RETREAT_HOME');
    expect(
      route((w) => void (w.mobs = [zombie(1, near(1, 1, w.player.position))]), routerCtx()),
    ).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['HOSTILES_NEARBY', 'ALREADY_AT_SAFE_LOCATION'],
    });
  });

  it('with somewhere to go it retreats, even from a zombie within reach', () => {
    const d = route((w) => {
      w.player.position = AWAY;
      w.mobs = [zombie(1, near(2, 0))];
    });
    expect(d).toMatchObject({ decision: 'RETREAT_HOME', reasonCodes: ['HOSTILES_NEARBY'] });
    expect(d.factsUsed['defense']).toBe('none');
  });

  it('...unless it is cornered by a hostile it kills in a few hits', () => {
    const cornered = (health: number, weapon?: typeof IRON_AXE) => (w: MockWorld) => {
      w.player.position = AWAY;
      w.mobs = [zombie(1, near(2, 0), health)];
      if (weapon !== undefined) w.weapon = weapon;
    };
    // An iron axe (6) kills 20 health in 4 hits: too long; 12 health in 2: fight.
    expect(route(cornered(20, IRON_AXE)).decision).toBe('RETREAT_HOME');
    const d = route(cornered(12, IRON_AXE));
    expect(d).toMatchObject({
      decision: 'DEFEND',
      reasonCodes: ['HOSTILES_NEARBY', 'HOSTILE_IN_REACH'],
      factsUsed: { defendTarget: 1, defendTargetType: 'minecraft:Zombie', defendTargetHealth: 12 },
    });
    // A bare hand kills 3 health in 3 hits, 4 in 4.
    expect(route(cornered(3)).decision).toBe('DEFEND');
    expect(route(cornered(4)).decision).toBe('RETREAT_HOME');
  });

  it('with nowhere to go, it fights a hostile in reach, or a melee mob coming at it', () => {
    const atHome = route((w) => void (w.mobs = [zombie(1, near(5, 0, w.player.position))]));
    expect(atHome).toMatchObject({
      decision: 'DEFEND',
      reasonCodes: ['HOSTILES_NEARBY', 'HOSTILE_IN_REACH', 'ALREADY_AT_SAFE_LOCATION'],
    });
    const homeless = routeDecision(
      makeState((w) => {
        w.player.position = AWAY;
        w.mobs = [zombie(1, near(7, 0))];
      }),
      noHome(),
    );
    expect(homeless).toMatchObject({
      decision: 'DEFEND',
      reasonCodes: ['HOSTILES_NEARBY', 'HOSTILE_IN_REACH', 'NO_SAFE_LOCATION'],
    });
    // Beyond 8 blocks it does not engage (the threat radius is 10): pause, as before.
    expect(route((w) => void (w.mobs = [zombie(1, near(9, 0, w.player.position))])).decision).toBe(
      'PAUSE_AND_ASK_USER',
    );
  });

  it('a skeleton at range is not chased; within reach it is fought', () => {
    expect(
      route((w) => void (w.mobs = [skeleton(1, near(6, 0, w.player.position))])),
    ).toMatchObject({ decision: 'PAUSE_AND_ASK_USER' });
    expect(
      route((w) => void (w.mobs = [skeleton(1, near(2, 0, w.player.position))])).decision,
    ).toBe('DEFEND');
  });

  it('creepers: back off, never fight (and say so)', () => {
    expect(
      route((w) => {
        w.player.position = AWAY;
        w.mobs = [creeper(1, near(3, 0))];
      }),
    ).toMatchObject({
      decision: 'RETREAT_HOME',
      reasonCodes: ['HOSTILES_NEARBY', 'CREEPER_NEARBY'],
    });
    // A zombie in reach, but a creeper 12 blocks off: still no fight.
    expect(
      route((w) => {
        w.mobs = [
          zombie(1, near(2, 0, w.player.position)),
          creeper(2, near(12, 0, w.player.position)),
        ];
      }),
    ).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['HOSTILES_NEARBY', 'CREEPER_NEARBY', 'ALREADY_AT_SAFE_LOCATION'],
    });
  });

  it('an unidentified mob beyond the threat radius still forbids a fight (it might explode)', () => {
    expect(
      route((w) => {
        w.mobs = [zombie(1, near(2, 0, w.player.position))];
        w.unclassified = [near(0, 13, w.player.position)];
      }),
    ).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['HOSTILES_NEARBY', 'CREEPER_NEARBY', 'ALREADY_AT_SAFE_LOCATION'],
    });
  });

  it('overwhelmed: flees instead of fighting more than two', () => {
    expect(
      route((w) => {
        const p = w.player.position;
        w.mobs = [zombie(1, near(2, 0, p)), zombie(2, near(-2, 0, p)), zombie(3, near(0, 3, p))];
      }),
    ).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['HOSTILES_NEARBY', 'TOO_MANY_HOSTILES', 'ALREADY_AT_SAFE_LOCATION'],
    });
  });

  it('never with low health or food, an unidentified entity, or lava near', () => {
    const cases: Array<(w: MockWorld) => void> = [
      (w) => void (w.player.health = 12),
      (w) => void (w.player.hunger = 7),
      (w) => void (w.unclassified = [near(-4, 0, w.player.position)]),
      (w) => void (w.hazards = [{ kind: 'lava', position: near(0, 4, w.player.position) }]),
    ];
    for (const extra of cases) {
      const d = route((w) => {
        w.mobs = [zombie(1, near(2, 0, w.player.position))];
        extra(w);
      });
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
    }
  });

  it('turns into ATTACK_ENTITY on the nearest hostile it may fight', () => {
    const state = makeState((w) => {
      const p = w.player.position;
      w.mobs = [
        { ...zombie(1, near(1, 0, p)), type: 'minecraft:PigZombie' }, // never attacked
        zombie(2, near(3, 0, p)),
      ];
    });
    const d = routeDecision(state, combat());
    expect(d.decision).toBe('DEFEND');
    expect(proposeAction(d, state, combat())).toMatchObject({
      kind: 'action',
      spec: { type: 'ATTACK_ENTITY', args: { entityId: 2 } },
    });
    // DEFEND without a target (e.g. a model chose it): pause.
    const calm = makeState();
    expect(proposeAction({ ...d }, calm, combat())).toMatchObject({
      kind: 'action',
      spec: { type: 'PAUSE_AND_ASK_USER' },
    });
  });

  it('is a safety decision: a model cannot overrule it', async () => {
    const state = makeState((w) => void (w.mobs = [zombie(1, near(2, 0, w.player.position))]));
    const d = routeDecision(state, combat());
    expect(isBindingRouterDecision(d)).toBe(true);
    const provider = new SafetyFirstDecisionProvider(
      MockDecisionProvider.always('EXECUTE_KNOWN_SAFE_STEP'),
    );
    expect(await provider.decide(state, combat())).toMatchObject({ decision: 'DEFEND' });
  });
});

describe('DEFEND in the decision model prompt', () => {
  it('the summary says when defending is the answer, and the danger rule names DEFEND', () => {
    const state = makeState((w) => void (w.mobs = [zombie(1, near(2, 0, w.player.position))]));
    expect(summarizeForDecision(state, combat())).toMatchObject({
      dangers: ['HOSTILES_NEARBY'],
      defend: true,
      home: 'here',
    });
    expect(summarizeForDecision(state, routerCtx()).defend).toBe(false);
    expect(DECISION_SYSTEM_PROMPT).toMatch(/If defend is true, decide DEFEND/);
    // The reply grammar still ends at the danger check, and accepts DEFEND's reasons.
    expect(
      ModelDecisionSchema.safeParse({
        stateProblems: false,
        outOfBounds: false,
        danger: true,
        decision: 'DEFEND',
        reasonCodes: ['HOSTILES_NEARBY', 'HOSTILE_IN_REACH', 'ALREADY_AT_SAFE_LOCATION'],
        confidence: 90,
      }).success,
    ).toBe(true);
  });
});
