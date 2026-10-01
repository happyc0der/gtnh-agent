import type { AgentConfig } from '../../config/env.ts';
import {
  carriedFoodPoints,
  FOOD_TASK_ID,
  FOOD_TRIP_POINTS,
  MEAL_HISTORY_LENGTH,
} from '../../domain/food.ts';
import type { GameState } from '../../domain/game-state.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { isProtected, mergeProtectedItems } from '../../safety/protected-items.ts';

/**
 * Food trips, play's own task when the agent is hungry and carries no food (approved
 * 2026-10-01). Seen live: food 9/20 with nothing to eat (its only apple eaten), while System 1
 * retreats or pauses below food 6 with no food, which stops play for a person: within a game
 * day or two the agent would starve its own play loop. GTNH's quest "Sticks 'n Stones" says
 * it plainly: "you need food, so look for Pam's Harvestcraft gardens".
 *
 * So, as play turns to the night shelter at dusk, it turns to food by day: hungry (below
 * hungerEatThreshold) with nothing to eat that would restore anything (Spice of Life counted),
 * play makes `get-food` the current task and runs bounded sessions on it until the agent
 * carries FOOD_TRIP_POINTS (about a day of food), then the quest goes on where it stopped.
 * In the sessions everything is as for any task: System 1 decides (and eats once it has food),
 * the planner plans from the food task's route (planner-provider.ts: the gardens and animals
 * code sees, each with its GATHER step, or where to look), code expands GATHER into digs,
 * walks and strikes, and every action is validated, executed and verified.
 */

/** The food situation, from one observation. */
export interface FoodStatus {
  /** Food level 0-20. */
  hunger: number;
  /**
   * Hunger points the approved food carried would restore, eaten meal by meal (Spice of Life
   * counted: food.ts carriedFoodPoints); 0 when eating is off.
   */
  carried: number;
  /** Below this food level System 1 eats (safety.hungerEatThreshold). */
  eatBelow: number;
}

/**
 * The food situation in an observation: its food level, and what the approved, unprotected
 * food carried would restore (Spice of Life counted, with the agent's own meals from the action
 * log); null when either is unknown. Counts up to FOOD_TRIP_POINTS.
 */
export function foodStatusOf(
  state: GameState,
  config: AgentConfig,
  repos: Repositories,
): FoodStatus | null {
  if (!state.player.hunger.known || !state.inventory.known) return null;
  const protectedItems = mergeProtectedItems(
    config.safety.protectedItems,
    repos.protectedItems.items(),
  );
  return {
    hunger: state.player.hunger.value,
    carried: carriedFoodPoints(
      state.inventory.value.items,
      config.safety.approvedFoods,
      repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
      (item) => isProtected(item, protectedItems),
      FOOD_TRIP_POINTS,
    ),
    eatBelow: config.safety.hungerEatThreshold,
  };
}

/** Hungry, and nothing carried would restore anything: time to get food. */
export function foodDue(s: FoodStatus): boolean {
  return s.hunger < s.eatBelow && s.carried <= 0;
}

/** A food trip has what it went for: about a day of food carried. */
export function foodTripDone(s: FoodStatus): boolean {
  return s.carried >= FOOD_TRIP_POINTS;
}

/** A food trip is under way: its task is active (it ends completed, or paused by a person). */
export function foodTripOngoing(repos: Repositories): boolean {
  return repos.tasks.get(FOOD_TASK_ID)?.status === 'active';
}

/** The food task's goal, as the planner reads it. */
export function foodGoal(s: FoodStatus): string {
  return (
    `Get food: hungry (food ${s.hunger}/20) with nothing to eat. Gather ` +
    `${FOOD_TRIP_POINTS} hunger points of approved food (HarvestCraft garden produce, raw ` +
    'beef, porkchop or mutton): GTNH\'s quest book says "look for Pam\'s Harvestcraft gardens". ' +
    'Then the quest goes on.'
  );
}

/**
 * Makes the food task the current task, active (a new trip re-activates it, as the night
 * shelter is each night). No requirements and no blueprint: its route is the food route.
 */
export function adoptFoodTask(
  repos: Repositories,
  s: FoodStatus,
): { taskId: string; created: boolean } {
  return repos.transaction(() => {
    const created = repos.tasks.get(FOOD_TASK_ID) === null;
    repos.tasks.ensure({
      id: FOOD_TASK_ID,
      goal: foodGoal(s),
      subgoal: `${s.carried}/${FOOD_TRIP_POINTS} hunger points of food carried`,
      status: 'active',
    });
    repos.tasks.setStatus(FOOD_TASK_ID, 'active');
    repos.memory.setTaskRequirements(FOOD_TASK_ID, null);
    repos.memory.setTaskBlueprint(FOOD_TASK_ID, null);
    repos.memory.setValue(CURRENT_TASK_KEY, FOOD_TASK_ID);
    return { taskId: FOOD_TASK_ID, created };
  });
}

/**
 * The trip is over (`why`): its task is completed, its open plan closed (the next trip plans
 * afresh), it is no longer current, and the journal says so.
 */
export function finishFoodTask(repos: Repositories, why: string): void {
  repos.transaction(() => {
    const task = repos.tasks.get(FOOD_TASK_ID);
    if (task === null) return;
    if (task.status === 'active') repos.tasks.setStatus(FOOD_TASK_ID, 'completed');
    const open = repos.plans.openForTask(FOOD_TASK_ID);
    if (open !== null) repos.plans.setStatus(open.id, 'completed', why.slice(0, 500));
    if (repos.memory.getValue(CURRENT_TASK_KEY) === FOOD_TASK_ID) {
      repos.memory.setValue(CURRENT_TASK_KEY, null);
    }
    repos.memory.appendJournal(FOOD_TASK_ID, `food trip over: ${why}`.slice(0, 300));
  });
}
