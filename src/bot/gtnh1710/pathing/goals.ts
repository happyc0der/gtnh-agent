import { MAX_DIG_REACH } from '../digging.ts';
import { PLAYER_EYE_HEIGHT } from '../packets.ts';
import type { HeuristicRates } from './costs.ts';

/**
 * Where a path may end, as plain data (so a goal can be logged and compared), and for each a
 * test of a feet block and a heuristic: a lower bound on the ticks still needed (admissible),
 * which never drops by more than a movement costs (consistent), built from the cheapest cost
 * per block of progress across, up and down (costs.ts heuristicRates). The goal kinds are
 * Baritone's (GoalBlock, GoalXZ, GoalNear, GoalYLevel, GoalGetToBlock, GoalComposite,
 * GoalRunAway: the ideas, not the code); Baritone's heuristics are weighted for speed, these
 * are kept admissible so a found path is the cheapest. A feet block (x, y, z) means the player
 * standing at (x + 0.5, y, z + 0.5). Pure.
 */

export type Goal =
  /** The feet in exactly this block. */
  | { readonly kind: 'block'; readonly x: number; readonly y: number; readonly z: number }
  /** The feet in this column, at any height. */
  | { readonly kind: 'xz'; readonly x: number; readonly z: number }
  /** The feet within `radius` of a point. */
  | {
      readonly kind: 'near';
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly radius: number;
    }
  /** The feet at this level. */
  | { readonly kind: 'y'; readonly y: number }
  /**
   * Standing where the player can reach a block to dig or open it: its centre within `reach`
   * of the eyes, never in its own column at or above it (not the block it stands on or is in);
   * `adjacent` also wants the feet in one of the 3 x 3 columns around it.
   */
  | {
      readonly kind: 'get-to-block';
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly reach: number;
      readonly adjacent: boolean;
    }
  /** Any of several goals. */
  | { readonly kind: 'any'; readonly goals: readonly Goal[] }
  /** At least `distance` (across, ignoring height) from every one of the points: running away. */
  | {
      readonly kind: 'away';
      readonly from: ReadonlyArray<{ readonly x: number; readonly z: number }>;
      readonly distance: number;
    };

export const goalBlock = (x: number, y: number, z: number): Goal => ({ kind: 'block', x, y, z });
export const goalXZ = (x: number, z: number): Goal => ({ kind: 'xz', x, z });
export const goalNear = (
  p: { readonly x: number; readonly y: number; readonly z: number },
  radius: number,
): Goal => ({ kind: 'near', x: p.x, y: p.y, z: p.z, radius });
export const goalY = (y: number): Goal => ({ kind: 'y', y });
export const goalGetToBlock = (
  b: { readonly x: number; readonly y: number; readonly z: number },
  options: { reach?: number; adjacent?: boolean } = {},
): Goal => ({
  kind: 'get-to-block',
  x: b.x,
  y: b.y,
  z: b.z,
  reach: options.reach ?? MAX_DIG_REACH,
  adjacent: options.adjacent ?? false,
});
export const goalAny = (...goals: Goal[]): Goal => ({ kind: 'any', goals });
export const goalAway = (
  from: ReadonlyArray<{ readonly x: number; readonly z: number }>,
  distance: number,
): Goal => ({ kind: 'away', from, distance });

/** A goal ready for a search: its test and its heuristic, for feet blocks. */
export interface CompiledGoal {
  isGoal(x: number, y: number, z: number): boolean;
  heuristic(x: number, y: number, z: number): number;
}

/** Grid distance across: diagonal steps cost √2 (the shortest 8-way path's length). */
function octile(dx: number, dz: number): number {
  const a = Math.abs(dx);
  const b = Math.abs(dz);
  return Math.max(a, b) + (Math.SQRT2 - 1) * Math.min(a, b);
}

/** Ticks at least, for `rise` blocks up (negative: down). */
function vertical(rates: HeuristicRates, rise: number): number {
  return rise > 0 ? rates.up * rise : -rise * rates.down;
}

