import { describe, expect, it } from 'vitest';
import { ok, failed } from '../../src/bot/minecraft-client.ts';
import type { ActionSpec } from '../../src/domain/actions.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import { known, unknown } from '../../src/domain/known.ts';
import { verifyPostcondition } from '../../src/executor/action-verifier.ts';
import { action, makeState, safetyCtx } from '../fixtures/index.ts';

const later = (s: GameState, ms = 1000): GameState => ({
  ...s,
  timestamp: new Date(Date.parse(s.timestamp) + ms).toISOString(),
});

function verify(spec: ActionSpec, before: GameState, after: GameState | null, exec = ok('done')) {
  return verifyPostcondition({
    action: action(spec),
    before,
    after,
    execution: exec,
    ctx: safetyCtx(),
  });
}

describe('verifyPostcondition', () => {
  const before = makeState();

  it('PLAYER_NEAR passes within tolerance and fails outside it', () => {
    const spec: ActionSpec = {
      type: 'MOVE_TO',
      args: { target: { x: 10, y: 64, z: 10 }, tolerance: 1 },
    };
    const arrived = later({
      ...before,
      player: { ...before.player, position: known({ x: 10.5, y: 64, z: 10 }) },
    });
    expect(verify(spec, before, arrived).verified).toBe(true);
    expect(verify(spec, before, later(before)).verified).toBe(false);
  });

  it('fails closed when the post-state value is unknown', () => {
    const spec: ActionSpec = {
      type: 'MOVE_TO',
      args: { target: { x: 1, y: 64, z: 1 }, tolerance: 1 },
    };
    const blind = later({ ...before, player: { ...before.player, position: unknown('lost') } });
    expect(verify(spec, before, blind).verified).toBe(false);
  });

  it('fails when there is no post-observation or execution failed', () => {
    const spec: ActionSpec = { type: 'OBSERVE_STATE', args: {} };
    expect(verify(spec, before, null).verified).toBe(false);
    expect(verify(spec, before, later(before), failed('nope')).verified).toBe(false);
    expect(verify(spec, before, later(before)).verified).toBe(true);
  });

  it('fails when the observation goes backwards in time', () => {
    expect(verify({ type: 'OBSERVE_STATE', args: {} }, before, later(before, -5000)).verified).toBe(
      false,
    );
  });

  it('TIME_ELAPSED checks observed time, not the client claim', () => {
    const spec: ActionSpec = { type: 'WAIT', args: { durationMs: 5000 } };
    expect(verify(spec, before, later(before, 4000)).verified).toBe(false);
    expect(verify(spec, before, later(before, 5000)).verified).toBe(true);
  });

  it('ITEMS_MOVED checks exact inventory and (when known) container deltas', () => {
    const spec: ActionSpec = {
      type: 'DEPOSIT_ITEM',
      args: { containerId: 'chest.main', item: 'minecraft:cobblestone', quantity: 64 },
    };
    const inv = before.inventory.known ? before.inventory.value : null;
    if (inv === null) throw new Error('fixture inventory unknown');
    const moved = later({
      ...before,
      inventory: known({ ...inv, items: { ...inv.items, 'minecraft:cobblestone': 0 } }),
      storage: before.storage.map((s) => ({
        ...s,
        items: known({ 'minecraft:cobblestone': 192 }),
      })),
    });
    expect(verify(spec, before, moved).verified).toBe(true);

    const vanished = later({ ...moved, storage: before.storage });
    const r = verify(spec, before, vanished);
    expect(r.verified).toBe(false);
    expect(r.checks.find((c) => c.name === 'container-delta')?.passed).toBe(false);
  });

  it('BLOCK_REMOVED needs the observation to have seen the block turn into air', () => {
    const spec: ActionSpec = { type: 'DIG_BLOCK', args: { position: { x: 2, y: 64, z: 1 } } };
    if (!before.nearbyBlocks.known) throw new Error('fixture blocks unknown');
    const blocks = before.nearbyBlocks.value;
    const dug = later({
      ...before,
      nearbyBlocks: known({
        ...blocks,
        resources: blocks.resources.filter((r) => r.position.x !== 2),
        removed: [{ x: 2, y: 64, z: 1 }],
      }),
    });
    expect(verify(spec, before, dug).verified).toBe(true);

    // The client said it dug, but the block is still listed (e.g. the server re-sent it).
    const still = verify(spec, before, later(before));
    expect(still.verified).toBe(false);
    expect(still.checks.find((c) => c.name === 'block-removed')?.detail).toBe(
      '(2, 64, 1) is still minecraft:dirt',
    );
    // Gone from the list but never seen as air (out of view, unloaded...): not verified.
    const vanished = later({
      ...before,
      nearbyBlocks: known({ ...blocks, resources: [], removed: [] }),
    });
    expect(verify(spec, before, vanished).verified).toBe(false);
    // Blocks not observable afterwards: fail closed.
    const blind = later({ ...before, nearbyBlocks: unknown('chunk unloaded') });
    expect(verify(spec, before, blind).verified).toBe(false);
  });

  it('BLOCK_PLACED needs the cell seen turning into the block, and exactly one item used', () => {
    const spec: ActionSpec = {
      type: 'PLACE_BLOCK',
      args: { position: { x: 2, y: 65, z: 1 }, item: 'minecraft:cobblestone' },
    };
    if (!before.nearbyBlocks.known || !before.inventory.known) throw new Error('fixture unknown');
    const blocks = before.nearbyBlocks.value;
    const inv = before.inventory.value;
    const after = (placed: GameState['nearbyBlocks'], cobblestone: number): GameState =>
      later({
        ...before,
        nearbyBlocks: placed,
        inventory: known({ ...inv, items: { ...inv.items, 'minecraft:cobblestone': cobblestone } }),
      });
    const seen = known({
      ...blocks,
      placed: [{ block: 'minecraft:cobblestone' as const, position: { x: 2, y: 65, z: 1 } }],
    });
    expect(verify(spec, before, after(seen, 63)).verified).toBe(true);

    // Placed, but the inventory did not change (or lost two): not verified.
    const kept = verify(spec, before, after(seen, 64));
    expect(kept.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['item-used']);
    expect(verify(spec, before, after(seen, 62)).verified).toBe(false);
    // The item went, but the cell was never seen turning into the block.
    const unseen = verify(spec, before, after(known(blocks), 63));
    expect(unseen.checks.find((c) => c.name === 'block-placed')?.detail).toBe(
      '(2, 65, 1) was not observed turning into minecraft:cobblestone',
    );
    // Another block appeared there.
    const other = known({
      ...blocks,
      placed: [{ block: 'minecraft:dirt' as const, position: { x: 2, y: 65, z: 1 } }],
    });
    expect(verify(spec, before, after(other, 63)).verified).toBe(false);
    // Blocks not observable afterwards: fail closed.
    expect(verify(spec, before, after(unknown('chunk unloaded'), 63)).verified).toBe(false);
  });

  it('ITEMS_CRAFTED checks the exact result gain, ingredient use, and that nothing else changed', () => {
    const spec: ActionSpec = {
      type: 'CRAFT_ITEM',
      args: { recipe: 'sticks', times: 2, craftingTableId: null },
    };
    const inv = before.inventory.known ? before.inventory.value : null;
    if (inv === null) throw new Error('fixture inventory unknown');
    const withPlanks = {
      ...before,
      inventory: known({
        ...inv,
        items: { ...inv.items, 'minecraft:planks': 3, 'minecraft:planks@2': 5 },
      }),
    };
    const after = (items: Record<string, number>): GameState =>
      later({ ...withPlanks, inventory: known({ ...inv, items: { ...inv.items, ...items } }) });

    // Any mix of plank kinds counts: 4 planks used, 8 sticks made.
    const crafted = after({ 'minecraft:planks': 1, 'minecraft:planks@2': 3, 'minecraft:stick': 8 });
    expect(verify(spec, withPlanks, crafted).verified).toBe(true);

    const short = verify(
      spec,
      withPlanks,
      after({ 'minecraft:planks': 0, 'minecraft:planks@2': 4, 'minecraft:stick': 4 }),
    );
    expect(short.checks.filter((c) => !c.passed).map((c) => c.name)).toEqual(['result-delta']);
    const extra = verify(
      spec,
      withPlanks,
      after({
        'minecraft:planks': 1,
        'minecraft:planks@2': 3,
        'minecraft:stick': 8,
        'minecraft:bucket': 1,
      }),
    );
    expect(extra.verified).toBe(false);
    expect(extra.checks.find((c) => c.name === 'other-items-unchanged')?.detail).toMatch(
      /minecraft:bucket 0 -> 1/,
    );
  });

  it('USER_NOTIFIED requires an acknowledgement', () => {
    const spec: ActionSpec = { type: 'PAUSE_AND_ASK_USER', args: { question: 'q' } };
    expect(verify(spec, before, later(before), ok('x', { acknowledged: true })).verified).toBe(
      true,
    );
    expect(verify(spec, before, later(before), ok('x')).verified).toBe(false);
  });
});
