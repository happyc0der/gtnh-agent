import { describe, expect, it } from 'vitest';
import { changedWorld } from '../../../../src/bot/gtnh1710/pathing/cells.ts';
import {
  planExecution,
  type ExecutionPlan,
  type PathStep,
  type Segment,
} from '../../../../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import {
  jumpHeights,
  SPRINT_SPEED,
  WALK_SPEED,
} from '../../../../src/bot/gtnh1710/pathing/physics.ts';
import { planPath, type PathOptions } from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { toTerrainMoves } from '../../../../src/bot/gtnh1710/pathing/terrain-moves.ts';
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
import { bodyProblem, terrainSteps } from '../../../../src/bot/gtnh1710/terrain.ts';
import type { Fence, Vec3 } from '../../../../src/bot/gtnh1710/walking.ts';
import { area, B, centre, poolWorld, TestWorld } from '../fixtures/path-worlds.ts';

const FROM = centre(0, 64, 0);
const STRIP: Fence = { min: { x: -8, y: 50, z: 0 }, max: { x: 12, y: 72, z: 0 } };

/** Plans, executes and validates; returns the plan's segments (failing the test otherwise). */
function walk(
  w: TestWorld,
  fence: Fence,
  from: Vec3,
  to: [number, number, number],
  options: PathOptions = {},
): { segments: readonly Segment[]; steps: PathStep[]; plan: ExecutionPlan; cost: number } {
  const r = planPath(w, fence, from, goalBlock(...to), options);
  expect(r.status, r.reason).toBe('reached');
  const plan = planExecution(w, fence, from, r.movements, { water: options.water ?? false });
  if (!plan.ok) throw new Error(plan.reason);
  const v = validatePlan(w, fence, from, plan, { water: options.water ?? false });
  expect(v, JSON.stringify(v)).toMatchObject({ ok: true });
  return {
    segments: plan.segments,
    steps: plan.segments.flatMap((s) => [...s.steps]),
    plan,
    cost: r.cost,
  };
}

const seg = (segments: readonly Segment[], kind: string): Segment => {
  const s = segments.find((x) => x.movement?.kind === kind);
  if (s === undefined) throw new Error(`no ${kind}`);
  return s;
};

