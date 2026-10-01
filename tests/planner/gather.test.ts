import { describe, expect, it } from 'vitest';
import type { MockResourceBlock, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import { DIGGABLE_BLOCKS, type DiggableBlock } from '../../src/domain/blocks.ts';
import type { Position } from '../../src/domain/common.ts';
import {
  chooseGatherAction,
  gatherDrops,
  givesSame,
  GATHER_MAX_ACTIONS,
  GATHER_MAX_MS,
  recordGatherAction,
  startGather,
  type GatherOptions,
  type GatherProgress,
  type GatherStep,
} from '../../src/planner/gather.ts';
import { PlanSchema, plannerResponseJsonSchema, type Plan } from '../../src/planner/plan-schema.ts';
import { validatePlan } from '../../src/planner/plan-validator.ts';
import { makeState, safetyCtx, T0 } from '../fixtures/index.ts';

// The mock player stands at (1, 64, 1): eyes at (1, 65.62, 1). Sand at (3, 64, 1) is 2.78
// from the eyes (within reach 4.5); sand at (8, 64, 1) is 7.6 away (a walk first).
const gather = (block: DiggableBlock = 'minecraft:sand', count = 4): GatherStep => ({
  type: 'GATHER',
  args: { block, count },
});
const sand = (x: number, y: number, z: number, standAt?: Position | null): MockResourceBlock => ({
  block: 'minecraft:sand',
  position: { x, y, z },
  ...(standAt === undefined ? {} : { standAt }),
});
const NOW = new Date(T0);

function setup(blocks: MockResourceBlock[], mutate: (w: MockWorld) => void = () => undefined) {
  const state = makeState((w) => {
    w.resourceBlocks = blocks;
    mutate(w);
  });
  return { state, progress: startGather(1, 0, gather(), state, NOW) };
}

/** Options whose check accepts everything (or refuses what `refuse` returns a reason for). */
function opts(
  refuse: (spec: ActionSpec, from: Position) => string | null = () => null,
  now = NOW,
): GatherOptions & { calls: Array<{ spec: ActionSpec; from: Position }> } {
  const calls: Array<{ spec: ActionSpec; from: Position }> = [];
  return {
    reach: 4.5,
    now,
    check: (spec, from) => {
      calls.push({ spec, from });
      return refuse(spec, from);
    },
    calls,
  };
}

describe('GATHER chooses each action in code, from the observation', () => {
  it('digs the nearest listed block of its kind within reach', () => {
    const { state, progress } = setup([
      { block: 'minecraft:dirt', position: { x: 2, y: 64, z: 1 } },
      sand(8, 64, 1, { x: 7.5, y: 64, z: 1.5 }),
      sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 }),
    ]);
    expect(chooseGatherAction(gather(), progress, state, opts())).toEqual({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 64, z: 1 } } },
      target: { x: 3, y: 64, z: 1 },
      walk: false,
      skip: [],
    });
  });

  it('walks to the stand spot of the nearest block out of reach (MOVE_TO, tolerance 0.5)', () => {
    const { state, progress } = setup([
      sand(12, 64, 1, { x: 11.5, y: 64, z: 1.5 }),
      sand(8, 64, 1, { x: 7.5, y: 64, z: 1.5 }),
    ]);
    const o = opts();
    expect(chooseGatherAction(gather(), progress, state, o)).toMatchObject({
      kind: 'act',
      spec: { type: 'MOVE_TO', args: { target: { x: 7.5, y: 64, z: 1.5 }, tolerance: 0.5 } },
      target: { x: 8, y: 64, z: 1 },
      walk: true,
    });
    // It asked about the dig from the stand spot first, then about the walk from here.
    expect(o.calls).toEqual([
      {
        spec: { type: 'DIG_BLOCK', args: { position: { x: 8, y: 64, z: 1 } } },
        from: { x: 7.5, y: 64, z: 1.5 },
      },
      {
        spec: { type: 'MOVE_TO', args: { target: { x: 7.5, y: 64, z: 1.5 }, tolerance: 0.5 } },
        from: { x: 1, y: 64, z: 1 },
      },
    ]);
  });

  it('digs what is within reach before walking, even to a nearer stand spot', () => {
    const { state, progress } = setup([
      sand(8, 64, 1, { x: 1.5, y: 64, z: 1.5 }),
      sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 }),
    ]);
    expect(chooseGatherAction(gather(), progress, state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 64, z: 1 } } },
    });
  });

  it('passes over blocks with no stand spot, skipped blocks, and blocks the check refuses', () => {
    const { state, progress } = setup([
      sand(2, 64, 1, null), // no stand spot: the client found nowhere to dig it from
      sand(2, 65, 1, { x: 1.5, y: 64, z: 1.5 }), // the check refuses it
      sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 }), // skipped earlier
      sand(3, 65, 1, { x: 2.5, y: 64, z: 1.5 }),
    ]);
    const skipped: GatherProgress = { ...progress, skipped: [{ x: 3, y: 64, z: 1 }] };
    const refuse = (spec: ActionSpec): string | null =>
      spec.type === 'DIG_BLOCK' && spec.args.position.y === 65 && spec.args.position.x === 2
        ? 'UNSAFE_DIG'
        : null;
    expect(chooseGatherAction(gather(), skipped, state, opts(refuse))).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 65, z: 1 } } },
    });
  });

  it('uses a block out of reach only with a stand spot (an adapter without them: within reach only)', () => {
    const { state, progress } = setup([sand(8, 64, 1), sand(3, 64, 1)]);
    expect(chooseGatherAction(gather(), progress, state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 64, z: 1 } } },
    });
    const far = setup([sand(8, 64, 1)]);
    expect(chooseGatherAction(gather(), far.progress, far.state, opts())).toEqual({
      kind: 'end',
      end: 'no-target',
      why: 'no minecraft:sand left in view to dig',
      skip: [],
    });
  });

  it('a walk that did not bring its block within reach is not repeated: the block is skipped', () => {
    const block = sand(8, 64, 1, { x: 7.5, y: 64, z: 1.5 });
    const { state, progress } = setup([block]);
    const walked: GatherProgress = {
      ...progress,
      last: { position: { x: 8, y: 64, z: 1 }, walk: true },
    };
    expect(chooseGatherAction(gather(), walked, state, opts())).toEqual({
      kind: 'end',
      end: 'no-target',
      why: 'no minecraft:sand left in view to dig',
      skip: [{ x: 8, y: 64, z: 1 }],
    });
    // Standing on its stand spot already and still out of reach: the same.
    const there = setup([sand(8, 64, 1, { x: 1.2, y: 64, z: 1 })]);
    expect(chooseGatherAction(gather(), there.progress, there.state, opts())).toMatchObject({
      kind: 'end',
      skip: [{ x: 8, y: 64, z: 1 }],
    });
  });

  it('nothing it may dig: the step ends, saying why (the planner is asked again)', () => {
    const { state, progress } = setup([sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 })]);
    expect(
      chooseGatherAction(
        gather(),
        progress,
        state,
        opts(() => 'UNSAFE_DIG'),
      ),
    ).toEqual({
      kind: 'end',
      end: 'no-target',
      why: 'none of the 1 minecraft:sand in view can be dug now (nearest (3, 64, 1): UNSAFE_DIG)',
      skip: [],
    });
    const none = setup([{ block: 'minecraft:dirt', position: { x: 2, y: 64, z: 1 } }]);
    expect(chooseGatherAction(gather(), none.progress, none.state, opts())).toMatchObject({
      end: 'no-target',
      why: 'no minecraft:sand left in view to dig',
    });
  });
});

