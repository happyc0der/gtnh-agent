import { describe, expect, it } from 'vitest';
import {
  goalAny,
  goalAway,
  goalBlock,
  goalGetToBlock,
  goalNear,
  goalXZ,
  goalY,
} from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import type { Movement } from '../../../../src/bot/gtnh1710/pathing/movements.ts';
import {
  planPath,
  type PathOptions,
  type PathResult,
} from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { area, at, B, centre, poolWorld, TestWorld } from '../fixtures/path-worlds.ts';

const kinds = (r: PathResult): string[] => r.movements.map((m) => m.kind);
const breaks = (r: PathResult) => r.movements.flatMap((m) => m.breaks.map((b) => b.cell));
const FROM = centre(0, 64, 0);
const PLACING: PathOptions = {
  canPlace: () => true,
  throwaway: { count: 16, block: 'minecraft:cobblestone' },
};
/** A strip one block wide along x (z = 0): no way round anything. */
const STRIP = { min: { x: -8, y: 50, z: 0 }, max: { x: 12, y: 72, z: 0 } };

describe('the search', () => {
  it('walks flat ground in as few turns as the cheapest path allows', () => {
    const r = planPath(new TestWorld(), area(16, 60, 70), FROM, goalBlock(10, 64, 3));
    expect(r.status).toBe('reached');
    expect(r.stop).toBe('goal');
    expect(r.end).toEqual({ x: 10, y: 64, z: 3 });
    // 3 diagonal and 7 straight steps: one turn.
    expect(kinds(r)).toEqual([
      ...Array<string>(3).fill('diagonal'),
      ...Array<string>(7).fill('traverse'),
    ]);
    expect(r.cost).toBeCloseTo(7 * 4.6326 + 3 * 6.5515, 1);
  });

  it('climbs hills one block at a time and goes down them', () => {
    const stairs = new TestWorld((x) => 63 + Math.max(0, Math.min(5, x - 1)));
    const up = planPath(stairs, STRIP, FROM, goalBlock(7, 69, 0));
    expect(kinds(up)).toEqual(['traverse', ...Array<string>(5).fill('ascend'), 'traverse']);
    const down = planPath(stairs, STRIP, centre(7, 69, 0), goalBlock(0, 64, 0));
    expect(kinds(down).filter((k) => k === 'descend')).toHaveLength(5);
  });

  it('drops at most 3 blocks onto dry ground, deeper only into calm one-deep water', () => {
    for (const depth of [2, 3]) {
      const cliff = new TestWorld((x) => (x >= 2 ? 63 - depth : 63));
      const r = planPath(cliff, STRIP, FROM, goalBlock(5, 64 - depth, 0));
      expect(r.movements.find((m) => m.kind === 'fall')).toMatchObject({ drop: depth });
    }
    const deep = new TestWorld((x) => (x >= 2 ? 59 : 63));
    expect(planPath(deep, STRIP, FROM, goalBlock(5, 60, 0)).status).not.toBe('reached');
    // A lake one deep at the cliff's foot, from 10 blocks up (a height the server does not punish).
    const lake = new TestWorld((x) => (x >= 2 ? 53 : 63)).fill(
      { x: 2, y: 54, z: 0 },
      { x: 12, y: 54, z: 0 },
      B.water,
    );
    const into = planPath(lake, STRIP, FROM, goalBlock(6, 54, 0), { water: true });
    expect(into.status).toBe('reached');
    expect(into.movements.find((m) => m.kind === 'fall')).toMatchObject({ drop: 10, water: true });
    // From 4 up (the box skips the water's last 0.6 in one tick: a hit), never.
    const four = new TestWorld((x) => (x >= 2 ? 59 : 63)).fill(
      { x: 2, y: 60, z: 0 },
      { x: 12, y: 60, z: 0 },
      B.water,
    );
    const r4 = planPath(four, STRIP, FROM, goalBlock(6, 60, 0), { water: true });
    expect(r4.status).not.toBe('reached');
    // Without water allowed, never into it.
    expect(planPath(lake, STRIP, FROM, goalBlock(6, 54, 0)).status).not.toBe('reached');
  });

  it('jumps gaps of 1 and 2 walking, 3 sprinting, never 4', () => {
    const gap = (n: number) => new TestWorld((x) => (x >= 1 && x <= n ? 60 : 63));
    for (const n of [1, 2]) {
      const r = planPath(gap(n), STRIP, FROM, goalBlock(6, 64, 0), { parkour: true });
      expect(r.movements[0]).toMatchObject({ kind: 'parkour', gap: n, sprint: false });
    }
    expect(planPath(gap(3), STRIP, FROM, goalBlock(6, 64, 0), { parkour: true }).status).not.toBe(
      'reached',
    );
    const sprint = planPath(gap(3), STRIP, FROM, goalBlock(6, 64, 0), {
      parkour: true,
      sprint: true,
    });
    expect(sprint.movements[0]).toMatchObject({ kind: 'parkour', gap: 3, sprint: true });
    const four = planPath(gap(4), STRIP, FROM, goalBlock(7, 64, 0), {
      parkour: true,
      sprint: true,
    });
    expect(four.status).not.toBe('reached');
    // Without parkour a ditch one block deep is a descend into it and a climb out.
    const ditch = new TestWorld((x) => (x === 1 ? 62 : 63));
    expect(kinds(planPath(ditch, STRIP, FROM, goalBlock(6, 64, 0))).slice(0, 2)).toEqual([
      'descend',
      'ascend',
    ]);
  });

  it('jumps only gaps it would survive falling into, unless allowed', () => {
    const ravine = new TestWorld((x) => (x === 1 ? 52 : 63));
    expect(planPath(ravine, STRIP, FROM, goalBlock(4, 64, 0), { parkour: true }).status).not.toBe(
      'reached',
    );
    const r = planPath(ravine, STRIP, FROM, goalBlock(4, 64, 0), {
      parkour: true,
      parkourOverDeepGaps: true,
    });
    expect(r.movements[0]).toMatchObject({ kind: 'parkour', gap: 1 });
    // Never with lava down there.
    const lava = new TestWorld((x) => (x === 1 ? 61 : 63)).set(1, 61, 0, B.lava);
    expect(planPath(lava, STRIP, FROM, goalBlock(4, 64, 0), { parkour: true }).status).not.toBe(
      'reached',
    );
  });

  it('goes round a wall when that is not much longer, and breaks through when it is', () => {
    const wall = (gapAt: number) => {
      const w = new TestWorld();
      for (let z = -8; z <= 8; z++)
        if (z !== gapAt) w.fill({ x: 2, y: 64, z }, { x: 2, y: 65, z }, B.leaves);
      return w;
    };
    const leaves = { canBreak: () => 10 };
    const near = planPath(wall(2), area(8, 60, 70), FROM, goalBlock(5, 64, 0), leaves);
    expect(breaks(near)).toEqual([]);
    const far = planPath(wall(8), area(8, 60, 70), FROM, goalBlock(5, 64, 0), leaves);
    expect(breaks(far)).toEqual([
      { x: 2, y: 65, z: 0 },
      { x: 2, y: 64, z: 0 },
    ]);
    // A higher penalty makes the long way round win.
    const dear = planPath(wall(8), area(8, 60, 70), FROM, goalBlock(5, 64, 0), {
      ...leaves,
      penalties: { breakPenalty: 100 },
    });
    expect(breaks(dear)).toEqual([]);
  });

  it('never breaks next to a fluid, under sand or gravel, or the block it stands on', () => {
    const blocked = (w: TestWorld) =>
      planPath(w, STRIP, FROM, goalBlock(4, 64, 0), { canBreak: () => 5 });
    const wall = () => new TestWorld().fill({ x: 2, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }, B.dirt);
    // Breaking the upper block opens a step up onto the lower one: cheaper than both.
    const open = blocked(wall());
    expect(open.status).toBe('reached');
    expect(breaks(open)).toEqual([{ x: 2, y: 65, z: 0 }]);
    // Water beside the upper block: it would flow in.
    expect(blocked(wall().set(2, 65, 1, B.water)).status).not.toBe('reached');
    // Gravel on top of the wall: it would fall in.
    expect(blocked(wall().set(2, 66, 0, B.gravel)).status).not.toBe('reached');
    // Sand beside the upper block with nothing under it: the break would drop it.
    expect(blocked(wall().set(2, 65, 1, B.sand)).status).not.toBe('reached');
    // ...but sand standing on something is left alone.
    expect(blocked(wall().set(2, 65, 1, B.sand).set(2, 64, 1, B.dirt)).status).toBe('reached');
    // The floor is never broken to go down (only digging down, when allowed).
    const r = planPath(new TestWorld(), STRIP, FROM, goalBlock(0, 62, 0), { canBreak: () => 5 });
    expect(r.status).not.toBe('reached');
    const down = planPath(new TestWorld(), STRIP, FROM, goalBlock(0, 62, 0), {
      canBreak: () => 5,
      downward: true,
    });
    expect(kinds(down)).toEqual(['downward', 'downward']);
  });

  it('pillars out of a pit and bridges a river, with throwaway blocks', () => {
    const pit = new TestWorld((x, z) => (x === 0 && z === 0 ? 60 : 63));
    const out = planPath(pit, area(6, 56, 70), centre(0, 61, 0), goalBlock(3, 64, 0), {
      ...PLACING,
      pillar: true,
    });
    expect(kinds(out).slice(0, 3)).toEqual(['pillar', 'pillar', 'ascend']);
    const place = out.movements[1]?.place;
    expect(place).toMatchObject({
      cell: { x: 0, y: 62, z: 0 },
      against: { x: 0, y: 61, z: 0 },
      face: 1,
    });
    expect(planPath(pit, area(6, 56, 70), centre(0, 61, 0), goalBlock(3, 64, 0)).status).toBe(
      'none',
    );

    // Up through solid ground (the fence is the one column: no staircase), breaking the block
    // over the head before each jump: two pillars on, the feet are in a block the path broke,
    // which the world still shows and the next pillar fills.
    const rock = new TestWorld().fill(at(0, 55, 0), at(0, 56, 0), B.air);
    const column = { min: { x: 0, y: 50, z: 0 }, max: { x: 0, y: 70, z: 0 } };
    const up = planPath(rock, column, centre(0, 55, 0), goalY(64), {
      ...PLACING,
      pillar: true,
      canBreak: () => 5,
    });
    expect(up.status).toBe('reached');
    expect(kinds(up)).toEqual(Array<string>(9).fill('pillar'));
    expect(breaks(up).map((c) => c.y)).toEqual([57, 58, 59, 60, 61, 62, 63]);
    expect(up.movements.map((m) => m.place?.cell.y)).toEqual([55, 56, 57, 58, 59, 60, 61, 62, 63]);

    const river = new TestWorld((x) => (x >= 1 && x <= 3 ? 55 : 63));
    const across = planPath(river, STRIP, FROM, goalBlock(6, 64, 0), { ...PLACING, bridge: true });
    expect(kinds(across).slice(0, 3)).toEqual(['bridge', 'bridge', 'bridge']);
    expect(across.movements[0]?.place).toMatchObject({
      cell: { x: 1, y: 63, z: 0 },
      against: { x: 0, y: 63, z: 0 },
      face: 5, // the east side of the block underfoot
    });
    // Two blocks are not enough for three.
    const short = planPath(river, STRIP, FROM, goalBlock(6, 64, 0), {
      bridge: true,
      canPlace: () => true,
      throwaway: { count: 2, block: 'minecraft:cobblestone' },
    });
    expect(short.status).not.toBe('reached');
    expect(short.reason).toMatch(/placing at most 2 blocks/);
  });

  it('keeps away from lava and fire, and never steps next to them', () => {
    const w = new TestWorld().set(2, 63, 0, B.lava).set(2, 63, 1, B.lava).set(2, 63, -1, B.lava);
    const r = planPath(w, area(6, 60, 70), FROM, goalBlock(5, 64, 0));
    expect(r.status).toBe('reached');
    for (const m of r.movements) {
      for (const c of [m.from, m.to]) {
        expect(Math.abs(c.x - 2) > 1 || Math.abs(c.z) > 2, JSON.stringify(c)).toBe(true);
      }
    }
    expect(planPath(w, STRIP, FROM, goalBlock(5, 64, 0)).status).not.toBe('reached');
  });

  it('never walks into or next to unloaded chunks, and never leaves the area', () => {
    const w = new TestWorld().unload((x) => x >= 9);
    const r = planPath(w, area(16, 60, 70), FROM, goalBlock(14, 64, 0));
    expect(r.status).toBe('partial');
    // Not next to the unloaded columns either.
    expect(r.end?.x).toBe(7);
    const fenced = planPath(new TestWorld(), area(3, 60, 70), FROM, goalBlock(8, 64, 0));
    expect(fenced.status).toBe('none');
    expect(Math.max(...fenced.movements.map((m) => m.to.x), 0)).toBeLessThanOrEqual(3);
  });

  it('heads toward a goal beyond the area: a partial path to the best spot, and why', () => {
    const r = planPath(new TestWorld(), area(16, 60, 70), FROM, goalBlock(200, 64, 30));
    expect(r.status).toBe('partial');
    expect(r.stop).toBe('exhausted');
    expect(r.reason).toMatch(/cannot be reached inside the search area: a partial path/);
    expect(r.end?.x).toBe(16);
    // Too close to the start to be worth walking: none.
    const tight = planPath(new TestWorld(), area(2, 60, 70), FROM, goalBlock(200, 64, 0));
    expect(tight.status).toBe('none');
    expect(tight.reason).toMatch(/no spot 5 or more blocks away/);
  });

  it('stops at its node and time limits, with a partial path', () => {
    const goal = goalBlock(30, 64, 30);
    // On open ground the heuristic is tight: the search goes nearly straight there.
    const free = planPath(new TestWorld(), area(32, 60, 70), FROM, goal);
    expect(free.nodesExpanded).toBeLessThan(40);
    const nodes = planPath(new TestWorld(), area(32, 60, 70), FROM, goal, { maxNodes: 10 });
    expect(nodes).toMatchObject({ status: 'partial', stop: 'node-limit', nodesExpanded: 10 });
    expect(nodes.reason).toMatch(/limit of 10 nodes: a partial path/);
    // The clock is read every 128 nodes: a search over the whole area for a goal out of it.
    let t = 0;
    const slow = planPath(new TestWorld(), area(32, 60, 70), FROM, goalBlock(100, 64, 0), {
      maxTimeMs: 100,
      now: () => (t += 60),
    });
    expect(slow.stop).toBe('time-limit');
    expect(slow.reason).toMatch(/time limit of 100 ms/);
  });

  it('meets every kind of goal', () => {
    const w = new TestWorld((x) => (x >= 7 ? 65 : x >= 5 ? 64 : 63));
    const zone = area(10, 58, 72);
    const end = (g: Parameters<typeof planPath>[3]) => planPath(w, zone, FROM, g).end;
    expect(end(goalXZ(-6, 4))).toEqual({ x: -6, y: 64, z: 4 });
    expect(end(goalY(66))?.y).toBe(66);
    const near = end(goalNear({ x: -5.5, y: 64, z: -5.5 }, 2));
    expect(Math.hypot((near?.x ?? 0) + 0.5 + 5.5, (near?.z ?? 0) + 0.5 + 5.5)).toBeLessThanOrEqual(
      2,
    );
    const dig = end(goalGetToBlock({ x: 8, y: 66, z: 0 }));
    expect(dig).not.toBeNull();
    expect(
      Math.hypot((dig?.x ?? 0) - 8, (dig?.y ?? 0) + 1.62 - 66.5 + 0.5, (dig?.z ?? 0) - 0),
    ).toBeLessThan(5);
    expect(end(goalAny(goalBlock(9, 66, 9), goalBlock(-2, 64, -2)))).toEqual({
      x: -2,
      y: 64,
      z: -2,
    });
    const away = end(goalAway([{ x: 0.5, z: 0.5 }], 7));
    expect(Math.hypot(away?.x ?? 0, away?.z ?? 0)).toBeGreaterThanOrEqual(6.4);
  });

  it('refuses to start off a block top, inside a block, or outside the area', () => {
    const w = new TestWorld();
    expect(
      planPath(w, area(4, 60, 70), { x: 0.5, y: 64.3, z: 0.5 }, goalBlock(2, 64, 0)).reason,
    ).toMatch(/not on a block top/);
    const inWall = new TestWorld().set(1, 64, 0, B.stone);
    expect(
      planPath(inWall, area(4, 60, 70), { x: 0.85, y: 64, z: 0.5 }, goalBlock(-2, 64, 0)).reason,
    ).toMatch(/the body touches the block at \(1, 64, 0\)/);
    expect(planPath(w, area(4, 60, 70), centre(9, 64, 0), goalBlock(2, 64, 0)).reason).toMatch(
      /outside the search area/,
    );
    expect(
      planPath(w, area(4, 60, 70), FROM, goalBlock(2, 64, 0), {
        throwaway: { count: 3, block: 'minecraft:torch' },
      }).reason,
    ).toMatch(/not a block the walker stands on/);
  });

  it('caps the blocks broken per path', () => {
    const tunnel = new TestWorld();
    for (let x = 1; x <= 5; x++) tunnel.fill({ x, y: 64, z: 0 }, { x, y: 65, z: 0 }, B.leaves);
    const all = planPath(tunnel, STRIP, FROM, goalBlock(7, 64, 0), { canBreak: () => 2 });
    expect(breaks(all)).toHaveLength(10);
    const capped = planPath(tunnel, STRIP, FROM, goalBlock(7, 64, 0), {
      canBreak: () => 2,
      maxBreaks: 6,
    });
    expect(capped.status).not.toBe('reached');
    expect(capped.reason).toMatch(/breaking at most 6 blocks/);
  });

  it('wades through calm one-deep water when allowed, and around it otherwise', () => {
    // A trench two deep, with water one deep across it between dry stretches of the same level.
    const w = new TestWorld()
      .fill({ x: -8, y: 64, z: -8 }, { x: 12, y: 65, z: 8 }, B.stone)
      .fill({ x: -8, y: 64, z: 0 }, { x: 12, y: 65, z: 0 }, B.air)
      .fill({ x: 2, y: 64, z: 0 }, { x: 3, y: 64, z: 0 }, B.water);
    const dry = planPath(w, area(8, 60, 70), FROM, goalBlock(6, 64, 0));
    expect(dry.status).not.toBe('reached');
    const wet = planPath(w, area(8, 60, 70), FROM, goalBlock(6, 64, 0), { water: true });
    expect(wet.status).toBe('reached');
    expect(wet.movements.filter((m: Movement) => m.water).length).toBeGreaterThan(0);
  });

  it('falls into one-deep water and climbs out onto a bank one block higher', () => {
    // A 10-block cliff over a pool one deep (floor 53, water 54), a bank at 54 beyond it.
    const w = poolWorld();
    const r = planPath(w, STRIP, FROM, goalBlock(6, 55, 0), { water: true });
    expect(r.status).toBe('reached');
    expect(kinds(r)).toEqual(['fall', 'traverse', 'traverse', 'ascend', 'traverse', 'traverse']);
    expect(r.movements[0]).toMatchObject({ drop: 10, water: true });
    expect(r.movements[3]).toMatchObject({ water: true, to: { x: 4, y: 55, z: 0 } });
    // Without room above the water, no climbing out (and so no falling in).
    const low = poolWorld().set(3, 57, 0, B.stone);
    expect(planPath(low, STRIP, FROM, goalBlock(6, 55, 0), { water: true }).status).not.toBe(
      'reached',
    );
  });
});

