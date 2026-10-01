import type { Action } from '../domain/actions.ts';
import {
  attackRefusal,
  hostileTactic,
  mayExplode,
  WEAPON_DAMAGE,
  type AttackCandidate,
} from '../domain/combat.ts';
import type { GameState, NearbyEntity } from '../domain/game-state.ts';
import { formatPosition, isInsideBox } from '../domain/geometry.ts';
import type { SafetyConfig, SafetyViolation } from '../domain/safety.ts';
import { isProtected } from './protected-items.ts';

type AttackAction = Extract<Action, { type: 'ATTACK_ENTITY' }>;

/**
 * Why a fight would be unsafe right now, whatever the target: the moment, not the opponent.
 * Shared by the safety policy (ATTACK_ENTITY) and System 1 (DEFEND), so both refuse alike.
 */
export interface FightProblem {
  code:
    | 'ENTITIES_UNKNOWN'
    | 'CREEPER_NEARBY'
    | 'TOO_MANY_HOSTILES'
    | 'UNCLASSIFIED_NEARBY'
    | 'LOW_HEALTH'
    | 'LOW_HUNGER';
  message: string;
}

/** Hostile creatures (not objects such as fireballs) within `radius`, nearest first. */
export function hostilesWithin(entities: readonly NearbyEntity[], radius: number): NearbyEntity[] {
  return entities.filter(
    (e) => e.category === 'hostile' && e.kind !== 'object' && e.distance <= radius,
  );
}

/** The candidate view of an observed entity (what attackRefusal needs). */
export function candidateOf(e: NearbyEntity): AttackCandidate {
  return { type: e.type, category: e.category, kind: e.kind, owned: e.owned, baby: e.baby };
}

/**
 * Every reason the player should not fight now (empty when it may):
 *  - its entity picture is not known;
 *  - within combat.creeperFleeRadius, a creeper, primed TNT, an exploding projectile, or
 *    anything unidentified (an unidentified hostile could be a creeper variant, an unidentified
 *    mob a modded exploding one): back off instead;
 *  - more hostiles within the threat radius than combat.maxHostilesToFight: flee instead;
 *  - an unidentified entity within the threat radius;
 *  - health or food below the fighting thresholds.
 */
export function fightProblems(state: GameState, config: SafetyConfig): FightProblem[] {
  const problems: FightProblem[] = [];
  const { combat } = config;
  if (!state.nearbyEntities.known) {
    problems.push({
      code: 'ENTITIES_UNKNOWN',
      message: `nearby entities are not observed (${state.nearbyEntities.reason})`,
    });
  } else {
    const entities = state.nearbyEntities.value.entities;
    const explosive = entities.find(
      (e) => mayExplode(e.type, e.category) && e.distance <= combat.creeperFleeRadius,
    );
    if (explosive !== undefined) {
      const sure = explosive.category === 'hostile' && hostileTactic(explosive.type) === 'explodes';
      problems.push({
        code: 'CREEPER_NEARBY',
        message:
          `${explosive.type} ${explosive.distance.toFixed(1)} blocks away ` +
          `${sure ? 'explodes' : 'might explode (unidentified)'}: back off`,
      });
    }
    const hostiles = hostilesWithin(entities, config.hostileThreatRadius);
    if (hostiles.length > combat.maxHostilesToFight) {
      problems.push({
        code: 'TOO_MANY_HOSTILES',
        message: `${hostiles.length} hostiles within ${config.hostileThreatRadius} blocks (the agent fights at most ${combat.maxHostilesToFight})`,
      });
    }
    const unidentified = entities.find(
      (e) => e.category === 'unclassified' && e.distance <= config.hostileThreatRadius,
    );
    if (unidentified !== undefined) {
      problems.push({
        code: 'UNCLASSIFIED_NEARBY',
        message: `unidentified ${unidentified.type} ${unidentified.distance.toFixed(1)} blocks away`,
      });
    }
  }
  const { health, hunger } = state.player;
  if (!health.known || health.value < combat.minHealthToFight) {
    problems.push({
      code: 'LOW_HEALTH',
      message: health.known
        ? `health ${health.value} is below ${combat.minHealthToFight}, the least the agent fights with`
        : 'health is not known',
    });
  }
  if (!hunger.known || hunger.value < combat.minHungerToFight) {
    problems.push({
      code: 'LOW_HUNGER',
      message: hunger.known
        ? `food ${hunger.value} is below ${combat.minHungerToFight} (no healing below 8 on this server)`
        : 'food level is not known',
    });
  }
  return problems;
}

