import { describe, expect, it } from 'vitest';
import { planExecution } from '../../../../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import { planPath, type PathOptions } from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
import type { Fence, Vec3 } from '../../../../src/bot/gtnh1710/walking.ts';
import { area, B, TestWorld } from '../fixtures/path-worlds.ts';

/**
 * Every path the search finds must have an execution plan that the validator passes: random
 * worlds (rough hills with holes, leaf bushes, pools and lava; a maze of 1-wide corridors with
 * pools and a canyon), random starts (off the block centre too), random goals and options.
 */

/** A small deterministic random generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roughWorld(seed: number): TestWorld {
  const r = rng(seed);
  const heights = new Map<string, number>();
  for (let x = -15; x <= 15; x++) {
    for (let z = -15; z <= 15; z++) {
      const base = 63 + Math.round(2 * Math.sin(x / 3 + seed) + 2 * Math.cos(z / 4 - seed));
      heights.set(`${x},${z}`, base - (r() < 0.06 ? Math.floor(1 + r() * 6) : 0));
    }
  }
  const w = new TestWorld((x, z) => heights.get(`${x},${z}`) ?? 63);
  const spot = (): [number, number] => [Math.floor(r() * 24) - 12, Math.floor(r() * 24) - 12];
  for (let i = 0; i < 25; i++) {
    const [x, z] = spot();
    w.set(x, w.ground(x, z) + 1, z, B.leaves);
    if (r() < 0.5) w.set(x, w.ground(x, z) + 2, z, B.leaves);
  }
  for (let i = 0; i < 3; i++) {
    const [x, z] = spot();
    w.set(x, w.ground(x, z), z, B.water);
  }
  if (r() < 0.5) {
    const [x, z] = spot();
    w.set(x, w.ground(x, z), z, B.lava);
  }
  return w;
}

function mazeWorld(seed: number): TestWorld {
  const r = rng(seed);
  const canyon = Math.floor(r() * 10) - 5;
  const w = new TestWorld((x) => (x === canyon || x === canyon + 1 ? 55 : 63));
  for (let x = -12; x <= 12; x++) {
    for (let z = -12; z <= 12; z++) {
      if (x === canyon || x === canyon + 1) {
        w.set(x, 55, z, B.water);
        continue;
      }
      if ((x % 3 === 0 || z % 3 === 0) && r() < 0.55) {
        w.fill({ x, y: 64, z }, { x, y: 65, z }, B.stone);
      } else if (r() < 0.08) w.set(x, 63, z, B.water);
      else if (r() < 0.04) w.set(x, 64, z, B.tallgrass);
    }
  }
  return w;
}

function check(
  w: TestWorld,
  fence: Fence,
  from: Vec3,
  goal: [number, number, number],
  options: PathOptions,
): string | null {
  const res = planPath(w, fence, from, goalBlock(...goal), options);
  if (res.movements.length === 0) return null;
  const water = options.water ?? false;
  const plan = planExecution(w, fence, from, res.movements, { water });
  const v = validatePlan(w, fence, from, plan, { water });
  if (plan.ok && v.ok) return '';
  return `${JSON.stringify(from)} -> ${goal.join(',')}: ${res.movements.map((m) => m.kind).join(' ')}: ${
    plan.ok ? '' : `plan: ${plan.reason}`
  } ${v.ok ? '' : `validation: segment ${v.segment} step ${v.step}: ${v.reason}`}`;
}

describe('every path found executes under vanilla physics', () => {
  it('on rough terrain', () => {
    let paths = 0;
    const failures: string[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const w = roughWorld(seed);
      const r = rng(seed * 7919);
      const pick = (): [number, number, number] => {
        const x = Math.floor(r() * 20) - 10;
        const z = Math.floor(r() * 20) - 10;
        return [x, w.ground(x, z) + 1, z];
      };
      const [sx, sy, sz] = pick();
      const options: PathOptions = {
        sprint: r() < 0.5,
        parkour: r() < 0.7,
        parkourOverDeepGaps: r() < 0.3,
        pillar: r() < 0.5,
        bridge: r() < 0.5,
        downward: r() < 0.3,
        water: r() < 0.5,
        canBreak: (c) => (w.blockAt(c.x, c.y, c.z) === B.leaves ? 10 : r() < 0.3 ? 15 : null),
        canPlace: () => true,
        throwaway: { count: 6, block: 'minecraft:dirt' },
      };
      for (let k = 0; k < 5; k++) {
        const from = { x: sx + 0.3 + 0.4 * r(), y: sy, z: sz + 0.3 + 0.4 * r() };
        const out = check(w, area(12, 50, 75), from, pick(), options);
        if (out === null) continue;
        paths++;
        if (out !== '') failures.push(`seed ${seed} ${out}`);
      }
    }
    expect(paths).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  }, 60_000);

  it('in a maze of corridors, pools and a canyon', () => {
    let paths = 0;
    const failures: string[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const w = mazeWorld(seed);
      const r = rng(seed * 104729);
      const open = (x: number, z: number): boolean =>
        w.blockAt(x, 64, z) === B.air &&
        w.blockAt(x, 65, z) === B.air &&
        w.blockAt(x, 63, z) === B.grass;
      const pick = (): [number, number, number] | null => {
        for (let t = 0; t < 50; t++) {
          const x = Math.floor(r() * 22) - 11;
          const z = Math.floor(r() * 22) - 11;
          if (open(x, z)) return [x, 64, z];
        }
        return null;
      };
      const s = pick();
      if (s === null) continue;
      const options: PathOptions = {
        sprint: r() < 0.5,
        parkour: r() < 0.7,
        pillar: r() < 0.5,
        bridge: r() < 0.5,
        water: r() < 0.7,
        canBreak: () => (r() < 0.5 ? 20 : null),
        canPlace: () => true,
        throwaway: { count: 4, block: 'minecraft:cobblestone' },
      };
      for (let k = 0; k < 5; k++) {
        const goal = pick();
        if (goal === null) continue;
        const from = { x: s[0] + 0.3 + 0.4 * r(), y: 64, z: s[2] + 0.3 + 0.4 * r() };
        const out = check(w, area(12, 50, 75), from, goal, options);
        if (out === null) continue;
        paths++;
        if (out !== '') failures.push(`seed ${seed} ${out}`);
      }
    }
    expect(paths).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  }, 60_000);
});
