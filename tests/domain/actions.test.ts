import { describe, expect, it } from 'vitest';
import {
  ACTION_TYPES,
  ActionSchema,
  ActionSpecSchema,
  createAction,
  expectedPostconditionFor,
  type ActionSpec,
} from '../../src/domain/actions.ts';
import {
  fallsWhenPlaced,
  PLACEABLE_BLOCKS,
  PLACEABLE_ITEMS,
  placedBlockOf,
} from '../../src/domain/blocks.ts';
import { GameStateSchema } from '../../src/domain/game-state.ts';
import { makeState } from '../fixtures/index.ts';

const deps = { newId: (p: string) => `${p}_0001`, now: () => new Date('2026-01-01T00:00:00.000Z') };

const oneOfEach: ActionSpec[] = [
  { type: 'OBSERVE_STATE', args: {} },
  { type: 'MOVE_TO', args: { target: { x: 1, y: 64, z: 1 }, tolerance: 1 } },
  { type: 'EXPLORE', args: { toward: 'south_west', maxDistance: 64 } },
  { type: 'WAIT', args: { durationMs: 1000 } },
  { type: 'EAT_FOOD', args: { item: 'minecraft:bread' } },
  { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: 'home' } },
  { type: 'OPEN_CONTAINER', args: { containerId: 'chest.main' } },
  {
    type: 'DEPOSIT_ITEM',
    args: { containerId: 'chest.main', item: 'minecraft:dirt', quantity: 1 },
  },
  {
    type: 'WITHDRAW_ITEM',
    args: { containerId: 'chest.main', item: 'minecraft:dirt', quantity: 1 },
  },
  { type: 'INSPECT_MACHINE', args: { machineId: 'm1' } },
  {
    type: 'REFUEL_KNOWN_GENERATOR',
    args: { generatorId: 'g1', fuelItem: 'minecraft:coal', quantity: 1 },
  },
  { type: 'DIG_BLOCK', args: { position: { x: -8, y: 200, z: -11 } } },
  {
    type: 'PLACE_BLOCK',
    args: { position: { x: -8, y: 201, z: -11 }, item: 'minecraft:planks@2' },
  },
  { type: 'CRAFT_ITEM', args: { recipe: 'chest', times: 2, craftingTableId: 'table.main' } },
  { type: 'INTERACT_BLOCK', args: { position: { x: -6, y: 200, z: -9 } } },
  {
    type: 'SMELT',
    args: {
      position: { x: -6, y: 200, z: -9 },
      input: 'minecraft:cobblestone',
      quantity: 8,
      fuel: 'minecraft:planks',
      fuelQuantity: 6,
    },
  },
  {
    type: 'TAKE_OUTPUT',
    args: { position: { x: -6, y: 200, z: -9 }, item: 'minecraft:stone' },
  },
  { type: 'PAUSE_AND_ASK_USER', args: { question: 'ok?' } },
  { type: 'SUBMIT_QUEST', args: { questId: '-2157870659866113684:-8191827436027574183' } },
  { type: 'CHECK_QUEST_BOX', args: { questId: '0:4', taskIndex: 0 } },
  { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: 1 } },
];

