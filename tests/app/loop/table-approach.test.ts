import { describe, expect, it } from 'vitest';
import { tableApproach } from '../../../src/app/loop/plan-steps.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { known } from '../../../src/domain/known.ts';
import { makeState } from '../../fixtures/index.ts';

/** The mock player at (1, 64, 1); a placed crafting table where `table` says, seen or not. */
function withTable(
  table: { x: number; y: number; z: number },
  seen: { standAt: { x: number; y: number; z: number } | null } | null,
): GameState {
  const base = makeState();
  return {
    ...base,
    interactables: known({
      scanRadius: 16,
      blocks:
        seen === null
          ? []
          : [
              {
                profile: 'crafting_table',
                block: 'minecraft:crafting_table',
                position: table,
                standAt: seen.standAt,
              },
            ],
    }),
  };
}

describe("a plan's craft at a crafting table out of reach (tableApproach)", () => {
  it('in reach, or no table named, or a configured one: the craft goes ahead', () => {
    const near = withTable({ x: 2, y: 64, z: 2 }, { standAt: null });
    expect(tableApproach(near, 'crafting_table:2.64.2', 4.5)).toBeNull();
    expect(tableApproach(near, null, 4.5)).toBeNull();
    expect(tableApproach(near, 'table.workshop', 4.5)).toBeNull();
  });

  it('in view but out of reach: walks to the spot to use it from', () => {
    const state = withTable({ x: 10, y: 64, z: 1 }, { standAt: { x: 9.5, y: 64, z: 1.5 } });
    expect(tableApproach(state, 'crafting_table:10.64.1', 4.5)).toEqual({
      spec: { type: 'MOVE_TO', args: { target: { x: 9.5, y: 64, z: 1.5 }, tolerance: 0.5 } },
      why: 'walking back to the crafting table at (10, 64, 1) to craft there',
    });
    // In view with no spot to use it from: nothing to do but let the craft fail.
    const walled = withTable({ x: 10, y: 64, z: 1 }, { standAt: null });
    expect(tableApproach(walled, 'crafting_table:10.64.1', 4.5)).toBeNull();
  });

  it('out of view (left behind on a trip for logs): heads back toward it', () => {
    // Seen live: the table 50 blocks back, the craft refused ("not known").
    const state = withTable({ x: -2, y: 89, z: 96 }, null);
    expect(tableApproach(state, 'crafting_table:-2.89.96', 4.5)).toMatchObject({
      spec: {
        type: 'EXPLORE',
        args: { toward: { x: -1.5, z: 96.5 }, maxDistance: 96 },
      },
    });
  });
});
