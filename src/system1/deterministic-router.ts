import { recentHurtMs } from '../domain/combat.ts';
import type { Decision, DecisionResult, FactValue, ReasonCode } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import { gettingFood } from '../domain/food.ts';
import { distance } from '../domain/geometry.ts';
import { NIGHT_SHELTER_TASK_ID } from '../domain/night-shelter.ts';
import { assessDangers, assessStateReliability } from '../safety/safety-policy.ts';
import { assessDefense } from './defend.ts';
import {
  availableApprovedFood,
  findStorage,
  generatorNeedingFuel,
  homeLocation,
  inventoryFillFraction,
  playerPosition,
  selectDepositCandidate,
  type RouterContext,
} from './state-queries.ts';

export const DETERMINISTIC_ROUTER_NAME = 'deterministic-router';

/** Hurt this recently (ms) with a hostile near is being attacked (UNDER_ATTACK). */
export const UNDER_ATTACK_MS = 5_000;
/**
 * Health (half-hearts) at or below which a hostile near is waited out offline at once
 * (CRITICAL_HEALTH): a zombie or a skeleton on Hard takes 3 to 5 a blow.
 */
export const CRITICAL_HEALTH = 6;
/**
 * At CRITICAL_HEALTH, a creature this near (blocks) is waited out offline though it has not
 * struck yet: a zombie closes 5 blocks in about 2 s.
 */
export const CRITICAL_CLOSE = 5;

/**
 * Fixed confidence per rule. The router is deterministic, so "confidence" expresses
 * how sure the rule is that its decision is appropriate, not a probability estimate.
 */
const CONFIDENCE = {
  failClosed: 1,
  safety: 0.95,
  vitals: 0.9,
  upkeep: 0.85,
  wait: 0.8,
  knownStep: 0.8,
  noTask: 0.9,
  planner: 0.5,
} as const;

/** Reason codes that mark a decision as safety-driven (used by SafetyFirstDecisionProvider). */
export const SAFETY_REASON_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'STATE_UNRELIABLE',
  'OUT_OF_BOUNDS',
  'DIMENSION_NOT_ALLOWED',
  'HAZARD_NEARBY',
  'HOSTILES_NEARBY',
  'UNCLASSIFIED_ENTITY_NEARBY',
  'HOSTILE_IN_REACH',
  'CREEPER_NEARBY',
  'TOO_MANY_HOSTILES',
  'SHELTERED',
  'UNDER_ATTACK',
  'LOW_HEALTH',
  'HUNGRY',
  'NO_APPROVED_FOOD',
]);

/**
 * System 1: a transparent, prioritized rule list over a normalized GameState.
 * Pure function: same state + context => same decision.
 *
 * Priority:
 *   0. unreliable state (unknown/stale/inconsistent)  -> PAUSE_AND_ASK_USER
 *   1. outside work area                               -> PAUSE_AND_ASK_USER
 *      creatures nearby, the player sealed in, not     -> EAT (SHELTERED, HUNGRY) when hungry with
 *      struck lately, no lava or void near                food it can eat, else PAUSE (SHELTERED: it
 *                                                         stays inside); at food 0 with nothing to
 *                                                         eat, the rules below
 *      creatures nearby, too weak to run or fight      -> PAUSE (CRITICAL_HEALTH: offline at once)
 *      hostiles nearby and fighting back is the answer -> DEFEND (only with combat enabled; see
 *                                                         defend.ts: cornered by a quick kill,
 *                                                         or nowhere to retreat to)
 *      struck lately, a creature near, no hazard       -> PAUSE (UNDER_ATTACK: offline at once)
 *      struck lately, only a hazard in view            -> PAUSE (UNDER_ATTACK, ATTACKER_UNSEEN)
 *      lava/void/hostiles nearby                       -> RETREAT_HOME (or PAUSE if already home / no home)
 *      struck lately, nothing in view                  -> PAUSE (UNDER_ATTACK, ATTACKER_UNSEEN)
 *   2. low health                                      -> REST (food enough to heal), else RETREAT_HOME (or PAUSE)
 *      hungry                                          -> EAT (or RETREAT_HOME/PAUSE with no approved food
 *                                                         below minHunger, except while the food task
 *                                                         gets food by day: it goes on)
 *   3. inventory nearly full                           -> EMPTY_INVENTORY (or PAUSE without a dump container)
 *   4. known generator out of fuel + approved fuel     -> REFUEL_GENERATOR
 *   5. no active task                                  -> PAUSE_AND_ASK_USER
 *      required machine busy                           -> WAIT_FOR_MACHINE
 *      required machine error                          -> PAUSE_AND_ASK_USER
 *      required machine not seen (unknown)             -> WAIT_FOR_MACHINE (never assume it is ready)
 *      required machine unpowered                      -> REQUEST_PLANNER
 *   6. known validated next step                       -> EXECUTE_KNOWN_SAFE_STEP
 *   7. otherwise                                       -> REQUEST_PLANNER
 */
