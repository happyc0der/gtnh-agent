import {
  ActionSchema,
  expectedPostconditionFor,
  toSpec,
  type Action,
  type ActionSpec,
  type ActionType,
} from '../domain/actions.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance } from '../domain/geometry.ts';
import type { NamedLocation, SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { stableStringify } from '../util/json.ts';
import { checkHazardClearance, checkWithinBoundary } from './coordinate-boundaries.ts';
import { classifyActionType } from './forbidden-actions.ts';
import { checkProtectedItems } from './protected-items.ts';

/** Everything the policy needs besides the action and state. Pure data; no I/O. */
export interface SafetyContext {
  config: SafetyConfig;
  /** Config protected items merged with the protected_items table. */
  protectedItems: ReadonlySet<string>;
  /** Named locations (config merged with the named_locations table). */
  locations: ReadonlyMap<string, NamedLocation>;
  now: Date;
}

/** Source of prior failure counts (backed by the action log in production). */
export interface FailureHistory {
  countFailures(taskId: string | null, fingerprint: string): number;
}

export const emptyFailureHistory: FailureHistory = { countFailures: () => 0 };

export interface SafetyEvaluation {
  allowed: boolean;
  violations: SafetyViolation[];
  /** True if any violation requires escalating to the user rather than just refusing. */
  requiresUserPause: boolean;
}

/** Actions that never touch the world, so they stay available even when state is unreliable. */
const ALWAYS_PERMITTED: ReadonlySet<ActionType> = new Set(['PAUSE_AND_ASK_USER', 'OBSERVE_STATE']);

/** Identity of an action for repeated-failure counting: type + canonical args. */
export function actionFingerprint(spec: ActionSpec): string {
  return `${spec.type}:${stableStringify(spec.args)}`;
}

function result(violations: SafetyViolation[]): SafetyEvaluation {
  return {
    allowed: violations.length === 0,
    violations,
    requiresUserPause: violations.some((v) => v.severity === 'pause'),
  };
}

// ---------------------------------------------------------------------------
// State-level checks
// ---------------------------------------------------------------------------

/**
 * Is the observation trustworthy enough to act on? Any violation here means the
 * agent must fail closed (pause). All violations have severity `pause`.
 */
export function assessStateReliability(state: GameState, ctx: SafetyContext): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const { config } = ctx;
  const observedAt = Date.parse(state.timestamp);
  const ageMs = ctx.now.getTime() - observedAt;

  if (ageMs > config.maxStateAgeMs) {
    v.push({
      code: 'STATE_STALE',
      severity: 'pause',
      message: `Game state is ${ageMs} ms old (max ${config.maxStateAgeMs} ms)`,
      details: { ageMs, maxStateAgeMs: config.maxStateAgeMs },
    });
  }
  if (-ageMs > config.maxClockSkewMs) {
    v.push({
      code: 'STATE_INCONSISTENT',
      severity: 'pause',
      message: `Game state is timestamped ${-ageMs} ms in the future`,
      details: { futureMs: -ageMs },
    });
  }

  const critical: Array<[string, { known: boolean }]> = [
    ['player.position', state.player.position],
    ['player.dimension', state.player.dimension],
    ['player.health', state.player.health],
    ['player.hunger', state.player.hunger],
    ['inventory', state.inventory],
    ['nearbyThreats', state.nearbyThreats],
    ['environmentHazards', state.environmentHazards],
  ];
  const unknownFields = critical.filter(([, k]) => !k.known).map(([name]) => name);
  if (unknownFields.length > 0) {
    v.push({
      code: 'STATE_UNKNOWN',
      severity: 'pause',
      message: `Critical state is unknown: ${unknownFields.join(', ')}`,
      details: { fields: unknownFields.join(',') },
    });
  }

  // Coverage: an observation that did not look far enough cannot answer the question.
  if (
    state.nearbyThreats.known &&
    state.nearbyThreats.value.scanRadius < config.hostileThreatRadius
  ) {
    v.push({
      code: 'STATE_UNKNOWN',
      severity: 'pause',
      message: `Entity scan covers ${state.nearbyThreats.value.scanRadius} blocks, less than the threat radius ${config.hostileThreatRadius}`,
      details: {
        scanRadius: state.nearbyThreats.value.scanRadius,
        required: config.hostileThreatRadius,
      },
    });
  }
  if (
    state.environmentHazards.known &&
    state.environmentHazards.value.scanRadius < config.hazardAvoidanceRadius
  ) {
    v.push({
      code: 'STATE_UNKNOWN',
      severity: 'pause',
      message: `Hazard scan covers ${state.environmentHazards.value.scanRadius} blocks, less than the hazard radius ${config.hazardAvoidanceRadius}`,
      details: {
        scanRadius: state.environmentHazards.value.scanRadius,
        required: config.hazardAvoidanceRadius,
      },
    });
  }

  for (const message of findInconsistencies(state)) {
    v.push({ code: 'STATE_INCONSISTENT', severity: 'pause', message, details: {} });
  }
  return v;
}

