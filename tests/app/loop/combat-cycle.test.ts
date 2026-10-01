import { describe, expect, it } from 'vitest';
import { runSingleCycle, runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { MOCK_CONFIG } from '../../../src/app/mock/scenarios.ts';
import { failed, ok } from '../../../src/bot/minecraft-client.ts';
import type { MockMob, MockWorld } from '../../../src/bot/mock-minecraft-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import type { ActionSpec } from '../../../src/domain/actions.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { unknown } from '../../../src/domain/known.ts';
import { verifyPostcondition } from '../../../src/executor/action-verifier.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { action, makeState, makeWorld, memoryRepos, safetyCtx } from '../../fixtures/index.ts';

const zombie = (id: number, x: number, z: number, health = 20): MockMob => ({
  id,
  type: 'minecraft:Zombie',
  category: 'hostile',
  position: { x, y: 64, z },
  health,
});
const COMBAT = defaultConfig({ ...MOCK_CONFIG, minecraft: { combat: { enabled: true } } });

async function cycle(mutate: (w: MockWorld) => void, config = COMBAT) {
  const { client, clock, world } = makeWorld(mutate);
  const repos = memoryRepos(clock);
  syncConfigToDatabase(config, repos);
  await client.connect();
  const deps = {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner: null,
    clock,
    newId: sequentialIds(),
  };
  return { result: await runSingleCycle(deps), world, deps };
}

describe('a fight through the whole agent cycle', () => {
  it('cornered at home by a zombie: DEFEND -> ATTACK_ENTITY, killed and verified', async () => {
    const { result, world } = await cycle((w) => {
      w.mobs = [zombie(7, 3, 1, 10)];
      w.weapon = { item: 'minecraft:iron_axe', damage: 6 };
    });
    expect(result.decision?.decision).toBe('DEFEND');
    expect(result.action).toMatchObject({ type: 'ATTACK_ENTITY', args: { entityId: 7 } });
    expect(result.status).toBe('succeeded');
    expect(result.outcome?.execution?.data).toMatchObject({ hits: 2, kills: 1 });
    expect(
      result.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(['PASS execution-ok', 'PASS observation-fresh', 'PASS entity-attacked']);
    expect(world.mobs).toEqual([]);
    expect(world.deaths?.[0]).toMatchObject({ id: 7, type: 'minecraft:Zombie' });
  });

  it('without combat enabled the same moment is a pause, as before', async () => {
    const { result } = await cycle(
      (w) => void (w.mobs = [zombie(7, 3, 1, 10)]),
      defaultConfig(MOCK_CONFIG),
    );
    expect(result.decision?.decision).toBe('PAUSE_AND_ASK_USER');
    expect(result.action?.type).toBe('PAUSE_AND_ASK_USER');
  });

  it("a person's attack on a villager is refused before anything is sent", async () => {
    const { deps } = await cycle(() => undefined);
    const { client } = deps;
    client.world.mobs = [
      {
        id: 9,
        type: 'minecraft:Villager',
        category: 'passive',
        position: { x: 3, y: 64, z: 1 },
        health: 20,
      },
    ];
    const r = await runUserAction(deps, { type: 'ATTACK_ENTITY', args: { entityId: 9 } }, 'test');
    expect(r.status).toBe('rejected');
    expect(r.summary).toMatch(/NOT_ATTACKABLE/);
    expect(client.performed.map((p) => p.action.type)).not.toContain('ATTACK_ENTITY');
  });
});

describe('ENTITY_ATTACKED verification', () => {
  const spec: ActionSpec = { type: 'ATTACK_ENTITY', args: { entityId: 7 } };
  const before = makeState((w) => void (w.mobs = [zombie(7, 3, 1, 20)]));
  const a = action(spec);
  const startedMs = Date.parse(a.timestamp);
  const after = (mutate: (w: MockWorld) => void): GameState => {
    const s = makeState(mutate);
    return { ...s, timestamp: new Date(startedMs + 1000).toISOString() };
  };
  const verify = (post: GameState | null, execution = ok('struck')) =>
    verifyPostcondition({ action: a, before, after: post, execution, ctx: safetyCtx() });
  const result = (post: GameState | null, execution = ok('struck')) => {
    const v = verify(post, execution);
    return { verified: v.verified, detail: v.checks.at(-1)?.detail };
  };

  it('passes when the target was seen dying after the action started', () => {
    const died = after((w) => {
      w.deaths = [{ id: 7, type: 'minecraft:Zombie', at: new Date(startedMs + 600).toISOString() }];
    });
    expect(result(died)).toEqual({
      verified: true,
      detail: 'minecraft:Zombie 7 was observed dying',
    });
    // A death from before the action is not this action's kill.
    const old = after((w) => {
      w.deaths = [{ id: 7, type: 'minecraft:Zombie', at: new Date(startedMs - 1).toISOString() }];
    });
    expect(result(old).verified).toBe(false);
  });

  it('passes when its health fell, fails when it did not', () => {
    expect(result(after((w) => void (w.mobs = [zombie(7, 3, 1, 14)])))).toEqual({
      verified: true,
      detail: 'minecraft:Zombie 7: health 20 -> 14',
    });
    expect(result(after((w) => void (w.mobs = [zombie(7, 3, 1, 20)]))).verified).toBe(false);
  });

  it('with unknown health, only a hurt status seen after the start counts', () => {
    const hurt = (at: number | null) =>
      after((w) => {
        w.mobs = [
          {
            ...zombie(7, 3, 1),
            health: null,
            lastHurtAt: at === null ? null : new Date(at).toISOString(),
          },
        ];
      });
    expect(result(hurt(startedMs + 500)).verified).toBe(true);
    expect(result(hurt(startedMs - 500)).verified).toBe(false);
    expect(result(hurt(null)).verified).toBe(false);
  });

  it('fails closed: gone without a death, entities unknown, no observation, or a failed run', () => {
    expect(result(after(() => undefined))).toEqual({
      verified: false,
      detail: 'entity 7 is gone, but was not observed dying',
    });
    const blind = { ...after(() => undefined), nearbyEntities: unknown('lost') };
    expect(result(blind).verified).toBe(false);
    expect(result(null).verified).toBe(false);
    const died = after((w) => {
      w.deaths = [{ id: 7, type: 'minecraft:Zombie', at: new Date(startedMs + 600).toISOString() }];
    });
    expect(verify(died, failed('halted')).verified).toBe(false);
  });
});