export function routeDecision(state: GameState, ctx: RouterContext): DecisionResult {
  const facts: Record<string, FactValue> = { stateTimestamp: state.timestamp };
  const decide = (
    decision: Decision,
    confidence: number,
    reasonCodes: ReasonCode[],
    requiresHumanConfirmation = decision === 'PAUSE_AND_ASK_USER',
  ): DecisionResult => ({
    decision,
    confidence,
    reasonCodes,
    factsUsed: facts,
    requiresHumanConfirmation,
    provider: DETERMINISTIC_ROUTER_NAME,
  });

  // 0. Fail closed on unreliable observations.
  const reliability = assessStateReliability(state, ctx.safety);
  if (reliability.length > 0) {
    facts['reliabilityViolations'] = reliability.map((v) => v.code).join(',');
    return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, ['STATE_UNRELIABLE']);
  }

  const position = playerPosition(state);
  const home = homeLocation(ctx);
  const atHome =
    home !== null &&
    position !== null &&
    distance(position, home.position) <= ctx.safety.config.interactionReach;
  facts['position'] = position === null ? null : `${position.x},${position.y},${position.z}`;
  facts['homeKnown'] = home !== null;
  facts['atHome'] = atHome;

  /** Retreat if there is somewhere to go; otherwise ask the user. */
  const retreatOrPause = (codes: ReasonCode[], confidence: number): DecisionResult => {
    if (home === null)
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, [...codes, 'NO_SAFE_LOCATION']);
    if (atHome)
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, [
        ...codes,
        'ALREADY_AT_SAFE_LOCATION',
      ]);
    return decide('RETREAT_HOME', confidence, codes);
  };

  // 1. Immediate danger.
  const dangers = assessDangers(state, ctx.safety);
  const dangerCodes = new Set(dangers.map((d) => d.code));
  facts['dangers'] = dangers.map((d) => d.code).join(',') || null;
  if (dangerCodes.has('OUT_OF_BOUNDS') || dangerCodes.has('DIMENSION_NOT_ALLOWED')) {
    const codes: ReasonCode[] = [];
    if (dangerCodes.has('OUT_OF_BOUNDS')) codes.push('OUT_OF_BOUNDS');
    if (dangerCodes.has('DIMENSION_NOT_ALLOWED')) codes.push('DIMENSION_NOT_ALLOWED');
    return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, codes);
  }
  if (
    dangerCodes.has('HAZARD_PROXIMITY') ||
    dangerCodes.has('HOSTILES_NEARBY') ||
    dangerCodes.has('UNCLASSIFIED_ENTITY_NEARBY')
  ) {
    const codes: ReasonCode[] = [];
    if (dangerCodes.has('HAZARD_PROXIMITY')) codes.push('HAZARD_NEARBY');
    if (dangerCodes.has('HOSTILES_NEARBY')) codes.push('HOSTILES_NEARBY');
    if (dangerCodes.has('UNCLASSIFIED_ENTITY_NEARBY')) codes.push('UNCLASSIFIED_ENTITY_NEARBY');
    // Sealed in (full blocks beside, above and below it: its roofed night pit) and not struck
    // lately: no mob can reach the player, and no retreat or fight could leave or strike
    // through the walls. It stays inside (seen live 2026-10-04: zombies about the night pit at
    // sunrise, and RETREAT_HOME failed from inside it session after session). Hostiles still
    // stop every other action: play waits for them to go before it digs out (night.ts).
    const hurt = recentHurtMs(state.player.lastHurtAt, state.timestamp);
    // A loss at food 0 was starving, not a blow (a meal since lifts the food bar, not the hurt).
    const struck = hurt !== null && !state.player.lastHurtStarving;
    facts['sealed'] = state.player.sealed;
    const starving = state.player.hunger.known && state.player.hunger.value <= 0;
    // Starving is no creature reaching it, and a meal is safe in there: hungry with food
    // carried, it eats (an independent review, 2026-10-05: starving in the sealed pit with
    // zombies about, every meal was refused). At food 0 with nothing to eat it does not stay:
    // in there starving hurts on (on Hard, to death). The rules below decide, as before: a
    // retreat, which cannot leave the pit, and then play's offline wait, where nothing starves.
    if (!dangerCodes.has('HAZARD_PROXIMITY') && state.player.sealed === true && !struck) {
      const hungry =
        state.player.hunger.known &&
        state.player.hunger.value < ctx.safety.config.hungerEatThreshold;
      if (hungry && availableApprovedFood(state, ctx) !== null) {
        return decide('EAT', CONFIDENCE.vitals, [...codes, 'SHELTERED', 'HUNGRY']);
      }
      if (!starving) {
        return decide('PAUSE_AND_ASK_USER', CONFIDENCE.safety, [...codes, 'SHELTERED']);
      }
    }
    // A creature near and too weak to run or fight: one blow more may kill, and a walk away is
    // slower than many mobs. It waits offline (seen live 2026-10-05: down to 1 health, from
    // something it never saw), when struck a moment ago or with the creature within
    // CRITICAL_CLOSE: not for one that cannot reach it (in a cave below), which would keep it
    // offline for good, since nothing heals offline and mobs freeze while nobody is on (an
    // independent review, 2026-10-05). Not at food 0: starving hurts too, and offline it would
    // never get food.
    const weak = state.player.health.known && state.player.health.value <= CRITICAL_HEALTH;
    const threats = state.nearbyThreats.known ? state.nearbyThreats.value : null;
    const closest = Math.min(
      threats?.nearestHostileDistance ?? Infinity,
      threats?.nearestUnclassifiedDistance ?? Infinity,
    );
    if (
      (dangerCodes.has('HOSTILES_NEARBY') || dangerCodes.has('UNCLASSIFIED_ENTITY_NEARBY')) &&
      weak &&
      !starving &&
      (struck || closest <= CRITICAL_CLOSE)
    ) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.safety, [...codes, 'CRITICAL_HEALTH']);
    }
    // Fighting back is considered only when hostiles are the sole danger: never near lava or
    // void, never with an unidentified entity near, never with low health or food.
    if ([...dangerCodes].every((c) => c === 'HOSTILES_NEARBY')) {
      const defense = assessDefense(state, ctx, { possible: home !== null && !atHome });
      facts['defense'] = defense.kind;
      if (defense.kind === 'defend') {
        const t = defense.target;
        facts['defendTarget'] = t.id;
        facts['defendTargetType'] = t.type;
        facts['defendTargetDistance'] = t.distance;
        facts['defendTargetHealth'] = t.health;
        const why = new Set<ReasonCode>([...codes, ...defense.reasons]);
        if (home === null) why.add('NO_SAFE_LOCATION');
        else if (atHome) why.add('ALREADY_AT_SAFE_LOCATION');
        return decide('DEFEND', CONFIDENCE.safety, [...why]);
      }
      if (defense.kind === 'flee') codes.push(...defense.reasons);
    }
    // Hurt a moment ago with a hostile (or an unidentified creature) near, and not fighting back:
    // an offline player cannot be hurt, and a walk away is slower than a spider (seen live
    // 2026-10-04: a Special Mobs Mother Spider took the bot from 20 health to 0 while it waited to
    // try its walk again and then set off on a 38-block retreat). It waits offline (play-state.ts
    // mobPause). Not at food 0: starving hurts too, and offline it would never get food.
    if (
      (dangerCodes.has('HOSTILES_NEARBY') || dangerCodes.has('UNCLASSIFIED_ENTITY_NEARBY')) &&
      !dangerCodes.has('HAZARD_PROXIMITY') &&
      !starving &&
      struck &&
      hurt <= UNDER_ATTACK_MS
    ) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.safety, [...codes, 'UNDER_ATTACK']);
    }
    // Hurt a moment ago with only a hazard in view (a fire lit beside it): whatever hurt it is
    // out of sight, and it waits offline as well (seen live 2026-10-05, below).
    if (
      !dangerCodes.has('HOSTILES_NEARBY') &&
      !dangerCodes.has('UNCLASSIFIED_ENTITY_NEARBY') &&
      !starving &&
      struck &&
      hurt <= UNDER_ATTACK_MS
    ) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.safety, [
        ...codes,
        'UNDER_ATTACK',
        'ATTACKER_UNSEEN',
      ]);
    }
    return retreatOrPause(codes, CONFIDENCE.safety);
  }

  // Hurt a moment ago with nothing in view that could have done it (a ranged mob beyond the
  // scan, an invisible one, a mod's lightning): an offline player cannot be hurt, so it waits
  // offline, as when a mob in view attacks (seen live 2026-10-05: in its morning staircase, no
  // hostile within 16 blocks, 20 health to 15 in one hit, a fire lit beside it, and 16 to 6
  // sixteen seconds later, while it rested and tried retreats the fire refused). Not at food
  // 0: starving hurts too, and offline it would never get food.
  {
    const hurt = recentHurtMs(state.player.lastHurtAt, state.timestamp);
    const starving = state.player.hunger.known && state.player.hunger.value <= 0;
    // A loss at food 0 was starving, though a meal since lifted the food bar (an independent
    // review, 2026-10-05: one bite after starving, the food trip went offline for an attacker).
    if (!starving && !state.player.lastHurtStarving && hurt !== null && hurt <= UNDER_ATTACK_MS) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.safety, ['UNDER_ATTACK', 'ATTACKER_UNSEEN']);
    }
  }

  // 2. Vitals. (Health/hunger are known here: reliability checked them.)
  const health = state.player.health.known ? state.player.health.value : 0;
  const hunger = state.player.hunger.known ? state.player.hunger.value : 0;
  facts['health'] = health;
  facts['hunger'] = hunger;
  if (health < ctx.safety.config.minHealth) {
    // Nothing threatens the player (rule 1 took every danger): it rests where it is while the
    // food bar heals it, as a person does (seen live: at 8 health with no food, the retreat
    // home was 100 blocks through a forest, and the pause there healed nothing: nothing heals
    // offline). Too hungry to heal: retreat or pause, as before.
    if (hunger < ctx.safety.config.minHungerToHeal) {
      // Too hungry to heal: food carried is eaten first (an independent review, 2026-10-05:
      // with bread carried, it walked home and paused there for a person). On the food trip by
      // day, getting food is the cure for both (seen live: starving, health fell below
      // minHealth on the way, and a pause would only have left it too weak to fetch food and
      // too hungry to heal). Otherwise retreat or pause.
      if (availableApprovedFood(state, ctx) !== null) {
        return decide('EAT', CONFIDENCE.vitals, ['LOW_HEALTH', 'HUNGRY']);
      }
      if (!gettingFood(state)) return retreatOrPause(['LOW_HEALTH'], CONFIDENCE.vitals);
      facts['gettingFood'] = true;
    } else if (state.currentTask?.taskId !== NIGHT_SHELTER_TASK_ID) {
      // At dusk the night shelter comes first: the pit is where resting is safe (seen live:
      // it rested in the open before digging in). Its steps run below (rule 6). Before the
      // rest, a meal when it is hungry anyway (below hungerEatThreshold): Hunger Overhaul heals
      // from minHungerToHeal on, no faster for a fuller bar, and healing uses food up; a meal
      // more would only waste food (and wear out its kind for Spice of Life).
      const food =
        hunger < ctx.safety.config.hungerEatThreshold ? availableApprovedFood(state, ctx) : null;
      if (food !== null) return decide('EAT', CONFIDENCE.vitals, ['LOW_HEALTH']);
      return decide('REST', CONFIDENCE.vitals, ['LOW_HEALTH']);
    }
  }
  if (hunger < ctx.safety.config.hungerEatThreshold) {
    const food = availableApprovedFood(state, ctx);
    facts['approvedFood'] = food;
    if (food !== null) return decide('EAT', CONFIDENCE.vitals, ['HUNGRY']);
    if (hunger < ctx.safety.config.minHunger) {
      // Getting food is the cure: in daylight, the play loop's food task (src/app/play/food.ts)
      // goes on with its steps instead of retreating to a home that has no food, or pausing
      // for a person (nothing heals offline, and a pause only starves). Health below
      // minHealth still retreats or pauses above (rule 2's health part).
      if (gettingFood(state)) {
        facts['gettingFood'] = true;
      } else {
        // No food trip now (the evening, the night): pause where it is. A walk home burns
        // food and finds none there (seen live: at food 2, the retreat home walked 143
        // blocks at dusk; on Hard a food bar at 0 starves the player to death).
        return decide('PAUSE_AND_ASK_USER', CONFIDENCE.vitals, ['HUNGRY', 'NO_APPROVED_FOOD']);
      }
    }
    // Mildly hungry with no food: not yet dangerous; continue with lower-priority rules.
  }

  // 3. Inventory nearly full.
  const fill = inventoryFillFraction(state);
  facts['inventoryFill'] = fill === null ? null : Number(fill.toFixed(3));
  if (fill !== null && fill >= ctx.safety.config.inventoryNearlyFullFraction) {
    const dump = findStorage(state, ctx.routing.dumpContainerId);
    const candidate = selectDepositCandidate(state, ctx);
    facts['dumpContainer'] = dump?.id ?? null;
    facts['depositCandidate'] = candidate?.item ?? null;
    if (dump === null || !dump.position.known) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, [
        'INVENTORY_NEARLY_FULL',
        'NO_DUMP_CONTAINER',
      ]);
    }
    if (candidate === null) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, [
        'INVENTORY_NEARLY_FULL',
        'NOTHING_DEPOSITABLE',
      ]);
    }
    return decide('EMPTY_INVENTORY', CONFIDENCE.upkeep, ['INVENTORY_NEARLY_FULL']);
  }

  // 4. Generator upkeep.
  const refuel = generatorNeedingFuel(state, ctx);
  if (refuel !== null) {
    facts['generator'] = refuel.generator.id;
    facts['fuelItem'] = refuel.fuelItem;
    return decide('REFUEL_GENERATOR', CONFIDENCE.upkeep, [
      'GENERATOR_OUT_OF_FUEL',
      'APPROVED_FUEL_AVAILABLE',
    ]);
  }

  // 5. Task and machine readiness.
  const task = state.currentTask;
  facts['taskId'] = task?.taskId ?? null;
  facts['taskStatus'] = task?.status ?? null;
  if (task === null || task.status !== 'active') {
    return decide('PAUSE_AND_ASK_USER', CONFIDENCE.noTask, ['NO_ACTIVE_TASK']);
  }
  const recipe = state.knownRecipeState;
  if (recipe !== null) {
    const required = recipe.requiredMachineIds.map(
      (id) => state.machines.find((m) => m.id === id) ?? { id, status: 'unknown' as const },
    );
    facts['requiredMachines'] = required.map((m) => `${m.id}=${m.status}`).join(',') || null;
    if (required.some((m) => m.status === 'error')) {
      return decide('PAUSE_AND_ASK_USER', CONFIDENCE.failClosed, ['MACHINE_ERROR']);
    }
    if (required.some((m) => m.status === 'busy')) {
      return decide('WAIT_FOR_MACHINE', CONFIDENCE.wait, ['MACHINE_BUSY']);
    }
    // A machine the agent cannot see (not observed yet, or its chunk not loaded) might be
    // busy: a step that depends on it waits rather than assume it is ready.
    if (required.some((m) => m.status === 'unknown')) {
      return decide('WAIT_FOR_MACHINE', CONFIDENCE.wait, ['MACHINE_UNKNOWN']);
    }
    if (required.some((m) => m.status === 'unpowered')) {
      return decide('REQUEST_PLANNER', CONFIDENCE.planner, ['MACHINE_NOT_READY']);
    }

    // 6. A known, validated step.
    if (recipe.nextKnownSafeStep !== null) {
      facts['nextStepType'] = recipe.nextKnownSafeStep.type;
      return decide('EXECUTE_KNOWN_SAFE_STEP', CONFIDENCE.knownStep, ['KNOWN_SAFE_STEP']);
    }
  }

  // 7. Nothing deterministic applies.
  return decide('REQUEST_PLANNER', CONFIDENCE.planner, ['NO_KNOWN_STEP']);
}
