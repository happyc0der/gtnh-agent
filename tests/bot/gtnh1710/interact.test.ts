import { describe, expect, it } from 'vitest';
import { ChunkStore, type ColumnSections } from '../../../src/bot/gtnh1710/chunk-data.ts';
import {
  applyClick,
  type Stack,
  type WindowSnapshot,
} from '../../../src/bot/gtnh1710/container.ts';
import {
  allSlots,
  buildInteractableTable,
  codeProfile,
  interactAreaProblem,
  interactStandSpot,
  OBSERVE_ONLY_CODE,
  planInsert,
  planTakeAll,
  playerCount,
  provenStackBound,
  roleOf,
  scanInteractables,
} from '../../../src/bot/gtnh1710/interact.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import type { WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { INTERACTION_PROFILES } from '../../../src/domain/interactions.ts';

/** A loaded chunk column with nothing in it (all air). */
const emptyColumn = (): ColumnSections => Array.from({ length: 16 }, () => null);

const FURNACE_LAYOUT = INTERACTION_PROFILES.furnace.window.variants[0]!.layout;
const COBBLE = { id: 4, damage: 0 };
const PLANKS = { id: 5, damage: 0 };
const stack = (id: number, count: number, hasNbt = false): Stack => ({
  id,
  count,
  damage: 0,
  hasNbt,
});

/** A furnace window: slots 0-2 the furnace, 3-29 main inventory, 30-38 hotbar. */
function furnaceWindow(
  furnace: [Stack | null, Stack | null, Stack | null],
  player: Record<number, Stack>,
): WindowSnapshot {
  const slots: Array<Stack | null> = [...furnace];
  for (let i = 0; i < 36; i++) slots.push(player[i] ?? null);
  return { containerSlots: 3, slots, cursor: null };
}

/** Replays the clicks with the client's own prediction and returns the result. */
function replay(w: WindowSnapshot, clicks: Array<{ slot: number; button: 0 | 1 }>): WindowSnapshot {
  let window = w;
  for (const c of clicks) {
    const r = applyClick(window, c);
    if (!r.ok) throw new Error(r.reason);
    window = r.window;
  }
  return window;
}

