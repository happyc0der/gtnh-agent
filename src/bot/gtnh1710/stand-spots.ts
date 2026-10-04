import { checkDig, type BlockPos, type DigArea } from './digging.ts';
import { compileGoal, goalGetToBlock } from './pathing/goals.ts';
import type { PathFlood } from './pathing/search.ts';
import type { Vec3, WalkWorld } from './walking.ts';

/**
 * Where to stand to dig a block, as a walk on the pathfinder gets there. Pure.
 *
 * The client floods the play area once per observation with MOVE_TO's own walk policy
 * (client/path-actions.ts reachable: the same movements, breaks and placements as the walk,
 * within a cost), so a stand spot offered here is one a MOVE_TO plans a path to: leaves
 * walling in a log are broken on the way, a ledge is climbed with a pillar. Seen live: "no walk
 * from here reaches a spot to dig one from", for logs walled in by leaves.
 */

/** Feet heights tried, relative to the block: on the ground beside it, level, or below it. */
const STAND_HEIGHTS = [1, 0, -1, -2, -3, -4] as const;
/** goalGetToBlock's test only (its heuristic is not used here). */
const NO_RATES = { across: 0, up: 0, down: 0 };

/**
 * The cheapest spot (by the walk there) a flood reached from which the player can dig
 * `target`: goalGetToBlock's test with `adjacent` (the feet in one of the 8 columns around the
 * block, the block's centre within reach of the eyes, as a person stands beside what it digs;
 * a log's drop then falls next to it), and checkDig allowing the dig from there on the blocks
 * as they are. Null when there is none.
 */
export function standSpotOnPath(
  world: WalkWorld,
  area: DigArea,
  target: BlockPos,
  flood: PathFlood,
): Vec3 | null {
  const goal = compileGoal(goalGetToBlock(target, { adjacent: true }), NO_RATES);
  let best: { spot: Vec3; cost: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const fx = target.x + dx;
      const fz = target.z + dz;
      for (const dy of STAND_HEIGHTS) {
        const fy = target.y + dy;
        const reached = flood.get(fx, fy, fz);
        if (reached === undefined || !goal.isGoal(fx, fy, fz)) continue;
        if (best !== null && reached.cost >= best.cost - 1e-9) continue;
        const spot = { x: fx + 0.5, y: fy, z: fz + 0.5 };
        if (!checkDig(world, area, spot, target).ok) continue;
        best = { spot, cost: reached.cost };
      }
    }
  }
  return best?.spot ?? null;
}
