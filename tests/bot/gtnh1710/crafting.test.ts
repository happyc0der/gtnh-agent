import { describe, expect, it } from 'vitest';
import {
  applyClick,
  type Stack,
  type WindowSnapshot,
} from '../../../src/bot/gtnh1710/container.ts';
import {
  applyTakeResult,
  gridEmpty,
  INVENTORY_GRID,
  placeRecipe,
  planClearGrid,
  planFill,
  planStoreCursor,
  planSyncClick,
  simulateCrafts,
  stackBounds,
  TABLE_GRID,
  windowDifferences,
  type CraftingLayout,
  type ItemKey,
  type PlacedRecipe,
} from '../../../src/bot/gtnh1710/crafting.ts';
import { craftingRecipe, RECIPES, type CraftingRecipe } from '../../../src/domain/recipes.ts';

// A tiny registry: vanilla 1.7.10 ids.
const IDS: Record<string, number> = {
  'minecraft:log': 17,
  'minecraft:planks': 5,
  'minecraft:stick': 280,
  'minecraft:coal': 263,
  'minecraft:torch': 50,
  'minecraft:chest': 54,
  'minecraft:flint': 318,
  'minecraft:crafting_table': 58,
  'minecraft:wooden_pickaxe': 270,
};
function resolve(name: string): ItemKey | null {
  const m = /^(.*?)(?:@(\d+))?$/.exec(name);
  const id = IDS[m?.[1] ?? ''];
  return id === undefined ? null : { id, damage: Number(m?.[2] ?? 0) };
}
const stack = (name: string, count: number, hasNbt = false): Stack => {
  const k = resolve(name);
  if (k === null) throw new Error(name);
  return { ...k, count, hasNbt };
};

/** A window laid out as `layout`, with the given player slots filled (absolute slot numbers). */
function win(layout: CraftingLayout, filled: Record<number, Stack>, cursor: Stack | null = null) {
  const size = layout.playerSlots[1] + 1 + (layout === INVENTORY_GRID ? 1 : 0);
  const slots: Array<Stack | null> = Array.from({ length: size }, () => null);
  for (const [i, s] of Object.entries(filled)) slots[Number(i)] = s;
  return { containerSlots: layout.playerSlots[0], slots, cursor } satisfies WindowSnapshot;
}

function placed(id: keyof typeof RECIPES, layout: CraftingLayout): PlacedRecipe {
  const p = placeRecipe(RECIPES[id], layout, resolve);
  if (!p.ok) throw new Error(p.reason);
  return p.value;
}

/** Replays clicks as the server applies them (container.ts is the server's slotClick). */
function replay(w: WindowSnapshot, clicks: ReadonlyArray<{ slot: number; button: 0 | 1 }>) {
  let cur = w;
  for (const c of clicks) {
    const r = applyClick(cur, c);
    if (!r.ok) throw new Error(r.reason);
    cur = r.window;
  }
  return cur;
}

describe('placing a recipe in the grid', () => {
  it('puts the pattern in the top-left corner, row by row', () => {
    expect(placed('torch_coal', INVENTORY_GRID).cells.map((c) => [c.slot, c.names])).toEqual([
      [1, ['minecraft:coal']],
      [3, ['minecraft:stick']],
    ]);
    const chest = placed('chest', TABLE_GRID);
    expect(chest.cells.map((c) => c.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(chest.cells[4]?.names).toEqual(['minecraft:flint']);
    expect(chest.expected).toEqual({ id: 54, damage: 0, count: 1, hasNbt: false });
  });

  it('keeps damage values exact, and lists every accepted variant', () => {
    const spruce = placed('planks_spruce', INVENTORY_GRID);
    expect(spruce.cells[0]?.accepts).toEqual([{ id: 17, damage: 1 }]);
    expect(spruce.expected).toMatchObject({ id: 5, damage: 1, count: 2 });
    // log2 is not in this registry: those variants are left out, the others stay.
    expect(placed('chest', TABLE_GRID).cells[0]?.accepts).toEqual([
      { id: 17, damage: 0 },
      { id: 17, damage: 1 },
      { id: 17, damage: 2 },
      { id: 17, damage: 3 },
    ]);
  });

  it('refuses a 3x3 pattern in the 2x2 grid, and names it cannot resolve', () => {
    expect(placeRecipe(RECIPES.chest, INVENTORY_GRID, resolve)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/chest is 3x3/) as string,
    });
    expect(placeRecipe(RECIPES.planks_acacia, INVENTORY_GRID, resolve)).toMatchObject({
      ok: false,
      reason: 'none of minecraft:log2 is in the item registry',
    });
  });
});

