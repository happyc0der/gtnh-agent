import {
  ActionSchema,
  expectedPostconditionFor,
  toSpec,
  type Action,
  type ActionSpec,
  type ActionType,
} from '../domain/actions.ts';
import { isGardenBlock } from '../domain/blocks.ts';
import {
  calmSpiderBlocker,
  HURT_DANGER_MS,
  hostileTactic,
  recentBlowMs,
} from '../domain/combat.ts';
import type { BlockPosition, Position } from '../domain/common.ts';
import { FOOD_TASK_ID, gettingFood } from '../domain/food.ts';
import { listedBlockAt, MAX_REPORTED_ENTITIES, type GameState } from '../domain/game-state.ts';
import { distance, formatPosition, isBlockInsideBox } from '../domain/geometry.ts';
import type { NamedLocation, SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { stableStringify } from '../util/json.ts';
import { attackChecks } from './combat-checks.ts';
import {
  blockOutsideBoundary,
  checkHazardClearance,
  checkWithinBoundary,
} from './coordinate-boundaries.ts';
import { digChecks, digDownChecks } from './dig-checks.ts';
import { exploreTargetChecks, exploreTimeChecks } from './explore-checks.ts';
import { classifyActionType } from './forbidden-actions.ts';
import {
  interactChecks,
  observedStorageOutside,
  OBSERVED_TABLE_PREFIX,
} from './interact-checks.ts';
import { placeChecks } from './place-checks.ts';
import { checkProtectedItems } from './protected-items.ts';
import { questBookViolations } from './quest-book-rules.ts';

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
/** Walks whose outcome depends on where they start: a failure from one spot says little about another. */
const WALK_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'MOVE_TO',
  'EXPLORE',
  'RETURN_TO_SAFE_LOCATION',
]);

/**
 * What makes two actions "the same" for the repeated-failure rule: the type and arguments,
 * and for a walk also the block it starts from (`from`, the player's position when it was
 * proposed). Seen live: an EXPLORE that failed twice from inside the night shelter's walls
 * was refused the next morning from outside them.
 */
