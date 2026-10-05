import { describe, expect, it } from 'vitest';
import type { MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { DecisionResultSchema } from '../../src/domain/decisions.ts';
import { FOOD_TASK_ID } from '../../src/domain/food.ts';
import { NIGHT_SHELTER_TASK_ID } from '../../src/domain/night-shelter.ts';
import { mobPause } from '../../src/app/play/play-state.ts';
import {
  CRITICAL_CLOSE,
  CRITICAL_HEALTH,
  routeDecision,
  UNDER_ATTACK_MS,
} from '../../src/system1/deterministic-router.ts';
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

    it('hostiles nearby while sealed in its shelter -> PAUSE (SHELTERED), no retreat or fight', () => {
      const sealedIn = (w: MockWorld): void => {
        w.player.position = { x: 30, y: 61, z: 30 };
        w.player.sealed = true;
        w.hostiles = [{ x: 31, y: 64, z: 30 }];
      };
      const d = route(sealedIn);
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED']);
      expect(d.factsUsed['sealed']).toBe(true);
      // Hurt a moment ago: something reaches it after all. The usual rules decide.
      const hurt = route((w) => {
        sealedIn(w);
        w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - 1_000).toISOString();
      });
      expect(hurt.reasonCodes).not.toContain('SHELTERED');
      // Not known to be sealed (or not sealed): as before.
      expect(route((w) => void (sealedIn(w), (w.player.sealed = null))).decision).toBe(
        'RETREAT_HOME',
      );
      // Lava near too: no staying put for that.
      const lava = route((w) => {
        sealedIn(w);
        w.hazards = [{ kind: 'lava', position: { x: 31, y: 61, z: 30 } }];
      });
      expect(lava.reasonCodes).not.toContain('SHELTERED');
    });

    it('sealed in with hostiles near and hungry, food carried -> EAT (SHELTERED, HUNGRY)', () => {
      // An independent review, 2026-10-05: starving in its sealed pit with zombies about, every
      // meal was refused, and a starving hurt counted as a blow. A meal is safe in there.
      const sealedIn =
        (food: number) =>
        (w: MockWorld): void => {
          w.player.position = { x: 30, y: 61, z: 30 };
          w.player.sealed = true;
          w.hostiles = [{ x: 31, y: 64, z: 30 }];
          w.player.hunger = food;
        };
      const d = route(sealedIn(10));
      expect(d.decision).toBe('EAT');
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED', 'HUNGRY']);
      // Fed (hungerEatThreshold): the pause, as before.
      expect(route(sealedIn(14)).reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED']);
      // Hurt by starving at food 0, no blow: it eats in there all the same.
      const hurtAgo = (w: MockWorld): void => {
        w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - 1_000).toISOString();
      };
      const starving = (w: MockWorld): void => {
        sealedIn(0)(w);
        hurtAgo(w);
        w.player.lastHurtStarving = true;
      };
      expect(route(starving).reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED', 'HUNGRY']);
      // Fed since (the starving hurt is still recent): the pause, not a retreat.
      expect(route((w) => void (starving(w), (w.player.hunger = 14))).reasonCodes).toEqual([
        'HOSTILES_NEARBY',
        'SHELTERED',
      ]);
      // Struck: something reaches it after all, and no meal in there.
      const struck = route((w) => void (sealedIn(10)(w), hurtAgo(w)));
      expect(struck.reasonCodes).not.toContain('SHELTERED');
      // Hungry with nothing to eat (or eating off), not starving: the pause.
      const noFood = (w: MockWorld): void => void delete w.inventory.items['minecraft:bread'];
      expect(route((w) => void (sealedIn(10)(w), noFood(w))).reasonCodes).toEqual([
        'HOSTILES_NEARBY',
        'SHELTERED',
      ]);
      const off = { ...routerCtx(), eatingEnabled: false };
      expect(route(sealedIn(10), off).reasonCodes).toEqual(['HOSTILES_NEARBY', 'SHELTERED']);
      // At food 0 with nothing to eat it does not stay: in there starving hurts on (on Hard, to
      // death). The usual rules decide, as before (a retreat, then play's offline wait).
      const stays = route((w) => void (starving(w), noFood(w)));
      expect(stays.reasonCodes).not.toContain('SHELTERED');
      expect(stays.decision).toBe('RETREAT_HOME');
    });

    it('a creeper within the threat radius -> PAUSE (CREEPER_NEARBY): offline at once, never a walk away', () => {
      // Seen live 2026-10-05, 11:07 EDT: blown up 3 s into a retreat home from 20 health, the
      // nearest of two hostiles 5.8 blocks away (and at 05:27 a Fire Creeper followed a retreat
      // home and exploded beside it).
      const withMob =
        (type: string, dx: number) =>
        (w: MockWorld): void => {
          w.player.position = { x: 30, y: 64, z: 30 };
          w.mobs = [
            {
              id: 7,
              type,
              category: 'hostile',
              position: { x: 30 + dx, y: 64, z: 30 },
              health: 20,
            },
          ];
        };
      for (const type of ['minecraft:Creeper', 'SpecialMobs.FireCreeper']) {
        const d = route(withMob(type, 6));
        expect(d.decision, type).toBe('PAUSE_AND_ASK_USER');
        expect(d.reasonCodes, type).toEqual(['HOSTILES_NEARBY', 'CREEPER_NEARBY']);
        expect(mobPause('needs-attention', d), type).toBe('HOSTILES_NEARBY, CREEPER_NEARBY');
      }
      // Low on food or health changes nothing: offline is safe from a creeper either way.
      const starving = route(
        (w) => void (withMob('minecraft:Creeper', 6)(w), (w.player.hunger = 0)),
      );
      expect(starving.reasonCodes).toContain('CREEPER_NEARBY');
      // A zombie as near: the retreat, as before.
      expect(route(withMob('minecraft:Zombie', 6)).decision).toBe('RETREAT_HOME');
      // A creeper beyond the threat radius: no danger yet.
      expect(route(withMob('minecraft:Creeper', 12)).reasonCodes).not.toContain('CREEPER_NEARBY');
      // Sealed in: no creeper sees the player to light its fuse; it stays inside.
      const sealed = route((w) => {
        withMob('minecraft:Creeper', 3)(w);
        w.player.position = { x: 30, y: 61, z: 30 };
        w.player.sealed = true;
      });
      expect(sealed.reasonCodes).toContain('SHELTERED');
    });

    it('hurt a moment ago with a hostile near -> PAUSE (UNDER_ATTACK): it waits offline', () => {
      // Seen live 2026-10-04: a Special Mobs Mother Spider took the bot from 20 health to 0
      // while it waited to try its walk again and then set off on a 38-block retreat.
      const hurtAgo =
        (ms: number) =>
        (w: MockWorld): void => {
          w.player.position = { x: 30, y: 64, z: 30 };
          w.hostiles = [{ x: 32, y: 64, z: 30 }];
          w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - ms).toISOString();
        };
      const d = route(hurtAgo(1_000));
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'UNDER_ATTACK']);
      // A pause play waits out offline, as for a mob near home.
      expect(mobPause('needs-attention', d)).toBe('HOSTILES_NEARBY, UNDER_ATTACK');
      // Hurt longer ago than UNDER_ATTACK_MS: the retreat, as before.
      expect(route(hurtAgo(UNDER_ATTACK_MS + 1_000)).decision).toBe('RETREAT_HOME');
      // Lava near too: the retreat from it, not a pause.
      const lava = route((w) => {
        hurtAgo(1_000)(w);
        w.hazards = [{ kind: 'lava', position: { x: 31, y: 64, z: 31 } }];
      });
      expect(lava.decision).toBe('RETREAT_HOME');
      // An unidentified creature is an attacker too (an independent review, 2026-10-04).
      const unknown = route((w) => {
        hurtAgo(1_000)(w);
        w.hostiles = [];
        w.unclassified = [{ x: 32, y: 64, z: 30 }];
      });
      expect(unknown.reasonCodes).toEqual(['UNCLASSIFIED_ENTITY_NEARBY', 'UNDER_ATTACK']);
      // At food 0 starving hurts too: offline it would never get food, so the retreat.
      const starving = route((w) => {
        hurtAgo(1_000)(w);
        w.player.hunger = 0;
      });
      expect(starving.reasonCodes).not.toContain('UNDER_ATTACK');
    });

    it('hurt a moment ago with no attacker in view -> PAUSE (UNDER_ATTACK, ATTACKER_UNSEEN): offline too', () => {
      // Seen live 2026-10-05: in its morning staircase, no hostile within 16 blocks, 20 health
      // to 15 in one hit and a fire lit beside it, 16 to 6 sixteen seconds later, while it
      // rested and tried retreats the fire refused.
      const hurtAgo =
        (ms: number) =>
        (w: MockWorld): void => {
          w.player.position = { x: 30, y: 64, z: 30 };
          w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - ms).toISOString();
        };
      const d = route(hurtAgo(1_000));
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['UNDER_ATTACK', 'ATTACKER_UNSEEN']);
      expect(mobPause('needs-attention', d)).toBe('UNDER_ATTACK, ATTACKER_UNSEEN');
      // With only a hazard in view (the fire beside it): the same, offline.
      const fire = route((w) => {
        hurtAgo(1_000)(w);
        w.hazards = [{ kind: 'fire', position: { x: 31, y: 64, z: 30 } }];
      });
      expect(fire.reasonCodes).toEqual(['HAZARD_NEARBY', 'UNDER_ATTACK', 'ATTACKER_UNSEEN']);
      expect(mobPause('needs-attention', fire)).toBe(
        'HAZARD_NEARBY, UNDER_ATTACK, ATTACKER_UNSEEN',
      );
      // Hurt longer ago than UNDER_ATTACK_MS: the usual rules (here: the nominal step).
      expect(route(hurtAgo(UNDER_ATTACK_MS + 1_000)).reasonCodes).not.toContain('UNDER_ATTACK');
      // At food 0 starving hurts: no offline wait for it, it would never get food.
      const starving = route((w) => {
        hurtAgo(1_000)(w);
        w.player.hunger = 0;
      });
      expect(starving.reasonCodes).not.toContain('UNDER_ATTACK');
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

    it('low health and hungry (below hungerEatThreshold) with food carried -> EAT first, then REST', () => {
      const lowAt = (hunger: number) =>
        route((w) => {
          w.player.health = 1;
          w.player.hunger = hunger;
          w.player.position = { x: 40, y: 64, z: 40 };
        });
      const hungry = lowAt(12);
      expect(hungry.decision).toBe('EAT');
      expect(hungry.reasonCodes).toEqual(['LOW_HEALTH']);
      // At 14 or more, no meal: Hunger Overhaul heals from 8 on, no faster for a fuller bar
      // (an independent review, 2026-10-05: meals from 14 to 18 only wasted food).
      expect(lowAt(14).decision).toBe('REST');
    });

    it('a creature near with health at CRITICAL_HEALTH or below -> PAUSE: offline, too weak to run', () => {
      const weak =
        (health: number, x = 30 + CRITICAL_CLOSE - 1) =>
        (w: MockWorld): void => {
          w.player.health = health;
          w.player.position = { x: 30, y: 64, z: 30 };
          w.hostiles = [{ x, y: 64, z: 30 }];
        };
      const d = route(weak(CRITICAL_HEALTH));
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['HOSTILES_NEARBY', 'CRITICAL_HEALTH']);
      expect(mobPause('needs-attention', d)).toBe('HOSTILES_NEARBY, CRITICAL_HEALTH');
      // Above it: the retreat, as before.
      expect(route(weak(CRITICAL_HEALTH + 1)).decision).toBe('RETREAT_HOME');
      // Farther than CRITICAL_CLOSE and no blow yet (a zombie in a cave below, say): no
      // offline wait, which would last for good (an independent review, 2026-10-05).
      expect(route(weak(CRITICAL_HEALTH, 38)).decision).toBe('RETREAT_HOME');
      // Struck a moment ago: offline whatever the distance.
      const struck = route((w) => {
        weak(CRITICAL_HEALTH, 38)(w);
        w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - 1_000).toISOString();
      });
      expect(struck.reasonCodes).toEqual(['HOSTILES_NEARBY', 'CRITICAL_HEALTH']);
      // Hurt starving at food 0, not struck: no offline wait for it.
      const starved = route((w) => {
        weak(CRITICAL_HEALTH, 38)(w);
        w.player.hunger = 1;
        w.player.lastHurtAt = new Date(Date.parse(makeState().timestamp) - 1_000).toISOString();
        w.player.lastHurtStarving = true;
      });
      expect(starved.reasonCodes).not.toContain('CRITICAL_HEALTH');
      expect(starved.reasonCodes).not.toContain('UNDER_ATTACK');
    });

    it('low health while building the night shelter: its steps first (the pit is where to rest)', () => {
      const d = route((w) => {
        w.player.health = 5;
        if (w.task !== null) w.task.taskId = NIGHT_SHELTER_TASK_ID;
      });
      expect(d.decision).not.toBe('REST');
    });

    it('low health, too hungry to heal: EAT what it carries, else RETREAT_HOME', () => {
      const tooHungry = (food: boolean) =>
        route((w) => {
          w.player.health = 5;
          w.player.hunger = 7;
          w.player.position = { x: 40, y: 64, z: 40 };
          if (!food) delete w.inventory.items['minecraft:bread'];
        });
      // An independent review, 2026-10-05: with bread carried, it walked home and paused there.
      const eat = tooHungry(true);
      expect(eat.decision).toBe('EAT');
      expect(eat.reasonCodes).toEqual(['LOW_HEALTH', 'HUNGRY']);
      const d = tooHungry(false);
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

    it('starving without approved food, away from home -> PAUSE (a walk home burns food)', () => {
      // Seen live: at food 2 the retreat home walked 143 blocks; home has no food.
      const d = route((w) => {
        w.player.hunger = 3;
        w.player.position = { x: 40, y: 64, z: 40 };
        delete w.inventory.items['minecraft:bread'];
      });
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
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
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
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

    it('starving without food, on the food task in the evening: pauses where it is', () => {
      const d = route((w) => {
        starvingOnFoodTask(w);
        w.timeOfDay = 12_500;
      });
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
      expect(d.reasonCodes).toEqual(['HUNGRY', 'NO_APPROVED_FOOD']);
    });

    it('low health from hunger does not stop the food trip by day: food is the cure', () => {
      const d = route((w) => {
        starvingOnFoodTask(w);
        w.player.health = 5;
      });
      expect(d.decision).toBe('REQUEST_PLANNER');
      expect(d.factsUsed).toMatchObject({ health: 5, gettingFood: true });
      // In the evening (no food trip) it retreats as before.
      const evening = route((w) => {
        starvingOnFoodTask(w);
        w.player.health = 5;
        w.timeOfDay = 12_500;
      });
      expect(evening.decision).toBe('RETREAT_HOME');
      expect(evening.reasonCodes).toEqual(['LOW_HEALTH']);
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
      expect(d.decision).toBe('PAUSE_AND_ASK_USER');
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