describe("placing the knowledge base's recipes", { timeout: 30_000 }, () => {
  /** GTNH's wooden pickaxe (any plankWood, any stickWood), as CRAFT_ITEM knows it. */
  const pickaxe = (): CraftingRecipe => {
    const r = craftingRecipe('minecraft:wooden_pickaxe#1');
    if (r === null) throw new Error('no pickaxe recipe');
    return r;
  };

  it('lays a 3x3 pattern out cell by cell at the table, with every kind its ore entry has', () => {
    const p = placeRecipe(pickaxe(), TABLE_GRID, resolve);
    if (!p.ok) throw new Error(p.reason);
    // aaa / .b. / .b.: slots 1-3, then 5 and 8.
    expect(p.value.cells.map((c) => c.slot)).toEqual([1, 2, 3, 5, 8]);
    expect(p.value.cells[0]?.label).toBe('ore:plankWood');
    // Only the kinds this registry names: of GTNH's 650 planks, vanilla's (the dump lists
    // minecraft:planks at every damage value it saw, 0-63).
    const planks = p.value.cells[0]?.accepts ?? [];
    expect(planks.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5].map((damage) => ({ id: 5, damage })));
    expect(planks.every((k) => k.id === 5)).toBe(true);
    expect(p.value.cells[3]?.accepts).toEqual([{ id: 280, damage: 0 }]);
    expect(p.value.expected).toEqual({ id: 270, damage: 0, count: 1, hasNbt: false });
    expect(placeRecipe(pickaxe(), INVENTORY_GRID, resolve)).toMatchObject({
      ok: false,
      reason: 'minecraft:wooden_pickaxe#1 is 3x3; the 2x2 inventory grid is smaller',
    });
  });

  it('fills it from any mix of accepted kinds, and names the ore entry when one runs out', () => {
    const p = placeRecipe(pickaxe(), TABLE_GRID, resolve);
    if (!p.ok) throw new Error(p.reason);
    const w = win(TABLE_GRID, {
      10: stack('minecraft:planks@4', 2),
      11: stack('minecraft:planks', 1),
      12: stack('minecraft:stick', 2),
    });
    const fill = planFill(w, TABLE_GRID, p.value);
    if (!fill.ok) throw new Error(fill.reason);
    expect([1, 2, 3, 5, 8].map((s) => fill.value.after.slots[s])).toEqual([
      stack('minecraft:planks@4', 1),
      stack('minecraft:planks@4', 1),
      stack('minecraft:planks', 1),
      stack('minecraft:stick', 1),
      stack('minecraft:stick', 1),
    ]);
    expect(replay(w, fill.value.clicks)).toEqual(fill.value.after);
    const noSticks = win(TABLE_GRID, { 10: stack('minecraft:planks', 3) });
    expect(planFill(noSticks, TABLE_GRID, p.value)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nothing left for ore:stickWood \(1 kind\)/) as string,
    });
  });
});

describe('filling the grid with predictable clicks', () => {
  it('picks a stack up, puts one item into each cell, and puts the rest back', () => {
    const w = win(INVENTORY_GRID, { 9: stack('minecraft:planks', 10) });
    const fill = planFill(w, INVENTORY_GRID, placed('sticks', INVENTORY_GRID));
    if (!fill.ok) throw new Error(fill.reason);
    expect(fill.value.clicks).toEqual([
      { slot: 9, button: 0 },
      { slot: 1, button: 1 },
      { slot: 3, button: 1 },
      { slot: 9, button: 0 },
    ]);
    expect(fill.value.after.slots[1]).toEqual(stack('minecraft:planks', 1));
    expect(fill.value.after.slots[3]).toEqual(stack('minecraft:planks', 1));
    expect(fill.value.after.slots[9]).toEqual(stack('minecraft:planks', 8));
    expect(fill.value.after.cursor).toBeNull();
    expect(replay(w, fill.value.clicks)).toEqual(fill.value.after);
  });

  it('takes from several stacks and kinds, never stacks with NBT data, leaves a used-up slot empty', () => {
    const w = win(TABLE_GRID, {
      10: stack('minecraft:log', 3, true), // NBT: never used
      11: stack('minecraft:log', 2),
      12: stack('minecraft:log@1', 2),
      13: stack('minecraft:planks', 4),
      14: stack('minecraft:flint', 1),
    });
    const fill = planFill(w, TABLE_GRID, placed('chest', TABLE_GRID));
    if (!fill.ok) throw new Error(fill.reason);
    const after = fill.value.after;
    expect(after.slots[10]).toEqual(stack('minecraft:log', 3, true));
    expect([after.slots[11], after.slots[12], after.slots[13], after.slots[14]]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(TABLE_GRID.gridSlots.every((g) => after.slots[g]?.count === 1)).toBe(true);
    expect(after.slots[5]).toEqual(stack('minecraft:flint', 1));
    expect(replay(w, fill.value.clicks)).toEqual(after);
  });

  it('refuses with a non-empty grid or cursor, or too few ingredients', () => {
    const torch = placed('torch_coal', INVENTORY_GRID);
    const ready = { 9: stack('minecraft:coal', 2), 10: stack('minecraft:stick', 2) };
    expect(
      planFill(
        win(INVENTORY_GRID, { ...ready, 2: stack('minecraft:coal', 1) }),
        INVENTORY_GRID,
        torch,
      ),
    ).toEqual({
      ok: false,
      reason: 'the crafting grid is not empty',
    });
    expect(
      planFill(win(INVENTORY_GRID, ready, stack('minecraft:coal', 1)), INVENTORY_GRID, torch),
    ).toEqual({
      ok: false,
      reason: 'the cursor is not empty',
    });
    expect(
      planFill(win(INVENTORY_GRID, { 9: stack('minecraft:coal', 2) }), INVENTORY_GRID, torch),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nothing left for minecraft:stick/) as string,
    });
  });
});

