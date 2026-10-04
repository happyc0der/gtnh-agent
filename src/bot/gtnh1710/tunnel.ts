import type { BlockPosition } from '../../domain/common.ts';
import type { ShelterStep } from '../../domain/night-shelter.ts';
import type { TunnelDirection, TunnelSlope } from '../../domain/owner-commands.ts';
import { BLOCK_CODE } from './block-hazards.ts';
import { checkDig, type BlockPos } from './digging.ts';
import { PlannedWorld, type PitOptions } from './night-pit.ts';
import { isLiquidName } from './pathing/cells.ts';
import { passProblem } from './passable.ts';
import type { Vec3, WalkWorld } from './walking.ts';

/**
 * A straight tunnel, one block wide and two high, as Baritone's #tunnel digs it (the idea; no
 * code was taken from Baritone, LGPL-3.0): planned by code a few cells at a time with the live
 * client's own dig rules (pure; no I/O). For each cell ahead, standing in the one before it:
 * the head block, then the feet block, each only when it is there and checkDig allows it with
 * a tool the player carries, then a step into the cell. The tunnel stops, and says why, at a
 * dig the rules refuse (a fluid, lava or a gap next to it, sand or gravel above, a player's
 * build, outside the play area) or at an open floor (a cave or a drop ahead). Every step is an
 * ordinary action the executor validates again when it runs.
 *
 * Going down (`slope` 'down'), it is a staircase: each cell one forward and one down, so the
 * player never digs the block it stands on, sees each step's floor before it steps down (the
 * classic way down a person digs), and three blocks go for each: above the head, then the
 * head height, then the cell it steps down into.
 */

/** Cells planned at a time: the rest is planned again from what the world shows then. */
export const TUNNEL_SEGMENT = 6;

const STEP: Readonly<Record<TunnelDirection, { dx: number; dz: number }>> = {
  north: { dx: 0, dz: -1 },
  south: { dx: 0, dz: 1 },
  east: { dx: 1, dz: 0 },
  west: { dx: -1, dz: 0 },
};

const EPS = 1e-6;
const fmt = (p: BlockPos): string => `(${p.x}, ${p.y}, ${p.z})`;

export type TunnelPlan =
  | {
      ok: true;
      /** Cells of the tunnel behind the player (it stands in the last of them). */
      done: number;
      /** The next cells' steps, in order: digs, then the step into the cell. */
      steps: ShelterStep[];
      /** Why the tunnel cannot go on past these steps; null when it can, or is complete. */
      problem: string | null;
    }
  | { ok: false; reason: string };

/**
 * The next steps of the tunnel that starts at feet block `start` and goes `length` cells
 * `direction` (and, with `slope` 'down', one block down for each), for the player with its
 * feet at `feet`. Standing in the tunnel's line (in its row, at the level the cells dug so far
 * reach), the next cells; elsewhere (a retreat, a food trip or the night took it away), a walk
 * back to the last cell of the tunnel open so far, from which the next round goes on.
 */
export function planTunnel(
  world: WalkWorld,
  feet: Vec3,
  start: BlockPosition,
  direction: TunnelDirection,
  length: number,
  opts: Pick<PitOptions, 'area' | 'canHarvest'>,
  slope: TunnelSlope = 'level',
): TunnelPlan {
  const { dx, dz } = STEP[direction];
  const drop = slope === 'down' ? 1 : 0;
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + EPS);
  const fz = Math.floor(feet.z);
  const done = (fx - start.x) * dx + (fz - start.z) * dz;
  const aside = dx !== 0 ? fz - start.z : fx - start.x;
  const cellAt = (k: number): BlockPos => ({
    x: start.x + k * dx,
    y: start.y - drop * k,
    z: start.z + k * dz,
  });
  if (fy !== start.y - drop * done || aside !== 0 || done < 0) {
    // The cells open so far, from the start: the tunnel as dug (an earlier session's).
    let open = 0;
    while (open < length && bodyOpen(world, cellAt(open + 1))) open += 1;
    const back = cellAt(open);
    return {
      ok: true,
      done: open,
      steps: [
        {
          spec: {
            type: 'MOVE_TO',
            args: { target: { x: back.x + 0.5, y: back.y, z: back.z + 0.5 }, tolerance: 0.5 },
          },
          text: `walk back to the tunnel at ${fmt(back)} (the player is at ${fmt({ x: fx, y: fy, z: fz })}, off its line)`,
        },
      ],
      problem: null,
    };
  }
  if (done >= length) return { ok: true, done: length, steps: [], problem: null };

  const plan = new PlannedWorld(world);
  const steps: ShelterStep[] = [];
  let at: Vec3 = feet;
  let problem: string | null = null;
  for (let k = done + 1; k <= Math.min(done + TUNNEL_SEGMENT, length); k++) {
    const cell = { x: start.x + k * dx, y: start.y - drop * k, z: start.z + k * dz };
    const floor = floorProblem(plan, { x: cell.x, y: cell.y - 1, z: cell.z });
    if (floor !== null) {
      problem = `the tunnel stops before ${fmt(cell)}: ${floor}`;
      break;
    }
    // The top block first: what stands on it stays put while the ones below go.
    const digs: ShelterStep[] = [];
    let refused: string | null = null;
    const heights = drop === 1 ? [2, 1, 0] : [1, 0];
    for (const p of heights.map((h) => ({ ...cell, y: cell.y + h }))) {
      if (passProblem(plan, p.x, p.y, p.z) === null) continue;
      const check = checkDig(plan, opts.area, at, p);
      const tool = check.ok && opts.canHarvest !== undefined ? opts.canHarvest(check.block) : null;
      if (!check.ok || tool !== null) {
        refused = check.ok ? `${fmt(p)}: ${tool}` : check.reason;
        break;
      }
      digs.push({
        spec: { type: 'DIG_BLOCK', args: { position: { ...p } } },
        text: `dig the ${check.block} at ${fmt(p)} (${['the feet', 'the head', 'above the head'][p.y - cell.y]} of ${fmt(cell)})`,
      });
      plan.dig(p);
    }
    if (refused !== null) {
      problem = `the tunnel stops before ${fmt(cell)}: ${refused}`;
      break;
    }
    steps.push(...digs, {
      spec: {
        type: 'MOVE_TO',
        args: { target: { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }, tolerance: 0.5 },
      },
      text: `step into ${fmt(cell)}`,
    });
    at = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
  }
  return { ok: true, done, steps, problem };
}

/** Feet and head cells of `p` both open (dug, or air). */
function bodyOpen(world: WalkWorld, p: BlockPos): boolean {
  return (
    passProblem(world, p.x, p.y, p.z) === null && passProblem(world, p.x, p.y + 1, p.z) === null
  );
}

/** Why the block under a tunnel cell will not hold the player, or null: a known solid block. */
function floorProblem(world: WalkWorld, p: BlockPos): string | null {
  const id = world.blockAt(p.x, p.y, p.z);
  if (id === undefined) return `the floor at ${fmt(p)} is not loaded`;
  if (passProblem(world, p.x, p.y, p.z) === null) {
    return `the floor at ${fmt(p)} is open (a cave or a drop ahead)`;
  }
  const name = world.blockName(id);
  if (name === undefined) return `the floor at ${fmt(p)} is a block the registry does not name`;
  if (world.hazardCode(id) !== BLOCK_CODE.safe) return `the floor at ${fmt(p)} is ${name}`;
  // A fluid: the walker never stands on one.
  if (isLiquidName(name)) {
    return `the floor at ${fmt(p)} is ${name}`;
  }
  return null;
}
