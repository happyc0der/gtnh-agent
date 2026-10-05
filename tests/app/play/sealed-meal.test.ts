import { describe, expect, it } from 'vitest';
import type { CycleResult } from '../../../src/app/loop/agent-loop.ts';
import type { SessionResult } from '../../../src/app/loop/live-session.ts';
import type { CommandDeps, StandbyCall } from '../../../src/app/play/commands.ts';
import { foodStatusOf } from '../../../src/app/play/food.ts';
import { standbyReason } from '../../../src/app/play/live-play.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayDeps } from '../../../src/app/play/play.ts';
import type { MockWorld } from '../../../src/bot/mock-minecraft-client.ts';
import type { DecisionResult } from '../../../src/domain/decisions.ts';
import { FOOD_TASK_ID } from '../../../src/domain/food.ts';
import { worldTime, type GameState } from '../../../src/domain/game-state.ts';
import type { ShelterStep } from '../../../src/domain/night-shelter.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import {
  CURRENT_TASK_KEY,
  NIGHT_SHELTER_KEY,
  OWNER_PAUSED_KEY,
} from '../../../src/persistence/memory-repository.ts';
import { createRepositories, type Repositories } from '../../../src/persistence/repositories.ts';
import { routeAndChangesForPlanner } from '../../../src/planner/planner-provider.ts';
import { routeDecision } from '../../../src/system1/deterministic-router.ts';
import { manualClock, systemClock } from '../../../src/util/clock.ts';
import { makeState, makeWorld, routerCtx, safetyCtx, testConfig } from '../../fixtures/index.ts';

// An independent review, 2026-10-05: sealed in its pit at food 0 with hostiles near, System 1
// eats when food is carried; but a meal that cannot be had (refused as a repeated failure in a
// task whose id never changes, or a stack the client never uses) was tried again and again,
// online, while starving hurt it: the morning read SHELTERED and looked again in 5 s, and idle
// play never went offline. Without food the same bot retreats, fails, and waits offline.
const sealedStarving =
  (food: boolean) =>
  (w: MockWorld): void => {
    w.player.position = { x: 30, y: 61, z: 30 };
    w.player.sealed = true;
    w.hostiles = [{ x: 31, y: 64, z: 30 }];
    w.player.hunger = 0;
    w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - 1_000).toISOString();
    w.player.lastHurtStarving = true;
    if (!food) delete w.inventory.items['minecraft:bread'];
  };

const open = (): Repositories => createRepositories(openDatabase(IN_MEMORY), systemClock);

const EXIT: ShelterStep[] = [
  {
    spec: { type: 'DIG_BLOCK', args: { position: { x: 30, y: 63, z: 30 } } },
    text: 'dig the roof',
  },
];

/** A morning walled in the pit, every exit session ending on `decision`. */
async function morning(decision: DecisionResult, stopKind: SessionResult['stopKind']) {
  const repos = open();
  repos.memory.setValue(NIGHT_SHELTER_KEY, '2026-10-05T04:00:00.000Z');
  let sessions = 0;
  const deps: PlayDeps = {
    repos,
    now: () => 0,
    inventory: () => Promise.resolve({}),
    time: () => Promise.resolve(worldTime(1_000, true)),
    // Starving counts as hurt: not "sheltered", so the way out's session runs.
    shelter: () =>
      Promise.resolve({
        kind: 'pit' as const,
        sheltered: false,
        steps: [],
        needs: {},
        problem: null,
        walled: true,
        exit: EXIT,
        hostiles: '1 hostile(s), nearest at 3.2 blocks',
      }),
    session: (_limits, hooks) => {
      sessions += 1;
      hooks.onCycle({ summary: 'x', decision } as unknown as CycleResult, 1);
      return Promise.resolve({
        cycles: [{ cycleId: 'c', summary: 'x' }],
        stopReason: `stopped: ${decision.decision}`,
        stopKind,
        taskId: repos.memory.getValue(CURRENT_TASK_KEY),
        taskStatus: 'active',
        elapsedMs: 1,
      });
    },
    sleep: () => Promise.resolve(),
  };
  const result = await runPlay(deps, DEFAULT_PLAY_LIMITS, {
    stopRequested: () => (sessions >= 30 ? 'test over' : null),
  });
  return { result, sessions };
}