describe('taking the result', () => {
  it('puts the whole result on the cursor and takes one item from every grid slot', () => {
    const w = win(INVENTORY_GRID, {
      0: stack('minecraft:torch', 3),
      1: stack('minecraft:coal', 1),
      3: stack('minecraft:stick', 2),
    });
    const take = applyTakeResult(w, INVENTORY_GRID);
    if (!take.ok) throw new Error(take.reason);
    expect(take.claimed).toEqual(stack('minecraft:torch', 3));
    expect(take.window.cursor).toEqual(stack('minecraft:torch', 3));
    expect([take.window.slots[0], take.window.slots[1], take.window.slots[3]]).toEqual([
      null,
      null,
      stack('minecraft:stick', 1),
    ]);
  });

  it('refuses an empty result, a result with NBT data, or a full cursor', () => {
    expect(applyTakeResult(win(INVENTORY_GRID, {}), INVENTORY_GRID)).toMatchObject({ ok: false });
    expect(
      applyTakeResult(
        win(INVENTORY_GRID, { 0: stack('minecraft:torch', 3, true) }),
        INVENTORY_GRID,
      ),
    ).toMatchObject({ ok: false, reason: 'the crafting result has NBT data' });
    expect(
      applyTakeResult(
        win(INVENTORY_GRID, { 0: stack('minecraft:torch', 3) }, stack('minecraft:coal', 1)),
        INVENTORY_GRID,
      ),
    ).toMatchObject({ ok: false, reason: 'the cursor is not empty' });
  });

  it('stores the result in the first EMPTY slot, never on a stack', () => {
    const w = win(INVENTORY_GRID, { 9: stack('minecraft:torch', 3) }, stack('minecraft:torch', 3));
    expect(planStoreCursor(w, INVENTORY_GRID)).toEqual({
      ok: true,
      value: { slot: 10, button: 0 },
    });
    const full: Record<number, Stack> = {};
    for (let i = 9; i <= 44; i++) full[i] = stack('minecraft:coal', 1);
    expect(
      planStoreCursor(win(INVENTORY_GRID, full, stack('minecraft:torch', 3)), INVENTORY_GRID),
    ).toEqual({
      ok: false,
      reason: 'no empty inventory slot for the result',
    });
  });

  it('syncs with a click on an empty slot (player slots first, then the grid)', () => {
    expect(
      planSyncClick(win(INVENTORY_GRID, { 9: stack('minecraft:coal', 1) }), INVENTORY_GRID),
    ).toEqual({
      ok: true,
      value: { slot: 10, button: 0 },
    });
    const full: Record<number, Stack> = {};
    for (let i = 9; i <= 44; i++) full[i] = stack('minecraft:coal', 1);
    expect(planSyncClick(win(INVENTORY_GRID, full), INVENTORY_GRID)).toEqual({
      ok: true,
      value: { slot: 1, button: 0 },
    });
    expect(
      planSyncClick(win(INVENTORY_GRID, {}, stack('minecraft:coal', 1)), INVENTORY_GRID),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe('returning the grid and the cursor to the inventory', () => {
  it('merges back onto a stack of the same item within its proven size, else uses an empty slot', () => {
    const start = win(INVENTORY_GRID, { 9: stack('minecraft:planks', 10) });
    const bounds = stackBounds(start, INVENTORY_GRID);
    expect(bounds.get('5:0')).toBe(10);
    // After a fill: 8 left in slot 9, one in each of grid slots 1 and 3.
    const filled = win(INVENTORY_GRID, {
      9: stack('minecraft:planks', 8),
      1: stack('minecraft:planks', 1),
      3: stack('minecraft:planks', 1),
    });
    const clear = planClearGrid(filled, INVENTORY_GRID, bounds);
    if (!clear.ok) throw new Error(clear.reason);
    expect(clear.value.clicks).toEqual([
      { slot: 1, button: 0 },
      { slot: 9, button: 1 },
      { slot: 3, button: 0 },
      { slot: 9, button: 1 },
    ]);
    expect(clear.value.after.slots[9]).toEqual(stack('minecraft:planks', 10));
    expect(gridEmpty(clear.value.after, INVENTORY_GRID)).toBe(true);
    expect(replay(filled, clear.value.clicks)).toEqual(clear.value.after);
  });

  it('never merges past what a stack of that item has proven it can hold', () => {
    // The source stack (bound 2) is full again, so the returned item needs an empty slot.
    const w = win(
      INVENTORY_GRID,
      { 9: stack('minecraft:coal', 2), 1: stack('minecraft:coal', 1) },
      stack('minecraft:stick', 1),
    );
    const clear = planClearGrid(w, INVENTORY_GRID, new Map([['263:0', 2]]));
    if (!clear.ok) throw new Error(clear.reason);
    expect(clear.value.clicks).toEqual([
      { slot: 10, button: 0 }, // the stick on the cursor: no stick stack, so an empty slot
      { slot: 1, button: 0 },
      { slot: 11, button: 0 }, // the coal: 2 + 1 > 2, so an empty slot too
    ]);
  });

  it('says so when there is no room at all', () => {
    const full: Record<number, Stack> = { 1: stack('minecraft:coal', 1) };
    for (let i = 9; i <= 44; i++) full[i] = stack('minecraft:stick', 1);
    expect(planClearGrid(win(INVENTORY_GRID, full), INVENTORY_GRID, new Map())).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no room in the inventory/) as string,
    });
  });
});

describe('checking a whole action up front', () => {
  it('simulates every craft exactly, results in empty slots', () => {
    const w = win(INVENTORY_GRID, { 9: stack('minecraft:log', 3) });
    const sim = simulateCrafts(w, INVENTORY_GRID, placed('planks_oak', INVENTORY_GRID), 3);
    if (!sim.ok) throw new Error(sim.reason);
    // The used-up log slot takes the last result.
    expect(sim.value.after.slots.slice(9, 13)).toEqual([
      stack('minecraft:planks', 2),
      stack('minecraft:planks', 2),
      stack('minecraft:planks', 2),
      null,
    ]);
    expect(gridEmpty(sim.value.after, INVENTORY_GRID)).toBe(true);
  });

  it('refuses when ingredients or empty slots run out', () => {
    const logs = win(INVENTORY_GRID, { 9: stack('minecraft:log', 2) });
    expect(
      simulateCrafts(logs, INVENTORY_GRID, placed('planks_oak', INVENTORY_GRID), 3),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^craft 3 of 3: not enough ingredients/) as string,
    });
    const full: Record<number, Stack> = { 9: stack('minecraft:log', 5) };
    for (let i = 10; i <= 44; i++) full[i] = stack('minecraft:coal', 1);
    expect(
      simulateCrafts(
        win(INVENTORY_GRID, full),
        INVENTORY_GRID,
        placed('planks_oak', INVENTORY_GRID),
        1,
      ),
    ).toMatchObject({
      ok: false,
      reason: 'craft 1 of 1: no empty inventory slot for the result',
    });
  });

  it('compares the prediction with the server view slot by slot', () => {
    const a = win(INVENTORY_GRID, { 9: stack('minecraft:log', 3) });
    const b = win(INVENTORY_GRID, {
      0: stack('minecraft:planks', 2),
      9: stack('minecraft:log', 2),
    });
    expect(windowDifferences(a, b, new Set([0]))).toEqual([
      'slot 9: expected 3 x 17@0, server has 2 x 17@0',
    ]);
    expect(windowDifferences(a, { ...a, cursor: stack('minecraft:log', 1) })).toEqual([
      'cursor: expected empty, server has 1 x 17@0',
    ]);
  });
});
