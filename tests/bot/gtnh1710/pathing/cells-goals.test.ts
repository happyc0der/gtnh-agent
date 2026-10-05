import { describe, expect, it } from 'vitest';
import { CELL, CellCache, changedWorld } from '../../../../src/bot/gtnh1710/pathing/cells.ts';
import { heuristicRates } from '../../../../src/bot/gtnh1710/pathing/costs.ts';
import {
  compileGoal,
  describeGoal,
  goalAny,
  goalAway,
  goalBlock,
  goalGetToBlock,
  goalNear,
  goalXZ,
  goalY,
  type Goal,
} from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import { expand, MoveContext } from '../../../../src/bot/gtnh1710/pathing/movements.ts';
import {
  cacheBox,
  planPath,
  resolvePathOptions,
  type PathOptions,
} from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { standProblem } from '../../../../src/bot/gtnh1710/terrain.ts';
import { area, B, centre, TestWorld } from '../fixtures/path-worlds.ts';

/** Bumpy ground with leaves, a cactus, lava, water and a vine around. */
function bumpy(): TestWorld {
  return new TestWorld((x, z) => 63 + ((x * 7 + z * 13) % 5 === 0 ? 1 : 0) - (x === 4 ? 2 : 0))
    .set(2, 64, 2, B.leaves)
    .set(-3, 64, 1, B.cactus)
    .set(5, 63, -4, B.lava)
    .set(-5, 63, -5, B.water)
    .set(1, 64, -6, B.vine)
    .set(3, 64, 3, B.foliage, 7); // poison ivy: a wall
}

describe('the cell cache', () => {
  it("says standable exactly where terrain.ts's standProblem does, but never in a vine", () => {
    const w = bumpy();
    const fence = area(8, 60, 68);
    const cells = new CellCache(w, cacheBox(fence));
    for (let x = -8; x <= 8; x++) {
      for (let z = -8; z <= 8; z++) {
        for (let y = 60; y <= 68; y++) {
          const vine = w.blockAt(x, y, z) === B.vine;
          expect(cells.standable(x, y, z), `(${x}, ${y}, ${z})`).toBe(
            standProblem(w, x, y, z) === null && !vine,
          );
        }
      }
    }
    expect(cells.has(1, 64, -6, CELL.LADDER)).toBe(true);
  });

  it('knows calm one-deep water: a source with no flow out of it', () => {
    // A 3 x 3 pool of sources, its floor at 62, the banks around solid at 63.
    const w = new TestWorld().fill({ x: 0, y: 63, z: 0 }, { x: 2, y: 63, z: 2 }, B.water);
    const cells = new CellCache(w, cacheBox(area(6, 60, 68)));
    expect(cells.calmWater(1, 63, 1)).toBe(true);
    expect(cells.wadeable(1, 63, 1)).toBe(true);
    // A flowing edge (level 3) next to it: neither is calm.
    w.set(3, 63, 1, B.flowingWater, 3);
    const c2 = new CellCache(w, cacheBox(area(6, 60, 68)));
    expect(c2.calmWater(2, 63, 1)).toBe(false);
    expect(c2.calmWater(3, 63, 1)).toBe(false);
    // Unknown metadata is never calm.
    const blind = {
      blockAt: (x: number, y: number, z: number) => w.blockAt(x, y, z),
      blockName: (id: number) => w.blockName(id),
      hazardCode: (id: number) => w.hazardCode(id),
    };
    expect(new CellCache(blind, cacheBox(area(6, 60, 68))).calmWater(1, 63, 1)).toBe(false);
  });

  it('marks hazards and unloaded cells, and everything next to them', () => {
    const w = new TestWorld().set(0, 64, 0, B.fire).unload((x) => x >= 6);
    const cells = new CellCache(w, cacheBox(area(8, 60, 68)));
    expect(cells.nearHazard(1, 65, 1)).toBe(true);
    expect(cells.nearHazard(2, 64, 0)).toBe(false);
    expect(cells.nearHazard(5, 64, 0)).toBe(true); // next to the unloaded column x = 6
    expect(cells.has(6, 64, 0, CELL.SOLID)).toBe(true);
    expect(cells.has(6, 64, 0, CELL.LOADED)).toBe(false);
  });

  it('reads a world with blocks broken and placed', () => {
    const w = new TestWorld();
    const changed = changedWorld(w, [
      { cell: { x: 0, y: 63, z: 0 }, block: null },
      { cell: { x: 1, y: 64, z: 0 }, block: 'minecraft:dirt' },
    ]);
    expect(changed.blockAt(0, 63, 0)).toBe(0);
    expect(changed.blockName(changed.blockAt(1, 64, 0) as number)).toBe('minecraft:dirt');
    expect(changed.blockAt(2, 63, 0)).toBe(B.grass);
  });
});

