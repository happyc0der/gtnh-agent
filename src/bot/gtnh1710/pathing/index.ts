/**
 * The pathfinder: where to walk, and how, tick by tick. Pure: it reads the blocks the server
 * sent (a WalkWorld) and returns plans; it sends nothing and runs no client code. The client
 * walks with it over terrain (client/path-actions.ts: MOVE_TO, EXPLORE, retreats, the flee,
 * owners' travel steps), under the walk policy of path-policy.ts, carries the plans out and
 * re-checks every step, break and placement just before it.
 *
 *  1. planPath (search.ts): A* over feet blocks inside the search area (the fence), with the
 *     movements of movements.ts (traverse, diagonal, ascend, descend, fall, parkour, pillar,
 *     bridge, digging down, breaking what is in the way, wading) and a goal of goals.ts. It
 *     returns the path to the goal, or the best partial path toward a goal out of reach, and
 *     why it stopped.
 *  2. planExecution (execute.ts): each movement's per-tick steps (position, onGround,
 *     sprinting, jumping) under vanilla 1.7.10 physics (physics.ts), with the blocks to break
 *     before it and the block to place after a given step.
 *  3. validatePlan (validate.ts): checks a plan against those physics and the server's
 *     movement and fall checks, tick by tick (the tests run every plan through it).
 *  4. floodPath (search.ts): every feet block a walk reaches within a cost, with the same
 *     movements and options: where to stand to dig a block is a look-up in it (stand-spots.ts).
 *
 * The design follows Baritone (the Minecraft pathfinding bot, LGPL-3.0): A* with a binary
 * heap and packed node keys, movements checked against the blocks with their costs in ticks
 * from the game's physics (its ActionCosts), penalties for breaking and placing, the goal
 * kinds, and best-so-far partial paths for goals beyond the loaded chunks. Only the ideas were
 * taken: no Baritone code was copied, and every rule and number here was worked out anew for
 * 1.7.10 and this agent's walker (docs/architecture.md, "Pathfinding").
 */

export {
  cacheBox,
  DEFAULT_MAX_NODES,
  DEFAULT_MAX_TIME_MS,
  floodPath,
  MAX_AREA_CELLS,
  planPath,
  resolvePathOptions,
  type FloodSpot,
  type PathFlood,
  type PathOptions,
  type PathResult,
  type PathStatus,
  type PathStop,
} from './search.ts';
export {
  compileGoal,
  describeGoal,
  goalAny,
  goalAway,
  goalBlock,
  goalGetToBlock,
  goalNear,
  goalXZ,
  goalY,
  type CompiledGoal,
  type Goal,
} from './goals.ts';
export {
  MOVEMENT_KINDS,
  type BlockBreak,
  type BlockPlace,
  type Movement,
  type MovementKind,
  type Throwaway,
} from './movements.ts';
export {
  planExecution,
  type ExecutionOptions,
  type ExecutionPlan,
  type PathStep,
  type Segment,
  type StepPlace,
} from './execute.ts';
export { stepProblem, validatePlan, type StepFault, type Validation } from './validate.ts';
export {
  ASCEND_TICKS,
  DEFAULT_PENALTIES,
  LEVEL_JUMP_TICKS,
  SPRINT_ONE_BLOCK,
  WADE_ONE_BLOCK,
  WALK_ONE_BLOCK,
  type Penalties,
} from './costs.ts';