describe('GATHER ends', () => {
  it('when the inventory holds count more of what the block drops than at the start', () => {
    const blocks = [sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 })];
    const at = (items: Record<string, number>, startHeld = 0) => {
      const { state, progress } = setup(blocks, (w) => Object.assign(w.inventory.items, items));
      return chooseGatherAction(gather(), { ...progress, startHeld }, state, opts());
    };
    expect(at({ 'minecraft:sand': 3 })).toMatchObject({ kind: 'act' });
    expect(at({ 'minecraft:sand': 4 })).toMatchObject({ kind: 'end', end: 'done' });
    // What was held before the step does not count.
    expect(at({ 'minecraft:sand': 10 }, 8)).toMatchObject({ kind: 'act' });
    expect(at({ 'minecraft:sand': 12 }, 8)).toMatchObject({ kind: 'end', end: 'done' });
  });

  it('counts the drops, not the blocks: clay gives clay balls, grass gives dirt', () => {
    const clay = makeState((w) => {
      w.resourceBlocks = [{ block: 'minecraft:clay', position: { x: 3, y: 64, z: 1 } }];
      w.inventory.items['minecraft:clay_ball'] = 8;
    });
    const fresh = { ...startGather(1, 0, gather('minecraft:clay', 8), clay, NOW), startHeld: 4 };
    expect(chooseGatherAction(gather('minecraft:clay', 8), fresh, clay, opts())).toMatchObject({
      kind: 'act',
    });
    expect(chooseGatherAction(gather('minecraft:clay', 4), fresh, clay, opts())).toMatchObject({
      kind: 'end',
      end: 'done',
    });
    expect(gatherDrops('minecraft:grass')).toEqual(['minecraft:dirt']);
    expect(gatherDrops('minecraft:gravel')).toEqual(['minecraft:gravel']); // GTNH: gravel never drops flint
    expect(gatherDrops('minecraft:log')).toContain('minecraft:log@2');
    // Every block DIG_BLOCK may break has drops to count.
    for (const block of DIGGABLE_BLOCKS) expect(gatherDrops(block).length).toBeGreaterThan(0);
  });

  it('digs any listed block that gives the item: a GATHER of dirt digs the grass floor', () => {
    // Seen live: GATHER 8 dirt found "no-target" on a floor of grass.
    const grassy = makeState((w) => {
      w.resourceBlocks = [{ block: 'minecraft:grass', position: { x: 2, y: 64, z: 1 } }];
    });
    const fresh = startGather(1, 0, gather('minecraft:dirt', 8), grassy, NOW);
    expect(chooseGatherAction(gather('minecraft:dirt', 8), fresh, grassy, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 2, y: 64, z: 1 } } },
    });
    expect(givesSame('minecraft:grass', 'minecraft:dirt')).toBe(true);
    expect(givesSame('minecraft:sand', 'minecraft:dirt')).toBe(false);
  });

  it('at 64 actions or 5 minutes, for a checkpoint', () => {
    const { state, progress } = setup([sand(3, 64, 1, { x: 2.5, y: 64, z: 1.5 })]);
    expect(
      chooseGatherAction(gather(), { ...progress, actions: GATHER_MAX_ACTIONS }, state, opts()),
    ).toMatchObject({ kind: 'end', end: 'bound', why: 'its bound of 64 actions' });
    const later = new Date(NOW.getTime() + GATHER_MAX_MS);
    expect(
      chooseGatherAction(
        gather(),
        progress,
        state,
        opts(() => null, later),
      ),
    ).toMatchObject({
      kind: 'end',
      end: 'bound',
      why: 'its bound of 5 minutes',
    });
  });

  it('counts every action; a block whose action did not succeed is not tried again', () => {
    const { progress } = setup([]);
    const at = { x: 3, y: 64, z: 1 };
    const walked = recordGatherAction(progress, { target: at, walk: true }, true);
    expect(walked).toMatchObject({ actions: 1, dug: 0, skipped: [], last: { walk: true } });
    const dug = recordGatherAction(walked, { target: at, walk: false }, true);
    expect(dug).toMatchObject({ actions: 2, dug: 1, skipped: [] });
    const failed = recordGatherAction(dug, { target: at, walk: false }, false);
    expect(failed).toMatchObject({ actions: 3, dug: 1, skipped: [at] });
    expect(recordGatherAction(failed, { target: at, walk: false }, false).skipped).toEqual([at]);
  });
});

