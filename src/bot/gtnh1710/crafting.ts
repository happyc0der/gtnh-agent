import type { CraftingRecipe } from '../../domain/recipes.ts';
import { applyClick, type Click, type Stack, type WindowSnapshot } from './container.ts';

/**
 * Crafting with the predictable clicks of container.ts, in the player's own 2x2 grid (window
 * 0) or a crafting table (3x3). Pure: no I/O.
 *
 * 1.7.10 facts this relies on (verified in the server jar and Forge's patches, see
 * docs/gtnh-compatibility.md "Crafting"):
 *  - the server NEVER sends the crafting result slot as a slot update (EntityPlayerMP skips
 *    SlotCrafting); only a full window sync (S30) carries it. The client asks for one with
 *    a click that changes nothing (see planSyncClick) and a deliberately wrong claim;
 *  - a left-click on the result slot with an empty cursor puts the WHOLE result on the
 *    cursor and takes one item from every non-empty grid slot;
 *  - closing the window, or disconnecting, DROPS whatever is in the grid and on the cursor.
 *
 * So one craft is: put exactly one item into every pattern cell, sync, take the result only
 * if it is exactly the expected item and count, put it into an EMPTY slot. Results are never
 * merged into other stacks (their stack limits are unknown), and the grid only ever holds
 * one craft's worth of items.
 */

export interface ItemKey {
  readonly id: number;
  readonly damage: number;
}

export interface CraftingLayout {
  readonly name: string;
  readonly resultSlot: number;
  /** Grid slots, top row first. */
  readonly gridSlots: readonly number[];
  readonly gridWidth: 2 | 3;
  /** The player's 36 storage slots in this window (main inventory, then hotbar), inclusive. */
  readonly playerSlots: readonly [number, number];
}

/**
 * Window 0, the player's own inventory container (1.7.10 ContainerPlayer): 0 result, 1-4 the
 * 2x2 grid, 5-8 armor, 9-35 main, 36-44 hotbar. GTNH's Backhand appends its off-hand slot
 * (45), which crafting never touches.
 */
export const INVENTORY_GRID: CraftingLayout = {
  name: 'the 2x2 inventory grid',
  resultSlot: 0,
  gridSlots: [1, 2, 3, 4],
  gridWidth: 2,
  playerSlots: [9, 44],
};

/** A crafting table window (type 1, ContainerWorkbench): 0 result, 1-9 the grid, 10-45 the player. */
export const TABLE_GRID: CraftingLayout = {
  name: 'the crafting table',
  resultSlot: 0,
  gridSlots: [1, 2, 3, 4, 5, 6, 7, 8, 9],
  gridWidth: 3,
  playerSlots: [10, 45],
};

/** One grid slot of a placed pattern and the items it accepts (registry id + damage). */
export interface GridCell {
  readonly slot: number;
  readonly accepts: readonly ItemKey[];
  /** Agent-facing names of the accepted items (for messages). */
  readonly names: readonly string[];
}

export interface PlacedRecipe {
  readonly cells: readonly GridCell[];
  /** The one result the agent accepts: exactly this item, damage and count, without NBT. */
  readonly expected: Stack;
}

export type Planned<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface ClickPlan {
  clicks: Click[];
  after: WindowSnapshot;
}

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export const sameStack = (a: Stack | null, b: Stack | null): boolean =>
  a === null || b === null
    ? a === b
    : a.id === b.id && a.damage === b.damage && a.count === b.count && a.hasNbt === b.hasNbt;

const accepts = (cell: GridCell, s: Stack): boolean =>
  !s.hasNbt && cell.accepts.some((k) => k.id === s.id && k.damage === s.damage);

const inPlayerSlots = (layout: CraftingLayout, from: number = layout.playerSlots[0]): number[] => {
  const out: number[] = [];
  for (let i = from; i <= layout.playerSlots[1]; i++) out.push(i);
  return out;
};

/**
 * Puts a recipe's pattern into the grid's top-left corner, resolving item names to registry
 * ids (names the registry does not know are left out; they cannot be in the inventory).
 */
export function placeRecipe(
  recipe: CraftingRecipe,
  layout: CraftingLayout,
  resolve: (name: string) => ItemKey | null,
): Planned<PlacedRecipe> {
  const rows = layout.gridSlots.length / layout.gridWidth;
  const width = Math.max(0, ...recipe.pattern.map((r) => r.length));
  if (width > layout.gridWidth || recipe.pattern.length > rows) {
    return fail(`${recipe.id} is ${width}x${recipe.pattern.length}; ${layout.name} is smaller`);
  }
  const cells: GridCell[] = [];
  for (let r = 0; r < recipe.pattern.length; r++) {
    const row = recipe.pattern[r] ?? '';
    for (let c = 0; c < row.length; c++) {
      const key = row[c] ?? ' ';
      if (key === ' ') continue;
      const names = recipe.key[key] ?? [];
      const resolved: ItemKey[] = [];
      const known: string[] = [];
      for (const name of names) {
        const k = resolve(name);
        if (k !== null) {
          resolved.push(k);
          known.push(name);
        }
      }
      if (resolved.length === 0) {
        return fail(`none of ${names.join(', ') || `key ${key}`} is in the item registry`);
      }
      const slot = layout.gridSlots[r * layout.gridWidth + c];
      if (slot === undefined) return fail('internal: pattern outside the grid');
      cells.push({ slot, accepts: resolved, names: known });
    }
  }
  const result = resolve(recipe.result.item);
  if (result === null) return fail(`${recipe.result.item} is not in the item registry`);
  return {
    ok: true,
    value: { cells, expected: { ...result, count: recipe.result.count, hasNbt: false } },
  };
}

