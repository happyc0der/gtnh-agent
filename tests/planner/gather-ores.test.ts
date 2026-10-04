import { describe, expect, it } from 'vitest';
import type { MockResourceBlock, MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import type { ExplorationSummary } from '../../src/domain/world-memory.ts';
import {
  chooseGatherAction,
  gatherDrops,
  gatheredSoFar,
  GatherProgressSchema,
  givesSame,
  itemProblem,
  progressSource,
  sourceName,
  startGather,
  type GatherOptions,
  type GatherStep,
} from '../../src/planner/gather.ts';
import { PlanSchema } from '../../src/planner/plan-schema.ts';
import { rememberedPlacesOf, routeForPlanner } from '../../src/planner/planner-provider.ts';
import { makeState, T0 } from '../fixtures/index.ts';

const ORE = 'gregtech:gt.blockores';
// GT raw ores (gt.metaitem.03 at 5000 + the material id): iron 32, copper 35.
const RAW_IRON = 'gregtech:gt.metaitem.03@5032';
const RAW_COPPER = 'gregtech:gt.metaitem.03@5035';
const NOW = new Date(T0);

const ironOre = (count = 16): GatherStep => ({
  type: 'GATHER',
  args: { block: ORE, item: RAW_IRON, count },
});
const opts = (remembered: GatherOptions['remembered'] = []): GatherOptions => ({
  reach: 4.5,
  now: NOW,
  check: () => null,
  remembered,
});
const plan = (action: unknown): unknown => ({
  goal: 'Mine iron ore',
  steps: [{ step: 1, action, rationale: 'the route says so' }],
  requiresUserApproval: false,
  explanation: 'Code digs the ores one by one.',
  failureHandling: { onStepFailure: 'REPLAN', maxRetriesPerStep: 1, escalationMessage: 'x' },
});

// The mock player stands at (1, 64, 1).
function world(blocks: MockResourceBlock[], items: Record<string, number> = {}): GameState {
  return makeState((w: MockWorld) => {
    w.resourceBlocks = blocks;
    w.inventory.items = { 'TConstruct:pickaxe': 1, ...items };
  });
}

describe('GATHER for one drop of a block (a GT ore by its raw ore)', () => {
  it('the step names the item; only blocks that can drop it are dug, and only it counts', () => {
    expect(PlanSchema.safeParse(plan(ironOre())).success).toBe(true);
    for (const bad of [
      { type: 'GATHER', args: { block: ORE, item: 'raw iron ore', count: 16 } },
      { type: 'GATHER', args: { animal: 'minecraft:Cow', item: 'minecraft:leather', count: 3 } },
    ]) {
      expect(PlanSchema.safeParse(plan(bad)).success, JSON.stringify(bad)).toBe(false);
    }
    // A GT ore's drops are every Overworld ore's (the block does not say which ore it is).
    expect(gatherDrops(ORE)).toEqual(expect.arrayContaining([RAW_IRON, RAW_COPPER]));
    expect(gatherDrops({ block: ORE, item: RAW_IRON })).toEqual([RAW_IRON]);
    expect(gatherDrops({ block: 'minecraft:stone', item: RAW_IRON })).toEqual([]);
    expect(givesSame(ORE, { block: ORE, item: RAW_IRON })).toBe(true);
    expect(givesSame('minecraft:stone', { block: ORE, item: RAW_IRON })).toBe(false);
    // Stone drops cobblestone: a GATHER of cobblestone digs stone too.
    expect(givesSame('minecraft:stone', 'minecraft:cobblestone')).toBe(true);
    expect(
      givesSame('minecraft:stone', { block: 'minecraft:stone', item: 'minecraft:stone' }),
    ).toBe(false);
    expect(sourceName({ block: ORE, item: RAW_IRON })).toBe(`${ORE} for ${RAW_IRON}`);
    expect(itemProblem(ORE, RAW_IRON)).toBeNull();
    expect(itemProblem('minecraft:stone', RAW_IRON)).toBe(
      `minecraft:stone never drops ${RAW_IRON} (it drops minecraft:cobblestone)`,
    );
  });

  it('digs the GT ores in view whatever their ore, and counts only raw iron', () => {
    const state = world(
      [
        // Stone is nearer, but gives no raw iron.
        { block: 'minecraft:stone', position: { x: 2, y: 64, z: 1 } },
        { block: ORE, position: { x: 3, y: 65, z: 1 } },
      ],
      { [RAW_IRON]: 2, [RAW_COPPER]: 5 },
    );
    const progress = startGather(1, 0, ironOre(), state, NOW);
    expect(progress).toMatchObject({ block: ORE, item: RAW_IRON, startHeld: 2 });
    // The progress keeps the item between cycles (agent memory).
    const stored = GatherProgressSchema.parse(JSON.parse(JSON.stringify(progress)));
    expect(progressSource(stored)).toEqual({ block: ORE, item: RAW_IRON });
    expect(chooseGatherAction(ironOre(), progress, state, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 65, z: 1 } } },
    });
    // The ore turned out to be copper: nothing gathered yet. Then an iron one.
    const items = (more: Record<string, number>): GameState => ({
      ...state,
      inventory: state.inventory.known
        ? {
            known: true,
            value: {
              ...state.inventory.value,
              items: { ...state.inventory.value.items, ...more },
            },
          }
        : state.inventory,
    });
    expect(gatheredSoFar(progress, items({ [RAW_COPPER]: 6 }))).toBe(0);
    expect(gatheredSoFar(progress, items({ [RAW_COPPER]: 6, [RAW_IRON]: 3 }))).toBe(1);
  });

  it('passes ores the server says are of another material by; unknown ones come last', () => {
    // Materials as GregTech sends them (TileEntityOres.mMetaData): copper 35, iron 32; iron
    // in black granite 3032 (the stone adds 1000 x its kind); a small copper ore 16035.
    const state = world([
      { block: ORE, position: { x: 2, y: 64, z: 1 }, ore: 35 },
      { block: ORE, position: { x: 1, y: 65, z: 3 }, ore: 16035 },
      { block: ORE, position: { x: 3, y: 64, z: 2 } },
      { block: ORE, position: { x: 4, y: 64, z: 1 }, ore: 3032 },
    ]);
    expect(givesSame(ORE, { block: ORE, item: RAW_IRON }, 35)).toBe(false);
    expect(givesSame(ORE, { block: ORE, item: RAW_IRON }, 3032)).toBe(true);
    expect(givesSame(ORE, { block: ORE, item: RAW_COPPER }, 16035)).toBe(false);
    expect(givesSame(ORE, { block: ORE, item: RAW_IRON })).toBe(true);
    // The iron ore, though the copper ones and an ore of no known material are nearer.
    const progress = startGather(1, 0, ironOre(), state, NOW);
    expect(chooseGatherAction(ironOre(), progress, state, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 4, y: 64, z: 1 } } },
    });
    // With the iron ore gone, the one not known (it may be iron); never the copper ones.
    const rest = world([
      { block: ORE, position: { x: 2, y: 64, z: 1 }, ore: 35 },
      { block: ORE, position: { x: 3, y: 64, z: 2 } },
    ]);
    expect(chooseGatherAction(ironOre(), progress, rest, opts())).toMatchObject({
      kind: 'act',
      spec: { type: 'DIG_BLOCK', args: { position: { x: 3, y: 64, z: 2 } } },
    });
    const copperOnly = world([{ block: ORE, position: { x: 2, y: 64, z: 1 }, ore: 35 }]);
    expect(chooseGatherAction(ironOre(), progress, copperOnly, opts())).toMatchObject({
      kind: 'end',
      end: 'no-target',
    });
  });

  it('an item the block never drops ends the step at once, saying why', () => {
    const state = world([{ block: 'minecraft:stone', position: { x: 2, y: 64, z: 1 } }]);
    const step: GatherStep = {
      type: 'GATHER',
      args: { block: 'minecraft:stone', item: RAW_IRON, count: 4 },
    };
    expect(
      chooseGatherAction(step, startGather(1, 0, step, state, NOW), state, opts()),
    ).toMatchObject({
      kind: 'end',
      end: 'no-target',
      why: `minecraft:stone never drops ${RAW_IRON} (it drops minecraft:cobblestone)`,
    });
  });
});

