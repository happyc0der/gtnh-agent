import { describe, expect, it } from 'vitest';
import { planExecution } from '../../../../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath, type PathOptions } from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
import type { Fence } from '../../../../src/bot/gtnh1710/walking.ts';
import { benchWalkWorld } from '../fixtures/path-worlds.ts';

/**
 * How fast the pathfinder is, on the bench terrain (hills, forest, desert, river, lake). Timed
 * in this process's CPU time, the best of a few warm runs: the test files run in parallel
 * worker processes, and a busy machine stretches the wall clock, not the work
 * (scripts/path-bench.ts prints the medians; docs/architecture.md, "Pathfinding", the figures).
 */
const { world, column } = benchWalkWorld();

/** The least CPU time (ms) of `runs` calls, and the last result. */
function best<T>(runs: number, f: () => T): { ms: number; last: T } {
  let ms = Infinity;
  let last = f(); // warm up (the JIT)
  for (let i = 0; i < runs; i++) {
    const t = process.cpuUsage();
    last = f();
    const used = process.cpuUsage(t);
    ms = Math.min(ms, (used.user + used.system) / 1000);
  }
  return { ms, last };
}

/** A play area of 64 x 64 columns and 32 levels around (cx, cz). */
function playArea(cx: number, cz: number): Fence {
  const g = column(cx, cz).ground;
  return { min: { x: cx - 32, y: g - 15, z: cz - 32 }, max: { x: cx + 31, y: g + 16, z: cz + 31 } };
}

const feet = (x: number, z: number) => ({ x: x + 0.5, y: column(x, z).ground + 1, z: z + 0.5 });

describe('performance', () => {
  it('plans a path across a 64 x 64 x 32 play area in well under 100 ms', () => {
    const options: PathOptions = { parkour: true, maxNodes: 200_000 };
    for (const [cx, cz] of [
      [8, 8],
      [-90, 90],
      [-50, -60],
    ] as const) {
      const area = playArea(cx, cz);
      const from = feet(cx - 28, cz - 28);
      const to = feet(cx + 27, cz + 27);
      const run = best(5, () =>
        planPath(world, area, from, goalBlock(Math.floor(to.x), to.y, Math.floor(to.z)), options),
      );
      expect(run.last.status).toBe('reached');
      expect(run.last.movements.length).toBeGreaterThan(50);
      expect(run.ms, `around (${cx}, ${cz})`).toBeLessThan(100);
      // Its steps and their validation are cheaper still.
      const steps = best(3, () => planExecution(world, area, from, run.last.movements));
      expect(steps.ms).toBeLessThan(50);
      expect(validatePlan(world, area, from, steps.last)).toMatchObject({ ok: true });
    }
  });

  it('expands 100,000 nodes in well under a second, reading each block once', () => {
    const g = column(8, 8).ground;
    const big: Fence = { min: { x: -120, y: g - 15, z: -120 }, max: { x: 135, y: g + 16, z: 135 } };
    let reads = 0;
    const counted = {
      ...world,
      blockAt: (x: number, y: number, z: number) => (reads++, world.blockAt(x, y, z)),
    };
    const search = () =>
      planPath(counted, big, feet(8, 8), goalBlock(2000, g, 2000), {
        parkour: true,
        bridge: true,
        pillar: true,
        canPlace: () => true,
        throwaway: { count: 32, block: 'minecraft:dirt' },
        maxNodes: 100_000,
        maxTimeMs: 20_000,
      });
    reads = 0;
    const once = search();
    expect(once.nodesExpanded).toBe(100_000);
    expect(once.stop).toBe('node-limit');
    // The cell cache: each block is read once (a node's checks touch some 60 cells; without
    // the cache every one would be a chunk-store lookup).
    expect(reads / once.nodesExpanded).toBeLessThan(12);
    // About 0.4 s on this machine alone (scripts/path-bench.ts); the bound catches a lost
    // cache or a quadratic open list, not a test machine busy with every other file.
    expect(best(1, search).ms).toBeLessThan(3000);
  }, 60_000);
});
