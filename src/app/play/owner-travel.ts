import type { PlayArea } from '../../bot/gtnh1710/play-area.ts';
import { reachableFeet, type ReachedFeet } from '../../bot/gtnh1710/terrain.ts';
import type { Vec3, WalkWorld } from '../../bot/gtnh1710/walking.ts';
import {
  MAX_EXPLORE_DISTANCE,
  MIN_EXPLORE_DISTANCE,
  type ActionSpec,
} from '../../domain/actions.ts';
import type { Position } from '../../domain/common.ts';

/**
 * The next step of an owner's travel command (come, follow, goto, home, a waypoint), planned
 * by code, never by a planner, with the live client's own walk rules: a MOVE_TO to a stand spot
 * a walk reaches (terrain.ts reachableFeet, as GATHER's stand spots), or, toward a point the
 * play area does not reach, an EXPLORE (hops over land, in daylight). The play loop
 * (commands.ts) re-plans after every cycle, so a moving owner is followed, and runs each step
 * as a known safe step: the executor validates it (the safety policy, the boundary, hazards,
 * the night), executes and verifies it like any other.
 */

/** Where a travel command goes: near a player (come, follow), or to a point (y null: any). */
export type TravelTarget =
  | { kind: 'near'; point: Position; within: number }
  | { kind: 'point'; point: { x: number; y: number | null; z: number } };

export type TravelStep =
  /** There already: `distance` blocks across from the target. */
  | { kind: 'arrived'; distance: number }
  | { kind: 'step'; spec: ActionSpec; text: string; distance: number }
  | { kind: 'refused'; reason: string };

export interface TravelInput {
  /** The client's blocks (null while unknown). */
  world: WalkWorld | null;
  /** Where walks may go now: the fence, or the play area around the player. */
  area: PlayArea;
  /** The player's feet (null while unknown). */
  feet: Vec3 | null;
  target: TravelTarget;
  movement: {
    enabled: boolean;
    /** EXPLORE is possible (movement mode 'follow'). */
    canExplore: boolean;
    /** Longest walk (blocks), as the walker plans it. */
    maxPathLength: number;
  };
  /**
   * How far (straight, from the feet) a MOVE_TO's target may be: the safety policy refuses one
   * whose surroundings the hazard scan has not covered.
   */
  moveReach: number;
}

/** At a point: this close across (blocks), and up or down. */
export const AT_POINT = 1.5;
/** Near a player: at most this far up or down. */
const NEAR_DY = 2.5;
/** A stand spot is never closer to the player it goes to than this: not into its body. */
const PERSONAL_SPACE = 1;
/** A walk toward a target must get at least this much closer across. */
const MIN_GAIN = 1;
/** Farther than this across, a target a walk does not reach is explored toward. */
const EXPLORE_BEYOND = 4;

const refused = (reason: string): TravelStep => ({ kind: 'refused', reason });
const centre = (s: ReachedFeet): Position => ({ x: s.x + 0.5, y: s.y, z: s.z + 0.5 });
const fmt = (p: { x: number; y: number | null; z: number }): string =>
  [p.x, p.y, p.z]
    .filter((v): v is number => v !== null)
    .map((v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)))
    .join(', ');

/** The next step toward `target`, or that it is there, or why there is no step. */
export function planTravelStep(input: TravelInput): TravelStep {
  const { world, feet, target } = input;
  if (feet === null) return refused('my position is not known');
  const goal = target.point;
  const across = Math.hypot(goal.x - feet.x, goal.z - feet.z);
  const dy = goal.y === null ? 0 : Math.abs(goal.y - feet.y);
  const arrived =
    target.kind === 'near'
      ? across <= target.within && dy <= NEAR_DY
      : across <= AT_POINT && dy <= AT_POINT;
  if (arrived) return { kind: 'arrived', distance: Number(across.toFixed(1)) };
  if (!input.movement.enabled) return refused('walking is off (MC_ENABLE_MOVEMENT)');
  if (input.area.fence === null) return refused(input.area.problem);
  if (world === null) return refused('the blocks around me are not known yet');

  const acrossFrom = (s: ReachedFeet): number => Math.hypot(s.x + 0.5 - goal.x, s.z + 0.5 - goal.z);
  const spots = [
    ...reachableFeet(world, input.area.fence, feet, input.movement.maxPathLength).values(),
  ].filter(
    (s) => Math.hypot(s.x + 0.5 - feet.x, s.y - feet.y, s.z + 0.5 - feet.z) <= input.moveReach,
  );
  const fits = (s: ReachedFeet): boolean => {
    const d = acrossFrom(s);
    const up = goal.y === null ? 0 : Math.abs(s.y - goal.y);
    return target.kind === 'near'
      ? d <= target.within && d >= PERSONAL_SPACE && up <= NEAR_DY
      : d <= AT_POINT && up <= AT_POINT;
  };
  const distance = Number(across.toFixed(1));
  const walk = (s: ReachedFeet, why: string): TravelStep => ({
    kind: 'step',
    spec: { type: 'MOVE_TO', args: { target: centre(s), tolerance: 1 } },
    text: `walk to (${fmt(centre(s))}): ${why}`,
    distance,
  });

  // A walk there: to a point, its own block when a walk reaches it (as Baritone's goal block:
  // `goto 20 64 5` is the block at 20 64 5); else the stand spot nearest by the walk.
  const block = {
    x: Math.floor(goal.x),
    y: goal.y === null ? null : Math.floor(goal.y + 1e-6),
    z: Math.floor(goal.z),
  };
  const byWalk = (a: ReachedFeet, b: ReachedFeet): number =>
    a.length - b.length || acrossFrom(a) - acrossFrom(b);
  const exact =
    target.kind === 'point'
      ? spots
          .filter(
            (s) => s.x === block.x && s.z === block.z && (block.y === null || s.y === block.y),
          )
          .sort(byWalk)[0]
      : undefined;
  const there = exact ?? spots.filter(fits).sort(byWalk)[0];
  if (there !== undefined) {
    return walk(there, `${target.kind === 'near' ? 'near' : 'at'} (${fmt(goal)})`);
  }
  // Beyond a walk: EXPLORE toward it, in hops (daylight only: the policy refuses it at night).
  if (input.movement.canExplore && across > EXPLORE_BEYOND) {
    return {
      kind: 'step',
      spec: {
        type: 'EXPLORE',
        args: {
          toward: { x: goal.x, z: goal.z },
          maxDistance: Math.min(
            MAX_EXPLORE_DISTANCE,
            Math.max(MIN_EXPLORE_DISTANCE, Math.ceil(across)),
          ),
        },
      },
      text: `EXPLORE toward (${fmt({ x: goal.x, y: null, z: goal.z })}): ${distance} blocks across`,
      distance,
    };
  }
  // Else as near as a walk gets (the fixed fence, or a target just out of reach).
  const nearer = spots
    .filter((s) => acrossFrom(s) <= across - MIN_GAIN)
    .sort((a, b) => acrossFrom(a) - acrossFrom(b) || a.length - b.length);
  if (nearer[0] !== undefined) return walk(nearer[0], `nearer to (${fmt(goal)})`);
  return refused(
    `no walk gets nearer to (${fmt(goal)}) from here (a wall, water, a cliff, or the edge of ` +
      'where I may walk)',
  );
}