export function compileGoal(goal: Goal, rates: HeuristicRates): CompiledGoal {
  switch (goal.kind) {
    case 'block':
      return {
        isGoal: (x, y, z) => x === goal.x && y === goal.y && z === goal.z,
        heuristic: (x, y, z) =>
          Math.max(rates.across * octile(goal.x - x, goal.z - z), vertical(rates, goal.y - y)),
      };
    case 'xz':
      return {
        isGoal: (x, _y, z) => x === goal.x && z === goal.z,
        heuristic: (x, _y, z) => rates.across * octile(goal.x - x, goal.z - z),
      };
    case 'near': {
      const r = goal.radius;
      return {
        isGoal: (x, y, z) => Math.hypot(x + 0.5 - goal.x, y - goal.y, z + 0.5 - goal.z) <= r,
        heuristic: (x, y, z) => {
          const across = Math.hypot(x + 0.5 - goal.x, z + 0.5 - goal.z);
          const rise = goal.y - y;
          const v = Math.max(0, Math.abs(rise) - r) * Math.sign(rise);
          return Math.max(rates.across * Math.max(0, across - r), vertical(rates, v));
        },
      };
    }
    case 'y':
      return {
        isGoal: (_x, y) => y === goal.y,
        heuristic: (_x, y) => vertical(rates, goal.y - y),
      };
    case 'get-to-block': {
      const cx = goal.x + 0.5;
      const cy = goal.y + 0.5;
      const cz = goal.z + 0.5;
      const reach = goal.reach;
      // Feet heights from which the eyes can be within reach of the centre at all.
      const low = cy - PLAYER_EYE_HEIGHT - reach;
      const high = cy - PLAYER_EYE_HEIGHT + reach;
      // Across, a goal spot is within reach of the centre, and adjacent ones within √2.
      const acrossSlack = goal.adjacent ? Math.min(reach, Math.SQRT2) : reach;
      return {
        isGoal: (x, y, z) => {
          if (x === goal.x && z === goal.z && goal.y <= y + 1) return false;
          if (goal.adjacent && (Math.abs(x - goal.x) > 1 || Math.abs(z - goal.z) > 1)) {
            return false;
          }
          return Math.hypot(x + 0.5 - cx, y + PLAYER_EYE_HEIGHT - cy, z + 0.5 - cz) <= reach;
        },
        heuristic: (x, y, z) => {
          const across = Math.hypot(x + 0.5 - cx, z + 0.5 - cz);
          // Feet are on whole levels: the nearest one within the heights.
          const rise = y < low ? Math.ceil(low - y) : y > high ? -Math.ceil(y - high) : 0;
          return Math.max(rates.across * Math.max(0, across - acrossSlack), vertical(rates, rise));
        },
      };
    }
    case 'any': {
      const parts = goal.goals.map((g) => compileGoal(g, rates));
      return {
        isGoal: (x, y, z) => parts.some((p) => p.isGoal(x, y, z)),
        heuristic: (x, y, z) => {
          let best = Infinity;
          for (const p of parts) best = Math.min(best, p.heuristic(x, y, z));
          return best;
        },
      };
    }
    case 'away': {
      const d = goal.distance;
      return {
        isGoal: (x, _y, z) => goal.from.every((p) => Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z) >= d),
        heuristic: (x, _y, z) => {
          let need = 0;
          for (const p of goal.from)
            need = Math.max(need, d - Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z));
          return rates.across * need;
        },
      };
    }
  }
}

/** The goal in words, for reasons and logs. */
export function describeGoal(goal: Goal): string {
  switch (goal.kind) {
    case 'block':
      return `feet at (${goal.x}, ${goal.y}, ${goal.z})`;
    case 'xz':
      return `the column (${goal.x}, ${goal.z})`;
    case 'near':
      return `within ${goal.radius} of (${goal.x}, ${goal.y}, ${goal.z})`;
    case 'y':
      return `feet at y=${goal.y}`;
    case 'get-to-block':
      return `${goal.adjacent ? 'next to' : 'within reach of'} the block (${goal.x}, ${goal.y}, ${goal.z})`;
    case 'any':
      return goal.goals.map(describeGoal).join(' or ');
    case 'away':
      return `${goal.distance} blocks away from ${goal.from.length} point(s)`;
  }
}
