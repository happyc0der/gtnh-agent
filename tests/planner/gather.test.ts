import { describe, expect, it } from 'vitest';
import type { MockMob, MockResourceBlock, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import { DIGGABLE_BLOCKS, type DiggableBlock } from '../../src/domain/blocks.ts';
import type { Position } from '../../src/domain/common.ts';
import {
  chooseGatherAction,
  gatherDrops,
  givesSame,
  GATHER_MAX_ACTIONS,
  GATHER_MAX_MS,
  HUNT_TOLERANCE,
  HUNT_WALKS_PER_TARGET,
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
      entity: null,
      skip: [],
      skipEntities: [],
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
      skipEntities: [],
    });
  });

  it('says when blocks are in view but no walk reaches a spot to dig them from', () => {
    // Seen live: logs 7 blocks away behind leaf bushes ("none left" read as "look elsewhere").
    const { state, progress } = setup([sand(8, 64, 1, null), sand(9, 64, 1, null)]);
    expect(chooseGatherAction(gather(), progress, state, opts())).toEqual({
      kind: 'end',
      end: 'no-target',
      why:
        '2 minecraft:sand in view, but no walk from here reaches a spot to dig one from ' +
        '(walled in by leaves, plants or water, too high, or something would fall)',
      skip: [],
      skipEntities: [],
    });
  });

  it('a walk that did not bring its block within reach is not repeated: the block is skipped', () => {
    const block = sand(8, 64, 1, { x: 7.5, y: 64, z: 1.5 });
    const { state, progress } = setup([block]);
    const walked: GatherProgress = {
      ...progress,
      last: { position: { x: 8, y: 64, z: 1 }, walk: true, entity: null, walks: 0 },
    };
    expect(chooseGatherAction(gather(), walked, state, opts())).toEqual({
      kind: 'end',
      end: 'no-target',
      why: 'no minecraft:sand left in view to dig',
      skip: [{ x: 8, y: 64, z: 1 }],
      skipEntities: [],
    });
    // Standing on its stand spot already and still out of reach: the same.
    const there = setup([sand(8, 64, 1, { x: 1.2, y: 64, z: 1 })]);
    expect(chooseGatherAction(gather(), there.progress, there.state, opts())).toMatchObject({
      kind: 'end',
      skip: [{ x: 8, y: 64, z: 1 }],
      skipEntities: [],
    });
  });

  it('with none in view, heads for the nearest place world memory remembers it at', () => {
    // Seen live: GATHER gravel ended "no gravel left in view" with gravel remembered 92 blocks
    // south, and the planner, asked again, planned the same GATHER.
    const { state, progress } = setup([]);
    const near = { x: -50, y: 70, z: 0, distance: 51 };
    const far = { x: 28, y: 104, z: 107, distance: 106 };
    expect(
      chooseGatherAction(gather(), progress, state, { ...opts(), remembered: [near, far] }),
    ).toEqual({
      kind: 'act',
      spec: { type: 'EXPLORE', args: { toward: { x: -49.5, z: 0.5 }, maxDistance: 59 } },
      target: { x: -50, y: 70, z: 0 },
      walk: true,
      entity: null,
      travel: true,
      skip: [],
      skipEntities: [],
    });
    // A place it stands by already, with none in view, is gone: the next one (at most 96).
    const by = { x: 5, y: 64, z: 5, distance: 5.7 };
    expect(
      chooseGatherAction(gather(), progress, state, { ...opts(), remembered: [by, far] }),
    ).toMatchObject({
      kind: 'act',
      spec: { type: 'EXPLORE', args: { toward: { x: 28.5, z: 107.5 }, maxDistance: 96 } },
      skip: [{ x: 5, y: 64, z: 5 }],
    });
    // An EXPLORE the policy would refuse: the step ends, saying why.
    const refused = opts((spec) => (spec.type === 'EXPLORE' ? 'it is night' : null));
    expect(
      chooseGatherAction(gather(), progress, state, { ...refused, remembered: [near] }),
    ).toEqual({
      kind: 'end',
      end: 'no-target',
      why: 'no minecraft:sand left in view to dig (the one remembered at (-50, 70, 0): it is night)',
      skip: [],
      skipEntities: [],
    });
    // Once there, the block in view is dug as usual: the trip is not a walk to its stand spot.
    const arrived = setup([sand(8, 64, 1, { x: 7.5, y: 64, z: 1.5 })]);
    const travelled: GatherProgress = {
      ...arrived.progress,
      last: { position: { x: 8, y: 64, z: 1 }, walk: true, entity: null, walks: 1, travel: true },
    };
    expect(chooseGatherAction(gather(), travelled, arrived.state, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'MOVE_TO' },
      target: { x: 8, y: 64, z: 1 },
    });
    // The trip counts as an action, not a block dug.
    expect(
      recordGatherAction(progress, { target: far, walk: true, entity: null, travel: true }, true),
    ).toMatchObject({ actions: 1, dug: 0, last: { walk: true, travel: true } });
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
      skipEntities: [],
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

  it('a GATHER of a food garden digs any food garden, and counts any produce', () => {
    // Seen live: a GATHER of a stalk garden walked to the gardens world memory remembered,
    // which were gourd gardens, and ended "none left in view".
    expect(givesSame('harvestcraft:gourdgarden', 'harvestcraft:stalkgarden')).toBe(true);
    const produce = gatherDrops('harvestcraft:stalkgarden');
    for (const item of gatherDrops('harvestcraft:gourdgarden')) expect(produce).toContain(item);
    // Not across kinds: a garden is no sand.
    expect(givesSame('harvestcraft:gourdgarden', 'minecraft:sand')).toBe(false);
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
    const walked = recordGatherAction(progress, { target: at, walk: true, entity: null }, true);
    expect(walked).toMatchObject({ actions: 1, dug: 0, skipped: [], last: { walk: true } });
    const dug = recordGatherAction(walked, { target: at, walk: false, entity: null }, true);
    expect(dug).toMatchObject({ actions: 2, dug: 1, skipped: [] });
    const failed = recordGatherAction(dug, { target: at, walk: false, entity: null }, false);
    expect(failed).toMatchObject({ actions: 3, dug: 1, skipped: [at] });
    expect(
      recordGatherAction(failed, { target: at, walk: false, entity: null }, false).skipped,
    ).toEqual([at]);
  });
});

