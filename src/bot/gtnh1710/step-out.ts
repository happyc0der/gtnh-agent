import { passProblem } from './passable.ts';
import type { PathStep } from './pathing/execute.ts';
import { overlappedCells } from './pathing/physics.ts';
import { fenceHolds } from './play-area.ts';
import { standProblem } from './terrain.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';

/**
 * Cobwebs: getting out of one the player stands in. Pure.
 *
 * A Special Mobs web spider spins a cobweb on the player it attacks, and mineshafts are full
 * of them. BlockWeb has no collision box; a body inside one is slowed (Entity.setInWeb: the
 * next move goes a quarter of the way across, a twentieth up or down). The walkers never
 * enter one (passable.ts lists no web: it is no plant), so they also refused to start from
 * inside one, and every walk failed while the player stood in it (seen live 2026-10-05: a
 * retreat home was stopped by a web spun into its way, and the agent stood in the web, its
 * walks refused, until it went offline for the night).
 *
 * The way out is one short level step onto a side cell the player may stand in. The server
 * takes it: NetHandlerPlayServer.processPlayer moves its player by the step with moveEntity,
 * which the web cuts to a quarter, and flags "moved wrongly" (putting the player back) only
 * when the client's position is more than 0.25 off across; otherwise it puts the player
 * where the client says. A step of WEB_STEP is 0.75 x 0.15 = 0.1125 off at most.
 */

/** A cobweb's registry name. */
export const COBWEB = 'minecraft:web';

/** How far a step out of a cobweb goes each tick (see the file comment). */
export const WEB_STEP = 0.15;

/** The side cells first, then the corners. */
const AROUND = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export interface Cell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The cobwebs the player's body, feet at `feet`, is in. */
export function websAt(world: WalkWorld, feet: Vec3): Cell[] {
  const [x0, x1, y0, y1, z0, z1] = overlappedCells(feet.x, feet.y, feet.z);
  const webs: Cell[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        const id = world.blockAt(x, y, z);
        if (id !== undefined && id !== 0 && world.blockName(id) === COBWEB) webs.push({ x, y, z });
      }
    }
  }
  return webs;
}

export type WebExit =
  | { ok: true; steps: PathStep[]; to: Vec3; webs: Cell[] }
  | { ok: false; reason: string; webs: Cell[] };

/**
 * The way out of the cobwebs the body is in, or null when it is in none: a level, straight
 * step onto the nearest cell beside the feet block (its sides first, then its corners) where
 * the player may stand (standProblem: a full block under it, the feet and head cells open, no
 * hazard about) inside the fence, WEB_STEP a tick, every cell the body overlaps on the way
 * open or one of the webs it started in (never into another web). The player stands on a
 * block top: a web holding it in the air is left to gravity (keepSupported).
 */
export function webExit(world: WalkWorld, fence: Fence, feet: Vec3): WebExit | null {
  const webs = websAt(world, feet);
  if (webs.length === 0) return null;
  const refuse = (reason: string): WebExit => ({ ok: false, reason, webs });
  const y = Math.round(feet.y);
  if (Math.abs(feet.y - y) > 1e-6) return refuse('the feet are not on a block top');
  const started = (x: number, cy: number, z: number): boolean =>
    webs.some((w) => w.x === x && w.y === cy && w.z === z);
  const fx = Math.floor(feet.x);
  const fz = Math.floor(feet.z);
  const reasons: string[] = [];
  // The sides first, then the corners, each the nearest first.
  const candidates = AROUND.map(([dx, dz], i) => {
    const to = { x: fx + dx + 0.5, y, z: fz + dz + 0.5 };
    return { to, corner: i >= 4, distance: Math.hypot(to.x - feet.x, to.z - feet.z) };
  }).sort((a, b) => Number(a.corner) - Number(b.corner) || a.distance - b.distance);
  for (const { to, distance } of candidates) {
    const cell = { x: Math.floor(to.x), y, z: Math.floor(to.z) };
    const where = `(${cell.x}, ${y}, ${cell.z})`;
    if (!fenceHolds(fence, to)) {
      reasons.push(`${where} is outside the fence`);
      continue;
    }
    const stand = standProblem(world, cell.x, y, cell.z);
    if (stand !== null) {
      reasons.push(`${where}: ${stand}`);
      continue;
    }
    const n = Math.max(1, Math.ceil(distance / WEB_STEP - 1e-9));
    const steps: PathStep[] = [];
    let blocked: string | null = null;
    for (let i = 1; i <= n && blocked === null; i++) {
      const t = i / n;
      const pos = { x: feet.x + (to.x - feet.x) * t, y, z: feet.z + (to.z - feet.z) * t };
      const [x0, x1, y0, y1, z0, z1] = overlappedCells(pos.x, pos.y, pos.z);
      for (let x = x0; x <= x1 && blocked === null; x++) {
        for (let cy = y0; cy <= y1 && blocked === null; cy++) {
          for (let z = z0; z <= z1 && blocked === null; z++) {
            if (started(x, cy, z)) continue;
            const problem = passProblem(world, x, cy, z);
            if (problem !== null)
              blocked = `the way to ${where} passes (${x}, ${cy}, ${z}): ${problem}`;
          }
        }
      }
      steps.push({ pos, onGround: true, sprint: false, jump: false });
    }
    if (blocked !== null) {
      reasons.push(blocked);
      continue;
    }
    return { ok: true, steps, to, webs };
  }
  return refuse(`no cell beside it to step onto: ${reasons.slice(0, 3).join('; ')}`);
}
