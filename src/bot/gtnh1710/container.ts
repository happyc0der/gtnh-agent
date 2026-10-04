import type { ItemStackData } from './packets.ts';

/**
 * A container window as the client sees it, and the small subset of vanilla 1.7.10 click
 * behaviour the agent uses. Pure: no I/O.
 *
 * In 1.7.10 the server confirms an accepted click (S32) WITHOUT sending the resulting slot
 * contents: the client must predict them. So the agent only uses clicks whose result it
 * can predict exactly, without knowing any item's maximum stack size:
 *
 *  - left-click a slot with an empty cursor: pick up the whole stack;
 *  - left-click an EMPTY slot with a stack on the cursor: put the whole stack down;
 *  - right-click an empty slot, or a slot holding the cursor's item that it filled itself,
 *    with a stack on the cursor: put ONE item down (never past the stack it came from);
 *  - only when the click asks for it (`swap`), left-click a player inventory slot holding
 *    ANOTHER item with a stack on the cursor: the two swap (Container.slotClick: the slot
 *    takes any item and holds 64, more than any cursor stack; the same item would merge,
 *    which needs the maximum stack size, and is refused).
 *
 * Stacks with NBT data are never touched (their exact data would have to be echoed).
 * The cursor must be empty whenever a window closes: the server drops cursor items into
 * the world.
 */

export type Stack = Readonly<ItemStackData>;

export interface WindowSnapshot {
  /** Slots 0..containerSlots-1 are the container; the next 27 the player's main inventory, then 9 hotbar. */
  containerSlots: number;
  slots: ReadonlyArray<Stack | null>;
  cursor: Stack | null;
}

export type ClickButton = 0 | 1;

export interface Click {
  slot: number;
  /** 0 = left, 1 = right (mode 0, a normal click). */
  button: ClickButton;
  /**
   * A left-click on a slot holding another item swaps it with the cursor's stack. Only for
   * the player's main inventory and hotbar slots, which take any item.
   */
  swap?: boolean;
}

const sameItem = (a: Stack, b: Stack): boolean =>
  a.id === b.id && a.damage === b.damage && !a.hasNbt && !b.hasNbt;

/** The result of a click, or why the agent refuses to make it (unpredictable outcome). */
export function applyClick(
  w: WindowSnapshot,
  click: Click,
): { ok: true; window: WindowSnapshot; claimed: Stack | null } | { ok: false; reason: string } {
  const slot = w.slots[click.slot];
  if (slot === undefined) return { ok: false, reason: `slot ${click.slot} does not exist` };
  if (slot?.hasNbt === true || w.cursor?.hasNbt === true) {
    return { ok: false, reason: 'stacks with NBT data are never moved' };
  }
  const slots = [...w.slots];
  // 1.7.10's slotClick returns (and the client must claim) the slot's stack before the click.
  const claimed = slot;
  if (w.cursor === null) {
    if (click.button !== 0 || slot === null) {
      return { ok: false, reason: 'with an empty cursor only a left-click on a stack is used' };
    }
    slots[click.slot] = null;
    return { ok: true, window: { ...w, slots, cursor: slot }, claimed };
  }
  if (click.button === 0) {
    if (slot !== null && click.swap === true && !sameItem(slot, w.cursor)) {
      slots[click.slot] = w.cursor;
      return { ok: true, window: { ...w, slots, cursor: slot }, claimed };
    }
    if (slot !== null) return { ok: false, reason: 'a stack is only put down into an empty slot' };
    slots[click.slot] = w.cursor;
    return { ok: true, window: { ...w, slots, cursor: null }, claimed };
  }
  if (slot !== null && !sameItem(slot, w.cursor)) {
    return { ok: false, reason: 'one item is only put down into an empty or matching slot' };
  }
  slots[click.slot] = { ...w.cursor, count: (slot?.count ?? 0) + 1 };
  const rest = w.cursor.count - 1;
  return {
    ok: true,
    window: { ...w, slots, cursor: rest > 0 ? { ...w.cursor, count: rest } : null },
    claimed,
  };
}