describe('planInsert: exactly N items into one container slot', () => {
  it('a whole stack into the empty slot with one click', () => {
    const w = furnaceWindow([null, null, null], { 0: stack(4, 8) });
    const plan = planInsert(w, FURNACE_LAYOUT, 0, COBBLE, 8);
    expect(plan.ok && plan.value.clicks).toEqual([
      { slot: 3, button: 0 },
      { slot: 0, button: 0 },
    ]);
  });

  it('part of a stack: one item per right-click, the rest back where it came from', () => {
    const w = furnaceWindow([null, null, null], { 0: stack(5, 6) });
    const plan = planInsert(w, FURNACE_LAYOUT, 1, PLANKS, 2);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.value.clicks).toEqual([
      { slot: 3, button: 0 },
      { slot: 1, button: 1 },
      { slot: 1, button: 1 },
      { slot: 3, button: 0 },
    ]);
    const after = replay(w, plan.value.clicks);
    expect(after.slots[1]).toEqual(stack(5, 2));
    expect(after.slots[3]).toEqual(stack(5, 4));
    expect(after.cursor).toBeNull();
    expect(plan.value.after).toEqual(after);
  });

  it('onto the same item already in the slot, within the largest stack seen', () => {
    const w = furnaceWindow([stack(4, 5), null, null], { 0: stack(4, 20) });
    const plan = planInsert(w, FURNACE_LAYOUT, 0, COBBLE, 3);
    if (!plan.ok) throw new Error(plan.reason);
    const after = replay(w, plan.value.clicks);
    expect(after.slots[0]).toEqual(stack(4, 8));
    expect(playerCount(after, FURNACE_LAYOUT, COBBLE)).toBe(17);
  });

  it('several stacks: the first goes down whole, the next one item at a time', () => {
    const w = furnaceWindow([null, null, null], { 0: stack(4, 3), 5: stack(4, 10) });
    const plan = planInsert(w, FURNACE_LAYOUT, 0, COBBLE, 7);
    if (!plan.ok) throw new Error(plan.reason);
    const after = replay(w, plan.value.clicks);
    expect(after.slots[0]).toEqual(stack(4, 7));
    expect(after.slots[3]).toBeNull();
    expect(after.slots[8]).toEqual(stack(4, 6));
  });

  it('refuses what it cannot predict or must not do', () => {
    const w = furnaceWindow([stack(17, 1), stack(5, 63), null], {
      0: stack(4, 20),
      1: stack(5, 64),
      2: stack(4, 3, true),
    });
    const refusal = (target: number, item: { id: number; damage: number }, n: number) => {
      const p = planInsert(w, FURNACE_LAYOUT, target, item, n);
      return p.ok ? 'planned' : p.reason;
    };
    expect(refusal(2, COBBLE, 1)).toMatch(/slot 2 does not take items/);
    expect(refusal(0, COBBLE, 1)).toMatch(/holds something else/);
    expect(refusal(1, PLANKS, 2)).toMatch(/would hold 65, more than the largest stack/);
    // The NBT stack never counts: only 20 plain cobblestone.
    expect(refusal(1, COBBLE, 1)).toMatch(/holds something else/);
    const empty = furnaceWindow([null, null, null], { 0: stack(4, 20), 2: stack(4, 3, true) });
    const p = planInsert(empty, FURNACE_LAYOUT, 0, COBBLE, 21);
    expect(p.ok ? 'planned' : p.reason).toMatch(/more than the largest stack|only 20 available/);
    expect(planInsert({ ...empty, cursor: stack(4, 1) }, FURNACE_LAYOUT, 0, COBBLE, 1)).toEqual({
      ok: false,
      reason: 'the cursor is not empty',
    });
  });

  it('the proven stack bound is the largest plain stack seen, at most 64', () => {
    const w = furnaceWindow([stack(4, 70), null, null], { 0: stack(4, 12), 1: stack(4, 3, true) });
    expect(provenStackBound(w, [3, 38], COBBLE)).toBe(12);
    expect(provenStackBound(w, [3, 38], COBBLE, [0])).toBe(64);
  });
});

describe('planTakeAll: a whole stack out into an empty inventory slot', () => {
  it('takes the output whole and puts it into the first empty slot', () => {
    const w = furnaceWindow([null, null, stack(1, 5)], { 0: stack(4, 3) });
    const plan = planTakeAll(w, FURNACE_LAYOUT, 2);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.value.clicks).toEqual([
      { slot: 2, button: 0 },
      { slot: 4, button: 0 },
    ]);
    expect(plan.value.taken).toEqual(stack(1, 5));
    expect(plan.value.after.slots[2]).toBeNull();
    expect(plan.value.after.slots[4]).toEqual(stack(1, 5));
  });

  it('refuses an empty slot, NBT data, or a full inventory', () => {
    const full: Record<number, Stack> = {};
    for (let i = 0; i < 36; i++) full[i] = stack(4, 1);
    const reason = (w: WindowSnapshot): string => {
      const p = planTakeAll(w, FURNACE_LAYOUT, 2);
      return p.ok ? 'planned' : p.reason;
    };
    expect(reason(furnaceWindow([null, null, null], {}))).toMatch(/output slot is empty/);
    expect(reason(furnaceWindow([null, null, stack(1, 1, true)], {}))).toMatch(/NBT/);
    expect(reason(furnaceWindow([null, null, stack(1, 1)], full))).toMatch(
      /no empty inventory slot/,
    );
  });
});

describe('layouts', () => {
  it('roles and slot access come from the profile', () => {
    expect(roleOf(FURNACE_LAYOUT, 1)).toBe('fuel');
    expect(roleOf(FURNACE_LAYOUT, 5)).toBeNull();
    expect(roleOf(null, 0)).toBeNull();
    expect(allSlots(FURNACE_LAYOUT, 'take')).toBe(true);
    expect(allSlots(FURNACE_LAYOUT, 'put')).toBe(false);
  });
});