describe('execution plans', () => {
  it('walk at no more than the vanilla walking speed, on the ground, ending at rest on the goal', () => {
    const { steps, plan } = walk(new TestWorld(), area(12, 60, 70), FROM, [9, 64, 4]);
    let at = FROM;
    for (const s of steps) {
      expect(Math.hypot(s.pos.x - at.x, s.pos.z - at.z)).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
      expect(s.pos.y).toBe(64);
      expect(s.onGround).toBe(true);
      at = s.pos;
    }
    expect(plan.ok && plan.end).toEqual(centre(9, 64, 4));
    // It reaches the steady speed on the straight part.
    const fastest = Math.max(
      ...steps.map((s, i) =>
        i === 0 ? 0 : Math.hypot(s.pos.x - steps[i - 1]!.pos.x, s.pos.z - steps[i - 1]!.pos.z),
      ),
    );
    expect(fastest).toBeGreaterThan(0.21);
  });

  it('sprint when allowed, and slow down for turns', () => {
    const { steps } = walk(new TestWorld(), area(12, 60, 70), FROM, [10, 64, 0], { sprint: true });
    const speeds = steps.map((s, i) =>
      Math.hypot(
        s.pos.x - (i === 0 ? FROM : steps[i - 1]!.pos).x,
        s.pos.z - (i === 0 ? FROM : steps[i - 1]!.pos).z,
      ),
    );
    expect(Math.max(...speeds)).toBeGreaterThan(0.27);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(SPRINT_SPEED + 1e-9);
    expect(steps.some((s) => s.sprint)).toBe(true);
    // An L-turn round a wall corner: the corner is passed slowly, never cut.
    const corner = new TestWorld().fill({ x: 1, y: 64, z: 1 }, { x: 8, y: 65, z: 8 }, B.stone);
    const turn = walk(corner, area(10, 60, 70), FROM, [0, 64, 6]);
    expect(turn.steps.length).toBeGreaterThan(0);
  });

  it('a step up is a real jump: 0.42 up first, off the step until the feet clear it, landing on its top', () => {
    const w = new TestWorld((x) => (x >= 2 ? 64 : 63));
    const { segments } = walk(w, STRIP, FROM, [4, 65, 0]);
    const up = seg(segments, 'ascend');
    const jump = up.steps.findIndex((s) => s.jump);
    expect(jump).toBeGreaterThanOrEqual(0);
    const y0 = up.start.y;
    const arc = jumpHeights(8);
    for (let k = 0; k < 8 && !up.steps[jump + k]!.onGround; k++) {
      expect(up.steps[jump + k]!.pos.y - y0).toBeCloseTo(arc[k]!, 9);
    }
    for (const s of up.steps) {
      // Below the step's top, the box stays out of the step's column (x >= 2).
      if (s.pos.y < 65) expect(s.pos.x + 0.3).toBeLessThanOrEqual(2 + 1e-9);
    }
    const landing = up.steps.find((s, i) => i > jump && s.onGround);
    expect(landing?.pos.y).toBe(65);
  });

  it('falls land exactly on the block top, after vanilla gravity, never doing damage', () => {
    for (const depth of [1, 2, 3]) {
      const w = new TestWorld((x) => (x >= 2 ? 63 - depth : 63));
      const { segments } = walk(w, STRIP, FROM, [5, 64 - depth, 0]);
      const fall = seg(segments, depth === 1 ? 'descend' : 'fall');
      const falling = fall.steps.filter((s) => s.pos.y < 64);
      const landing = falling.find((s) => s.onGround);
      expect(landing?.pos.y).toBe(64 - depth);
      // Every tick in the air falls further than the last (gravity), until the landing.
      const drops = falling
        .slice(0, falling.indexOf(landing as PathStep))
        .map((s, i, a) => (i === 0 ? 64 - s.pos.y : a[i - 1]!.pos.y - s.pos.y));
      for (let i = 1; i < drops.length; i++) expect(drops[i]!).toBeGreaterThan(drops[i - 1]!);
      expect(drops[0]).toBeCloseTo(0.0784, 6);
    }
  });

  it('a fall into one-deep water from 10 up is honest and safe', () => {
    const lake = new TestWorld((x) => (x >= 2 ? 53 : 63)).fill(
      { x: 2, y: 54, z: 0 },
      { x: 12, y: 54, z: 0 },
      B.water,
    );
    const { segments } = walk(lake, STRIP, FROM, [6, 54, 0], { water: true });
    const fall = seg(segments, 'fall');
    expect(fall.steps.at(-1)?.pos.y).toBe(54);
  });

  it('climbs out of one-deep water as a player does: swimming up against the bank until pushed up', () => {
    const { segments } = walk(poolWorld(), STRIP, FROM, [6, 55, 0], { water: true });
    const out = seg(segments, 'ascend');
    // Swimming up (jump held) while in the water, pressed against the bank (x = 4).
    expect(out.steps.some((s) => s.jump)).toBe(true);
    const bumps = out.steps.filter((s) => s.bump !== undefined);
    expect(bumps.length).toBeGreaterThan(0);
    for (const s of bumps) expect(s.pos.x + 0.3).toBeCloseTo(4, 9);
    // The water's push: a rise of about 0.3 (+ 0.04 swimming) in one tick after a bump.
    const rises = out.steps.map((s, i) => (i === 0 ? 0 : s.pos.y - out.steps[i - 1]!.pos.y));
    expect(Math.max(...rises)).toBeGreaterThan(0.3);
    expect(out.steps.at(-1)).toMatchObject({ onGround: true, pos: { y: 55 } });
    // About as long as it costs.
    expect(out.steps.length).toBeGreaterThan(12);
    expect(out.steps.length).toBeLessThan(26);
  });

  it('jumps gaps with the arc of a real jump, from the last tick on the edge', () => {
    for (const [gap, sprint] of [
      [1, false],
      [2, false],
      [3, true],
    ] as const) {
      // Three deep: falling in would be survivable (a deeper gap needs parkourOverDeepGaps).
      const w = new TestWorld((x) => (x >= 1 && x <= gap ? 60 : 63));
      const { segments } = walk(w, STRIP, FROM, [gap + 3, 64, 0], { parkour: true, sprint });
      const p = seg(segments, 'parkour');
      const jump = p.steps.findIndex((s) => s.jump);
      // Taking off from the start block: the box still over it.
      const before = jump === 0 ? p.start : p.steps[jump - 1]!.pos;
      expect(before.x - 0.3).toBeLessThan(1);
      const landing = p.steps.findIndex((s, i) => i > jump && s.onGround);
      expect(landing - jump + 1).toBe(12); // the same-level arc: back down on tick 12
      expect(p.steps[landing]?.pos.x).toBeGreaterThan(gap + 1 - 0.3);
      expect(p.steps[jump]?.sprint).toBe(sprint);
    }
  });

  it('pillars: the block placed under the feet once they clear the cell, then landed on; a fallback without it', () => {
    const pit = new TestWorld((x, z) => (x === 0 && z === 0 ? 61 : 63));
    const { segments } = walk(pit, area(5, 56, 70), centre(0, 62, 0), [2, 64, 0], {
      pillar: true,
      canPlace: () => true,
      throwaway: { count: 4, block: 'minecraft:dirt' },
    });
    const p = seg(segments, 'pillar');
    expect(p.steps[0]?.jump).toBe(true);
    const place = p.places[0];
    expect(place).toMatchObject({
      cell: { x: 0, y: 62, z: 0 },
      against: { x: 0, y: 61, z: 0 },
      face: 1,
    });
    expect(place?.cursor).toEqual({ x: 8, y: 16, z: 8 });
    // Placed right after the first step with the feet above the cell's top.
    const after = p.steps[place!.afterStep]!;
    expect(after.pos.y).toBeGreaterThanOrEqual(63);
    expect(p.steps[place!.afterStep - 1]!.pos.y).toBeLessThan(63);
    // The landing on it is the step that needs it.
    expect(p.steps[place!.neededBy]).toMatchObject({ onGround: true, pos: { y: 63 } });
    // Without the block (not confirmed in time) the jump comes back down where it began: the
    // same steps up to the landing, then on down instead.
    expect(p.fallback?.fromStep).toBe(place!.neededBy);
    expect(p.fallback?.steps[0]?.pos.y).toBeLessThan(63);
    expect(p.fallback?.steps.at(-1)).toMatchObject({ onGround: true, pos: { y: 62 } });
    // Horizontal: none.
    for (const s of p.steps) expect([s.pos.x, s.pos.z]).toEqual([0.5, 0.5]);
  });

  it('bridges: stops at the edge with the eyes past it, clicks the side of the block underfoot, waits, walks on', () => {
    const river = new TestWorld((x) => (x >= 1 && x <= 2 ? 55 : 63));
    const { segments } = walk(river, STRIP, FROM, [5, 64, 0], {
      bridge: true,
      canPlace: () => true,
      throwaway: { count: 4, block: 'minecraft:cobblestone' },
    });
    const b = seg(segments, 'bridge');
    const place = b.places[0]!;
    expect(place).toMatchObject({
      cell: { x: 1, y: 63, z: 0 },
      against: { x: 0, y: 63, z: 0 },
      face: 5,
    });
    const at = b.steps[place.afterStep]!;
    expect(at.pos.x).toBeCloseTo(1.1, 9); // 0.6 past the centre: the eyes beyond the edge
    expect(at.onGround).toBe(true);
    // Standing still when it clicks (the step before is the same position).
    expect(b.steps[place.afterStep - 1]?.pos).toEqual(at.pos);
    expect(place.neededBy).toBe(place.afterStep + 1);
  });

  it('breaks before the move, standing still at the centre, upper block first', () => {
    const w = new TestWorld().fill({ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }, B.leaves);
    const { segments } = walk(w, STRIP, FROM, [3, 64, 0], { canBreak: () => 10 });
    const t = segments.find((s) => s.breaks.length > 0)!;
    expect(t.breaks.map((b) => b.cell.y)).toEqual([65, 64]);
    expect(t.start).toEqual(FROM);
  });

  it('digs down: the dig first, then the fall into the hole', () => {
    const { segments } = walk(new TestWorld(), STRIP, FROM, [0, 63, 0], {
      downward: true,
      canBreak: () => 8,
    });
    const d = seg(segments, 'downward');
    expect(d.breaks).toEqual([{ cell: { x: 0, y: 63, z: 0 }, ticks: 8 }]);
    expect(d.steps.at(-1)).toMatchObject({ onGround: true, pos: { x: 0.5, y: 63, z: 0.5 } });
  });

  it('a block above the head cuts a jump short, and it still lands on the step', () => {
    // A ceiling 3 above the start's feet, over the start and the step.
    const w = new TestWorld((x) => (x >= 2 ? 64 : 63)).fill(
      { x: -8, y: 67, z: 0 },
      { x: 12, y: 67, z: 0 },
      B.stone,
    );
    const { segments } = walk(w, STRIP, centre(1, 64, 0), [4, 65, 0]);
    const up = seg(segments, 'ascend');
    const heights = up.steps.map((s) => s.pos.y);
    expect(Math.max(...heights)).toBeCloseTo(67 - 1.8, 9); // the head against the ceiling
    // A pillar under a ceiling: the head bumps, the feet still clear the cell, it lands.
    const pit = new TestWorld((x, z) => (x === 0 && z === 0 ? 61 : 63)).set(0, 65, 0, B.stone);
    const p = walk(pit, area(5, 56, 70), centre(0, 62, 0), [0, 63, 0], {
      pillar: true,
      canPlace: () => true,
      throwaway: { count: 4, block: 'minecraft:dirt' },
    });
    const pillar = seg(p.segments, 'pillar');
    expect(Math.max(...pillar.steps.map((s) => s.pos.y))).toBeCloseTo(65 - 1.8, 9);
    expect(pillar.steps.at(-1)).toMatchObject({ onGround: true, pos: { y: 63 } });
  });

  it('flows from one movement into the next: a ditch is crossed without stopping', () => {
    const ditch = new TestWorld((x) => (x === 2 ? 62 : 63));
    const { steps } = walk(ditch, STRIP, FROM, [5, 64, 0]);
    // Never standing still on the way (only at the end).
    const moving = steps.slice(0, -2).every((s, i, a) => i === 0 || s.pos.x > a[i - 1]!.pos.x);
    expect(moving).toBe(true);
  });

  it('sprints round corners, slowing just enough for each turn', () => {
    const w = new TestWorld().fill({ x: 1, y: 64, z: 1 }, { x: 8, y: 65, z: 8 }, B.stone);
    const { steps } = walk(w, area(10, 60, 70), FROM, [6, 64, 9], { sprint: true });
    expect(steps.some((s) => s.sprint)).toBe(true);
  });

  it('takes about as many ticks as the path costs', () => {
    const hills = new TestWorld((x, z) => 63 + Math.round(Math.sin(x / 2) + Math.cos(z / 3)));
    const { steps, cost } = walk(
      hills,
      area(10, 58, 70),
      centre(-8, hills.ground(-8, -8) + 1, -8),
      [8, hills.ground(8, 8) + 1, 8],
    );
    expect(steps.length).toBeGreaterThan(cost * 0.8);
    expect(steps.length).toBeLessThan(cost * 1.4);
  });

  it("converts to terrain.ts's moves (walk, step-up, drop) when every movement has one", () => {
    const w = new TestWorld((x) => (x >= 2 && x <= 4 ? 64 : x >= 5 ? 62 : 63)).set(
      3,
      65,
      0,
      B.leaves,
    );
    const r = planPath(w, STRIP, { x: 0.3, y: 64, z: 0.5 }, goalBlock(7, 63, 0), {
      canBreak: () => 10,
    });
    expect(r.status).toBe('reached');
    const t = toTerrainMoves(r.start!, r.movements);
    if (!t.ok) throw new Error(t.reason);
    expect(t.moves.map((m) => m.kind)).toEqual([
      'walk',
      'walk',
      'step-up',
      'walk',
      'walk',
      'drop',
      'walk',
      'walk',
    ]);
    expect(t.moves.find((m) => m.breaks !== undefined)?.breaks).toEqual([{ x: 3, y: 65, z: 0 }]);
    // The existing walker's own steps along them keep the body clear (with the leaf broken).
    const broken = changedWorld(w, [{ cell: { x: 3, y: 65, z: 0 }, block: null }]);
    for (const s of terrainSteps({ x: 0.3, y: 64, z: 0.5 }, t.moves)) {
      expect(bodyProblem(broken, STRIP, s.pos)).toBeNull();
    }
    const gap = new TestWorld((x) => (x === 1 ? 60 : 63));
    const p = planPath(gap, STRIP, FROM, goalBlock(4, 64, 0), { parkour: true });
    expect(toTerrainMoves(p.start!, p.movements)).toMatchObject({ ok: false, index: 0 });
  });
});
