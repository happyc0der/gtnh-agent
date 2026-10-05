import type { AgentConfig } from '../../config/env.ts';
import {
  carriedFoodPoints,
  FOOD_TASK_ID,
  FOOD_TRIP_POINTS,
  MEAL_HISTORY_LENGTH,
} from '../../domain/food.ts';
import { usableItems, type GameState, type WorldTime } from '../../domain/game-state.ts';
import { CURRENT_TASK_KEY } from '../../persistence/memory-repository.ts';
import type { Repositories } from '../../persistence/repositories.ts';
import { isProtected, mergeProtectedItems } from '../../safety/protected-items.ts';
import { cycleEvent } from './narration.ts';
import { isDark, nightReason, nightSoon } from './night.ts';
import {
  autonomyOff,
  commandWaiting,
  CONTINUE_AFTER,
  done,
  mobPause,
  waitOutMob,
  type PlayState,
  type RoundEnd,
} from './play-state.ts';
import type { PlayDeps } from './play.ts';

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
  /**
   * Below this food level the food bar is nearly empty (safety.minHunger): the safety policy
   * then lets only a food trip's actions run, so getting food keeps priority over an owner's
   * command (commands.ts).
   */
  starveBelow: number;
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
      usableItems(state.inventory.value),
      config.safety.approvedFoods,
      repos.actions.recentMeals(MEAL_HISTORY_LENGTH),
      (item) => isProtected(item, protectedItems),
      FOOD_TRIP_POINTS,
    ),
    eatBelow: config.safety.hungerEatThreshold,
    starveBelow: config.safety.minHunger,
  };
}

/** Hungry, and nothing carried would restore anything: time to get food. */
export function foodDue(s: FoodStatus): boolean {
  return s.hunger < s.eatBelow && s.carried <= 0;
}

/** The food bar nearly empty with nothing to eat: food comes before an owner's command too. */
export function starving(s: FoodStatus): boolean {
  return s.hunger < s.starveBelow && s.carried <= 0;
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

/**
 * Hungry with nothing to eat, by day: food first, as the shelter comes first at dusk
 * (night.ts). A trip goes on, session after session (a meal does not end one: live-session.ts
 * TASK_PROGRESS), until about a day of food is carried; then the quest goes on where it stopped. With no trip
 * to begin or go on: null (a trip that has its food ends here first).
 */
export async function foodRound(play: PlayState): Promise<RoundEnd> {
  const { deps, limits, hooks, emit } = play;
  const fed = deps.food === undefined ? null : await deps.food.now();
  if (fed !== null && foodTripOngoing(deps.repos) && foodTripDone(fed)) {
    finishFoodTask(deps.repos, `${fed.carried} hunger points of food carried`);
    emit({ kind: 'food', message: `trip over: ${fed.carried} hunger points of food carried` });
    play.foodStuck = 0;
  } else if (
    fed !== null &&
    (foodTripOngoing(deps.repos) || foodDue(fed)) &&
    // An owner paused play: no food trip, unless the food bar is nearly empty.
    (starving(fed) || autonomyOff(deps.repos) === null)
  ) {
    const food = deps.food as NonNullable<PlayDeps['food']>;
    // A food trip on a nearly empty food bar keeps priority; any other gives way to a command.
    const urgent = starving(fed);
    let preempted: string | null = null;
    if (play.foodStuck >= limits.maxStuckSessions) {
      return done(
        play,
        `hungry (food ${fed.hunger}/20) with nothing to eat, and ${play.foodStuck} food sessions in ` +
          `a row found no food and no new ground (last: ${play.lastStop})`,
      );
    }
    if (!foodTripOngoing(deps.repos)) {
      emit({
        kind: 'food',
        message: `food ${fed.hunger}/20 and nothing to eat: getting food first`,
      });
    }
    const adopted = adoptFoodTask(deps.repos, fed);
    emit({
      kind: 'goal',
      quest: `food: ${fed.carried}/${FOOD_TRIP_POINTS} hunger points carried`,
      goal: `get ${FOOD_TRIP_POINTS} hunger points of food`,
      missing: {},
      taskId: adopted.taskId,
      created: adopted.created,
    });
    // The trip got somewhere: more food carried, or a fuller food bar (System 1 eats what is
    // gathered while hungry, so the food carried can stay at 0 as the bar fills).
    let progressed = false;
    let enough = false;
    let foodDark: WorldTime | null = null;
    const session = play.sessions + 1;
    const seenBefore = deps.scouting?.chunksSeen() ?? null;
    const result = await deps.session(limits.session, {
      stopRequested: () =>
        enough
          ? 'enough food is carried'
          : foodDark !== null
            ? nightReason(foodDark)
            : ((urgent ? null : (preempted ??= commandWaiting(play))) ?? hooks.stopRequested()),
      onCycle: (r, index) => {
        play.lastDecision = r.decision ?? null;
        emit(cycleEvent(deps.repos, session, r, index));
        const after = r.outcome?.stateAfter;
        if (after === undefined || after === null) return;
        const now = food.of(after);
        if (now !== null) {
          if (now.carried > fed.carried || now.hunger > fed.hunger) progressed = true;
          if (foodTripDone(now)) enough = true;
        }
        // Shelter time (or dark, without shelters) ends a food session as it ends a quest's.
        if (
          after.time.known &&
          (deps.shelter === undefined ? isDark(after.time.value) : nightSoon(after.time.value))
        ) {
          foodDark = after.time.value;
        }
      },
    });
    play.sessions = session;
    play.lastStop = result.stopReason;
    const sawMore = seenBefore !== null && (deps.scouting?.chunksSeen() ?? 0) > seenBefore;
    // A session a new command or dusk cut short counts neither way (an independent review, 2026-10-05: three quick !status whispers failed a !get for "no progress in 3 sessions").
    if (progressed || sawMore) play.foodStuck = 0;
    else if (preempted === null && foodDark === null) play.foodStuck += 1;
    emit({
      kind: 'session-end',
      session,
      stopKind: result.stopKind,
      stopReason: result.stopReason,
      cycles: result.cycles.length,
      system1: result.system1,
    });
    if (foodDark !== null) {
      deps.repos.memory.appendJournal(FOOD_TASK_ID, `interrupted: ${nightReason(foodDark)}`);
      if (deps.shelter === undefined) return done(play, nightReason(foodDark), foodDark);
      return 'next-round'; // the next round builds the shelter
    }
    // An owner's command comes first; the trip goes on after it.
    if (preempted !== null && result.stopKind === 'stop-requested') return 'next-round';
    if (result.stopKind === 'stop-requested' && !enough) return done(play, result.stopReason);
    const mob = mobPause(result.stopKind, play.lastDecision);
    if (mob !== null) return waitOutMob(play, FOOD_TASK_ID, mob);
    if (!CONTINUE_AFTER.has(result.stopKind)) return done(play, result.stopReason);
    return 'next-round'; // the next round ends the trip, or goes on with it
  }
  return null;
}