export function actionFingerprint(spec: ActionSpec, from: Position | null = null): string {
  const base = `${spec.type}:${stableStringify(spec.args)}`;
  if (!WALK_TYPES.has(spec.type) || from === null) return base;
  return `${base}@${Math.floor(from.x)},${Math.floor(from.y + 1e-6)},${Math.floor(from.z)}`;
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
  problems.push(...entityInconsistencies(state));
  if (state.nearbyBlocks.known) {
    const { resources, removed } = state.nearbyBlocks.value;
    const key = (p: BlockPosition): string => `${p.x},${p.y},${p.z}`;
    const listed = new Set(resources.map((r) => key(r.position)));
    if (listed.size !== resources.length) problems.push('nearbyBlocks lists a position twice');
    if (removed.some((p) => listed.has(key(p)))) {
      problems.push('nearbyBlocks lists a position as both a resource and removed');
    }
  }
  const ids = [
    ...state.machines.map((m) => m.id),
    ...state.storage.map((s) => s.id),
    ...state.power.generators.map((g) => g.id),
    ...state.craftingTables.map((t) => t.id),
  ];
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    problems.push(
      `duplicate machine/storage/generator/crafting table ids: ${[...new Set(duplicates)].join(', ')}`,
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
 * The entity details must agree with the threat counts they explain: same scan, unique ids,
 * nothing listed beyond the scan, and (when the list is complete) the same numbers of
 * hostile (not calm) and unidentified entities. An entity marked calm must be one that can
 * be (calmSpiderBlocker: a vanilla spider, beyond its leap, the player not hurt lately); the
 * light at it only the adapter can judge.
 */
function entityInconsistencies(state: GameState): string[] {
  if (!state.nearbyEntities.known) return [];
  const problems: string[] = [];
  const { scanRadius, entities } = state.nearbyEntities.value;
  if (!state.nearbyThreats.known) {
    return ['nearbyEntities is reported but nearbyThreats is not'];
  }
  const t = state.nearbyThreats.value;
  if (scanRadius !== t.scanRadius) {
    problems.push('nearbyEntities and nearbyThreats cover different scan radii');
  }
  if (new Set(entities.map((e) => e.id)).size !== entities.length) {
    problems.push('nearbyEntities lists an entity twice');
  }
  if (entities.some((e) => e.distance > scanRadius)) {
    problems.push('nearbyEntities lists an entity beyond its scan radius');
  }
  const hurt = recentBlowMs(state.player, state.timestamp);
  for (const e of entities) {
    const why = e.calm ? calmSpiderBlocker(e, hurt) : null;
    if (why !== null) problems.push(`nearbyEntities marks ${e.type} #${e.id} calm, but ${why}`);
  }
  const hostile = entities.filter((e) => e.category === 'hostile' && !e.calm).length;
  const unclassified = entities.filter((e) => e.category === 'unclassified').length;
  const complete = entities.length < MAX_REPORTED_ENTITIES;
  if (complete ? hostile !== t.hostileCount : hostile > t.hostileCount) {
    problems.push(
      `nearbyEntities lists ${hostile} hostile(s), nearbyThreats counts ${t.hostileCount}`,
    );
  }
  if (complete ? unclassified !== t.unclassifiedCount : unclassified > t.unclassifiedCount) {
    problems.push(
      `nearbyEntities lists ${unclassified} unidentified, nearbyThreats counts ${t.unclassifiedCount}`,
    );
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
    const shooter = rangedHostileInView(state);
    const hurt = hurtLately(state);
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
    } else if (shooter !== null) {
      // Seen live: a giant skeleton shot the agent from 10 to 16 blocks, outside the threat
      // radius, so nothing counted as danger and it walked back into the arrows (20 -> 8).
      v.push({
        code: 'HOSTILES_NEARBY',
        severity: 'block',
        message: `${shooter.type} shoots from ${shooter.distance.toFixed(1)} blocks (in range of the entity scan)`,
        details: { hostileCount: t.hostileCount, nearest: shooter.distance, ranged: shooter.type },
      });
    } else if (hurt !== null && t.nearestHostileDistance !== null) {
      // Hurt a moment ago with a hostile about: something is attacking, from wherever.
      v.push({
        code: 'HOSTILES_NEARBY',
        severity: 'block',
        message: `the player was hurt ${(hurt / 1000).toFixed(0)} s ago, a hostile at ${t.nearestHostileDistance.toFixed(1)} blocks`,
        details: {
          hostileCount: t.hostileCount,
          nearest: t.nearestHostileDistance,
          hurtMsAgo: hurt,
        },
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
    case 'EXPLORE':
      v.push(...exploreTargetChecks(spec.args.toward, config));
      break;
    case 'DIG_BLOCK':
    case 'DIG_DOWN':
    case 'PLACE_BLOCK': {
      // The whole block must lie inside the work area, not just a corner of it.
      const b = spec.args.position;
      if (!isBlockInsideBox(b, config.boundary)) {
        v.push({
          code: 'OUT_OF_BOUNDS',
          severity: 'block',
          message: `${spec.type} target block ${formatPosition(b)} is not inside the configured boundary`,
          details: {
            x: b.x,
            y: b.y,
            z: b.z,
            min: formatPosition(config.boundary.min),
            max: formatPosition(config.boundary.max),
          },
        });
      }
      break;
    }
    case 'INTERACT_BLOCK':
    case 'TAKE_OUTPUT':
      v.push(...blockOutsideBoundary(spec.type, spec.args.position, config));
      break;
    case 'SMELT': {
      v.push(...blockOutsideBoundary(spec.type, spec.args.position, config));
      const { fuel, fuelQuantity } = spec.args;
      if (fuel === LAVA_BUCKET || spec.args.input === LAVA_BUCKET) {
        v.push({
          code: 'FORBIDDEN_MODIFICATION',
          severity: 'pause',
          message: 'SMELT never uses lava (lava interaction is not allowed)',
          details: { item: LAVA_BUCKET },
        });
      }
      if (fuelQuantity > 0 && !config.approvedFuels.includes(fuel)) {
        v.push({
          code: 'NOT_APPROVED_FUEL',
          severity: 'block',
          message: `${fuel} is not an approved fuel`,
          details: { item: fuel },
        });
      }
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
    case 'CRAFT_ITEM': // its ingredients are checked as protected items above
    case 'ATTACK_ENTITY': // its target exists only in a live state (dynamicChecks)
    case 'PAUSE_AND_ASK_USER':
    case 'SUBMIT_QUEST': // what a submit takes depends on the quest book: see dynamicChecks
    case 'CHECK_QUEST_BOX':
    case 'CLAIM_QUEST_REWARD':
      break;
  }
  return v;
}

const LAVA_BUCKET = 'minecraft:lava_bucket';

/**
 * Being hurt this recently (ms) with a hostile about counts as being attacked (and no spider
 * counts as calm then). Defined with the spider rules in src/domain/combat.ts.
 */
export { HURT_DANGER_MS };

/**
 * The nearest hostile that shoots (a skeleton, a witch, a blaze, Special Mobs ones too:
 * hostileTactic), anywhere in the entity scan: their reach is the scan's, not the threat
 * radius. Null when none, or the entities are not known. (Spiders fight in melee; a calm one
 * is skipped all the same, like everywhere a hostile counts.) One that cannot see the player
 * (NearbyEntitySchema.hidden: rock on every line between them) neither aims nor hits from out
 * there: seen live 2026-10-04, a giant skeleton in a cave 7 blocks under the night pit, 10.4
 * blocks off, kept the agent sealed in its shelter for a whole day. Within the threat radius
 * every hostile counts, seen or not.
 */
function rangedHostileInView(state: GameState): { type: string; distance: number } | null {
  if (!state.nearbyEntities.known) return null;
  let best: { type: string; distance: number } | null = null;
  for (const e of state.nearbyEntities.value.entities) {
    if (e.category !== 'hostile' || e.calm || e.hidden || hostileTactic(e.type) !== 'ranged') {
      continue;
    }
    if (best === null || e.distance < best.distance) best = { type: e.type, distance: e.distance };
  }
  return best;
}

/** How long ago (ms) the player was last hurt, when within HURT_DANGER_MS of the observation. */
function hurtLately(state: GameState): number | null {
  return recentBlowMs(state.player, state.timestamp);
}

/**
 * Violations for an action type that is not allowed while dangers are present. Only a
 * retreat (and eating, when only the vitals are low) restores safety. PLACE_BLOCK is
 * deliberately not an escape: one block does not make a shelter, sealing one with a mob
 * within reach can wall the agent in with it, and a creeper's blast opens it again. Shelters
 * are built before dark, while the state is safe (docs/action-contract.md).
 *
 * One more cure: food, for a food level below minHunger with nothing else wrong. An action
 * that gets food (`getsFood`, below) may run then, since with no food carried a retreat home
 * finds none there, and a pause only starves: nothing heals offline, and on Hard a food bar
 * at 0 starves the player to death. Seen live: food 2 with no food, the agent offline. Low
 * health too, on that trip: health lost to an empty food bar comes back only with food
 * (seen live: at food 0 the trip's own walks cost health, it fell below minHealth while the
 * planner planned, and the next EXPLORE was refused: too weak to fetch food, too hungry to
 * heal). Hostiles, hazards, the boundary and the night still stop it.
 */
function dangerGate(
  type: ActionType,
  dangers: SafetyViolation[],
  getsFood = false,
): SafetyViolation[] {
  if (dangers.length === 0) return [];
  const codes = new Set(dangers.map((d) => d.code));
  const outsideWorkArea = codes.has('OUT_OF_BOUNDS') || codes.has('DIMENSION_NOT_ALLOWED');
  const onlyVitals = [...codes].every((c) => c === 'LOW_HEALTH' || c === 'LOW_HUNGER');
  // Fighting back is how the agent survives a hostile it cannot retreat from; any other
  // danger (lava, an unidentified entity, low health or food) forbids it.
  const onlyHostiles = [...codes].every((c) => c === 'HOSTILES_NEARBY');

  let permitted = false;
  if (!outsideWorkArea) {
    permitted =
      type === 'RETURN_TO_SAFE_LOCATION' ||
      (type === 'EAT_FOOD' && onlyVitals) ||
      // Resting is how health comes back when nothing else is wrong (REST).
      (type === 'WAIT' && onlyVitals) ||
      (type === 'ATTACK_ENTITY' && onlyHostiles) ||
      (getsFood && onlyVitals);
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

/**
 * The action gets food: the food task's own action (its task is FOOD_TASK_ID) while that task
 * gets food by day (food.ts gettingFood), and one of the actions a food trip is made of: a walk
 * (MOVE_TO), an EXPLORE (to where food grows or grazes), or the dig of a HarvestCraft garden
 * the observation lists. Nothing else: no dig of anything but a garden, no building, no
 * crafting, and no fight (ATTACK_ENTITY has its own, higher food limit: combat-checks.ts).
 */
export function getsFood(action: Action, state: GameState): boolean {
  if (action.taskId !== FOOD_TASK_ID || !gettingFood(state)) return false;
  if (action.type === 'MOVE_TO' || action.type === 'EXPLORE') return true;
  if (action.type !== 'DIG_BLOCK' || !state.nearbyBlocks.known) return false;
  const at = action.args.position;
  const listed = listedBlockAt(state.nearbyBlocks.value, at);
  return listed !== undefined && isGardenBlock(listed.block);
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
    case 'EXPLORE':
      // The target is checked against the boundary in evaluateStaticSpec; the walk's length
      // is bounded by its schema (MAX_EXPLORE_DISTANCE). Unscanned ground is the point of
      // exploring: the client checks every step on the blocks the server sends.
      v.push(...exploreTimeChecks(state));
      break;
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
      v.push(...observedStorageOutside(action.type, action.args.containerId, state, config));
      break;
    case 'INSPECT_MACHINE':
      if (!state.machines.some((m) => m.id === action.args.machineId)) {
        v.push(unknownTarget('Machine', action.args.machineId));
      }
      break;
    case 'DIG_BLOCK':
      v.push(...digChecks(action.args.position, state, config));
      break;
    case 'DIG_DOWN':
      v.push(...digDownChecks(action, state, config));
      break;
    case 'PLACE_BLOCK':
      v.push(...placeChecks(action.args.position, action.args.item, state, config));
      break;
    case 'CRAFT_ITEM': {
      const tableId = action.args.craftingTableId;
      if (tableId !== null && !state.craftingTables.some((t) => t.id === tableId)) {
        v.push(unknownTarget('Crafting table', tableId));
      }
      // A crafting table the observation found (not configured): inside the work area too.
      const observed = state.craftingTables.find(
        (t) => t.id === tableId && t.id.startsWith(OBSERVED_TABLE_PREFIX),
      );
      if (observed?.position.known === true) {
        const p = observed.position.value;
        v.push(...blockOutsideBoundary(action.type, { x: p.x, y: p.y, z: p.z }, config));
      }
      break;
    }
    case 'INTERACT_BLOCK':
    case 'SMELT':
    case 'TAKE_OUTPUT':
      v.push(...interactChecks(action.type, action.args.position, state));
      break;
    case 'ATTACK_ENTITY':
      v.push(...attackChecks(action, state, config, ctx.protectedItems));
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
    case 'SUBMIT_QUEST':
    case 'CHECK_QUEST_BOX':
    case 'CLAIM_QUEST_REWARD':
      v.push(...questBookViolations(action, state, ctx.protectedItems));
      break;
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

  violations.push(...dangerGate(action.type, assessDangers(state, ctx), getsFood(action, state)));
  violations.push(...evaluateStaticSpec(spec, ctx));
  violations.push(...dynamicChecks(action, state, ctx));

  // The rule stops the AGENT from retrying its own failing choices. An action a human
  // requested directly (origin 'user') is that human's decision each time; every other
  // rule above still applies to it.
  const from = state.player.position.known ? state.player.position.value : null;
  const failures =
    action.origin === 'user'
      ? 0
      : history.countFailures(action.taskId, actionFingerprint(spec, from));
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