describe('action model', () => {
  it('covers exactly the allowlist', () => {
    expect(oneOfEach.map((s) => s.type).sort()).toEqual([...ACTION_TYPES].sort());
  });

  it('createAction attaches metadata and the code-derived postcondition', () => {
    for (const spec of oneOfEach) {
      const a = createAction({ spec, reason: 'r', origin: 'test', taskId: null }, deps);
      expect(a.actionId).toBe('act_0001');
      expect(a.expectedPostcondition).toEqual(expectedPostconditionFor(spec));
      expect(ActionSchema.safeParse(a).success).toBe(true);
    }
  });

  it.each([
    ['unknown type', { type: 'TELEPORT', args: {} }],
    ['extra field', { type: 'WAIT', args: { durationMs: 100, extra: 1 } }],
    ['wait too long', { type: 'WAIT', args: { durationMs: 3_600_000 } }],
    [
      'zero quantity',
      { type: 'DEPOSIT_ITEM', args: { containerId: 'c', item: 'minecraft:dirt', quantity: 0 } },
    ],
    ['bad item id', { type: 'EAT_FOOD', args: { item: 'bread; rm -rf /' } }],
    [
      'non-finite coordinate',
      { type: 'MOVE_TO', args: { target: { x: Infinity, y: 64, z: 0 }, tolerance: 1 } },
    ],
    [
      'huge refuel',
      {
        type: 'REFUEL_KNOWN_GENERATOR',
        args: { generatorId: 'g', fuelItem: 'minecraft:coal', quantity: 65 },
      },
    ],
    [
      'a dig at a point, not a block',
      { type: 'DIG_BLOCK', args: { position: { x: 1.5, y: 64, z: 0 } } },
    ],
    ['a dig above the world', { type: 'DIG_BLOCK', args: { position: { x: 1, y: 256, z: 0 } } }],
    [
      'a dig with extra args',
      { type: 'DIG_BLOCK', args: { position: { x: 1, y: 64, z: 0 }, radius: 3 } },
    ],
    [
      'breaking by another name',
      { type: 'BREAK_BLOCK', args: { position: { x: 1, y: 64, z: 0 } } },
    ],
    [
      'placing an item that is not on the allowlist',
      { type: 'PLACE_BLOCK', args: { position: { x: 1, y: 64, z: 0 }, item: 'minecraft:tnt' } },
    ],
    [
      'placing a block without saying which',
      { type: 'PLACE_BLOCK', args: { position: { x: 1, y: 64, z: 0 } } },
    ],
    [
      'placing at a point, not a cell',
      { type: 'PLACE_BLOCK', args: { position: { x: 1, y: 64.5, z: 0 }, item: 'minecraft:dirt' } },
    ],
    [
      'placing a planks type that does not exist',
      {
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 64, z: 0 }, item: 'minecraft:planks@6' },
      },
    ],
    [
      'unknown recipe',
      { type: 'CRAFT_ITEM', args: { recipe: 'diamond_pickaxe', times: 1, craftingTableId: null } },
    ],
    [
      'too many crafts',
      { type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 65, craftingTableId: null } },
    ],
    [
      'zero crafts',
      { type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 0, craftingTableId: null } },
    ],
    ['crafting without saying where', { type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 1 } }],
    ['a quest id that is not two longs', { type: 'SUBMIT_QUEST', args: { questId: '12' } }],
    [
      'a quest id half beyond 64 bits',
      { type: 'SUBMIT_QUEST', args: { questId: '0:9223372036854775808' } },
    ],
    ['a negative task index', { type: 'CHECK_QUEST_BOX', args: { questId: '0:4', taskIndex: -1 } }],
    ['a claim without saying the choice', { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5' } }],
    [
      'a forced (random) claim',
      { type: 'CLAIM_QUEST_REWARD', args: { questId: '0:5', choice: null, force: true } },
    ],
    ['exploring too far', { type: 'EXPLORE', args: { toward: 'north', maxDistance: 97 } }],
    ['exploring a few steps', { type: 'EXPLORE', args: { toward: 'north', maxDistance: 7 } }],
    ['an unknown direction', { type: 'EXPLORE', args: { toward: 'up', maxDistance: 32 } }],
    [
      'a point with a height',
      { type: 'EXPLORE', args: { toward: { x: 1, y: 70, z: 2 }, maxDistance: 32 } },
    ],
    [
      'a point beyond the world border',
      { type: 'EXPLORE', args: { toward: { x: 3e7 + 1, z: 0 }, maxDistance: 32 } },
    ],
    ['exploring without a limit', { type: 'EXPLORE', args: { toward: 'east' } }],
  ])('rejects %s', (_name, spec) => {
    expect(ActionSpecSchema.safeParse(spec).success).toBe(false);
    expect(() =>
      createAction({ spec: spec as ActionSpec, reason: 'r', origin: 'test', taskId: null }, deps),
    ).toThrow();
  });

  it('rejects an unknown origin', () => {
    const a = createAction(
      { spec: oneOfEach[0] as ActionSpec, reason: 'r', origin: 'test', taskId: null },
      deps,
    );
    expect(ActionSchema.safeParse({ ...a, origin: 'llm-direct' }).success).toBe(false);
  });

  it('PLACE_BLOCK expects the block the item becomes, and one item used', () => {
    expect(
      expectedPostconditionFor({
        type: 'PLACE_BLOCK',
        args: { position: { x: 1, y: 65, z: 2 }, item: 'minecraft:log2@1' },
      }),
    ).toEqual({
      kind: 'BLOCK_PLACED',
      position: { x: 1, y: 65, z: 2 },
      block: 'minecraft:log2',
      item: 'minecraft:log2@1',
    });
  });
});