describe('GATHER of a farm animal: hunting it', () => {
  // The mock player stands at (1, 64, 1) with a bare hand: it strikes within 2.2 blocks, and
  // the step keeps 0.3 of that for the animal's moving.
  const hunt = (count = 3, animal: GatherStep['args'] = { animal: 'minecraft:Cow', count }) =>
    ({ type: 'GATHER', args: animal }) as GatherStep;
  const cow = (id: number, x: number, z: number, more: Partial<MockMob> = {}): MockMob => ({
    id,
    type: 'minecraft:Cow',
    category: 'passive',
    position: { x, y: 64, z },
    health: 10,
    ...more,
  });
  const herd = (mobs: MockMob[], mutate: (w: MockWorld) => void = () => undefined) => {
    const state = makeState((w) => {
      w.mobs = mobs;
      mutate(w);
    });
    return { state, progress: startGather(1, 0, hunt(), state, NOW) };
  };

  it('strikes the nearest cow within reach (ATTACK_ENTITY), else walks next to it', () => {
    const near = herd([cow(7, 6, 1), cow(8, 2.5, 1)]);
    expect(chooseGatherAction(hunt(), near.progress, near.state, opts())).toEqual({
      kind: 'act',
      spec: { type: 'ATTACK_ENTITY', args: { entityId: 8 } },
      target: { x: 2, y: 64, z: 1 },
      walk: false,
      entity: 8,
      skip: [],
      skipEntities: [],
    });
    const far = herd([cow(7, 6, 1)]);
    const o = opts();
    expect(chooseGatherAction(hunt(), far.progress, far.state, o)).toEqual({
      kind: 'act',
      spec: { type: 'MOVE_TO', args: { target: { x: 6, y: 64, z: 1 }, tolerance: HUNT_TOLERANCE } },
      target: { x: 6, y: 64, z: 1 },
      walk: true,
      entity: 7,
      skip: [],
      skipEntities: [],
    });
    // The strike is checked from where the walk ends, and the walk from here.
    expect(o.calls.map((c) => [c.spec.type, c.from])).toEqual([
      ['ATTACK_ENTITY', { x: 6, y: 64, z: 1 }],
      ['MOVE_TO', { x: 1, y: 64, z: 1 }],
    ]);
  });

  it('never hunts a calf, an owned animal, another kind, or one it passed over', () => {
    const { state, progress } = herd([
      cow(1, 2, 1, { baby: true }),
      cow(2, 2, 2, { owned: true }),
      { ...cow(3, 1, 2), type: 'minecraft:Pig' },
      cow(4, 3, 1),
    ]);
    expect(
      chooseGatherAction(hunt(), { ...progress, skippedEntities: [4] }, state, opts()),
    ).toMatchObject({
      kind: 'end',
      end: 'no-target',
      why: "no minecraft:Cow in view that may be hunted (grown and nobody's)",
    });
  });

  it('passes over a cow that keeps getting away after 3 walks in a row to it', () => {
    const { state, progress } = herd([cow(7, 6, 1)]);
    let p = progress;
    for (let i = 0; i < HUNT_WALKS_PER_TARGET; i++) {
      p = recordGatherAction(p, { target: { x: 6, y: 64, z: 1 }, walk: true, entity: 7 }, true);
    }
    expect(p.last).toMatchObject({ entity: 7, walk: true, walks: HUNT_WALKS_PER_TARGET });
    expect(chooseGatherAction(hunt(), p, state, opts())).toMatchObject({
      kind: 'end',
      why: 'the minecraft:Cow in view keep getting away (1 passed over)',
      skipEntities: [7],
    });
    // A strike in between starts the count again.
    const struck = recordGatherAction(
      p,
      { target: { x: 6, y: 64, z: 1 }, walk: false, entity: 7 },
      true,
    );
    expect(struck).toMatchObject({ dug: 1, last: { walks: 0 } });
  });

  it('ends, saying why, when the policy would not let it hunt now (too hungry to fight)', () => {
    const { state, progress } = herd([cow(7, 2.5, 1)]);
    const refused = opts((spec) => (spec.type === 'ATTACK_ENTITY' ? 'LOW_HUNGER' : null));
    expect(chooseGatherAction(hunt(), progress, state, refused)).toMatchObject({
      kind: 'end',
      end: 'no-target',
      why: 'none of the 1 minecraft:Cow in view can be hunted now (nearest minecraft:Cow 7: LOW_HUNGER)',
    });
  });

  it("counts the animal's drops, and an attack that failed passes that animal over", () => {
    const { progress } = herd([cow(7, 2.5, 1)], (w) => {
      w.inventory.items['minecraft:beef'] = 1;
    });
    expect(progress).toMatchObject({ animal: 'minecraft:Cow', startHeld: 1, skippedEntities: [] });
    expect(gatherDrops({ animal: 'minecraft:Cow' })).toEqual([
      'minecraft:beef',
      'minecraft:leather',
    ]);
    const after = makeState((w) => {
      w.mobs = [];
      w.inventory.items['minecraft:beef'] = 3;
      w.inventory.items['minecraft:leather'] = 1;
    });
    expect(chooseGatherAction(hunt(3), progress, after, opts())).toMatchObject({
      kind: 'end',
      end: 'done',
    });
    const failed = recordGatherAction(
      progress,
      { target: { x: 2, y: 64, z: 1 }, walk: false, entity: 7 },
      false,
    );
    expect(failed).toMatchObject({ skipped: [], skippedEntities: [7] });
  });
});

