import type { Decision, DecisionResult, FactValue, ReasonCode } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance } from '../domain/geometry.ts';
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
 *      hostiles nearby and fighting back is the answer -> DEFEND (only with combat enabled; see
 *                                                         defend.ts: cornered by a quick kill,
 *                                                         or nowhere to retreat to)
 *      lava/void/hostiles nearby                       -> RETREAT_HOME (or PAUSE if already home / no home)
 *   2. low health                                      -> RETREAT_HOME (or PAUSE)
 *      hungry                                          -> EAT (or RETREAT_HOME/PAUSE with no approved food)
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
    return retreatOrPause(codes, CONFIDENCE.safety);
  }

  // 2. Vitals. (Health/hunger are known here: reliability checked them.)
  const health = state.player.health.known ? state.player.health.value : 0;
  const hunger = state.player.hunger.known ? state.player.hunger.value : 0;
  facts['health'] = health;
  facts['hunger'] = hunger;
  if (health < ctx.safety.config.minHealth) {
    return retreatOrPause(['LOW_HEALTH'], CONFIDENCE.vitals);
  }
  if (hunger < ctx.safety.config.hungerEatThreshold) {
    const food = availableApprovedFood(state, ctx);
    facts['approvedFood'] = food;
    if (food !== null) return decide('EAT', CONFIDENCE.vitals, ['HUNGRY']);
    if (hunger < ctx.safety.config.minHunger) {
      return retreatOrPause(['HUNGRY', 'NO_APPROVED_FOOD'], CONFIDENCE.vitals);
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