function findInconsistencies(state: GameState): string[] {
  const problems: string[] = [];
  if (state.inventory.known) {
    const inv = state.inventory.value;
    const kinds = Object.values(inv.items).filter((q) => q > 0).length;
    if (inv.usedSlots > inv.capacitySlots) {
      problems.push(`inventory.usedSlots ${inv.usedSlots} > capacitySlots ${inv.capacitySlots}`);
    }
    if (kinds > inv.usedSlots) {
      problems.push(`inventory lists ${kinds} item kinds but only ${inv.usedSlots} used slots`);
    }
  }
  if (state.nearbyThreats.known) {
    const t = state.nearbyThreats.value;
    if ((t.hostileCount === 0) !== (t.nearestHostileDistance === null)) {
      problems.push('nearbyThreats.hostileCount and nearestHostileDistance disagree');
    }
    if ((t.unclassifiedCount === 0) !== (t.nearestUnclassifiedDistance === null)) {
      problems.push('nearbyThreats.unclassifiedCount and nearestUnclassifiedDistance disagree');
    }
  }
  if (state.environmentHazards.known) {
    const h = state.environmentHazards.value;
    if (h.hazards.some((x) => x.kind === 'lava') && !h.lavaNearby) {
      problems.push('lava hazard listed but lavaNearby is false');
    }
    if (h.hazards.some((x) => x.kind === 'void') && !h.voidNearby) {
      problems.push('void hazard listed but voidNearby is false');
    }
  }
  const ids = [
    ...state.machines.map((m) => m.id),
    ...state.storage.map((s) => s.id),
    ...state.power.generators.map((g) => g.id),
  ];
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    problems.push(
      `duplicate machine/storage/generator ids: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
  if (
    state.lastAction !== null &&
    Date.parse(state.lastAction.timestamp) > Date.parse(state.timestamp)
  ) {
    problems.push('lastAction is newer than the observation');
  }
  return problems;
}

/**
 * Immediate dangers in a reliable state. Out-of-bounds/dimension violations are
 * `pause` (the agent must not act at all); the others are `block` (only
 * safety-restoring actions are allowed).
 */
export function assessDangers(state: GameState, ctx: SafetyContext): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const { config } = ctx;
  const { position, dimension, health, hunger } = state.player;

  if (position.known && dimension.known) {
    v.push(...checkWithinBoundary(position.value, dimension.value, config.boundary, 'Player'));
  }
  if (state.environmentHazards.known) {
    const h = state.environmentHazards.value;
    if (position.known) {
      v.push(
        ...checkHazardClearance(position.value, h.hazards, config.hazardAvoidanceRadius, 'Player'),
      );
    }
    const unlocatedHazard =
      (h.lavaNearby && !h.hazards.some((x) => x.kind === 'lava')) ||
      (h.voidNearby && !h.hazards.some((x) => x.kind === 'void'));
    if (unlocatedHazard) {
      v.push({
        code: 'HAZARD_PROXIMITY',
        severity: 'block',
        message: 'Lava or void reported nearby at an unknown position',
        details: { lavaNearby: h.lavaNearby, voidNearby: h.voidNearby },
      });
    }
  }
  if (state.nearbyThreats.known) {
    const t = state.nearbyThreats.value;
    if (
      t.nearestHostileDistance !== null &&
      t.nearestHostileDistance <= config.hostileThreatRadius
    ) {
      v.push({
        code: 'HOSTILES_NEARBY',
        severity: 'block',
        message: `${t.hostileCount} hostile(s), nearest at ${t.nearestHostileDistance.toFixed(1)} blocks`,
        details: { hostileCount: t.hostileCount, nearest: t.nearestHostileDistance },
      });
    }
    // Fail closed: an entity the agent cannot identify is treated like a hostile one.
    if (
      t.nearestUnclassifiedDistance !== null &&
      t.nearestUnclassifiedDistance <= config.hostileThreatRadius
    ) {
      v.push({
        code: 'UNCLASSIFIED_ENTITY_NEARBY',
        severity: 'block',
        message: `${t.unclassifiedCount} unidentified entit(y/ies), nearest at ${t.nearestUnclassifiedDistance.toFixed(1)} blocks`,
        details: { unclassifiedCount: t.unclassifiedCount, nearest: t.nearestUnclassifiedDistance },
      });
    }
  }
  if (health.known && health.value < config.minHealth) {
    v.push({
      code: 'LOW_HEALTH',
      severity: 'block',
      message: `Health ${health.value} is below ${config.minHealth}`,
      details: { health: health.value, minHealth: config.minHealth },
    });
  }
  if (hunger.known && hunger.value < config.minHunger) {
    v.push({
      code: 'LOW_HUNGER',
      severity: 'block',
      message: `Food level ${hunger.value} is below ${config.minHunger}`,
      details: { hunger: hunger.value, minHunger: config.minHunger },
    });
  }
  return v;
}

// ---------------------------------------------------------------------------
// Action-level checks
// ---------------------------------------------------------------------------

/**
 * Checks that depend only on the action and configuration, not on live state.
 * Used for every step of a plan; the full evaluateAction() runs on the step about to execute.
 */
export function evaluateStaticSpec(spec: ActionSpec, ctx: SafetyContext): SafetyViolation[] {
  const { config } = ctx;
  const v: SafetyViolation[] = [...checkProtectedItems(spec, ctx.protectedItems)];

  switch (spec.type) {
    case 'EAT_FOOD':
      if (!config.approvedFoods.includes(spec.args.item)) {
        v.push({
          code: 'NOT_APPROVED_FOOD',
          severity: 'block',
          message: `${spec.args.item} is not an approved food`,
          details: { item: spec.args.item },
        });
      }
      break;
    case 'REFUEL_KNOWN_GENERATOR':
      if (!config.approvedFuels.includes(spec.args.fuelItem)) {
        v.push({
          code: 'NOT_APPROVED_FUEL',
          severity: 'block',
          message: `${spec.args.fuelItem} is not an approved fuel`,
          details: { item: spec.args.fuelItem },
        });
      }
      break;
    case 'MOVE_TO': {
      const outside = checkWithinBoundary(
        spec.args.target,
        config.boundary.allowedDimensions[0] ?? 'overworld',
        config.boundary,
        'MOVE_TO target',
      ).filter((x) => x.code === 'OUT_OF_BOUNDS');
      v.push(...outside.map((x) => ({ ...x, severity: 'block' as const })));
      break;
    }
    case 'RETURN_TO_SAFE_LOCATION': {
      const location = ctx.locations.get(spec.args.locationName);
      if (location === undefined || location.kind !== 'safe') {
        v.push({
          code: 'UNKNOWN_TARGET',
          severity: 'pause',
          message: `"${spec.args.locationName}" is not a known safe location`,
          details: { locationName: spec.args.locationName },
        });
      } else {
        v.push(
          ...checkWithinBoundary(
            location.position,
            location.dimension,
            config.boundary,
            `Safe location "${spec.args.locationName}"`,
          ),
        );
      }
      break;
    }
    case 'OBSERVE_STATE':
    case 'WAIT':
    case 'OPEN_CONTAINER':
    case 'DEPOSIT_ITEM':
    case 'WITHDRAW_ITEM':
    case 'INSPECT_MACHINE':
    case 'PAUSE_AND_ASK_USER':
      break;
  }
  return v;
}

/** Violations for an action type that is not allowed while dangers are present. */
function dangerGate(type: ActionType, dangers: SafetyViolation[]): SafetyViolation[] {
  if (dangers.length === 0) return [];
  const codes = new Set(dangers.map((d) => d.code));
  const outsideWorkArea = codes.has('OUT_OF_BOUNDS') || codes.has('DIMENSION_NOT_ALLOWED');
  const onlyVitals = [...codes].every((c) => c === 'LOW_HEALTH' || c === 'LOW_HUNGER');

  let permitted = false;
  if (!outsideWorkArea) {
    permitted = type === 'RETURN_TO_SAFE_LOCATION' || (type === 'EAT_FOOD' && onlyVitals);
  }
  if (permitted) return [];
  return [
    {
      code: 'ACTION_NOT_ALLOWED_IN_DANGER',
      severity: outsideWorkArea ? 'pause' : 'block',
      message: `${type} is not allowed while: ${[...codes].join(', ')}`,
      details: { actionType: type, dangers: [...codes].join(',') },
    },
  ];
}

function dynamicChecks(action: Action, state: GameState, ctx: SafetyContext): SafetyViolation[] {
  const { config } = ctx;
  const v: SafetyViolation[] = [];
  const position = state.player.position.known ? state.player.position.value : null;
  const dimension = state.player.dimension.known ? state.player.dimension.value : null;
  const hazards = state.environmentHazards.known ? state.environmentHazards.value.hazards : [];

  const unknownTarget = (kind: string, id: string): SafetyViolation => ({
    code: 'UNKNOWN_TARGET',
    severity: 'pause',
    message: `${kind} "${id}" is not in the observed state`,
    details: { kind, id },
  });

  switch (action.type) {
    case 'MOVE_TO': {
      // The boundary box is checked in evaluateStaticSpec; the player's dimension in assessDangers.
      const target = action.args.target;
      // Hazards are only known within the scan radius around the player. A target whose
      // surroundings were not scanned cannot be shown to be clear, so it is refused.
      if (position !== null && state.environmentHazards.known) {
        const coverage = state.environmentHazards.value.scanRadius;
        const needed = distance(position, target) + config.hazardAvoidanceRadius;
        if (needed > coverage) {
          v.push({
            code: 'MOVE_TOO_FAR',
            severity: 'block',
            message: `MOVE_TO target's surroundings are outside the hazard scan (${needed.toFixed(1)} > ${coverage} blocks)`,
            details: { needed: Number(needed.toFixed(2)), coverage },
          });
        }
      }
      v.push(
        ...checkHazardClearance(target, hazards, config.hazardAvoidanceRadius, 'MOVE_TO target'),
      );
      if (position !== null && distance(position, target) > config.maxMoveDistance) {
        v.push({
          code: 'MOVE_TOO_FAR',
          severity: 'block',
          message: `MOVE_TO distance ${distance(position, target).toFixed(1)} exceeds ${config.maxMoveDistance}`,
          details: { distance: distance(position, target), max: config.maxMoveDistance },
        });
      }
      break;
    }
    case 'RETURN_TO_SAFE_LOCATION': {
      const location = ctx.locations.get(action.args.locationName);
      if (location === undefined) break; // reported by evaluateStaticSpec
      if (dimension !== null && location.dimension !== dimension) {
        v.push({
          code: 'UNKNOWN_TARGET',
          severity: 'pause',
          message: `Safe location "${action.args.locationName}" is in another dimension; cross-dimension travel is unsupported`,
          details: { locationDimension: location.dimension, playerDimension: dimension },
        });
      }
      v.push(
        ...checkHazardClearance(
          location.position,
          hazards,
          config.hazardAvoidanceRadius,
          'Safe location',
        ),
      );
      if (position !== null && distance(position, location.position) > config.maxRetreatDistance) {
        v.push({
          code: 'MOVE_TOO_FAR',
          severity: 'pause',
          message: `Safe location is ${distance(position, location.position).toFixed(1)} blocks away (max ${config.maxRetreatDistance})`,
          details: { max: config.maxRetreatDistance },
        });
      }
      break;
    }
    case 'OPEN_CONTAINER':
    case 'DEPOSIT_ITEM':
    case 'WITHDRAW_ITEM':
      if (!state.storage.some((s) => s.id === action.args.containerId)) {
        v.push(unknownTarget('Container', action.args.containerId));
      }
      break;
    case 'INSPECT_MACHINE':
      if (!state.machines.some((m) => m.id === action.args.machineId)) {
        v.push(unknownTarget('Machine', action.args.machineId));
      }
      break;
    case 'REFUEL_KNOWN_GENERATOR': {
      const generator = state.power.generators.find((g) => g.id === action.args.generatorId);
      if (generator === undefined) {
        v.push(unknownTarget('Generator', action.args.generatorId));
      } else if (!generator.acceptedFuels.includes(action.args.fuelItem)) {
        v.push({
          code: 'NOT_APPROVED_FUEL',
          severity: 'block',
          message: `${generator.id} is not known to accept ${action.args.fuelItem}`,
          details: { generatorId: generator.id, item: action.args.fuelItem },
        });
      }
      break;
    }
    case 'OBSERVE_STATE':
    case 'WAIT':
    case 'EAT_FOOD':
    case 'PAUSE_AND_ASK_USER':
      break;
  }
  return v;
}