describe('GATHER of logs fells each trunk from its base', () => {
  // Seen live 2026-10-01: three logs dug, one picked up; the logs dug high in the trees, off
  // the player's column, dropped onto the logs and leaves under them, out of its reach. The
  // mock player stands at (1, 64, 1), eyes at (1, 65.62, 1); a trunk stands at (2, 2).
  const fell = (count = 4): GatherStep => gather('minecraft:log', count);
  const log = (x: number, y: number, z: number, standAt?: Position): MockResourceBlock => ({
    block: 'minecraft:log',
    position: { x, y, z },
    standAt: standAt ?? { x: x - 0.5, y: 64, z: z + 0.5 },
  });
  const trunk = (x: number, z: number, from: number, to: number): MockResourceBlock[] =>
    Array.from({ length: to - from + 1 }, (_, i) => log(x, from + i, z));
  function felling(blocks: MockResourceBlock[], last: GatherProgress['last'] = null) {
    const state = makeState((w) => {
      w.resourceBlocks = blocks;
    });
    return { state, progress: { ...startGather(1, 0, fell(), state, NOW), last } };
  }
  const dug = (x: number, y: number, z: number): NonNullable<GatherProgress['last']> => ({
    position: { x, y, z },
    walk: false,
    entity: null,
    walks: 0,
  });

  it('digs the lowest log of a trunk first, though the one above it is nearer the eyes', () => {
    const { state, progress } = felling(trunk(2, 2, 64, 66));
    expect(chooseGatherAction(fell(), progress, state, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 2, y: 64, z: 2 } } },
    });
    // Sand stacked the same way is dug nearest first, as before.
    const sandy = setup(trunk(2, 2, 64, 66).map((b) => ({ ...b, block: 'minecraft:sand' })));
    expect(chooseGatherAction(gather(), sandy.progress, sandy.state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 2, y: 65, z: 2 } } },
    });
  });

  it('then goes on up that trunk while it is in reach, before another trunk nearer the eyes', () => {
    // The base is dug; another trunk's base (0, 64, 0) is 1.3 from the eyes, the next log 2.1.
    const { state, progress } = felling(
      [...trunk(2, 2, 65, 66), ...trunk(0, 0, 64, 65)],
      dug(2, 64, 2),
    );
    expect(chooseGatherAction(fell(), progress, state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 2, y: 65, z: 2 } } },
    });
    // Once that trunk is down, the other one, from its base.
    const next = felling(trunk(0, 0, 64, 65), dug(2, 66, 2));
    expect(chooseGatherAction(fell(), next.progress, next.state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 0, y: 64, z: 0 } } },
    });
  });

  it('walks to beside a trunk first, though its log is in reach from here', () => {
    // (4, 64, 1) is 3.7 from the eyes, three columns away: its drop would land out of reach.
    const { state, progress } = felling([log(4, 64, 1, { x: 3.5, y: 64, z: 1.5 })]);
    expect(chooseGatherAction(fell(), progress, state, opts())).toMatchObject({
      spec: { type: 'MOVE_TO', args: { target: { x: 3.5, y: 64, z: 1.5 }, tolerance: 0.5 } },
      target: { x: 4, y: 64, z: 1 },
      walk: true,
    });
    // That walk made, it digs from where it ended.
    const walked: GatherProgress['last'] = { ...dug(4, 64, 1), walk: true, walks: 1 };
    expect(chooseGatherAction(fell(), { ...progress, last: walked }, state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 4, y: 64, z: 1 } } },
    });
    // Sand there is dug from here, as before.
    const sandy = setup([sand(4, 64, 1, { x: 3.5, y: 64, z: 1.5 })]);
    expect(chooseGatherAction(gather(), sandy.progress, sandy.state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 4, y: 64, z: 1 } } },
    });
  });

  it('a log on leaves (a branch) comes after a trunk, but is dug when none is left', () => {
    const leaves: MockResourceBlock = {
      block: 'minecraft:leaves',
      position: { x: 1, y: 66, z: 2 },
    };
    const branch = log(1, 67, 2);
    const { state, progress } = felling([leaves, branch, log(6, 64, 6)]);
    expect(chooseGatherAction(fell(), progress, state, opts())).toMatchObject({
      spec: { type: 'MOVE_TO', args: { target: { x: 5.5, y: 64, z: 6.5 } } },
      target: { x: 6, y: 64, z: 6 },
    });
    const alone = felling([leaves, branch]);
    expect(chooseGatherAction(fell(), alone.progress, alone.state, opts())).toMatchObject({
      spec: { type: 'DIG_BLOCK', args: { position: { x: 1, y: 67, z: 2 } } },
    });
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
    expect(PlanSchema.safeParse(plan(gather('harvestcraft:berrygarden', 6))).success).toBe(true);
    // Stone and ores: with a pickaxe (each dig is checked for one when it runs).
    expect(PlanSchema.safeParse(plan(gather('minecraft:stone', 64))).success).toBe(true);
    expect(PlanSchema.safeParse(plan(gather('gregtech:gt.blockores', 16))).success).toBe(true);
    const cows = { type: 'GATHER', args: { animal: 'minecraft:Cow', count: 3 } };
    expect(PlanSchema.safeParse(plan(cows)).success).toBe(true);
    for (const bad of [
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 0 } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 257 } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 1.5 } },
      { type: 'GATHER', args: { block: 'minecraft:obsidian', count: 4 } }, // not on DIG_BLOCK's list
      { type: 'GATHER', args: { block: 'minecraft:sand' } },
      { type: 'GATHER', args: { block: 'minecraft:sand', count: 4, radius: 64 } },
      // Only a farm animal, and never a block and an animal at once.
      { type: 'GATHER', args: { animal: 'minecraft:Zombie', count: 1 } },
      { type: 'GATHER', args: { animal: 'minecraft:Cow', block: 'minecraft:sand', count: 1 } },
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