describe('goals', () => {
  const rates = { across: 4.6, up: 10, down: 3 };

  it('each kind says where it is met', () => {
    expect(compileGoal(goalBlock(1, 2, 3), rates).isGoal(1, 2, 3)).toBe(true);
    expect(compileGoal(goalBlock(1, 2, 3), rates).isGoal(1, 3, 3)).toBe(false);
    expect(compileGoal(goalXZ(4, 5), rates).isGoal(4, 99, 5)).toBe(true);
    expect(compileGoal(goalY(70), rates).isGoal(-100, 70, 3)).toBe(true);
    const near = compileGoal(goalNear({ x: 0.5, y: 64, z: 0.5 }, 3), rates);
    expect(near.isGoal(3, 64, 0)).toBe(true);
    expect(near.isGoal(4, 64, 0)).toBe(false);
    // Within reach of a block, never standing on it or in its column below it.
    const dig = compileGoal(goalGetToBlock({ x: 0, y: 64, z: 0 }), rates);
    expect(dig.isGoal(1, 64, 0)).toBe(true);
    expect(dig.isGoal(3, 64, 3)).toBe(true); // 4.3 from the eyes
    expect(dig.isGoal(4, 64, 3)).toBe(false);
    expect(dig.isGoal(0, 65, 0)).toBe(false); // on top of it
    expect(dig.isGoal(0, 62, 0)).toBe(true); // under it: it is above the head
    const next = compileGoal(goalGetToBlock({ x: 0, y: 64, z: 0 }, { adjacent: true }), rates);
    expect(next.isGoal(1, 64, 1)).toBe(true);
    expect(next.isGoal(2, 64, 0)).toBe(false);
    const any = compileGoal(goalAny(goalBlock(5, 64, 5), goalXZ(-5, -5)), rates);
    expect(any.isGoal(5, 64, 5) && any.isGoal(-5, 0, -5) && !any.isGoal(0, 64, 0)).toBe(true);
    const away = compileGoal(goalAway([{ x: 0, z: 0 }], 8), rates);
    expect(away.isGoal(8, 64, 0)).toBe(true);
    expect(away.isGoal(6, 64, 0)).toBe(false);
    expect(away.heuristic(0, 64, 0)).toBeCloseTo(rates.across * (8 - Math.SQRT1_2), 9);
    // In words, to a tenth of a block (seen live: "12.325250118572388 blocks away").
    expect(describeGoal(goalAway([{ x: 0, z: 0 }], 12.325250118572388))).toBe(
      '12.3 blocks away from 1 point(s)',
    );
  });

  it('heuristics never overestimate the cost of a found path, and drop no faster than a move costs', () => {
    const w = bumpy();
    const fence = area(8, 58, 70);
    const options: PathOptions = {
      parkour: true,
      sprint: true,
      pillar: true,
      bridge: true,
      water: true,
      downward: true,
      canBreak: () => 5,
      canPlace: () => true,
      throwaway: { count: 10, block: 'minecraft:dirt' },
    };
    const resolved = resolvePathOptions(options);
    if (typeof resolved === 'string') throw new Error(resolved);
    const r = heuristicRates(resolved.costs, { pillar: true, downward: true, minDigTicks: 0 });
    const goals: Goal[] = [
      goalBlock(6, 64, 6),
      goalXZ(-6, 7),
      goalNear({ x: -4, y: 64, z: 6 }, 2.5),
      goalY(62),
      goalGetToBlock({ x: 6, y: 63, z: -6 }),
      goalGetToBlock({ x: -6, y: 64, z: -2 }, { adjacent: true }),
      goalAny(goalBlock(7, 64, -7), goalBlock(-7, 64, 7)),
      goalAway([{ x: 0.5, z: 0.5 }], 6),
    ];
    const cells = new CellCache(w, cacheBox(fence));
    const ctx = new MoveContext(cells, fence, resolved.move, resolved.costs);
    for (const goal of goals) {
      const compiled = compileGoal(goal, r);
      // Consistent: along every movement out of every feet block of the area.
      for (let x = -7; x <= 7; x++) {
        for (let z = -7; z <= 7; z++) {
          for (let y = 60; y <= 66; y++) {
            if (!cells.standable(x, y, z)) continue;
            const h = compiled.heuristic(x, y, z);
            expand(ctx, x, y, z, (nx, ny, nz, cost) => {
              expect(h, `${goal.kind} (${x},${y},${z})->(${nx},${ny},${nz})`).toBeLessThanOrEqual(
                cost + compiled.heuristic(nx, ny, nz) + 1e-9,
              );
            });
          }
        }
      }
      // Admissible: never more than a path found costs.
      const y0 = w.ground(0, 0) + 1;
      const found = planPath(w, fence, centre(0, y0, 0), goal, options);
      expect(found.status, goal.kind).toBe('reached');
      expect(compiled.heuristic(0, y0, 0)).toBeLessThanOrEqual(found.cost + 1e-9);
    }
  });
});
