import { BLOCK_CODE } from './block-hazards.ts';
import { dropSpot, withinPickup } from './combat.ts';
import { goalAny, goalBlock, type Goal } from './pathing/goals.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';
import type { ItemEntity } from './world-model.ts';

/**
 * Picking up what a dig or a kill dropped, for the live GTNH client: which dropped items are an
 * action's own, and where to stand to pick one up. Pure functions; no I/O (client/drop-actions.ts
 * waits and walks).
 *
 * Seen live 2026-10-01: gathering logs for a crafting table, the agent dug three logs and got
 * one. Standing at (-20.5, 114, 122.5), it dug the logs at (-20, 116, 123) and (-18, 117, 123),
 * high in the trees and off its own column; their drops fell onto other logs or leaves and
 * stopped out of its pickup reach, where the client never looked (only on the floor of the dug
 * cell or below it). So the client follows the items themselves now (world-model.ts: the item
 * entities the server spawns, what each is, where it moves, whether it lies still).
 *
 * Server facts (1.7.10): a broken block's drop appears 0.15-0.85 into its cell on each axis
 * (Block.dropBlockAsItem), a killed animal's at its feet (Entity.entityDropItem), each flying up
 * and a little sideways; it can be picked up 10 ticks later, by a player whose box grown by 1
 * sideways and 0.5 up and down touches it (EntityPlayer.onLivingUpdate: withinPickup), at the
 * player's own ticks (the client's idle ticks).
 */

/** How far from a dug block's centre its drops appear (0.15-0.85 into its cell). */
export const DIG_DROP_SPAWN_RADIUS = 1;
/** How far from where the client last saw a killed animal its drops appear (it sees a move late). */
export const KILL_DROP_SPAWN_RADIUS = 2;
/** A drop that ended up farther than this from where it appeared (down a cliff) is left. */
export const MAX_FETCH_DISTANCE = 6;
/** At most this many walks to the drops of one action. */
export const MAX_DROP_WALKS = 2;
/**
 * How long the drops of an action may take to come to rest (or be picked up) before the client
 * gives up on the ones still moving: the server shows where one came to rest 20 ticks after it
 * appeared, world-model.ts ITEM_SETTLE_MS later it counts as settled (ITEM_STILL_MS at most).
 */
export const DROP_SETTLE_WAIT_MS = 5_000;
/**
 * A drop of the client's own that an earlier dig or kill left lying (a walk to it stopped,
 * the walks ran out, or it lay out of reach then) is swept up with a later one's drops when it
 * lies within this far of it, as a person sweeps up what fell around the tree.
 */