describe('GATHER in a plan', () => {
  const plan = (action: unknown): unknown => ({
    goal: 'Gather sand',
    steps: [{ step: 1, action, rationale: 'the route needs it' }],
    requiresUserApproval: false,
    explanation: 'One GATHER step.',
    failureHandling: { onStepFailure: 'REPLAN', maxRetriesPerStep: 1, escalationMessage: 'x' },
  });

  it('is a plan step: the schema takes a diggable block and a count of 1 to 256', () => {
    expect(PlanSchema.safeParse(plan(gather('minecraft:sand', 54))).success).toBe(true);
    expect(PlanSchema.safeParse(plan(gather('minecraft:log', 256))).success).toBe(true);
    for (const bad of [
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 0 } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 257 } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 1.5 } },
      { type: 'GATHER', args: { block: 'minecraft:stone', count: 4 } }, // not on DIG_BLOCK's list
      { type: 'GATHER', args: { block: 'minecraft:sand' } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 4, radius: 64 } },
    ]) {
      expect(PlanSchema.safeParse(plan(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    // Constrained decoding offers it, with the dig allowlist as its blocks.
    const schema = JSON.stringify(plannerResponseJsonSchema());
    expect(schema).toContain('"GATHER"');
  });

  it('validatePlan passes it; every action it becomes is checked when it runs', () => {
    expect(validatePlan(plan(gather('minecraft:sand', 54)), safetyCtx(), 8)).toMatchObject({
      ok: true,
      schemaIssues: [],
      stepViolations: [],
    });
    const mixed: Plan = PlanSchema.parse(plan(gather()));
    mixed.steps.push({
      step: 2,
      action: { type: 'EAT_FOOD', args: { item: 'minecraft:diamond' } },
      rationale: 'x',
    });
    // The other steps still get their static checks.
    const r = validatePlan(mixed, safetyCtx(), 8);
    expect(r.ok).toBe(false);
    expect(r.stepViolations.map((s) => s.step)).toEqual([2]);
    expect(r.stepViolations[0]?.violations.map((v) => v.code)).toContain('PROTECTED_ITEM');
  });
});