/**
 * The single entry point for action safety. Accepts `unknown` on purpose: anything
 * that is not a schema-valid, allowlisted action is refused (fail closed).
 */
export function evaluateAction(
  candidate: unknown,
  state: GameState,
  ctx: SafetyContext,
  history: FailureHistory,
): SafetyEvaluation {
  const parsed = ActionSchema.safeParse(candidate);
  if (!parsed.success) {
    const rawType =
      candidate !== null && typeof candidate === 'object' && 'type' in candidate
        ? candidate.type
        : undefined;
    const cls = classifyActionType(rawType);
    return result([
      {
        code: cls === 'forbidden' ? 'FORBIDDEN_MODIFICATION' : 'UNSUPPORTED_ACTION',
        severity: 'pause',
        message:
          cls === 'forbidden'
            ? `Action type ${String(rawType)} is a forbidden world/base modification`
            : `Action failed schema validation: ${parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
        details: { actionType: typeof rawType === 'string' ? rawType : null },
      },
    ]);
  }

  const action = parsed.data;
  const spec = toSpec(action);
  const violations: SafetyViolation[] = [];

  if (
    stableStringify(expectedPostconditionFor(spec)) !==
    stableStringify(action.expectedPostcondition)
  ) {
    violations.push({
      code: 'INVALID_POSTCONDITION',
      severity: 'block',
      message: 'Declared postcondition does not match the one derived from the action',
      details: { actionType: action.type },
    });
  }

  if (ALWAYS_PERMITTED.has(action.type)) return result(violations);

  const reliability = assessStateReliability(state, ctx);
  if (reliability.length > 0) return result([...violations, ...reliability]);

  violations.push(...dangerGate(action.type, assessDangers(state, ctx)));
  violations.push(...evaluateStaticSpec(spec, ctx));
  violations.push(...dynamicChecks(action, state, ctx));

  // The rule stops the AGENT from retrying its own failing choices. An action a human
  // requested directly (origin 'user') is that human's decision each time; every other
  // rule above still applies to it.
  const failures =
    action.origin === 'user' ? 0 : history.countFailures(action.taskId, actionFingerprint(spec));
  if (failures >= ctx.config.maxFailuresPerActionPerTask) {
    violations.push({
      code: 'REPEATED_FAILURE',
      severity: 'pause',
      message: `${action.type} already failed ${failures} time(s) for this task; escalating instead of retrying`,
      details: { failures, max: ctx.config.maxFailuresPerActionPerTask, taskId: action.taskId },
    });
  }
  return result(violations);
}