/**
 * ATTACK_ENTITY rules the observation can answer. The live client re-checks the target, the
 * moment and its reach every tick of the burst (src/bot/gtnh1710/combat.ts).
 *  - The target must be listed, and be an entity the agent may ever attack (attackRefusal):
 *    an identified melee or ranged hostile, or an unowned, grown farm animal.
 *  - Farm animals only for a task or a person's own request, and never while hostiles are
 *    near (hunting is no defence).
 *  - Inside the work area.
 *  - The moment must be safe (fightProblems).
 *  - Every allowlisted weapon the player carries must be unprotected: the client picks the
 *    best one in the hotbar, and striking wears it.
 */
export function attackChecks(
  action: AttackAction,
  state: GameState,
  config: SafetyConfig,
  protectedItems: ReadonlySet<string>,
): SafetyViolation[] {
  const v: SafetyViolation[] = [];
  const id = action.args.entityId;
  if (!state.nearbyEntities.known) {
    v.push({
      code: 'UNKNOWN_TARGET',
      severity: 'pause',
      message: `Nearby entities are not observed (${state.nearbyEntities.reason}); nothing can be attacked`,
      details: { entityId: id },
    });
    return v;
  }
  const target = state.nearbyEntities.value.entities.find((e) => e.id === id);
  if (target === undefined) {
    v.push({
      code: 'TARGET_GONE',
      severity: 'block',
      message: `Entity ${id} is not near the player any more (it died, left or despawned)`,
      details: { entityId: id },
    });
    return v;
  }
  const details = { entityId: id, type: target.type };
  const refusal = attackRefusal(candidateOf(target));
  if (refusal !== null) {
    v.push({
      code: 'NOT_ATTACKABLE',
      severity: 'pause',
      message: `Entity ${id} may never be attacked: ${refusal}`,
      details,
    });
    return v;
  }
  if (target.category === 'passive') {
    if (action.taskId === null && action.origin !== 'user') {
      v.push({
        code: 'NOT_ATTACKABLE',
        severity: 'pause',
        message: `${target.type} ${id}: farm animals are attacked only for a task or on a person's request`,
        details,
      });
    }
    const hostiles = hostilesWithin(
      state.nearbyEntities.value.entities,
      config.hostileThreatRadius,
    );
    if (hostiles.length > 0) {
      v.push({
        code: 'UNSAFE_ATTACK',
        severity: 'block',
        message: `no hunting while ${hostiles.length} hostile(s) are within ${config.hostileThreatRadius} blocks`,
        details,
      });
    }
  }
  if (!isInsideBox(target.position, config.boundary)) {
    v.push({
      code: 'OUT_OF_BOUNDS',
      severity: 'block',
      message: `${target.type} ${id} at ${formatPosition(target.position)} is outside the configured boundary`,
      details,
    });
  }
  for (const p of fightProblems(state, config)) {
    v.push({
      code: p.code === 'ENTITIES_UNKNOWN' ? 'UNKNOWN_TARGET' : 'UNSAFE_ATTACK',
      severity: 'block',
      message: `Not fighting now: ${p.message}`,
      details: { ...details, problem: p.code },
    });
  }
  const carried = state.inventory.known ? state.inventory.value.items : {};
  for (const weapon of WEAPON_DAMAGE.keys()) {
    if ((carried[weapon] ?? 0) > 0 && isProtected(weapon, protectedItems)) {
      v.push({
        code: 'PROTECTED_ITEM',
        severity: 'pause',
        message: `ATTACK_ENTITY could strike with protected item ${weapon} (the client picks the best weapon in the hotbar)`,
        details: { item: weapon, actionType: action.type },
      });
    }
  }
  return v;
}
