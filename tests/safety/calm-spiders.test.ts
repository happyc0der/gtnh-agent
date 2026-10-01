import { describe, expect, it } from 'vitest';
import { trailRetreat } from '../../src/app/loop/trail.ts';
import type { MockMob, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { GameStateSchema, type GameState } from '../../src/domain/game-state.ts';
import { known } from '../../src/domain/known.ts';
import { fightProblems } from '../../src/safety/combat-checks.ts';
import {
  assessDangers,
  assessStateReliability,
  emptyFailureHistory,
  evaluateAction,
} from '../../src/safety/safety-policy.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { action, makeState, routerCtx, safetyCtx, T0 } from '../fixtures/index.ts';

// The mock player stands at (1, 64, 1) with 20 health and food 18; home is (0, 64, 0).
const at = (x: number, z: number) => ({ x, y: 64, z });
const spider = (id: number, x: number, z: number, calm = true): MockMob => ({
  id,
  type: 'minecraft:Spider',
  category: 'hostile',
  position: at(x, z),
  health: 16,
  calm,
});
const zombie = (id: number, x: number, z: number): MockMob => ({
  id,
  type: 'minecraft:Zombie',
  category: 'hostile',
  position: at(x, z),
  health: 20,
});
const withMobs =
  (...mobs: MockMob[]) =>
  (w: MockWorld): void =>
    void (w.mobs = mobs);

function entitiesOf(s: GameState) {
  if (!s.nearbyEntities.known) throw new Error(s.nearbyEntities.reason);
  return s.nearbyEntities.value.entities;
}

describe('a calm spider is no threat', () => {
  it('7 blocks away in the light: listed as calm, not counted, no danger', () => {
    const s = makeState(withMobs(spider(1, 8, 1)));
    expect(entitiesOf(s)).toEqual([expect.objectContaining({ id: 1, calm: true, distance: 7 })]);
    expect(s.nearbyThreats).toMatchObject({
      value: { hostileCount: 0, nearestHostileDistance: null },
    });
    expect(assessDangers(s, safetyCtx())).toEqual([]);
    expect(assessStateReliability(s, safetyCtx())).toEqual([]);
  });

  it('an angry one (not calm) at the same spot is a danger, and System 1 retreats from it', () => {
    const s = makeState((w) => {
      w.player.position = at(20, 20);
      w.mobs = [spider(1, 27, 20, false)];
    });
    expect(assessDangers(s, safetyCtx()).map((v) => v.code)).toEqual(['HOSTILES_NEARBY']);
    expect(routeDecision(s, routerCtx()).decision).toBe('RETREAT_HOME');
    const calm = makeState((w) => {
      w.player.position = at(20, 20);
      w.mobs = [spider(1, 27, 20)];
    });
    expect(routeDecision(calm, routerCtx()).reasonCodes).not.toContain('HOSTILES_NEARBY');
  });

  it('the mock applies the rest of the rule: only spiders, beyond their leap, the player not hurt lately', () => {
    const calmZombie: MockMob = { ...zombie(2, 9, 1), calm: true };
    const close = makeState(withMobs(spider(1, 6, 1), calmZombie)); // 5 blocks
    expect(entitiesOf(close).map((e) => [e.id, e.calm])).toEqual([
      [1, false],
      [2, false],
    ]);
    expect(close.nearbyThreats).toMatchObject({ value: { hostileCount: 2 } });
    const bitten = makeState((w) => {
      w.mobs = [spider(1, 8, 1)];
      w.player.lastHurtAt = new Date(Date.parse(T0) - 5_000).toISOString();
    });
    expect(entitiesOf(bitten)[0]?.calm).toBe(false);
    expect(assessDangers(bitten, safetyCtx()).map((v) => v.code)).toEqual(['HOSTILES_NEARBY']);
  });
});

describe('the consistency check knows calm spiders', () => {
  const calmState = (): GameState => makeState(withMobs(spider(1, 8, 1)));
  const problems = (s: GameState): string[] =>
    assessStateReliability(s, safetyCtx())
      .filter((v) => v.code === 'STATE_INCONSISTENT')
      .map((v) => v.message);
  const withEntities = (
    s: GameState,
    change: (e: ReturnType<typeof entitiesOf>[number]) => object,
  ) => ({
    ...s,
    nearbyEntities: known({
      ...(s.nearbyEntities.known ? s.nearbyEntities.value : { scanRadius: 16, recentDeaths: [] }),
      entities: entitiesOf(s).map((e) => ({ ...e, ...change(e) })),
    }),
  });

  it('a calm spider counted as a threat (or a threat not counted) is inconsistent', () => {
    const s = calmState();
    expect(problems(s)).toEqual([]);
    const counted: GameState = {
      ...s,
      nearbyThreats: known({
        scanRadius: 16,
        hostileCount: 1,
        nearestHostileDistance: 7,
        unclassifiedCount: 0,
        nearestUnclassifiedDistance: null,
      }),
    };
    expect(problems(counted)).toContain(
      'nearbyEntities lists 0 hostile(s), nearbyThreats counts 1',
    );
    expect(problems(withEntities(s, () => ({ calm: false })))).toContain(
      'nearbyEntities lists 1 hostile(s), nearbyThreats counts 0',
    );
  });

  it('calm only where it can be: a vanilla spider, beyond its leap, the player not hurt lately', () => {
    const s = calmState();
    expect(problems(withEntities(s, () => ({ type: 'minecraft:Zombie' })))[0]).toMatch(
      /marks minecraft:Zombie #1 calm, but minecraft:Zombie is not a vanilla spider/,
    );
    expect(problems(withEntities(s, () => ({ type: 'SpecialMobs.SpecialSpider' })))[0]).toMatch(
      /not a vanilla spider/,
    );
    expect(problems(withEntities(s, () => ({ distance: 6 })))[0]).toMatch(/within its leap \(6\)/);
    const hurt: GameState = {
      ...s,
      player: { ...s.player, lastHurtAt: new Date(Date.parse(s.timestamp) - 3_000).toISOString() },
    };
    expect(problems(hurt)[0]).toMatch(/the player was hurt 3 s ago/);
  });

  it('snapshots stored before calm existed read every spider as not calm', () => {
    const old = structuredClone(
      makeState(withMobs(spider(1, 8, 1), zombie(2, 4, 1))),
    ) as unknown as {
      nearbyEntities: { value: { entities: Array<Record<string, unknown>> } };
    };
    for (const e of old.nearbyEntities.value.entities) delete e['calm'];
    const parsed = GameStateSchema.parse(old);
    expect(entitiesOf(parsed).map((e) => e.calm)).toEqual([false, false]);
  });
});

describe('a calm spider is never provoked', () => {
  it('ATTACK_ENTITY on it is refused (not a pause: it may be fought once it is not calm)', () => {
    const r = evaluateAction(
      action({ type: 'ATTACK_ENTITY', args: { entityId: 1 } }),
      makeState(withMobs(spider(1, 8, 1))),
      safetyCtx(),
      emptyFailureHistory,
    );
    expect(r.violations.map((v) => [v.code, v.severity])).toEqual([['NOT_ATTACKABLE', 'block']]);
    expect(r.violations[0]?.message).toMatch(/calm .* striking it would provoke it/);
    expect(r.requiresUserPause).toBe(false);
  });

  it('DEFEND never picks one, and calm spiders are no crowd to flee from', () => {
    const ctx = { ...routerCtx(), combatEnabled: true };
    // At home, a zombie 9 blocks away and a calm spider 7: the spider is nearer and within the
    // 8 blocks a melee mob is waited for, but never the target; the zombie is not coming yet.
    const home = makeState(withMobs(zombie(2, 10, 1), spider(1, 1, 8)));
    expect(routeDecision(home, ctx)).toMatchObject({
      decision: 'PAUSE_AND_ASK_USER',
      reasonCodes: ['HOSTILES_NEARBY', 'ALREADY_AT_SAFE_LOCATION'],
    });
    // A zombie in reach and three calm spiders: the zombie alone is fought, no crowd.
    const s = makeState(
      withMobs(zombie(2, 3, 1), spider(3, 8, 1), spider(4, 1, 9), spider(5, -7, 1)),
    );
    expect(fightProblems(s, safetyCtx().config)).toEqual([]);
    const d = routeDecision(s, ctx);
    expect(d.decision).toBe('DEFEND');
    expect(d.factsUsed['defendTarget']).toBe(2);
  });
});

describe('the trail retreat', () => {
  const point = (x: number, z: number) => ({ dimension: 'overworld', position: { x, y: 64, z } });

  it('a calm spider is nothing to retreat from', () => {
    const trail = [point(-24, 1), point(-12, 1)];
    expect(trailRetreat(trail, makeState(withMobs(spider(1, 8, 1))), safetyCtx())).toBeNull();
  });

  it('a point beside a calm spider is passed over: it would make the spider count again', () => {
    const trail = [point(-40, 1), point(-24, 1), point(-12, 1)];
    // A zombie east of the player; a calm spider 3 blocks from the point 13 blocks back west.
    const s = makeState(withMobs(zombie(2, 8, 1), spider(1, -12, 4)));
    expect(trailRetreat(trail, s, safetyCtx())).toMatchObject({ position: { x: -24, z: 1 } });
  });
});