export const gridEmpty = (w: WindowSnapshot, layout: CraftingLayout): boolean =>
  layout.gridSlots.every((s) => w.slots[s] == null);

/**
 * Clicks that put ONE accepted item into every cell of the pattern. The grid and the cursor
 * must be empty. Stacks are taken in slot order: pick one up, place one item into each empty
 * cell that accepts it (right-clicks), put the rest back where it came from. Stacks with NBT
 * data are never used.
 */
export function planFill(
  w: WindowSnapshot,
  layout: CraftingLayout,
  placed: PlacedRecipe,
): Planned<ClickPlan> {
  if (w.cursor !== null) return fail('the cursor is not empty');
  if (!gridEmpty(w, layout)) return fail('the crafting grid is not empty');
  let window = w;
  const clicks: Click[] = [];
  const click = (c: Click): string | null => {
    const r = applyClick(window, c);
    if (!r.ok) return r.reason;
    clicks.push(c);
    window = r.window;
    return null;
  };
  let remaining = [...placed.cells];
  while (remaining.length > 0) {
    let source: number | null = null;
    for (const i of inPlayerSlots(layout)) {
      const s = window.slots[i];
      if (s != null && remaining.some((cell) => accepts(cell, s))) {
        source = i;
        break;
      }
    }
    if (source === null) {
      const missing = remaining[0];
      return fail(
        `not enough ingredients for one more craft: nothing left for ${missing?.names.join(' / ') ?? 'a cell'}`,
      );
    }
    const pickUp = click({ slot: source, button: 0 });
    if (pickUp !== null) return fail(pickUp);
    for (const cell of [...remaining]) {
      const cursor = window.cursor;
      if (cursor === null) break;
      if (!accepts(cell, cursor)) continue;
      const place = click({ slot: cell.slot, button: 1 });
      if (place !== null) return fail(place);
      remaining = remaining.filter((c) => c !== cell);
    }
    if (window.cursor !== null) {
      // Put the rest back where it came from (that slot is empty now).
      const back = click({ slot: source, button: 0 });
      if (back !== null) return fail(back);
    }
  }
  return { ok: true, value: { clicks, after: window } };
}

/**
 * The result-slot click (left, empty cursor) as 1.7.10 applies it: the cursor gets the WHOLE
 * result the slot shows, every non-empty grid slot loses one item. The result slot is then
 * whatever the server's recipes make of the rest of the grid, so it is cleared here and only
 * trusted again after the next sync.
 */
export function applyTakeResult(
  w: WindowSnapshot,
  layout: CraftingLayout,
): { ok: true; window: WindowSnapshot; claimed: Stack } | { ok: false; reason: string } {
  if (w.cursor !== null) return fail('the cursor is not empty');
  const result = w.slots[layout.resultSlot];
  if (result == null) return fail('the crafting result slot is empty');
  if (result.hasNbt) return fail('the crafting result has NBT data');
  const slots = [...w.slots];
  for (const g of layout.gridSlots) {
    const s = slots[g];
    if (s != null) slots[g] = s.count > 1 ? { ...s, count: s.count - 1 } : null;
  }
  slots[layout.resultSlot] = null;
  return { ok: true, window: { ...w, slots, cursor: result }, claimed: result };
}

/** The click that puts the cursor into the first EMPTY player slot. */
export function planStoreCursor(w: WindowSnapshot, layout: CraftingLayout): Planned<Click> {
  if (w.cursor === null) return fail('the cursor is empty');
  for (const i of inPlayerSlots(layout)) {
    if (w.slots[i] === null) return { ok: true, value: { slot: i, button: 0 } };
  }
  return fail('no empty inventory slot for the result');
}

/**
 * Where to send the "sync" click: a slot that is EMPTY (with an empty cursor), so the click
 * itself changes nothing on the server. An empty player slot first, else an empty grid slot.
 */
export function planSyncClick(w: WindowSnapshot, layout: CraftingLayout): Planned<Click> {
  if (w.cursor !== null) return fail('the cursor is not empty');
  for (const i of [...inPlayerSlots(layout), ...layout.gridSlots]) {
    if (w.slots[i] === null) return { ok: true, value: { slot: i, button: 0 } };
  }
  return fail('no empty slot to sync with');
}

/**
 * The largest stack of each item (by "id:damage", NBT-free) the window shows, capped at 64.
 * A stack that exists proves its item stacks at least that high, so putting items back into
 * a stack of the same item stays predictable up to that size.
 */
