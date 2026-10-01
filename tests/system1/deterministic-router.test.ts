import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { DecisionResultSchema } from '../../src/domain/decisions.ts';
import { FOOD_TASK_ID } from '../../src/domain/food.ts';
import { NIGHT_SHELTER_TASK_ID } from '../../src/domain/night-shelter.ts';
import { routeDecision } from '../../src/system1/deterministic-router.ts';
import { makeState, routerCtx, testConfig } from '../fixtures/index.ts';

const route = (mutate: (w: MockWorld) => void = () => undefined, ctx = routerCtx()) =>
  routeDecision(makeState(mutate), ctx);

const fillInventory = (w: MockWorld): void => {
  Object.assign(w.inventory.items, {
    'minecraft:cobblestone': 64 * 20,
    'minecraft:gravel': 512,
    'minecraft:dirt': 256,
  });
};

describe('System1 deterministic router', () => {
  it('executes the known safe step in the nominal state', () => {
    const d = route();
    expect(d.decision).toBe('EXECUTE_KNOWN_SAFE_STEP');
    expect(d.reasonCodes).toEqual(['KNOWN_SAFE_STEP']);
    expect(d.requiresHumanConfirmation).toBe(false);
    expect(DecisionResultSchema.safeParse(d).success).toBe(true);
  });

  it('is deterministic: identical input gives identical output', () => {
    const state = makeState();
    expect(routeDecision(state, routerCtx())).toEqual(
      routeDecision(structuredClone(state), routerCtx()),
    );
  });

  it('records the facts it used', () => {
    const d = route((w) => {
      w.player.hunger = 8;
    });
    expect(d.factsUsed).toMatchObject({ hunger: 8, approvedFood: 'minecraft:bread', atHome: true });
  });

  describe('priority 0: unreliable state -> PAUSE', () => {
    it.each([
      ['unknown health', (w: MockWorld) => void (w.unobservable = ['health'])],
      ['unknown inventory', (w: MockWorld) => void (w.unobservable = ['inventory'])],
      ['stale', (w: MockWorld) => void (w.observationLagMs = 30_000)],
    ])('%s', (_n, mutate) => {
      const d = route(mutate);
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['STATE_UNRELIABLE']);
      expect(d.confidence).toBe(1);
      expect(d.requiresHumanConfirmation).toBe(true);
    });
  });

  describe('priority 1: danger', () => {
    it('outside the boundary -> PAUSE', () => {
      expect(route((w) => void (w.player.position = { x: 900, y: 64, z: 0 })).reasonCodes).toEqual([
        'OUT_OF_BOUNDS',
      ]);
    });

    it('wrong dimension -> PAUSE', () => {
      expect(route((w) => void (w.player.dimension = 'the_end')).reasonCodes).toEqual([
        'DIMENSION_NOT_ALLOWED',
      ]);
    });

    it('lava nearby, away from home -> RETREAT_HOME', () => {
      const d = route((w) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.hazards = [{ kind: 'lava', position: { x: 31, y: 64, z: 30 } }];
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['HAZARD_NEARBY']);
    });

    it('an unidentified entity nearby, away from home -> RETREAT_HOME', () => {
      const d = route((w) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.unclassified = [{ x: 33, y: 64, z: 30 }];
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['UNCLASSIFIED_ENTITY_NEARBY']);
    });

    it('hostiles nearby while already home -> PAUSE', () => {
      const d = route((w) => void (w.hostiles = [{ x: 4, y: 64, z: 1 }]));
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'ALREADY_AT_SAFE_LOCATION']);
    });

    it('danger with no configured home -> PAUSE', () => {
      const config = { ...testConfig(), locations: {} };
      const d = route((w) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.hostiles = [{ x: 32, y: 64, z: 30 }];
      }, routerCtx(config));
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'NO_SAFE_LOCATION']);
    });

    it('danger outranks hunger and a full inventory', () => {
      const d = route((w) => {
        w.player.position = { x: 30, y: 64, z: 30 };
        w.player.hunger = 8;
        w.hostiles = [{ x: 33, y: 64, z: 30 }];
        fillInventory(w);
      });
      expect(d.decision).toBe('RETREAT_HOME');
    });
  });

  describe('priority 2: vitals', () => {
    it('low health with food enough to heal -> REST where it is', () => {
      const d = route((w) => {
        w.player.health = 5;
        w.player.position = { x: 40, y: 64, z: 40 };
      });
      expect(d.decision).toBe('REST');
      expect(d.reasonCodes).toEqual(['LOW_HEALTH']);
    });

    it('low health while building the night shelter: its steps first (the pit is where to rest)', () => {
      const d = route((w) => {
        w.player.health = 5;
        if (w.task !== null) w.task.taskId = NIGHT_SHELTER_TASK_ID;
      });
      expect(d.decision).not.toBe('REST');
    });

    it('low health, too hungry to heal, away from home -> RETREAT_HOME', () => {
      const d = route((w) => {
        w.player.health = 5;
        w.player.hunger = 7;
        w.player.position = { x: 40, y: 64, z: 40 };
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['LOW_HEALTH']);
    });

    it('hungry with approved food -> EAT', () => {
      expect(route((w) => void (w.player.hunger = 10)).decision).toBe('EAT');
    });

    it('never EAT when the client may not eat (MC_ENABLE_EATING off): as if no food were carried', () => {
      const off = { ...routerCtx(), eatingEnabled: false };
      expect(route((w) => void (w.player.hunger = 10), off).decision).not.toBe('EAT');
    });

    it('starving without approved food -> RETREAT_HOME', () => {
      const d = route((w) => {
        w.player.hunger = 3;
        w.player.position = { x: 40, y: 64, z: 40 };
        delete w.inventory.items['minecraft:bread'];
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['HUNGRY', 'NO_APPROVED_FOOD']);
    });

    it('never eats protected food, even if it is approved', () => {
      const config = testConfig();
      config.safety.protectedItems.push('minecraft:bread');
      const d = route(
        (w) => {
          w.player.hunger = 3;
          w.player.position = { x: 40, y: 64, z: 40 };
        },
        {
          ...routerCtx(config),
          safety: {
            ...routerCtx(config).safety,
            protectedItems: new Set(config.safety.protectedItems),
          },
        },
      );
      expect(d.decision).toBe('RETREAT_HOME');
    });

    it('mildly hungry without food continues with other rules', () => {
      const d = route((w) => {
        w.player.hunger = 10;
        delete w.inventory.items['minecraft:bread'];
      });
      expect(d.decision).toBe('EXECUTE_KNOWN_SAFE_STEP');
    });

    /** Food 2 with nothing to eat (seen live), away from home, on the food task. */
    const starvingOnFoodTask = (w: MockWorld): void => {
      w.player.hunger = 2;
      w.player.position = { x: 40, y: 64, z: 40 };
      delete w.inventory.items['minecraft:bread'];
      w.task = {
        taskId: FOOD_TASK_ID,
        goal: 'Get food',
        subgoal: '0/10 carried',
        status: 'active',
      };
      w.recipe = null;
    };

    it('starving without food, on the food task by day: goes on getting food', () => {
      // A retreat home finds no food there, and a pause only starves (nothing heals offline).
      const d = route(starvingOnFoodTask);
      expect(d.decision).toBe('REQUEST_PLANNER');
      expect(d.factsUsed).toMatchObject({ hunger: 2, approvedFood: null, gettingFood: true });
    });

    it('starving without food, on the food task in the evening: retreats as before', () => {
      const d = route((w) => {
        starvingOnFoodTask(w);
        w.timeOfDay = 12_500;
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['HUNGRY', 'NO_APPROVED_FOOD']);
    });

    it('low health still comes first on the food task', () => {
      const d = route((w) => {
        starvingOnFoodTask(w);
        w.player.health = 5;
      });
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['LOW_HEALTH']);
    });

    it('eats the carried food that restores the most now (Spice of Life)', () => {
      // Five apples among the last meals: the next restores floor(1 x 0.875) = 0.
      const ctx = { ...routerCtx(), recentMeals: Array<string>(5).fill('minecraft:apple') };
      const d = route((w) => {
        w.player.hunger = 10;
        delete w.inventory.items['minecraft:bread'];
        w.inventory.items['minecraft:apple'] = 4;
        w.inventory.items['minecraft:carrot'] = 1;
      }, ctx);
      expect(d.decision).toBe('EAT');
      expect(d.factsUsed).toMatchObject({ approvedFood: 'minecraft:carrot' });
    });

    it('carried food that would restore nothing counts as none', () => {
      const ctx = { ...routerCtx(), recentMeals: Array<string>(5).fill('minecraft:apple') };
      const d = route((w) => {
        w.player.hunger = 3;
        w.player.position = { x: 40, y: 64, z: 40 };
        delete w.inventory.items['minecraft:bread'];
        w.inventory.items['minecraft:apple'] = 4;
      }, ctx);
      expect(d.decision).toBe('RETREAT_HOME');
      expect(d.reasonCodes).toEqual(['HUNGRY', 'NO_APPROVED_FOOD']);
    });
  });

  describe('priority 3-4: upkeep', () => {
    it('inventory nearly full -> EMPTY_INVENTORY', () => {
      expect(route(fillInventory).decision).toBe('EMPTY_INVENTORY');
    });

    it('inventory full without a dump container -> PAUSE', () => {
      const config = testConfig();
      config.routing.dumpContainerId = null;
      const d = route(fillInventory, routerCtx(config));
      expect(d.reasonCodes).toEqual(['INVENTORY_NEARLY_FULL', 'NO_DUMP_CONTAINER']);
    });

    it('empty known generator + approved fuel -> REFUEL_GENERATOR', () => {
      const d = route((w) => void ((w.generators[0] as { fuel: object }).fuel = {}));
      expect(d.decision).toBe('REFUEL_GENERATOR');
      expect(d.factsUsed).toMatchObject({ generator: 'gen.1', fuelItem: 'minecraft:coal' });
    });

    it('empty generator but no approved fuel carried -> not refueled', () => {
      const d = route((w) => {
        (w.generators[0] as { fuel: object }).fuel = {};
        delete w.inventory.items['minecraft:coal'];
      });
      expect(d.decision).toBe('EXECUTE_KNOWN_SAFE_STEP');
    });
  });

  describe('priority 5-7: task progress', () => {
    it('no active task -> PAUSE', () => {
      expect(route((w) => void (w.task = null)).reasonCodes).toEqual(['NO_ACTIVE_TASK']);
      const paused = route(
        (w) => void (w.task = { taskId: 't', goal: 'g', subgoal: null, status: 'paused' }),
      );
      expect(paused.reasonCodes).toEqual(['NO_ACTIVE_TASK']);
    });

    it('required machine busy -> WAIT_FOR_MACHINE', () => {
      expect(
        route((w) => void ((w.machines[0] as { status: string }).status = 'busy')).decision,
      ).toBe('WAIT_FOR_MACHINE');
    });

    it('required machine in error -> PAUSE', () => {
      expect(
        route((w) => void ((w.machines[0] as { status: string }).status = 'error')).reasonCodes,
      ).toEqual(['MACHINE_ERROR']);
    });

    it('required machine not seen (unknown) -> WAIT_FOR_MACHINE, never assumed ready', () => {
      const d = route((w) => void ((w.machines[0] as { status: string }).status = 'unknown'));
      expect(d.decision).toBe('WAIT_FOR_MACHINE');
      expect(d.reasonCodes).toEqual(['MACHINE_UNKNOWN']);
    });

    it('required machine unpowered -> REQUEST_PLANNER', () => {
      const d = route((w) => void ((w.machines[0] as { status: string }).status = 'unpowered'));
      expect(d.decision).toBe('REQUEST_PLANNER');
      expect(d.reasonCodes).toEqual(['MACHINE_NOT_READY']);
    });

    it('no known step -> REQUEST_PLANNER with low confidence', () => {
      const d = route(
        (w) => void ((w.recipe as { nextKnownSafeStep: null }).nextKnownSafeStep = null),
      );
      expect(d.decision).toBe('REQUEST_PLANNER');
      expect(d.confidence).toBeLessThan(0.8);
    });
  });

  it('confidence is always within [0, 1]', () => {
    for (const mutate of [
      () => undefined,
      (w: MockWorld) => void (w.player.hunger = 8),
      (w: MockWorld) => void (w.unobservable = ['threats']),
      fillInventory,
    ]) {
      const { confidence } = route(mutate);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });
});
