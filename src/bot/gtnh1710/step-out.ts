import { BLOCK_CODE } from './block-hazards.ts';
import { passProblem } from './passable.ts';
import type { PathStep } from './pathing/execute.ts';
import { overlappedCells } from './pathing/physics.ts';
import { fenceHolds } from './play-area.ts';
import { standProblem, TERRAIN_SURFACES } from './terrain.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';

/**
 * Stepping out of a spot no walk starts from: a cobweb the body is in, or a spot beside a
 * hazard (fire, lava, a cactus...) or in one. Pure.
 *
 * The walkers never take the body into a cobweb (passable.ts lists none: it is no plant) or
 * next to a hazard (standProblem's 3 x 3 columns), so they also refused to start from such a
 * spot, and every walk failed while the player stood there. Seen live 2026-10-05: a Special
 * Mobs web spider spun a web into a retreat's way, and the agent stood in it, its walks refused,
 * until it went offline for the night; the next morning, hurt by something out of sight, it
 * stood beside a fire that lit in its staircase, every retreat refused ("cannot walk from here:
 * next to minecraft:fire"), from 20 health to 6.
 *
 * The way out is one short level step onto the nearest cell beside the feet block where the
 * player may stand (standProblem: a full block under it, its feet and head open, no hazard
 * near), its sides first, then its corners. On the way the body passes only open cells and
 * those it started in (a web, the fire it stands in), never into another. The server takes
 * such a step: NetHandlerPlayServer.processPlayer moves its player by it with moveEntity, which
 * a web cuts to a quarter (Entity.setInWeb), and puts the player back ("moved wrongly") only
 * when the client's position is more than 0.25 off across; otherwise it puts the player where
 * the client says. A step of STEP_OUT_PACE is 0.75 x 0.15 = 0.1125 off at most.
 */

/** A cobweb's registry name. */
export const COBWEB = 'minecraft:web';

/** How far a step out goes each tick (see the file comment). */
export const STEP_OUT_PACE = 0.15;

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

/**
 * The hazards (block-hazards.ts: lava, fire, harmful fluids, blocks that hurt to touch) in or
 * beside the body: in the 3 x 3 columns around each block the feet are over, from under the
 * feet to above the head, as standProblem looks. Never an unnamed or unloaded block: those
 * stop a walk, but there is nothing to step away from.
 */
export function hazardsAt(world: WalkWorld, feet: Vec3): Array<Cell & { name: string }> {
  const [x0, x1, , , z0, z1] = overlappedCells(feet.x, feet.y, feet.z);
  const y = Math.floor(feet.y + 1e-6);
  const found = new Map<string, Cell & { name: string }>();
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    for (let cy = y - 1; cy <= y + 2; cy++) {
      for (let z = z0 - 1; z <= z1 + 1; z++) {
        const id = world.blockAt(x, cy, z);
        if (id === undefined || id === 0) continue;
        const code = world.hazardCode(id);
        if (code === BLOCK_CODE.safe || code === BLOCK_CODE.unknown) continue;
        found.set(`${x},${cy},${z}`, { x, y: cy, z, name: world.blockName(id) ?? `id ${id}` });
      }
    }
  }
  return [...found.values()];
}

/** Why the player steps out: the webs it is in, or the hazards beside it. */
export type StepOutCause =
  { kind: 'cobweb'; cells: Cell[] } | { kind: 'hazard'; cells: Array<Cell & { name: string }> };

export type StepOut =
  | { ok: true; cause: StepOutCause; steps: PathStep[]; to: Vec3 }
  | { ok: false; cause: StepOutCause; reason: string };

/**
 * The step out of a cobweb the body is in, or away from a hazard beside it (or in it), or null
 * when there is neither. The feet must be on a block top: a web holding the player in the
 * air is left to gravity (keepSupported).
 */
export function stepOut(world: WalkWorld, fence: Fence, feet: Vec3): StepOut | null {
  const webs = websAt(world, feet);
  const hazards = webs.length > 0 ? [] : hazardsAt(world, feet);
  if (webs.length === 0 && hazards.length === 0) return null;
  const cause: StepOutCause =
    webs.length > 0 ? { kind: 'cobweb', cells: webs } : { kind: 'hazard', cells: hazards };
  const refuse = (reason: string): StepOut => ({ ok: false, cause, reason });
  const y = Math.round(feet.y);
  if (Math.abs(feet.y - y) > 1e-6) return refuse('the feet are not on a block top');
  // A floor under the body: a web holding the player above a hole is left to gravity first
  // (an independent review, 2026-10-05: a level step from there kept it hanging for good).
  const [fx0, fx1, , , fz0, fz1] = overlappedCells(feet.x, feet.y, feet.z);
  let floor = false;
  for (let x = fx0; x <= fx1 && !floor; x++) {
    for (let z = fz0; z <= fz1 && !floor; z++) {
      const id = world.blockAt(x, y - 1, z);
      const name = id === undefined || id === 0 ? undefined : world.blockName(id);
      floor = name !== undefined && TERRAIN_SURFACES.has(name);
    }
  }
  if (!floor) return refuse('no floor under the feet: gravity first');
  // The cells the body is in now: passed on the way even when not open (the web, a fire).
  const [bx0, bx1, by0, by1, bz0, bz1] = overlappedCells(feet.x, feet.y, feet.z);
  const started = (x: number, cy: number, z: number): boolean =>
    x >= bx0 && x <= bx1 && cy >= by0 && cy <= by1 && z >= bz0 && z <= bz1;
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
    const n = Math.max(1, Math.ceil(distance / STEP_OUT_PACE - 1e-9));
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
            if (problem !== null) {
              blocked = `the way to ${where} passes (${x}, ${cy}, ${z}): ${problem}`;
            }
          }
        }
      }
      steps.push({ pos, onGround: true, sprint: false, jump: false });
    }
    if (blocked !== null) {
      reasons.push(blocked);
      continue;
    }
    return { ok: true, cause, steps, to };
  }
  return refuse(`no cell beside it to step onto: ${reasons.slice(0, 3).join('; ')}`);
}

/** The cause in words, for the log: "the cobweb at (x, y, z)", "the minecraft:fire at ...". */
export function describeStepOutCause(cause: StepOutCause): string {
  const at = (c: Cell): string => `(${c.x}, ${c.y}, ${c.z})`;
  if (cause.kind === 'cobweb') return `the cobweb at ${cause.cells.map(at).join(', ')}`;
  return cause.cells.map((c) => `the ${c.name} at ${at(c)}`).join(', ');
}
