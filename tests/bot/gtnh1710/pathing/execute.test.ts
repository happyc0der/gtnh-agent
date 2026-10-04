import { describe, expect, it } from 'vitest';
import { deepWaterDive } from '../../../../src/bot/gtnh1710/pathing/costs.ts';
import {
  planExecution,
  surfacing,
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
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
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

/**
 * A wall of stone at x = 2, four high (y 64-67), with a ladder up its west face at x = 1
 * (metadata 4: the ladder's slab on the east edge of its cell, against the wall): its top at
 * y = 67, the ledge on the wall's top at feet level 68.
 */
const ladderWorld = (): TestWorld => {
  const w = new TestWorld().fill({ x: 2, y: 64, z: 0 }, { x: 2, y: 67, z: 0 }, B.stone);
  for (let y = 64; y <= 67; y++) w.set(1, y, 0, B.ladder, 4);
  return w;
};

/**
 * A calm lake four deep (water y 60-63, its floor's top at 60) between banks of grass at 63
 * (feet 64): x 1-5, z -3..3. With `shallows`, its edge rows x = 1 and x = 5 are one deep.
 * `bank` raises the west bank's top (feet bank + 1), for a drop in.
 */
const lakeWorld = (shallows = false, bank = 63): TestWorld => {
  const w = new TestWorld((x) => (x <= 0 ? bank : x <= 5 ? 59 : 63)).fill(
    { x: 1, y: 60, z: -3 },
    { x: 5, y: 63, z: 3 },
    B.water,
  );
  if (shallows) {
    w.fill({ x: 1, y: 60, z: -3 }, { x: 1, y: 62, z: 3 }, B.dirt);
    w.fill({ x: 5, y: 60, z: -3 }, { x: 5, y: 62, z: 3 }, B.dirt);
  }
  return w;
};
const LAKE: Fence = { min: { x: -4, y: 55, z: -4 }, max: { x: 10, y: 70, z: 4 } };
/** The water's surface in the lake (a source block is 8/9 full). */
const SURFACE = 63 + 8 / 9;
const kindsOf = (segments: readonly Segment[]): string[] =>
  segments.flatMap((x) => x.movement?.kind ?? []);

const seg = (segments: readonly Segment[], kind: string): Segment => {
  const s = segments.find((x) => x.movement?.kind === kind);
  if (s === undefined) throw new Error(`no ${kind}`);
  return s;
};

describe('execution plans', () => {
  it('climbs a ladder: onto its foot, up it centred in its column, off onto the ledge at its top', () => {
    const w = ladderWorld();
    // Only climbing gets up the wall in a strip one block wide.
    expect(planPath(w, STRIP, FROM, goalBlock(2, 68, 0)).status).toBe('none');
    const up = walk(w, STRIP, FROM, [2, 68, 0], { climb: true });
    expect(up.segments.flatMap((x) => x.movement?.kind ?? [])).toEqual([
      'traverse',
      'climbUp',
      'climbUp',
      'climbUp',
      'climbOff',
    ]);
    const climbing = up.steps.filter((x) => x.climb === true);
    // Up the column at its centre, never faster than a climbing client, off it on the ledge.
    expect(climbing.length).toBeGreaterThan(30);
    for (const [i, x] of climbing.entries()) {
      const prev = i === 0 ? null : climbing[i - 1];
      if (prev !== null && prev !== undefined) {
        expect(x.pos.y - prev.pos.y).toBeLessThanOrEqual(0.1176 + 1e-9);
      }
    }
    expect(up.steps.at(-1)).toMatchObject({ pos: { x: 2.5, y: 68, z: 0.5 }, onGround: true });
    // And down again: onto the ladder from the ledge, down it, off at its foot.
    const down = walk(w, STRIP, centre(2, 68, 0), [0, 64, 0], { climb: true });
    expect(down.segments.flatMap((x) => x.movement?.kind ?? [])).toEqual([
      'climbOn',
      'climbDown',
      'climbDown',
      'climbDown',
      'traverse',
    ]);
    expect(down.steps.at(-1)).toMatchObject({ pos: { x: 0.5, y: 64, z: 0.5 }, onGround: true });
  });

  it('climbs after any approach: the stop before a climb may leave a hair of motion', () => {
    // A stop keeps a 1e-7 spare to its end (BRAKING_SPARE), so the tick that stands still on
    // the centre can carry a few hundred-millionths of motion; a climb that wanted under 1e-9
    // refused these (found by fuzzing, 2026-10-04).
    for (const [len, x] of [
      [8, 0.32],
      [9, 0.3875],
      [10, 0.275],
    ] as const) {
      const w = new TestWorld().fill(
        { x: len + 1, y: 64, z: 0 },
        { x: len + 1, y: 67, z: 0 },
        B.stone,
      );
      for (let y = 64; y <= 67; y++) w.set(len, y, 0, B.ladder, 4);
      const fence: Fence = { min: { x: -8, y: 50, z: 0 }, max: { x: len + 6, y: 72, z: 0 } };
      const up = walk(w, fence, { x, y: 64, z: 0.5 }, [len + 1, 68, 0], { climb: true });
      expect(kindsOf(up.segments)).toContain('climbUp');
    }
  });

  it("from a ladder's foot onto the block it hangs on: climbing off, never a jump into its slab", () => {
    // An independent review (2026-10-04): a one-high ladder on a one-high block; a jump from
    // the ladder's foot onto the block was planned, and its steps hit the ladder's slab.
    const w = new TestWorld().set(2, 64, 0, B.stone).set(1, 64, 0, B.ladder, 4);
    const up = walk(w, STRIP, FROM, [2, 65, 0], { climb: true });
    expect(up.segments.flatMap((x) => x.movement?.kind ?? [])).toEqual(['traverse', 'climbOff']);
    expect(up.steps.at(-1)).toMatchObject({ pos: { x: 2.5, y: 65, z: 0.5 }, onGround: true });
  });

  it('gets off a ladder onto a floor beside it partway up, and back on from there', () => {
    // A ladder six high up a wall at x = 2 (y 64-69), and a ledge beside it at x = 0 whose
    // top is at feet level 68, partway up: the ladder goes on above it.
    const w = new TestWorld()
      .fill({ x: 2, y: 64, z: 0 }, { x: 2, y: 69, z: 0 }, B.stone)
      .set(0, 67, 0, B.stone);
    for (let y = 64; y <= 69; y++) w.set(1, y, 0, B.ladder, 4);
    const from = centre(-2, 64, 0);
    const off = walk(w, STRIP, from, [0, 68, 0], { climb: true });
    expect(off.segments.flatMap((x) => x.movement?.kind ?? []).slice(-5)).toEqual([
      'climbUp',
      'climbUp',
      'climbUp',
      'climbUp',
      'climbAcross',
    ]);
    expect(off.steps.at(-1)).toMatchObject({ pos: { x: 0.5, y: 68, z: 0.5 }, onGround: true });
    const on = walk(w, STRIP, centre(0, 68, 0), [-2, 64, 0], { climb: true });
    expect(on.segments.flatMap((x) => x.movement?.kind ?? []).slice(0, 5)).toEqual([
      'climbAcross',
      'climbDown',
      'climbDown',
      'climbDown',
      'climbDown',
    ]);
    // Across, the body never reaches the ladder's slab (x 1.875 to 2).
    for (const s of on.steps) expect(s.pos.x + 0.3).toBeLessThan(1.875);
  });

  it('a walk to the block the player stands on the edge of centres on that block', () => {
    // Its feet at x 1.1, over the hole at x 1, the box (0.3 each way) still on the block at x 0.
    const w = new TestWorld().set(1, 63, 0, B.air).set(1, 62, 0, B.air).set(1, 61, 0, B.air);
    const from = { x: 1.1, y: 64, z: 0.5 };
    const r = planPath(w, STRIP, from, goalBlock(0, 64, 0));
    expect(r).toMatchObject({ status: 'reached', start: { x: 0, y: 64, z: 0 }, movements: [] });
    const plan = planExecution(w, STRIP, from, r.movements, { start: r.start });
    expect(plan).toMatchObject({ ok: true, end: { x: 0.5, y: 64, z: 0.5 } });
    expect(validatePlan(w, STRIP, from, plan)).toMatchObject({ ok: true });
  });

  it('a climb step needs a ladder where the feet are, not one beside them', () => {
    const w = ladderWorld();
    const climb = (x: number, y: number): PathStep => ({
      pos: { x, y, z: 0.5 },
      onGround: false,
      sprint: false,
      jump: false,
      climb: true,
    });
    const plan = (x: number): ExecutionPlan => ({
      ok: true,
      ticks: 1,
      end: { x, y: 64.1176, z: 0.5 },
      segments: [
        {
          movement: null,
          start: { x, y: 64, z: 0.5 },
          breaks: [],
          steps: [climb(x, 64.1176)],
          places: [],
          fallback: null,
        },
      ],
    });
    // Up the column beside the ladder (x = 0): no ladder holds the feet there.
    expect(validatePlan(w, STRIP, centre(0, 64, 0), plan(0.5))).toMatchObject({
      ok: false,
      reason: 'a climb with no ladder where the feet are',
    });
    // Up the ladder's own column: a climb.
    expect(validatePlan(w, STRIP, centre(1, 64, 0), plan(1.5))).toMatchObject({ ok: true });
    // Faster across than a climbing client (motionX and Z clamped to 0.15): refused.
    const across = plan(1.5);
    const fast: ExecutionPlan = across.ok
      ? {
          ...across,
          segments: across.segments.map((s) => ({
            ...s,
            steps: [{ ...climb(1.5, 64.1176), pos: { x: 1.5, y: 64.1176, z: 0.3 } }],
          })),
        }
      : across;
    expect(validatePlan(w, STRIP, centre(1, 64, 0), fast)).toMatchObject({
      ok: false,
      reason: 'a climb of 0.2000 across',
    });
  });

  it('swims across a calm deep lake: in by a drop, afloat across, out up the far bank', () => {
    const w = lakeWorld();
    // Without water there is no way across.
    expect(planPath(w, LAKE, centre(-1, 64, 0), goalBlock(7, 64, 0)).status).toBe('none');
    const r = walk(w, LAKE, centre(-1, 64, 0), [7, 64, 0], { water: true });
    expect(kindsOf(r.segments)).toEqual([
      'traverse',
      'fall',
      'traverse',
      'traverse',
      'traverse',
      'traverse',
      'ascend',
      'traverse',
    ]);
    expect(r.segments.filter((s) => s.movement?.swim === true)).toHaveLength(6);
    // Afloat over the deep water, the feet stay in its top block, never above the height where
    // the body leaves the water (63.599), and the eyes (1.62 up) above the surface.
    const afloat = r.steps.filter((s) => s.pos.x > 1.5 && s.pos.x < 5.5);
    expect(afloat.length).toBeGreaterThan(30);
    for (const s of afloat) {
      expect(s.pos.y).toBeGreaterThanOrEqual(63);
      expect(s.pos.y).toBeLessThan(63.599);
      expect(s.pos.y + 1.62).toBeGreaterThan(SURFACE);
      expect(s.onGround).toBe(false);
    }
    // Jump is held only to stay up, never out of the water.
    expect(afloat.some((s) => s.jump)).toBe(true);
    expect(r.steps.at(-1)).toMatchObject({ pos: { x: 7.5, y: 64, z: 0.5 }, onGround: true });
  });

  it('stops afloat out on a lake, or standing in its shallows', () => {
    const afloat = walk(lakeWorld(), LAKE, centre(-1, 64, 0), [3, 63, 0], { water: true });
    const end = afloat.steps.at(-1);
    expect(end?.pos).toMatchObject({ x: 3.5, z: 0.5 });
    expect(end?.pos.y).toBeGreaterThanOrEqual(63);
    expect(end?.onGround).toBe(false);
    // One-deep at x = 5: it sinks onto the floor there and stands.
    const shallow = walk(lakeWorld(true), LAKE, centre(-1, 64, 0), [5, 63, 0], { water: true });
    expect(shallow.steps.at(-1)).toMatchObject({ pos: { x: 5.5, y: 63, z: 0.5 }, onGround: true });
  });

  it('starts afloat (a walk stopped on the lake), and dives in from a bank up to 5 high', () => {
    const r = walk(lakeWorld(), LAKE, { x: 3.3, y: 63.45, z: 0.6 }, [7, 64, 0], { water: true });
    expect(kindsOf(r.segments)).toEqual(['traverse', 'traverse', 'ascend', 'traverse']);
    for (const bank of [65, 67]) {
      const dive = walk(lakeWorld(false, bank), LAKE, centre(-1, bank + 1, 0), [7, 64, 0], {
        water: true,
      });
      expect(kindsOf(dive.segments).slice(0, 2)).toEqual(['traverse', 'fall']);
      // The fall ends back up in the lake's top block, before swimming on.
      const fall = seg(dive.segments, 'fall');
      expect(Math.floor((fall.steps.at(-1) as PathStep).pos.y)).toBe(63);
    }
  });

  it('starts under water by rising into the top block first, and afloat over one-deep water by sinking', () => {
    // Under water (a stop, a correction, a login there), at several depths: up, then on.
    for (const y of [60.2, 61.5, 62.9]) {
      const r = walk(lakeWorld(), LAKE, { x: 3.4, y, z: 0.6 }, [7, 64, 0], { water: true });
      const rise = r.segments[0]?.steps ?? [];
      expect(Math.floor((rise.at(-1) as PathStep).pos.y)).toBe(63);
      expect(kindsOf(r.segments).at(-2)).toBe('ascend');
    }
    // Afloat over the one-deep rim: it sinks onto the floor and wades on.
    const s = walk(lakeWorld(true), LAKE, { x: 1.5, y: 63.4, z: 0.5 }, [-1, 64, 0], {
      water: true,
    });
    expect(s.steps.some((x) => x.onGround && x.pos.y === 63)).toBe(true);
  });

  it('idle in or over deep water: swims up into its top block, or falls in first', () => {
    const w = lakeWorld();
    const top = (steps: PathStep[] | null): number => {
      const end = steps?.at(-1);
      if (end === undefined) throw new Error('no steps');
      return end.pos.y;
    };
    // Under water: up into the top block, rising.
    const up = surfacing(w, { x: 3.5, y: 60.7, z: 0.5 });
    expect(top(up)).toBeGreaterThanOrEqual(63);
    expect(top(up)).toBeLessThan(63.599);
    // Above it (a stop mid-fall): down into it, then up to its top block.
    expect(Math.floor(top(surfacing(w, { x: 3.5, y: 65.3, z: 0.5 })))).toBe(63);
    // Afloat in the top block already, or on dry land: nothing to do.
    expect(surfacing(w, { x: 3.5, y: 63.4, z: 0.5 })).toBeNull();
    expect(surfacing(w, { x: -1.5, y: 64, z: 0.5 })).toBeNull();
    // On the bank's edge with its centre over the lake (an independent review, 2026-10-04: it
    // "swam up" on the spot forever), or in the air beside the bank (it would land on it).
    expect(surfacing(w, { x: 1.1, y: 64, z: 0.5 })).toBeNull();
    expect(surfacing(w, { x: 1.1, y: 66.5, z: 0.5 })).toBeNull();
    // Higher above the water than any drop a path makes: not from there.
    expect(surfacing(w, { x: 3.5, y: 70.5, z: 0.5 })).toBeNull();
  });

  it('a dive goes deeper the higher the drop, and comes back up', () => {
    let last = -1;
    for (const h of [1, 2, 3, 5, 10, 20]) {
      const d = deepWaterDive(h);
      expect(d.depth).toBeGreaterThan(last);
      expect(d.ticks).toBeGreaterThan(h);
      last = d.depth;
    }
    // From one block up the feet barely dip under the top block; from ten, about four blocks.
    expect(deepWaterDive(1).depth).toBeLessThan(0.3);
    expect(deepWaterDive(10).depth).toBeGreaterThan(3.5);
  });

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

  it('a fall into one-deep water from 5 up is honest and safe', () => {
    const lake = new TestWorld((x) => (x >= 2 ? 58 : 63)).fill(
      { x: 2, y: 59, z: 0 },
      { x: 12, y: 59, z: 0 },
      B.water,
    );
    const { segments } = walk(lake, STRIP, FROM, [6, 59, 0], { water: true });
    const fall = seg(segments, 'fall');
    expect(fall.steps.at(-1)?.pos.y).toBe(59);
  });

  it('climbs out of one-deep water as a player does: swimming up against the bank until pushed up', () => {
    const { segments } = walk(poolWorld(), STRIP, FROM, [6, 60, 0], { water: true });
    const out = seg(segments, 'ascend');
    // Swimming up (jump held) while in the water, pressed against the bank (x = 4).
    expect(out.steps.some((s) => s.jump)).toBe(true);
    const bumps = out.steps.filter((s) => s.bump !== undefined);
    expect(bumps.length).toBeGreaterThan(0);
    for (const s of bumps) expect(s.pos.x + 0.3).toBeCloseTo(4, 9);
    // The water's push: a rise of about 0.3 (+ 0.04 swimming) in one tick after a bump.
    const rises = out.steps.map((s, i) => (i === 0 ? 0 : s.pos.y - out.steps[i - 1]!.pos.y));
    expect(Math.max(...rises)).toBeGreaterThan(0.3);
    expect(out.steps.at(-1)).toMatchObject({ onGround: true, pos: { y: 60 } });
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
});
