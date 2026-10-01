import { describe, expect, it } from 'vitest';
import {
  celestialAngle,
  lightPointY,
  mcCos,
  OVERWORLD_BRIGHTNESS,
  skylightSubtracted,
} from '../../../src/bot/gtnh1710/light.ts';
import { SPIDER_CALM_LIGHT } from '../../../src/domain/combat.ts';

describe('the server light math (1.7.10, mirrored in floats)', () => {
  it('the overworld brightness reaches 0.5 at exactly SPIDER_CALM_LIGHT (12)', () => {
    // EntitySpider.findPlayerToAttack targets only while getBrightness < 0.5F.
    expect(OVERWORLD_BRIGHTNESS[11]).toBeCloseTo(0.4074074, 6);
    expect(OVERWORLD_BRIGHTNESS[12]).toBe(Math.fround(0.50000006));
    expect(OVERWORLD_BRIGHTNESS.findIndex((b) => b >= 0.5)).toBe(SPIDER_CALM_LIGHT);
    expect([OVERWORLD_BRIGHTNESS[0], OVERWORLD_BRIGHTNESS[15]]).toEqual([0, 1]);
  });

  it('MathHelper.cos reads the 65536-entry sine table', () => {
    expect(mcCos(0)).toBe(1);
    expect(mcCos(Math.fround(Math.PI))).toBeCloseTo(-1, 6);
    for (const x of [0.3, 1.7, 4.2, 6]) expect(mcCos(x)).toBeCloseTo(Math.cos(x), 3);
  });

  it('the sun is overhead at noon and opposite at midnight', () => {
    expect(celestialAngle(6000, 0)).toBeCloseTo(0, 6);
    expect(celestialAngle(18000, 0)).toBeCloseTo(0.5, 6);
    // Only the time of day counts.
    expect(celestialAngle(24000 * 7 + 6000, 0)).toBe(celestialAngle(6000, 0));
  });

  it('the sky is dimmed 0 by day and 11 at night, by 3 in the rain and 5 in a storm at noon', () => {
    expect(skylightSubtracted(6000, 0, 0)).toBe(0);
    expect(skylightSubtracted(0, 0, 0)).toBe(0);
    expect(skylightSubtracted(18000, 0, 0)).toBe(11);
    expect(skylightSubtracted(6000, 1, 0)).toBe(3); // sky light 12: spiders in the open stay calm
    expect(skylightSubtracted(6000, 1, 1)).toBe(5); // a thunderstorm: sky light 10
    // Thunder only counts as much as it rains (getWeightedThunderStrength).
    expect(skylightSubtracted(6000, 0, 1)).toBe(0);
  });

  it('an open-sky spider may target the player from tick 12541 to 23458 (sky light below 12)', () => {
    expect(skylightSubtracted(12540, 0, 0)).toBe(3);
    expect(skylightSubtracted(12541, 0, 0)).toBe(4);
    expect(skylightSubtracted(23458, 0, 0)).toBe(4);
    expect(skylightSubtracted(23459, 0, 0)).toBe(3);
  });

  it('a mob reads the light 0.66 of its height above its feet', () => {
    expect(lightPointY(64, 0.9)).toBeCloseTo(64.594, 6); // a spider: the block it stands in
    expect(lightPointY(64, 0.5)).toBeCloseTo(64.33, 6); // a cave spider
    expect(Math.floor(lightPointY(64.5, 0.9))).toBe(65); // on a slab: the block above
  });
});