export type TransferDirection = 'to_player' | 'to_container';

export type TransferPlan =
  { ok: true; clicks: Click[]; after: WindowSnapshot } | { ok: false; reason: string };

export function containerRange(w: WindowSnapshot): [number, number] {
  return [0, w.containerSlots - 1];
}

export function playerRange(w: WindowSnapshot): [number, number] {
  return [w.containerSlots, w.containerSlots + 35];
}

/** How many of this item (by registry id and damage, without NBT) the slots in [from, to] hold. */
export function countItem(
  w: WindowSnapshot,
  range: [number, number],
  item: { id: number; damage: number },
): number {
  let n = 0;
  for (let i = range[0]; i <= range[1]; i++) {
    const s = w.slots[i];
    if (s != null && !s.hasNbt && s.id === item.id && s.damage === item.damage) n += s.count;
  }
  return n;
}

/**
 * Plans moving exactly `quantity` of an item between the container and the player, using
 * only predictable clicks (see above), and simulates it. Refuses (before any click) when
 * the source does not hold enough NBT-free stacks or the destination runs out of empty
 * slots. The plan always ends with an empty cursor.
 */
export function planTransfer(
  w: WindowSnapshot,
  direction: TransferDirection,
  item: { id: number; damage: number },
  quantity: number,
): TransferPlan {
  if (w.cursor !== null) return { ok: false, reason: 'the cursor is not empty' };
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: 'bad quantity' };
  const [src, dst] =
    direction === 'to_player'
      ? [containerRange(w), playerRange(w)]
      : [playerRange(w), containerRange(w)];
  const available = countItem(w, src, item);
  if (available < quantity) {
    return { ok: false, reason: `only ${available} available without NBT data, need ${quantity}` };
  }

  const clicks: Click[] = [];
  let window = w;
  const click = (c: Click): string | null => {
    const r = applyClick(window, c);
    if (!r.ok) return r.reason;
    clicks.push(c);
    window = r.window;
    return null;
  };
  const emptySlot = (range: [number, number]): number | null => {
    for (let i = range[0]; i <= range[1]; i++) if (window.slots[i] === null) return i;
    return null;
  };

  let remaining = quantity;
  while (remaining > 0) {
    let from: number | null = null;
    for (let i = src[0]; i <= src[1]; i++) {
      const s = window.slots[i];
      if (s != null && !s.hasNbt && s.id === item.id && s.damage === item.damage) {
        from = i;
        break;
      }
    }
    const to = emptySlot(dst);
    if (from === null) return { ok: false, reason: 'internal: source ran out' };
    if (to === null) return { ok: false, reason: 'no empty slot left on the receiving side' };
    const size = (window.slots[from] as Stack).count;
    const problem = click({ slot: from, button: 0 });
    if (problem !== null) return { ok: false, reason: problem };
    if (size <= remaining) {
      const p = click({ slot: to, button: 0 });
      if (p !== null) return { ok: false, reason: p };
      remaining -= size;
    } else {
      for (let k = 0; k < remaining; k++) {
        const p = click({ slot: to, button: 1 });
        if (p !== null) return { ok: false, reason: p };
      }
      // Put the rest back where it came from (that slot is empty now).
      const p = click({ slot: from, button: 0 });
      if (p !== null) return { ok: false, reason: p };
      remaining = 0;
    }
  }
  if (window.cursor !== null)
    return { ok: false, reason: 'internal: plan ends with a full cursor' };
  return { ok: true, clicks, after: window };
}

/**
 * After the server rejected a click and re-sent the window: clicks that put a stack on the
 * cursor back into an empty slot (preferring `preferred`), so the window can close safely.
 */
export function planEmptyCursor(w: WindowSnapshot, preferred: [number, number]): Click[] | null {
  if (w.cursor === null) return [];
  const ranges: Array<[number, number]> = [preferred, containerRange(w), playerRange(w)];
  for (const [a, b] of ranges) {
    for (let i = a; i <= b; i++) if (w.slots[i] === null) return [{ slot: i, button: 0 }];
  }
  return null;
}