/** World memory with one place of `resource` 40 blocks east of the player. */
const remembering = (resource: 'ore' | 'stone'): ExplorationSummary => ({
  chunksSeen: 12,
  directions: {
    north: { seen: 16, room: 240 },
    north_east: { seen: 16, room: 240 },
    east: { seen: 48, room: 240 },
    south_east: { seen: 16, room: 240 },
    south: { seen: 16, room: 240 },
    south_west: { seen: 16, room: 240 },
    west: { seen: 16, room: 240 },
    north_west: { seen: 16, room: 240 },
  },
  places: [
    {
      resource,
      x: 41,
      y: 58,
      z: 2,
      distance: 40,
      direction: 'east',
      count: 3,
      biome: 'Extreme Hills',
      seenMinutesAgo: 6,
    },
  ],
  biomes: [],
});

describe('ores and stone world memory remembers', () => {
  it('a GT ore (or emerald ore) GATHER heads for a remembered ore place; stone for stone', () => {
    const state = world([]);
    const ores = remembering('ore');
    expect(rememberedPlacesOf(ORE, state, ores)).toEqual([{ x: 41, y: 58, z: 2, distance: 40 }]);
    expect(rememberedPlacesOf('minecraft:emerald_ore', state, ores)).toHaveLength(1);
    expect(rememberedPlacesOf('minecraft:stone', state, ores)).toEqual([]);
    for (const stone of ['minecraft:stone', 'minecraft:mossy_cobblestone'] as const) {
      expect(rememberedPlacesOf(stone, state, remembering('stone'))).toHaveLength(1);
    }
    const remembered = rememberedPlacesOf(ORE, state, ores);
    expect(
      chooseGatherAction(
        ironOre(),
        startGather(1, 0, ironOre(), state, NOW),
        state,
        opts(remembered),
      ),
    ).toMatchObject({
      kind: 'act',
      spec: { type: 'EXPLORE', args: { toward: { x: 41.5, z: 2.5 }, maxDistance: 48 } },
      travel: true,
    });
  });

  it('the route to 16 raw iron ore: the GATHER that digs it, at the remembered ore place', () => {
    const needing = (items: Record<string, number>): GameState => {
      const state = world([], items);
      return {
        ...state,
        currentTask: {
          taskId: 'mine-iron',
          goal: 'Mine 16 iron ore',
          subgoal: null,
          status: 'active',
          requirements: { [RAW_IRON]: 16 },
        },
      };
    };
    // A Tinkers' pickaxe: its level is in its NBT data, so the route digs with it (unverified).
    const route = routeForPlanner(needing({ 'TConstruct:pickaxe': 1 }), remembering('ore'));
    const gather = route?.steps.find((s) => s.includes(`gather 16 ${RAW_IRON}`)) ?? '';
    expect(gather).toContain(`GATHER {"block":"${ORE}","item":"${RAW_IRON}"}`);
    expect(gather).toContain('remembered (Extreme Hills)');
    expect(gather).toContain('(41, 58, 2)');
    // With no pickaxe, the route says which level digs it (GT iron ore: level 2).
    const none = routeForPlanner(needing({}), remembering('ore'));
    expect(none?.steps.join(' ')).toMatch(/pickaxe level >= 2/);
  });
});