describe('the place allowlist', () => {
  it('holds plain vanilla blocks only, each becoming a block of the same name', () => {
    for (const item of PLACEABLE_ITEMS) {
      expect(item.startsWith('minecraft:'), item).toBe(true);
      expect(placedBlockOf(item), item).toBe(item.replace(/@\d+$/, ''));
    }
    expect([...new Set(PLACEABLE_ITEMS.map(placedBlockOf))].sort()).toEqual(
      [...PLACEABLE_BLOCKS].sort(),
    );
  });

  it('knows which of them fall', () => {
    expect(PLACEABLE_ITEMS.filter(fallsWhenPlaced)).toEqual(['minecraft:sand', 'minecraft:gravel']);
  });

  it('every wood type, and nothing else, has a damage value', () => {
    expect(PLACEABLE_ITEMS.filter((i) => i.includes('@'))).toEqual([
      'minecraft:planks@1',
      'minecraft:planks@2',
      'minecraft:planks@3',
      'minecraft:planks@4',
      'minecraft:planks@5',
      'minecraft:log@1',
      'minecraft:log@2',
      'minecraft:log@3',
      'minecraft:log2@1',
    ]);
  });
});

describe('game state schema', () => {
  it('accepts a mock observation and rejects extra fields', () => {
    const state = makeState();
    expect(GameStateSchema.safeParse(state).success).toBe(true);
    expect(GameStateSchema.safeParse({ ...state, surprise: true }).success).toBe(false);
  });

  it('represents unobservable values explicitly', () => {
    const state = makeState((w) => {
      w.unobservable = ['health'];
    });
    expect(state.player.health).toEqual({ known: false, reason: 'mock: health hidden' });
    expect(state.power.availableEUt.known).toBe(false);
  });

  it('reads a snapshot stored before nearbyBlocks existed as "nearby blocks unknown"', () => {
    const older: Record<string, unknown> = { ...makeState() };
    delete older['nearbyBlocks'];
    const parsed = GameStateSchema.parse(older);
    expect(parsed.nearbyBlocks).toEqual({
      known: false,
      reason: 'not reported by this observation',
    });
  });

  it('reads a snapshot stored before questBook existed as "quest book unknown"', () => {
    const older: Record<string, unknown> = { ...makeState() };
    delete older['questBook'];
    expect(GameStateSchema.parse(older).questBook).toEqual({
      known: false,
      reason: 'not reported by this observation',
    });
  });

  it('reads a snapshot stored before placing as "nothing placeable, nothing placed"', () => {
    const state = makeState();
    if (!state.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const value: Record<string, unknown> = { ...state.nearbyBlocks.value };
    delete value['placeable'];
    delete value['placed'];
    const parsed = GameStateSchema.parse({ ...state, nearbyBlocks: { known: true, value } });
    expect(parsed.nearbyBlocks).toMatchObject({
      known: true,
      value: { placeable: [], placed: [] },
    });
  });

  it('lists only allowlisted blocks as placed blocks', () => {
    const state = makeState();
    if (!state.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const withChest = {
      ...state,
      nearbyBlocks: {
        known: true,
        value: {
          ...state.nearbyBlocks.value,
          placed: [{ block: 'minecraft:chest', position: { x: 0, y: 64, z: 0 } }],
        },
      },
    };
    expect(GameStateSchema.safeParse(withChest).success).toBe(false);
  });

  it('lists only allowlisted blocks as diggable resources', () => {
    const state = makeState();
    if (!state.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const withStone = {
      ...state,
      nearbyBlocks: {
        known: true,
        value: {
          ...state.nearbyBlocks.value,
          resources: [{ block: 'minecraft:stone', position: { x: 0, y: 64, z: 0 } }],
        },
      },
    };
    expect(GameStateSchema.safeParse(withStone).success).toBe(false);
  });
});
