import { describe, expect, it } from 'vitest';
import { CellCache } from '../../../../src/bot/gtnh1710/pathing/cells.ts';
import {
  physicsTick,
  planExecution,
  restingBody,
  type Body,
  type ExecutionPlan,
  type PathStep,
  type Segment,
} from '../../../../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../../../../src/bot/gtnh1710/pathing/goals.ts';
import { cacheBox, planPath } from '../../../../src/bot/gtnh1710/pathing/search.ts';
import { validatePlan } from '../../../../src/bot/gtnh1710/pathing/validate.ts';
import type { Fence, Vec3 } from '../../../../src/bot/gtnh1710/walking.ts';
import { area, B, centre, poolWorld, TestWorld } from '../fixtures/path-worlds.ts';

const FENCE: Fence = area(10, 50, 72);
const FROM = centre(0, 64, 0);

/** A plan of one segment with these steps (and breaks, places). */
function plan(steps: PathStep[], extra: Partial<Segment> = {}): ExecutionPlan {
  const segment: Segment = {
    movement: null,
    start: FROM,
    breaks: [],
    steps,
    places: [],
    fallback: null,
    ...extra,
  };
  return { ok: true, segments: [segment], ticks: steps.length, end: steps.at(-1)?.pos ?? FROM };
}

const step = (pos: Vec3, onGround = true, more: Partial<PathStep> = {}): PathStep => ({
  pos,
  onGround,
  sprint: false,
  jump: false,
  ...more,
});

/**
 * Real physics with chosen displacements (null: coasting, the motion carried over): honest
 * steps, whatever their outcome.
 */
function simulate(
  w: TestWorld,
  moves: Array<[number, number, boolean?] | null>,
  from = FROM,
): PathStep[] {
  const cells = new CellCache(w, cacheBox(FENCE));
  let b: Body = restingBody(from);
  return moves.map((move) => {
    const [mx, mz, jump] = move ?? [b.cx, b.cz, false];
    const next = physicsTick(cells, b, mx, mz, jump ?? false);
    if (next === null) throw new Error('blocked');
    b = next;
    return step({ x: b.x, y: b.y, z: b.z }, b.onGround, { jump: jump ?? false });
  });
}

const reasonOf = (w: TestWorld, p: ExecutionPlan, from = FROM): string => {
  const v = validatePlan(w, FENCE, from, p);
  return v.ok ? 'ok' : v.reason;
};

