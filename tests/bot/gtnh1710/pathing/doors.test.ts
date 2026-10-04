import { describe, expect, it } from 'vitest';
import { CELL, CellCache } from '../../../../src/bot/gtnh1710/pathing/cells.ts';
import { planExecution } from '../../../../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath, type PathOptions } from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
import { area, B, centre, TestWorld } from '../fixtures/path-worlds.ts';

/**
 * Doors and fence gates (cells.ts doorways, movements.ts door): a wall of stone along x = 3
 * with one doorway in it at (3, 64, 0), between the player at (0, 64, 0) and the goal at
 * (6, 64, 0). Door metadata (1.7.10 BlockDoor): the lower half holds the facing (bits 0-1) and
 * the open bit (4); the upper half has bit 8 (and the hinge in bit 1).
 */
const FROM = centre(0, 64, 0);
const GOAL = goalBlock(6, 64, 0);
const AREA = area(8, 60, 70);
const DOORS: PathOptions = { doors: true };

/** The wall, with `door` (a block and its lower and upper metadata) in its gap. */
function walled(block: number, lower: number, upper = 8): TestWorld {
  const w = new TestWorld().fill({ x: 3, y: 64, z: -8 }, { x: 3, y: 66, z: 8 }, B.stone);
  w.set(3, 64, 0, block, lower);
  if (block === B.fenceGate) w.set(3, 65, 0, B.air);
  else w.set(3, 65, 0, block, upper);
  return w;
}

const kinds = (r: ReturnType<typeof planPath>): string[] => r.movements.map((m) => m.kind);

describe('doorways (cells.ts)', () => {
  it('reads a door by both halves: clear along one axis, turned a quarter when open', () => {
    const cells = (w: TestWorld) => new CellCache(w, AREA);
    // Closed, facing 0: its panel along a west or east edge, so clear along z only.
    const closed = cells(walled(B.woodenDoor, 0));
    expect(closed.has(3, 64, 0, CELL.DOORWAY)).toBe(true);
    expect(closed.has(3, 64, 0, CELL.CLEAR_Z)).toBe(true);
    expect(closed.has(3, 64, 0, CELL.CLEAR_X)).toBe(false);
    expect(closed.has(3, 65, 0, CELL.CLEAR_Z)).toBe(true);
    expect(closed.has(3, 64, 0, CELL.SOLID | CELL.PASSABLE)).toBe(false);
    expect(closed.has(3, 64, 0, CELL.TOGGLE)).toBe(true);
    // Open: along x.
    expect(cells(walled(B.woodenDoor, 4)).has(3, 64, 0, CELL.CLEAR_X)).toBe(true);
    // An iron door does not turn on a click.
    expect(cells(walled(B.ironDoor, 0)).has(3, 64, 0, CELL.TOGGLE)).toBe(false);
    // A half without its other half (or one unknown) is solid.
    const half = new TestWorld().set(3, 64, 0, B.woodenDoor, 0);
    expect(cells(half).has(3, 64, 0, CELL.SOLID)).toBe(true);
    // A closed gate is clear along nothing; an open one has no box at all.
    expect(cells(walled(B.fenceGate, 0)).has(3, 64, 0, CELL.CLEAR_X | CELL.CLEAR_Z)).toBe(false);
    const open = cells(walled(B.fenceGate, 4));
    expect(open.has(3, 64, 0, CELL.CLEAR_X) && open.has(3, 64, 0, CELL.CLEAR_Z)).toBe(true);
  });

  it('lets a body stay in a doorway only clear of its panel', () => {
    const c = new CellCache(walled(B.woodenDoor, 4), AREA); // open: clear along x
    // Centred on z (the body is 0.6 wide), anywhere along x: clear.
    expect(c.bodyFitsDoorway(3, 64, 0, 2.9, 3.5, 0.2, 0.8)).toBe(true);
    // Off centre by a tenth: into the panel (3/16 thick) along z = 0 or z = 1.
    expect(c.bodyFitsDoorway(3, 64, 0, 3.2, 3.8, 0.1, 0.7)).toBe(false);
    expect(c.bodyFitsDoorway(4, 64, 0, 4.2, 4.8, 0.2, 0.8)).toBe(false); // not a doorway
  });
});

