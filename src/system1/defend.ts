import {
  attackRefusal,
  BARE_HAND,
  BLIND_STRIKE_REACH,
  ENGAGE_RADIUS,
  hitsToKill,
  hostileTactic,
  QUICK_FIGHT_HITS,
} from '../domain/combat.ts';
import type { ReasonCode } from '../domain/decisions.ts';
import type { GameState, NearbyEntity } from '../domain/game-state.ts';
import { candidateOf, fightProblems, hostilesWithin } from '../safety/combat-checks.ts';
import type { RouterContext } from './state-queries.ts';

/** What System 1 should do about the hostiles near it, as far as fighting goes. */
export type DefenseAssessment =
  /** Fight back: ATTACK_ENTITY on `target`. */
  | { kind: 'defend'; target: NearbyEntity; reasons: ReasonCode[] }
  /** Never fight now; these extra reasons explain the retreat (or pause). */
  | { kind: 'flee'; reasons: ReasonCode[] }
  /** Fighting is not the answer here (retreat or pause as without combat). */
  | { kind: 'none' };

/**
 * DEFEND: fight back when a hostile is close and retreating is impossible or worse. The
 * idea follows the priority chains of bots such as AltoClef's MobDefenseChain (flee what
 * cannot be beaten, keep away from creepers, fight what is close), written for this agent's
 * own rules; no code is shared. In order:
 *  1. combat is off, or the moment is unsafe (fightProblems: unknown entities, a creeper or
 *     an unidentified hostile within the creeper radius, too many hostiles, an unidentified
 *     entity, low health or food): never fight. A creeper or a crowd is named as the reason
 *     to flee.
 *  2. The target is the nearest hostile within the threat radius that may be attacked at all
 *     (an identified melee or ranged mob: never a creeper, enderman, pigman, silverfish...),
 *     and never a calm spider: hostilesWithin leaves those out (a blow would provoke it).
 *  3. With somewhere to retreat to, retreating is the answer, unless the target is already
 *     within striking distance and dies in at most QUICK_FIGHT_HITS full hits (its health is
 *     known): turning away would only take its blows.
 *  4. With nowhere to retreat to (no home, or already home), fight a target within striking
 *     distance, or a melee mob coming within ENGAGE_RADIUS (ATTACK_ENTITY waits for it).
 *     A ranged mob out of reach (a skeleton) is not chased: System 1 pauses, as before.
 */
export function assessDefense(
  state: GameState,
  ctx: RouterContext,
  retreat: { possible: boolean },
): DefenseAssessment {
  if (ctx.combatEnabled !== true) return { kind: 'none' };
  const { config } = ctx.safety;
  const problems = fightProblems(state, config);
  if (problems.length > 0) {
    const reasons: ReasonCode[] = [];
    if (problems.some((p) => p.code === 'CREEPER_NEARBY')) reasons.push('CREEPER_NEARBY');
    if (problems.some((p) => p.code === 'TOO_MANY_HOSTILES')) reasons.push('TOO_MANY_HOSTILES');
    return reasons.length > 0 ? { kind: 'flee', reasons } : { kind: 'none' };
  }
  if (!state.nearbyEntities.known) return { kind: 'none' };
  const target = hostilesWithin(
    state.nearbyEntities.value.entities,
    config.hostileThreatRadius,
  ).find((e) => attackRefusal(candidateOf(e)) === null);
  if (target === undefined) return { kind: 'none' };

  const weapon = state.player.weapon.known ? state.player.weapon.value : BARE_HAND;
  const inReach = target.distance <= BLIND_STRIKE_REACH;
  const defend = (): DefenseAssessment => ({
    kind: 'defend',
    target,
    reasons: ['HOSTILES_NEARBY', 'HOSTILE_IN_REACH'],
  });
  if (retreat.possible) {
    const quick = target.health !== null && hitsToKill(target.health, weapon) <= QUICK_FIGHT_HITS;
    return inReach && quick ? defend() : { kind: 'none' };
  }
  const coming = hostileTactic(target.type) === 'melee' && target.distance <= ENGAGE_RADIUS;
  return inReach || coming ? defend() : { kind: 'none' };
}
