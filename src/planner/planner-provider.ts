import { ACTION_TYPES } from '../domain/actions.ts';
import type { GameState } from '../domain/game-state.ts';
import { forbiddenKeywords } from '../safety/forbidden-actions.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';
import {
  PlannerRequestSchema,
  type CompactState,
  type PlannerRequest,
  type PlannerResponse,
} from './plan-schema.ts';

/**
 * High-level planner (a local LLM in the future; a fixture-driven mock today).
 *
 * Contract:
 *  - It receives only a PlannerRequest (compact state, task, allowlist, constraints, history).
 *  - It returns a PlannerResponse: a strict Plan or an explicit escalation.
 *  - It has NO execution authority. The agent loop validates every step against the
 *    schema and the safety policy, and only the executor performs actions.
 *  - It is called only for REQUEST_PLANNER decisions (unknown/blocked work).
 */
export interface PlannerProvider {
  readonly name: string;
  plan(request: PlannerRequest): Promise<PlannerResponse>;
}

export interface RecentActionSummary {
  actionType: (typeof ACTION_TYPES)[number];
  status: string;
  reason: string;
}

export interface RecentFailureSummary {
  actionType: (typeof ACTION_TYPES)[number];
  fingerprint: string;
  failures: number;
}

/** Reduces GameState to what a planner needs. Unknown values stay null and are listed. */
export function sanitizeStateForPlanner(state: GameState): CompactState {
  const unknownFields: string[] = [];
  const val = <T>(
    name: string,
    k: { known: true; value: T } | { known: false; reason: string },
  ): T | null => {
    if (k.known) return k.value;
    unknownFields.push(name);
    return null;
  };

  const position = val('player.position', state.player.position);
  const dimension = val('player.dimension', state.player.dimension);
  const health = val('player.health', state.player.health);
  const hunger = val('player.hunger', state.player.hunger);
  const inventory = val('inventory', state.inventory);
  const threats = val('nearbyThreats', state.nearbyThreats);
  const hazards = val('environmentHazards', state.environmentHazards);
  val('power.availableEUt', state.power.availableEUt);

  const inventoryTop = inventory
    ? Object.entries(inventory.items)
        .filter(([, q]) => q > 0)
        .sort(([a, qa], [b, qb]) => qb - qa || (a < b ? -1 : 1))
        .slice(0, 20)
        .map(([item, quantity]) => ({ item, quantity }))
    : [];

  return {
    observedAt: state.timestamp,
    position,
    dimension,
    health,
    hunger,
    inventoryTop,
    inventoryFill: inventory
      ? Number((inventory.usedSlots / inventory.capacitySlots).toFixed(3))
      : null,
    threats: threats
      ? { hostileCount: threats.hostileCount, unclassifiedCount: threats.unclassifiedCount }
      : null,
    hazards: hazards ? { lavaNearby: hazards.lavaNearby, voidNearby: hazards.voidNearby } : null,
    machines: state.machines.slice(0, 32).map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      position: m.position.known ? m.position.value : null,
    })),
    storage: state.storage.slice(0, 32).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position.known ? s.position.value : null,
    })),
    generators: state.power.generators.slice(0, 32).map((g) => ({
      id: g.id,
      name: g.name,
      status: g.status,
      position: g.position.known ? g.position.value : null,
      acceptedFuels: g.acceptedFuels,
    })),
    knownRecipe: state.knownRecipeState
      ? {
          target: state.knownRecipeState.target,
          missingComponents: state.knownRecipeState.missingComponents,
        }
      : null,
    unknownFields,
  };
}

export function buildPlannerRequest(input: {
  state: GameState;
  safety: SafetyContext;
  maxPlanSteps: number;
  recentActions: RecentActionSummary[];
  recentFailures: RecentFailureSummary[];
}): PlannerRequest {
  const { config } = input.safety;
  return PlannerRequestSchema.parse({
    state: sanitizeStateForPlanner(input.state),
    task: input.state.currentTask,
    allowedActions: [...ACTION_TYPES],
    safetyConstraints: {
      boundaryMin: config.boundary.min,
      boundaryMax: config.boundary.max,
      allowedDimensions: config.boundary.allowedDimensions,
      protectedItems: [...input.safety.protectedItems].sort(),
      approvedFoods: config.approvedFoods,
      approvedFuels: config.approvedFuels,
      maxMoveDistance: config.maxMoveDistance,
      safeLocations: [...input.safety.locations.entries()]
        .filter(([, l]) => l.kind === 'safe')
        .map(([name]) => name)
        .sort(),
      forbidden: [...forbiddenKeywords()],
    },
    recentActions: input.recentActions,
    recentFailures: input.recentFailures,
    maxPlanSteps: input.maxPlanSteps,
  });
}
