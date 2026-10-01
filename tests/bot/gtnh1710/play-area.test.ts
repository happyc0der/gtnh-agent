import { describe, expect, it } from 'vitest';
import { NO_FENCE, playArea } from '../../../src/bot/gtnh1710/play-area.ts';
import { defaultConfig, MAX_FENCE_HEIGHT, MAX_FENCE_SIDE } from '../../../src/config/env.ts';

const FENCE = { min: { x: -9, y: 106, z: -12 }, max: { x: -1, y: 106, z: -4 } };
const BOUNDARY = { min: { x: -256, y: 0, z: -256 }, max: { x: 256, y: 255, z: 256 } };
const movement = (m: Record<string, unknown>) =>
  defaultConfig({ minecraft: { movement: m } }).minecraft.movement;

describe('the play area', () => {
  it("mode 'fixed' (the default) is the configured fence, exactly, wherever the player is", () => {
    const fixed = movement({ fence: FENCE });
    expect(fixed.mode).toBe('fixed');
    for (const feet of [null, { x: 0.5, y: 64, z: 0.5 }, { x: 900.5, y: 10, z: -3.5 }]) {
      expect(playArea(fixed, BOUNDARY, feet)).toEqual({ fence: FENCE, problem: null });
      expect(playArea(fixed, null, feet)).toEqual({ fence: FENCE, problem: null });
    }
    // A copy: changing it cannot change the configuration.
    const area = playArea(fixed, null, null);
    if (area.fence !== null) (area.fence.min as { x: number }).x = 99;
    expect(fixed.fence?.min.x).toBe(-9);
    expect(playArea(movement({}), BOUNDARY, null)).toEqual({ fence: null, problem: NO_FENCE });
  });

  it("mode 'follow' is a window centred on the player's feet block, the biggest by default", () => {
    const follow = movement({ mode: 'follow', fence: FENCE });
    const area = playArea(follow, BOUNDARY, { x: 10.7, y: 70, z: -20.2 });
    expect(area.problem).toBeNull();
    expect(area.fence).toEqual({
      min: { x: 10 - 31, y: 70 - 16, z: -21 - 31 },
      max: { x: 10 + 32, y: 70 + 16, z: -21 + 32 },
    });
    if (area.fence === null) return;
    expect(area.fence.max.x - area.fence.min.x + 1).toBe(MAX_FENCE_SIDE);
    expect(area.fence.max.y - area.fence.min.y).toBe(MAX_FENCE_HEIGHT);
    // The configured fence plays no part in it.
    expect(area.fence).not.toEqual(FENCE);
  });

  it('is clipped to the exploration boundary, block by block, and to the world heights', () => {
    const follow = movement({ mode: 'follow', area: { side: 16, height: 8 } });
    const box = { min: { x: 0, y: 60, z: -10.5 }, max: { x: 20, y: 66, z: 30 } };
    expect(playArea(follow, box, { x: 2.5, y: 62, z: -9.5 }).fence).toEqual({
      // x from 0 (the boundary), z from -10 (the first whole block), y from the boundary's 60.
      min: { x: 0, y: 60, z: -10 },
      max: { x: 2 + 8, y: 62 + 4, z: -10 + 8 },
    });
    // The far edges: a block reaches x + 1, so x 19 is the last one inside x <= 20.
    expect(playArea(follow, box, { x: 18.5, y: 64, z: 28.5 }).fence?.max).toEqual({
      x: 19,
      y: 66,
      z: 29,
    });
    const low = playArea(follow, BOUNDARY, { x: 0.5, y: 2, z: 0.5 });
    expect(low.fence?.min.y).toBe(1);
  });

  it('has none when the player is outside the boundary, its position unknown, or no boundary is given', () => {
    const follow = movement({ mode: 'follow' });
    expect(playArea(follow, BOUNDARY, { x: 300.5, y: 64, z: 0.5 }).problem).toMatch(
      /outside the exploration boundary/,
    );
    expect(playArea(follow, BOUNDARY, null).problem).toMatch(/position is unknown/);
    expect(playArea(follow, null, { x: 0.5, y: 64, z: 0.5 }).problem).toMatch(
      /needs the exploration boundary/,
    );
  });
});
