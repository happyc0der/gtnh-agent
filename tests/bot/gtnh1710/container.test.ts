import { describe, expect, it } from 'vitest';
import {
  applyClick,
  countItem,
  planEmptyCursor,
  planTransfer,
  playerRange,
  type Stack,
  type WindowSnapshot,
} from '../../../src/bot/gtnh1710/container.ts';

const COBBLE = { id: 4, damage: 0 };
const cobble = (count: number): Stack => ({ ...COBBLE, count, hasNbt: false });
const bread = (count: number): Stack => ({ id: 297, damage: 0, count, hasNbt: false });

/** A single chest (27 slots) plus the player's 36; `player` indexes are 0-35 (main, then hotbar). */
function win(
  chest: Record<number, Stack>,
  player: Record<number, Stack> = {},
  cursor: Stack | null = null,
): WindowSnapshot {
  const slots: Array<Stack | null> = Array.from({ length: 63 }, () => null);
  for (const [i, s] of Object.entries(chest)) slots[Number(i)] = s;
  for (const [i, s] of Object.entries(player)) slots[27 + Number(i)] = s;
  return { containerSlots: 27, slots, cursor };
}

/** Replays a plan with applyClick (as the server does it) and returns the final window. */
function replay(w: WindowSnapshot, clicks: ReadonlyArray<{ slot: number; button: 0 | 1 }>) {
  let cur = w;
  for (const c of clicks) {
    const r = applyClick(cur, c);
    if (!r.ok) throw new Error(r.reason);
    cur = r.window;
  }
  return cur;
}

describe('predictable clicks', () => {
  it('picks up a whole stack, claiming the stack that was there', () => {
    const r = applyClick(win({ 0: cobble(64) }), { slot: 0, button: 0 });
    expect(r).toMatchObject({ ok: true, claimed: cobble(64) });
    if (r.ok) expect([r.window.slots[0], r.window.cursor]).toEqual([null, cobble(64)]);
  });

  it('puts a whole stack into an empty slot, and one item with a right-click', () => {
    const w = win({}, {}, cobble(5));
    const all = applyClick(w, { slot: 30, button: 0 });
    expect(all).toMatchObject({ ok: true, claimed: null });
    if (all.ok) expect([all.window.slots[30], all.window.cursor]).toEqual([cobble(5), null]);

    const one = applyClick(w, { slot: 30, button: 1 });
    if (!one.ok) throw new Error(one.reason);
    expect([one.window.slots[30], one.window.cursor]).toEqual([cobble(1), cobble(4)]);
    const two = applyClick(one.window, { slot: 30, button: 1 });
    expect(two).toMatchObject({ ok: true, claimed: cobble(1) });
  });

  it('refuses clicks whose result would need item stack limits, or NBT data', () => {
    expect(applyClick(win({ 0: cobble(3) }), { slot: 0, button: 1 })).toMatchObject({ ok: false });
    expect(applyClick(win({ 0: bread(3) }, {}, cobble(2)), { slot: 0, button: 0 })).toMatchObject({
      ok: false,
    });
    expect(applyClick(win({ 0: bread(3) }, {}, cobble(2)), { slot: 0, button: 1 })).toMatchObject({
      ok: false,
    });
    expect(
      applyClick(win({ 0: { ...cobble(3), hasNbt: true } }), { slot: 0, button: 0 }),
    ).toMatchObject({ ok: false, reason: 'stacks with NBT data are never moved' });
  });
});

describe('transfer plans', () => {
  it('takes a partial amount: pick up, place one at a time, put the rest back', () => {
    const w = win({ 0: cobble(64) });
    const plan = planTransfer(w, 'to_player', COBBLE, 10);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.clicks).toEqual([
      { slot: 0, button: 0 },
      ...Array.from({ length: 10 }, () => ({ slot: 27, button: 1 })),
      { slot: 0, button: 0 },
    ]);
    expect(plan.after.slots[0]).toEqual(cobble(54));
    expect(plan.after.slots[27]).toEqual(cobble(10));
    expect(plan.after.cursor).toBeNull();
    expect(replay(w, plan.clicks)).toEqual(plan.after);
  });

  it('moves whole stacks with two clicks each, and spans stacks', () => {
    const w = win({ 0: cobble(64), 5: cobble(64) });
    const plan = planTransfer(w, 'to_player', COBBLE, 100);
    if (!plan.ok) throw new Error(plan.reason);
    expect(countItem(plan.after, playerRange(plan.after), COBBLE)).toBe(100);
    expect(countItem(plan.after, [0, 26], COBBLE)).toBe(28);
    expect(plan.clicks.slice(0, 2)).toEqual([
      { slot: 0, button: 0 },
      { slot: 27, button: 0 },
    ]);
    expect(plan.clicks).toHaveLength(2 + 1 + 36 + 1);
  });

  it('deposits into empty chest slots only, never merging', () => {
    const w = win({ 0: cobble(10) }, { 0: cobble(20) });
    const plan = planTransfer(w, 'to_container', COBBLE, 20);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.after.slots[0]).toEqual(cobble(10));
    expect(plan.after.slots[1]).toEqual(cobble(20));
  });

  it('refuses up front when it cannot finish exactly', () => {
    expect(planTransfer(win({ 0: cobble(5) }), 'to_player', COBBLE, 6)).toEqual({
      ok: false,
      reason: 'only 5 available without NBT data, need 6',
    });
    expect(
      planTransfer(win({ 0: { ...cobble(64), hasNbt: true } }), 'to_player', COBBLE, 1),
    ).toMatchObject({ ok: false, reason: 'only 0 available without NBT data, need 1' });
    const full: Record<number, Stack> = {};
    for (let i = 0; i < 36; i++) full[i] = bread(1);
    expect(planTransfer(win({ 0: cobble(5) }, full), 'to_player', COBBLE, 5)).toEqual({
      ok: false,
      reason: 'no empty slot left on the receiving side',
    });
    expect(planTransfer(win({ 0: cobble(5) }, {}, bread(1)), 'to_player', COBBLE, 1)).toEqual({
      ok: false,
      reason: 'the cursor is not empty',
    });
  });

  it('after a failure, puts the cursor into an empty slot on the preferred side first', () => {
    expect(planEmptyCursor(win({ 0: cobble(1) }, {}, cobble(3)), [0, 26])).toEqual([
      { slot: 1, button: 0 },
    ]);
    const chestFull: Record<number, Stack> = {};
    for (let i = 0; i < 27; i++) chestFull[i] = bread(1);
    expect(planEmptyCursor(win(chestFull, {}, cobble(3)), [0, 26])).toEqual([
      { slot: 27, button: 0 },
    ]);
    expect(planEmptyCursor(win({}), [0, 26])).toEqual([]);
  });
});