describe('finding interactable blocks in the chunk data', () => {
  const registry: Registry = {
    blocks: new Map([
      [1, 'minecraft:stone'],
      [61, 'minecraft:furnace'],
      [146, 'minecraft:trapped_chest'],
      [3000, 'appliedenergistics2:tile.BlockDrive'],
      [3001, 'JABBA:barrel'],
    ]),
    items: new Map(),
    blockSubstitutions: [],
    itemSubstitutions: [],
  };
  const table = buildInteractableTable(registry, ['appliedenergistics2:*']);

  it('maps block ids to profiles, observe-only, or nothing (never-opened ones excluded)', () => {
    expect(codeProfile(table[61] ?? 0)).toBe('furnace');
    expect(table[3000]).toBe(OBSERVE_ONLY_CODE);
    expect(codeProfile(table[3000] ?? 0)).toBeNull();
    expect(codeProfile(table[146] ?? 0)).toBeUndefined();
    expect(codeProfile(table[3001] ?? 0)).toBeUndefined();
    expect(codeProfile(table[1] ?? 0)).toBeUndefined();
  });

  function store(blocks: Array<[number, number, number, number]>): ChunkStore {
    const s = new ChunkStore();
    for (let cx = -2; cx <= 1; cx++) {
      for (let cz = -2; cz <= 1; cz++) s.setColumn(cx, cz, emptyColumn(), 0);
    }
    for (const [x, y, z, id] of blocks) s.setBlock(x, y, z, id, 0);
    return s;
  }

  it('lists exposed blocks nearest first; a buried one is not seen', () => {
    const buried: Array<[number, number, number, number]> = [
      [5, 70, 5, 61],
      [6, 70, 5, 1],
      [4, 70, 5, 1],
      [5, 71, 5, 1],
      [5, 69, 5, 1],
      [5, 70, 6, 1],
      [5, 70, 4, 1],
    ];
    const s = store([[1, 64, 1, 61], [-3, 65, 2, 3000], ...buried]);
    const scan = scanInteractables(s, table, { x: 0.5, y: 64, z: 0.5 });
    if (!scan.ok) throw new Error(scan.reason);
    expect(scan.blocks.map((b) => [b.profile, b.position])).toEqual([
      ['furnace', { x: 1, y: 64, z: 1 }],
      [null, { x: -3, y: 65, z: 2 }],
    ]);
  });

  it('fails closed while nearby chunks are missing', () => {
    const s = new ChunkStore();
    s.setColumn(0, 0, emptyColumn(), 0);
    const scan = scanInteractables(s, table, { x: 8, y: 64, z: 8 });
    expect(scan).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/waiting for .* chunk/) as unknown,
    });
  });
});

describe('where a block may be used', () => {
  const fence = { min: { x: 0, y: 64, z: 0 }, max: { x: 4, y: 64, z: 4 } };

  it('inside the fence columns, from below the floor to head height', () => {
    expect(interactAreaProblem(null, { x: 100, y: 1, z: 100 })).toBeNull();
    expect(interactAreaProblem(fence, { x: 2, y: 63, z: 2 })).toBeNull();
    expect(interactAreaProblem(fence, { x: 2, y: 66, z: 2 })).toBeNull();
    expect(interactAreaProblem(fence, { x: 5, y: 64, z: 2 })).toMatch(
      /outside the fence's columns/,
    );
    expect(interactAreaProblem(fence, { x: 2, y: 67, z: 2 })).toMatch(
      /outside the fence's heights/,
    );
  });

  it('a stand spot beside the block, standable, inside the fence and within reach', () => {
    const solid = new Set(['1,64,1']);
    const world: WalkWorld = {
      blockAt: (x, y, z) => (y === 63 ? 1 : solid.has(`${x},${y},${z}`) ? 61 : 0),
      blockName: (id) =>
        id === 1 ? 'minecraft:stone' : id === 61 ? 'minecraft:furnace' : undefined,
      hazardCode: () => 0,
    };
    const spot = interactStandSpot(world, fence, { x: 1, y: 64, z: 1 }, { x: 4.5, y: 64, z: 4.5 });
    expect(spot).toEqual({ x: 2.5, y: 64, z: 2.5 });
  });
});