export function stackBounds(w: WindowSnapshot, layout: CraftingLayout): Map<string, number> {
  const bounds = new Map<string, number>();
  for (const i of [...inPlayerSlots(layout), ...layout.gridSlots]) {
    const s = w.slots[i];
    if (s == null || s.hasNbt) continue;
    const key = `${s.id}:${s.damage}`;
    bounds.set(key, Math.min(64, Math.max(bounds.get(key) ?? 0, s.count)));
  }
  return bounds;
}

/**
 * Clicks that return the cursor and everything in the grid to the player's slots: each stack
 * goes onto a stack of the same item one item at a time while that stays within the item's
 * proven bound (usually back onto the stack it came from), otherwise into an empty slot.
 */
export function planClearGrid(
  w: WindowSnapshot,
  layout: CraftingLayout,
  bounds: ReadonlyMap<string, number>,
): Planned<ClickPlan> {
  let window = w;
  const clicks: Click[] = [];
  const click = (c: Click): string | null => {
    const r = applyClick(window, c);
    if (!r.ok) return r.reason;
    clicks.push(c);
    window = r.window;
    return null;
  };
  const putDown = (): string | null => {
    const held = window.cursor;
    if (held === null) return null;
    if (held.hasNbt) return 'the cursor holds a stack with NBT data';
    const bound = bounds.get(`${held.id}:${held.damage}`) ?? 0;
    for (const i of inPlayerSlots(layout)) {
      const s = window.slots[i];
      if (s == null || s.hasNbt || s.id !== held.id || s.damage !== held.damage) continue;
      if (s.count + held.count > bound) continue;
      for (let k = 0; k < held.count; k++) {
        const p = click({ slot: i, button: 1 });
        if (p !== null) return p;
      }
      return null;
    }
    for (const i of inPlayerSlots(layout)) {
      if (window.slots[i] === null) return click({ slot: i, button: 0 });
    }
    return `no room in the inventory for ${held.count} of item ${held.id}@${held.damage}`;
  };
  const first = putDown();
  if (first !== null) return fail(first);
  for (const g of layout.gridSlots) {
    if (window.slots[g] == null) continue;
    const pickUp = click({ slot: g, button: 0 });
    if (pickUp !== null) return fail(pickUp);
    const p = putDown();
    if (p !== null) return fail(p);
  }
  return { ok: true, value: { clicks, after: window } };
}

/**
 * Simulates `times` crafts from `w`, assuming the server shows the expected result each time,
 * so the client can refuse up front (before any click) when they cannot all finish: too few
 * ingredients, or no empty slot for a result.
 */
export function simulateCrafts(
  w: WindowSnapshot,
  layout: CraftingLayout,
  placed: PlacedRecipe,
  times: number,
): Planned<{ clicks: number; after: WindowSnapshot }> {
  if (!Number.isInteger(times) || times < 1) return fail('bad number of crafts');
  let window = w;
  let clicks = 0;
  for (let n = 1; n <= times; n++) {
    const fill = planFill(window, layout, placed);
    if (!fill.ok) return fail(`craft ${n} of ${times}: ${fill.reason}`);
    clicks += fill.value.clicks.length;
    const shown = [...fill.value.after.slots];
    shown[layout.resultSlot] = placed.expected;
    const take = applyTakeResult({ ...fill.value.after, slots: shown }, layout);
    if (!take.ok) return fail(`craft ${n} of ${times}: ${take.reason}`);
    const store = planStoreCursor(take.window, layout);
    if (!store.ok) return fail(`craft ${n} of ${times}: ${store.reason}`);
    const stored = applyClick(take.window, store.value);
    if (!stored.ok) return fail(`craft ${n} of ${times}: ${stored.reason}`);
    window = stored.window;
    clicks += 2;
  }
  return { ok: true, value: { clicks, after: window } };
}

/**
 * Slots (and the cursor) where two views of the same window differ, e.g. the client's
 * prediction and the server's sync. `ignore` lists slots to skip (the result slot).
 */
export function windowDifferences(
  expected: WindowSnapshot,
  actual: WindowSnapshot,
  ignore: ReadonlySet<number> = new Set(),
): string[] {
  const out: string[] = [];
  const show = (s: Stack | null | undefined): string =>
    s == null ? 'empty' : `${s.count} x ${s.id}@${s.damage}${s.hasNbt ? '+nbt' : ''}`;
  const n = Math.max(expected.slots.length, actual.slots.length);
  for (let i = 0; i < n; i++) {
    if (ignore.has(i)) continue;
    const a = expected.slots[i] ?? null;
    const b = actual.slots[i] ?? null;
    if (!sameStack(a, b)) out.push(`slot ${i}: expected ${show(a)}, server has ${show(b)}`);
  }
  if (!sameStack(expected.cursor, actual.cursor)) {
    out.push(`cursor: expected ${show(expected.cursor)}, server has ${show(actual.cursor)}`);
  }
  return out;
}