describe('starving, sealed in with hostiles near', () => {
  it('a meal in there that cannot be had is waited out offline, not tried again and again', async () => {
    const d = routeDecision(makeState(sealedStarving(true)), routerCtx());
    expect(d.decision).toBe('EAT');
    expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED', 'HUNGRY']);
    // Refused (a repeated failure): needs attention. Failed: the cycle failed. Either way, offline.
    for (const stopKind of ['needs-attention', 'cycle-failed'] as const) {
      const run = await morning(d, stopKind);
      expect(run.sessions).toBe(1);
      expect(run.result.mobNearby).toBe('HOSTILES_NEARBY, SHELTERED, HUNGRY');
    }
  });

  it('without food, it retreats, fails, and waits offline at once, as before', async () => {
    const d = routeDecision(makeState(sealedStarving(false)), routerCtx());
    expect(d.decision).toBe('RETREAT_HOME');
    const run = await morning(d, 'cycle-failed');
    expect(run.sessions).toBe(1);
    expect(run.result.mobNearby).not.toBeNull();
  });

  it('idle, a refused meal sealed in is waited out offline at once', async () => {
    const run = async (food: boolean) => {
      const repos = open();
      repos.memory.setValue(OWNER_PAUSED_KEY, 'DankAxon said pause'); // play idles
      const clock = manualClock(new Date().toISOString());
      const now = (): GameState => {
        clock.set(new Date().toISOString());
        return makeWorld((w) => {
          sealedStarving(food)(w);
          w.player.lastHurtAt = new Date(clock.now().getTime() - 1_000).toISOString();
        }, clock).state;
      };
      let sessions = 0;
      let lastCall: StandbyCall | null = null;
      const commands: CommandDeps = {
        take: () => [],
        waiting: () => false,
        reply: () => undefined,
        clearInterrupt: () => undefined,
        view: () => ({
          position: null,
          dimension: null,
          health: null,
          food: null,
          inventory: null,
          playerAt: () => null,
        }),
        step: () => ({ kind: 'refused', reason: 'x' }),
        owners: ['DankAxon'],
        homeName: 'home',
        configLocations: new Map(),
        boundary: {
          min: { x: -256, y: 0, z: -256 },
          max: { x: 256, y: 255, z: 256 },
          allowedDimensions: ['overworld'],
        },
        standby: () => {
          lastCall = standbyReason(now(), testConfig(), repos);
          return Promise.resolve(lastCall);
        },
      };
      const deps: PlayDeps = {
        repos,
        inventory: () => Promise.resolve({}),
        listen: true,
        session: (_limits, hooks) => {
          sessions += 1;
          const d = routeDecision(now(), routerCtx(testConfig(), new Date()));
          // The executor: a refused meal (a repeated failure) needs attention; a retreat fails.
          hooks.onCycle({ summary: 'x', decision: d } as unknown as CycleResult, 1);
          return Promise.resolve({
            cycles: [{ cycleId: 'c', summary: 'x' }],
            stopReason: 'x',
            stopKind: d.decision === 'EAT' ? 'needs-attention' : 'cycle-failed',
            taskId: repos.memory.getValue(CURRENT_TASK_KEY),
            taskStatus: 'active',
            elapsedMs: 1,
          });
        },
        sleep: () => Promise.resolve(),
        commands,
      };
      const result = await runPlay(deps, DEFAULT_PLAY_LIMITS, {
        stopRequested: () => (sessions >= 20 ? 'test over' : null),
      });
      return { result, sessions, lastCall };
    };
    const fed = await run(true);
    const call = fed.lastCall as StandbyCall | null;
    expect(call?.kind === 'reflex' ? call.text.split(' ')[0] : null).toBe('EAT');
    expect(fed.sessions).toBe(1);
    expect(fed.result.mobNearby).toBe('HOSTILES_NEARBY, SHELTERED, HUNGRY');
    const none = await run(false);
    expect(none.sessions).toBe(1);
    expect(none.result.mobNearby).not.toBeNull();
  });
});

describe('food in a stack with NBT data: the client never eats it', () => {
  it('System 1 does not choose it, and the food trip does not count it as carried', () => {
    const nbtOnly = (w: MockWorld): void => {
      w.inventory.items['minecraft:bread'] = 3;
      w.inventory.nbt = { 'minecraft:bread': 3 };
    };
    // Starving, sealed in with hostiles near: as with no food at all.
    const d = routeDecision(
      makeState((w) => void (sealedStarving(true)(w), nbtOnly(w))),
      routerCtx(),
    );
    expect(d.decision).toBe('RETREAT_HOME');
    // Hungry by day: no meal of it either.
    expect(
      routeDecision(
        makeState((w) => void (nbtOnly(w), (w.player.hunger = 10))),
        routerCtx(),
      ).decision,
    ).not.toBe('EAT');
    // One plain loaf besides: that one is eaten.
    const plainToo = (w: MockWorld): void => {
      nbtOnly(w);
      w.inventory.items['minecraft:bread'] = 4;
    };
    expect(
      routeDecision(
        makeState((w) => void (plainToo(w), (w.player.hunger = 10))),
        routerCtx(),
      ).decision,
    ).toBe('EAT');
    // The food status: nothing carried that it would eat.
    const repos = open();
    const status = foodStatusOf(
      makeState((w) => void (nbtOnly(w), (w.player.hunger = 10))),
      testConfig(),
      repos,
    );
    expect(status?.carried).toBe(0);
    expect(
      foodStatusOf(
        makeState((w) => void (plainToo(w), (w.player.hunger = 10))),
        testConfig(),
        repos,
      )?.carried,
    ).toBeGreaterThan(0);
  });

  it("the food trip's planner counts it as none too", () => {
    // An independent review, 2026-10-05: play started a food trip (nothing carried it eats),
    // and the trip's planner was told enough food was carried already.
    const state = makeState((w) => {
      w.player.hunger = 3;
      w.inventory.items = { 'minecraft:bread': 10 };
      w.inventory.nbt = { 'minecraft:bread': 10 };
      w.task = { taskId: FOOD_TASK_ID, goal: 'Get food', subgoal: '0/10', status: 'active' };
    });
    const { route } = routeAndChangesForPlanner(state, undefined, {
      safety: safetyCtx(),
      recentMeals: [],
      combatEnabled: false,
    });
    expect(route?.stock[0]?.have).toBe(0);
  });
});
