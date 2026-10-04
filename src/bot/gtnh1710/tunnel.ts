import type { BlockPosition } from '../../domain/common.ts';
import type { ShelterStep } from '../../domain/night-shelter.ts';
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
 */

/** The ways a tunnel goes: one block wide only along an axis. */
export const TUNNEL_DIRECTIONS = ['north', 'south', 'east', 'west'] as const;
export type TunnelDirection = (typeof TUNNEL_DIRECTIONS)[number];

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
 * `direction`, for the player with its feet at `feet`, which must stand in the tunnel's line
 * (the start's level, in its row).
 */
export function planTunnel(
  world: WalkWorld,
  feet: Vec3,
  start: BlockPosition,
  direction: TunnelDirection,
  length: number,
  opts: Pick<PitOptions, 'area' | 'canHarvest'>,
): TunnelPlan {
  const { dx, dz } = STEP[direction];
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + EPS);
  const fz = Math.floor(feet.z);
  const done = (fx - start.x) * dx + (fz - start.z) * dz;
  const aside = dx !== 0 ? fz - start.z : fx - start.x;
  if (fy !== start.y || aside !== 0 || done < 0) {
    return {
      ok: false,
      reason: `the player at ${fmt({ x: fx, y: fy, z: fz })} is not in the tunnel's line from ${fmt(start)} ${direction}`,
    };
  }
  if (done >= length) return { ok: true, done: length, steps: [], problem: null };

  const plan = new PlannedWorld(world);
  const steps: ShelterStep[] = [];
  let at: Vec3 = feet;
  let problem: string | null = null;
  for (let k = done + 1; k <= Math.min(done + TUNNEL_SEGMENT, length); k++) {
    const cell = { x: start.x + k * dx, y: start.y, z: start.z + k * dz };
    const floor = floorProblem(plan, { x: cell.x, y: cell.y - 1, z: cell.z });
    if (floor !== null) {
      problem = `the tunnel stops before ${fmt(cell)}: ${floor}`;
      break;
    }
    // The head block first: what stands on it stays put while the feet block goes.
    const digs: ShelterStep[] = [];
    let refused: string | null = null;
    for (const p of [{ ...cell, y: cell.y + 1 }, cell]) {
      if (passProblem(plan, p.x, p.y, p.z) === null) continue;
      const check = checkDig(plan, opts.area, at, p);
      const tool = check.ok && opts.canHarvest !== undefined ? opts.canHarvest(check.block) : null;
      if (!check.ok || tool !== null) {
        refused = check.ok ? `${fmt(p)}: ${tool}` : check.reason;
        break;
      }
      digs.push({
        spec: { type: 'DIG_BLOCK', args: { position: { ...p } } },
        text: `dig the ${check.block} at ${fmt(p)} (the tunnel's ${p.y === cell.y ? 'feet' : 'head'} height)`,
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