describe('keeping away from hostile mobs (avoid)', () => {
  it('bends a walk around a mob where a detour costs less than walking past it', () => {
    // A zombie just beside the straight line from (0, 64, 0) to (16, 64, 0).
    const mob = { x: 8.5, y: 64, z: 1.5, radius: 4, coefficient: 1.5 };
    const straight = planPath(new TestWorld(), area(20, 60, 70), FROM, goalBlock(16, 64, 0));
    expect(straight.movements.every((m) => m.to.z === 0)).toBe(true);
    const r = planPath(new TestWorld(), area(20, 60, 70), FROM, goalBlock(16, 64, 0), {
      avoid: [mob],
    });
    expect(r.status).toBe('reached');
    // No feet block of the path within the mob's radius once it can keep out of it.
    const near = r.movements.filter(
      (m) => Math.hypot(m.to.x + 0.5 - mob.x, m.to.z + 0.5 - mob.z) <= mob.radius,
    );
    expect(near.length).toBeLessThan(
      straight.movements.filter(
        (m) => Math.hypot(m.to.x + 0.5 - mob.x, m.to.z + 0.5 - mob.z) <= mob.radius,
      ).length,
    );
    // The cost reported is the walk's real ticks (the avoidance only steers the search).
    expect(r.cost).toBeGreaterThan(straight.cost);
  });
});
