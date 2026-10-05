import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import {
  planNightPit,
  PIT_SEARCH_SPOTS,
  PIT_SEARCH_WALK,
  type PitOptions,
} from '../../../src/bot/gtnh1710/night-pit.ts';
import { reachableFeet } from '../../../src/bot/gtnh1710/terrain.ts';
import type { Vec3, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';

// An independent review, 2026-10-05: only the 80 nearest reachable cells were planned, whatever
// their blocks. On open ground those lie within about 5 blocks' walk, so a spot 8 blocks off was
// never found, though the refusal said "within 24 blocks' walk".
const ID = { air: 0, stone: 1, grass: 2, dirt: 3 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.dirt, 'minecraft:dirt'],
]);
/** Flat land: the top layer (y 63) is stone within `r` of (0, 0) (no pit digs it), grass beyond. */
function land(r: number): WalkWorld {
  return {
    blockAt(x, y, z) {
      if (y === 63) return Math.hypot(x, z) <= r ? ID.stone : ID.grass;
      if (y >= 60 && y < 63) return ID.dirt;
      return y < 60 ? ID.stone : ID.air;
    },
    blockName: (id) => (id === 0 ? undefined : NAMES.get(id)),
    hazardCode: (id) => (id === 0 || NAMES.has(id) ? BLOCK_CODE.safe : BLOCK_CODE.unknown),
  };
}
const FENCE = { min: { x: -40, y: 40, z: -40 }, max: { x: 40, y: 90, z: 40 } };
const OPTS: PitOptions = { area: { fence: FENCE, maxHeightAboveFence: 4 }, maxPathLength: 64 };
const FEET: Vec3 = { x: 0.5, y: 64, z: 0.5 };
const DIRT = { 'minecraft:dirt': 4 };

describe('the night pit search', () => {
  it('on open ground, the 80 nearest cells lie within a few blocks: more than they were tried', () => {
    const reach = [...reachableFeet(land(7), FENCE, FEET, PIT_SEARCH_WALK).values()].sort(
      (a, b) => a.length - b.length,
    );
    expect(reach.length).toBeGreaterThan(1000);
    expect(reach[PIT_SEARCH_SPOTS + 8]?.length ?? 0).toBeLessThan(7);
  });

  it('finds a spot 8 blocks off, past every column of stone nearer', () => {
    const plan = planNightPit(land(7), FEET, DIRT, OPTS);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(Math.hypot(plan.site.x, plan.site.z)).toBeGreaterThan(7);
    expect(Math.hypot(plan.site.x, plan.site.z)).toBeLessThan(9);
    // The walk there first, then the digs.
    expect(plan.steps[0]?.spec.type).toBe('MOVE_TO');
  });

  it('with no column that could take one within the walk, says how far it looked', () => {
    const plan = planNightPit(land(40), FEET, DIRT, OPTS);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/^no spot for a pit within 24 blocks' walk/);
  });
});