describe('the step validator', () => {
  it('passes honest walking', () => {
    const w = new TestWorld();
    const steps = simulate(w, [
      [0.098, 0],
      [0.15, 0],
      [0.18, 0],
      [0.19, 0],
      [0.1, 0],
      [0, 0],
    ]);
    expect(reasonOf(w, plan(steps))).toBe('ok');
  });

  it('catches moving faster than the keys allow: a teleport, a start at full speed', () => {
    const w = new TestWorld();
    expect(reasonOf(w, plan([step({ x: 1.5, y: 64, z: 0.5 })]))).toMatch(/changes by 1\.0000/);
    expect(reasonOf(w, plan([step({ x: 0.75, y: 64, z: 0.5 })]))).toMatch(
      /at most 0\.1000 on the ground/,
    );
    // Sprinting allows more, but not that much.
    expect(reasonOf(w, plan([step({ x: 0.62, y: 64, z: 0.5 }, true, { sprint: true })]))).toBe(
      'ok',
    );
  });

  it('catches hovering, a lie about onGround, and a jump from the air', () => {
    const w = new TestWorld();
    const up = simulate(w, [[0, 0, true]]);
    expect(reasonOf(w, plan(up))).toBe('ok');
    // Staying at the jump's height a tick (hovering).
    expect(reasonOf(w, plan([...up, step(up[0]!.pos, false)]))).toMatch(
      /the game's move takes them/,
    );
    expect(reasonOf(w, plan([step(FROM, false)]))).toMatch(/onGround is false/);
    const again = { ...up[0]!, pos: { ...up[0]!.pos, y: up[0]!.pos.y + 0.42 }, jump: true };
    expect(reasonOf(w, plan([...up, again]))).toMatch(/a jump from the air/);
  });

  it('catches a step into a block, past a hazard, out of the fence', () => {
    const wall = new TestWorld().set(1, 64, 0, B.stone);
    // 0.25 east puts the box's face 0.05 into the wall.
    expect(
      reasonOf(
        wall,
        plan(
          simulate(new TestWorld(), [
            [0.098, 0],
            [0.15, 0],
          ]),
        ),
      ),
    ).toMatch(/runs into a block/);
    const lava = new TestWorld().set(2, 63, 1, B.lava);
    expect(
      reasonOf(
        lava,
        plan(
          simulate(new TestWorld(), [
            [0.098, 0],
            [0.15, 0],
          ]),
        ),
      ),
    ).toMatch(/next to a hazard/);
    const edge = centre(10, 64, 0);
    expect(
      reasonOf(
        new TestWorld(),
        plan(
          simulate(
            new TestWorld(),
            [
              [0.098, 0],
              [0.15, 0],
            ],
            edge,
          ),
          { start: edge },
        ),
        edge,
      ),
    ).toMatch(/leaves the fence/);
  });

  it('catches a fall that hurts', () => {
    const cliff = new TestWorld((x) => (x >= 1 ? 59 : 63));
    // Off the edge, coasting, four blocks down.
    const moves: Array<[number, number] | null> = [
      [0.098, 0],
      [0.15, 0],
      [0.18, 0],
      [0.19, 0],
      [0.2, 0],
    ];
    for (let i = 0; i < 11; i++) moves.push(null);
    const steps = simulate(cliff, moves);
    expect(steps.at(-1)).toMatchObject({ onGround: true, pos: { y: 60 } });
    expect(reasonOf(cliff, plan(steps))).toMatch(/deals 1 fall damage/);
    // Three down is fine.
    const three = new TestWorld((x) => (x >= 1 ? 60 : 63));
    const safe = simulate(three, moves.slice(0, 15));
    expect(safe.at(-1)).toMatchObject({ onGround: true, pos: { y: 61 } });
    expect(reasonOf(three, plan(safe))).toBe('ok');
  });

  it('catches breaking the block underfoot, and placing a block into the body', () => {
    const w = new TestWorld();
    const under = plan([step(FROM)], { breaks: [{ cell: { x: 0, y: 63, z: 0 }, ticks: 5 }] });
    expect(reasonOf(w, under)).toMatch(/the block under the player/);
    const inBody = plan([step(FROM)], {
      places: [
        {
          cell: { x: 0, y: 64, z: 0 },
          against: { x: 0, y: 63, z: 0 },
          face: 1,
          cursor: { x: 8, y: 16, z: 8 },
          block: 'minecraft:dirt',
          afterStep: 0,
          neededBy: 1,
        },
      ],
    });
    expect(reasonOf(w, inBody)).toMatch(/inside the body/);
  });

  it('checks climbing out of water: a bump needs a block, the push up needs the bump', () => {
    const w = poolWorld();
    const fence: Fence = { min: { x: -8, y: 50, z: 0 }, max: { x: 12, y: 72, z: 0 } };
    const r = planPath(w, fence, FROM, goalBlock(6, 60, 0), { water: true });
    const p = planExecution(w, fence, FROM, r.movements, { water: true });
    expect(validatePlan(w, fence, FROM, p, { water: true })).toMatchObject({ ok: true });
    if (!p.ok) throw new Error(p.reason);
    const k = p.segments.findIndex((s) => s.movement?.kind === 'ascend');
    const exit = p.segments[k]!;
    const i = exit.steps.findIndex((s) => s.bump !== undefined);
    const alter = (steps: PathStep[]): ExecutionPlan => ({
      ...p,
      segments: p.segments.map((s, j) => (j === k ? { ...s, steps } : s)),
    });
    // The same step without its bump: the push up that follows has no cause.
    const bumped = exit.steps[i]!;
    const plain: PathStep = {
      pos: bumped.pos,
      onGround: bumped.onGround,
      sprint: bumped.sprint,
      jump: bumped.jump,
    };
    const noBump = exit.steps.map((s, j) => (j === i ? plain : s));
    expect(validatePlan(w, fence, FROM, alter(noBump), { water: true })).toMatchObject({
      ok: false,
    });
    // A bump claimed away from the bank.
    const wrongWay = exit.steps.map((s, j) => (j === i ? { ...s, bump: { x: -1, z: 0 } } : s));
    expect(validatePlan(w, fence, FROM, alter(wrongWay), { water: true })).toMatchObject({
      ok: false,
      reason: 'a bump against no block (X)',
    });
  });

  it('passes what the planner makes, and fails it on a world that changed since', () => {
    const w = new TestWorld();
    const r = planPath(w, FENCE, FROM, goalBlock(6, 64, 2));
    const p = planExecution(w, FENCE, FROM, r.movements);
    expect(validatePlan(w, FENCE, FROM, p)).toMatchObject({ ok: true });
    const changed = new TestWorld().fill({ x: 3, y: 64, z: -10 }, { x: 3, y: 64, z: 10 }, B.stone);
    expect(validatePlan(changed, FENCE, FROM, p)).toMatchObject({ ok: false });
  });
});