describe('walking through doors and gates', () => {
  it('opens a closed wooden door in its way, walks through, and is off by default', () => {
    const w = walled(B.woodenDoor, 0);
    const r = planPath(w, AREA, FROM, GOAL, DOORS);
    expect(r.status).toBe('reached');
    expect(kinds(r)).toEqual(['traverse', 'traverse', 'door', 'traverse', 'traverse', 'traverse']);
    const door = r.movements[2];
    expect(door?.toggle).toEqual({
      cell: { x: 3, y: 64, z: 0 },
      block: 'minecraft:wooden_door',
      was: 0,
      meta: 4,
    });
    // Without doors allowed, the wall stands.
    expect(planPath(w, AREA, FROM, GOAL).status).not.toBe('reached');
  });

  it('walks through a door already clear along its way without a click', () => {
    const r = planPath(walled(B.woodenDoor, 4), AREA, FROM, GOAL, DOORS);
    expect(r.status).toBe('reached');
    expect(r.movements.find((m) => m.kind === 'door')?.toggle).toBeNull();
  });

  it('never through an iron door that is in the way (no click turns it)', () => {
    const r = planPath(walled(B.ironDoor, 0), AREA, FROM, GOAL, DOORS);
    expect(r.status).not.toBe('reached');
  });

  it('opens a closed fence gate in a fence', () => {
    const w = new TestWorld().fill({ x: 3, y: 64, z: -8 }, { x: 3, y: 64, z: 8 }, B.fence);
    w.fill({ x: 3, y: 65, z: -8 }, { x: 3, y: 66, z: 8 }, B.stone);
    w.set(3, 64, 0, B.fenceGate, 1).set(3, 65, 0, B.air);
    const r = planPath(w, AREA, FROM, GOAL, DOORS);
    expect(r.status).toBe('reached');
    expect(r.movements.find((m) => m.kind === 'door')?.toggle).toMatchObject({ was: 1, meta: 5 });
  });

  it('leaves a doorway only along its axis (no corner cut through the panel)', () => {
    // An open gate (no box), the goal north-east beyond the wall: through it straight, then turn.
    const w = walled(B.woodenDoor, 4);
    const r = planPath(w, AREA, FROM, goalBlock(6, 64, 3), DOORS);
    expect(r.status).toBe('reached');
    const i = r.movements.findIndex((m) => m.kind === 'door');
    expect(r.movements[i + 1]).toMatchObject({ kind: 'traverse', dir: { x: 1, z: 0 } });
  });

  it('plans the clicks: open standing still before it, close it once through, at rest', () => {
    const w = walled(B.woodenDoor, 0);
    const r = planPath(w, AREA, FROM, GOAL, DOORS);
    const exec = planExecution(w, AREA, FROM, r.movements);
    if (!exec.ok) throw new Error(exec.reason);
    const opening = exec.segments.findIndex((s) => s.toggle != null);
    const seg = exec.segments[opening];
    // From the west side of the door: its west face (4); the door turns open (4).
    expect(seg?.toggle).toMatchObject({ cell: { x: 3, y: 64, z: 0 }, face: 4, was: 0, meta: 4 });
    // The next segment walks out east, stops, and closes it from there (its east face).
    const after = exec.segments[opening + 1];
    expect(after?.restore).toMatchObject({ cell: { x: 3, y: 64, z: 0 }, face: 5, was: 4, meta: 0 });
    const last = after?.steps.at(-1);
    expect(last?.pos).toEqual({ x: 4.5, y: 64, z: 0.5 });
    // The step validator replays it all against the rules, the door turning as clicked.
    expect(validatePlan(w, AREA, FROM, exec)).toMatchObject({ ok: true });
  });
});