export const SWEEP_RADIUS = 4;

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The dropped items that are an action's own: they appeared since `since` (the action began),
 * within `spawnRadius` of `origin` (the dug block's centre, or where the animal died). Other
 * items (older drops, another player's) are not touched.
 */
export function actionDrops(
  items: readonly ItemEntity[],
  origin: Vec3,
  since: Date,
  spawnRadius: number,
): ItemEntity[] {
  return items.filter(
    (i) => i.spawnedAt.getTime() >= since.getTime() && distance(i.spawn, origin) <= spawnRadius,
  );
}

/**
 * What an action sweeps up besides its own drops: the client's own earlier drops (`own`: ids
 * of the items its earlier digs and kills dropped, which it dug and killed for) still lying
 * within SWEEP_RADIUS of `origin`, lying still, nearest to `origin` first. Another player's
 * items are never among them. A drop that lands within half a block of an older one of the
 * same item merges into it (EntityItem.combineItems) and is gone: the older one, swept up,
 * holds both.
 */
export function leftovers(
  items: readonly ItemEntity[],
  own: ReadonlySet<number>,
  origin: Vec3,
): ItemEntity[] {
  return items
    .filter((i) => own.has(i.entityId) && i.settled && distance(i.position, origin) <= SWEEP_RADIUS)
    .sort((a, b) => distance(a.position, origin) - distance(b.position, origin));
}

/** How to pick up one dropped item that lies still: it is in reach, a walk, or why not. */
export type DropFetch =
  | { kind: 'in-reach' }
  | { kind: 'walk'; spot: Vec3 }
  /** No free spot puts it in reach: a walk that may break on its way (pickupGoal). */
  | { kind: 'dig-to'; goal: Goal; reason: string }
  | { kind: 'refused'; reason: string };

/**
 * How the player, feet at `feet`, picks up `item` (lying still): within the pickup reach it
 * needs nothing (the server picks it up at the player's next tick); otherwise a walk to where
 * combat.ts dropSpot puts the player: the item's own cell, else the nearest cell beside it (one
 * level up or down at most) from which it is within reach, a cell inside the fence a player
 * may stand in (a full block underfoot, room for the body, no hazard within a block: never
 * into lava, fire or the like). Refused for an item that ended up more than MAX_FETCH_DISTANCE
 * from where it appeared. When no such cell exists, a walk that may break blocks on its way
 * but never places one (`dig-to`, pickupGoal): to a drop in a gap one block high under
 * leaves (seen live 2026-10-04: two cobblestone drops left so under a tree), never up a tree.
 */
export function planDropFetch(
  world: WalkWorld,
  fence: Fence,
  feet: Vec3,
  item: Pick<ItemEntity, 'position' | 'spawn'>,
): DropFetch {
  if (withinPickup(feet, item.position)) return { kind: 'in-reach' };
  const moved = distance(item.position, item.spawn);
  if (moved > MAX_FETCH_DISTANCE) {
    return {
      kind: 'refused',
      reason: `it ended up ${moved.toFixed(1)} blocks from where it appeared (at most ${MAX_FETCH_DISTANCE} are fetched)`,
    };
  }
  const spot = dropSpot(world, fence, item.position);
  if (spot === null) {
    const reason =
      'no cell inside the play area that a player may stand in (a full block underfoot, room ' +
      'for the body, no hazard near) puts it within pickup reach';
    const goal = pickupGoal(world, fence, item.position);
    return goal === null ? { kind: 'refused', reason } : { kind: 'dig-to', goal, reason };
  }
  return { kind: 'walk', spot };
}

/**
 * The pathfinder's goal for picking up an item lying at `at`: any feet block inside the fence
 * from whose centre it is within pickup reach (withinPickup), at its level or below it, with
 * no hazard (lava, fire...) or unloaded block in the 3 x 3 columns around it from under the
 * feet to above the head, as terrain.ts standProblem asks; a walk that only breaks (never
 * places) may get there. Null when there is none.
 */
export function pickupGoal(world: WalkWorld, fence: Fence, at: Vec3): Goal | null {
  const cx = Math.floor(at.x);
  const cz = Math.floor(at.z);
  const goals: Goal[] = [];
  for (let y = Math.floor(at.y + 1e-6); y >= Math.floor(at.y - 2.2); y--) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const x = cx + dx;
        const z = cz + dz;
        const inside =
          x >= fence.min.x &&
          x <= fence.max.x &&
          z >= fence.min.z &&
          z <= fence.max.z &&
          y >= fence.min.y &&
          y <= fence.max.y;
        if (!inside || !withinPickup({ x: x + 0.5, y, z: z + 0.5 }, at)) continue;
        if (!hazardFree(world, x, y, z)) continue;
        goals.push(goalBlock(x, y, z));
      }
    }
  }
  return goals.length === 0 ? null : goalAny(...goals);
}

/** No hazard and nothing unloaded in the 3 x 3 columns around feet (x, y, z), y-1 to y+2. */
function hazardFree(world: WalkWorld, x: number, y: number, z: number): boolean {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const id = world.blockAt(x + dx, y + dy, z + dz);
        if (id === undefined || world.hazardCode(id) !== BLOCK_CODE.safe) return false;
      }
    }
  }
  return true;
}

/** "(-20, 116, 123)": the block cell a point is in. */
export function cellText(p: Vec3): string {
  return `(${Math.floor(p.x)}, ${Math.floor(p.y + 1e-6)}, ${Math.floor(p.z)})`;
}

/** "1 x minecraft:log at (-20, 116, 123)": an item and the block cell it lies in. */
export function describeDrop(item: Pick<ItemEntity, 'item' | 'count' | 'position'>): string {
  const what = item.item === null ? 'an item' : `${item.count ?? '?'} x ${item.item}`;
  return `${what} at ${cellText(item.position)}`;
}
