import { describe, expect, it } from 'vitest';
import {
  adoptFoodTask,
  finishFoodTask,
  foodDue,
  foodGoal,
  foodStatusOf,
  foodTripDone,
  foodTripOngoing,
} from '../../src/app/food.ts';
import { FOOD_TASK_ID, FOOD_TRIP_POINTS } from '../../src/domain/food.ts';
import { CURRENT_TASK_KEY } from '../../src/persistence/memory-repository.ts';
import type { Repositories } from '../../src/persistence/repositories.ts';
import { makeState, memoryRepos, testConfig } from '../fixtures/index.ts';

const ate = (repos: Repositories, items: readonly string[]): void => {
  items.forEach((item, i) => {
    repos.actions.insert({
      actionId: `meal-${i}`,
      cycleId: 'c',
      taskId: 't',
      actionType: 'EAT_FOOD',
      origin: 'deterministic-router',
      fingerprint: `EAT_FOOD:${item}`,
      reason: 'hungry',
      action: { type: 'EAT_FOOD', args: { item } },
      status: 'proposed',
      validation: { ok: true },
    });
    repos.actions.update(`meal-${i}`, { status: 'succeeded' });
  });
};

describe('the food situation', () => {
  it('counts what the approved, unprotected food carried restores (Spice of Life counted)', () => {
    const repos = memoryRepos();
    const config = testConfig();
    const state = makeState((w) => {
      w.player.hunger = 9;
      w.inventory.items = { 'minecraft:apple': 3, 'minecraft:carrot': 2 };
    });
    expect(foodStatusOf(state, config, repos)).toEqual({ hunger: 9, carried: 5, eatBelow: 14 });
    // Five apples eaten lately: the apples carried restore nothing now.
    ate(repos, Array<string>(5).fill('minecraft:apple'));
    expect(foodStatusOf(state, config, repos)?.carried).toBe(2);
    // A protected food is never counted (it is never eaten).
    repos.protectedItems.add('minecraft:carrot', 'kept for a quest', 'user');
    expect(foodStatusOf(state, config, repos)?.carried).toBe(0);
  });

  it('is unknown when the food level or the inventory is', () => {
    const repos = memoryRepos();
    const blind = makeState((w) => void (w.unobservable = ['inventory']));
    expect(foodStatusOf(blind, testConfig(), repos)).toBeNull();
  });

  it('says when a trip is due (hungry, nothing to eat) and when it has enough', () => {
    expect(foodDue({ hunger: 9, carried: 0, eatBelow: 14 })).toBe(true);
    expect(foodDue({ hunger: 9, carried: 1, eatBelow: 14 })).toBe(false); // eat that first
    expect(foodDue({ hunger: 14, carried: 0, eatBelow: 14 })).toBe(false); // not hungry yet
    expect(foodTripDone({ hunger: 9, carried: FOOD_TRIP_POINTS, eatBelow: 14 })).toBe(true);
    expect(foodTripDone({ hunger: 9, carried: FOOD_TRIP_POINTS - 1, eatBelow: 14 })).toBe(false);
  });
});

describe('the food task', () => {
  it('becomes the current, active task, with no requirements: its route is the food route', () => {
    const repos = memoryRepos();
    const status = { hunger: 2, carried: 0, eatBelow: 14 };
    expect(foodTripOngoing(repos)).toBe(false);
    expect(adoptFoodTask(repos, status)).toEqual({ taskId: FOOD_TASK_ID, created: true });
    expect(foodTripOngoing(repos)).toBe(true);
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBe(FOOD_TASK_ID);
    expect(repos.tasks.get(FOOD_TASK_ID)).toMatchObject({
      status: 'active',
      goal: foodGoal(status),
    });
    expect(repos.memory.taskRequirements(FOOD_TASK_ID)).toBeNull();
    expect(foodGoal(status)).toContain('food 2/20');

    finishFoodTask(repos, '10 hunger points of food carried');
    expect(foodTripOngoing(repos)).toBe(false);
    expect(repos.tasks.get(FOOD_TASK_ID)?.status).toBe('completed');
    expect(repos.memory.getValue(CURRENT_TASK_KEY)).toBeNull();
    expect(repos.memory.journal(FOOD_TASK_ID).at(-1)?.text).toBe(
      'food trip over: 10 hunger points of food carried',
    );

    // The next trip makes the same task active again.
    expect(adoptFoodTask(repos, status)).toEqual({ taskId: FOOD_TASK_ID, created: false });
    expect(repos.tasks.get(FOOD_TASK_ID)?.status).toBe('active');
  });
});
