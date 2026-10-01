import { describe, expect, it } from 'vitest';
import { decodePlay } from '../../src/bot/gtnh1710/packets.ts';
import { Reader } from '../../src/bot/gtnh1710/wire.ts';
import { worldTime } from '../../src/domain/game-state.ts';

describe('the world clock', () => {
  it('names the phase and counts real minutes to night and to sunrise', () => {
    expect(worldTime(6000, true)).toEqual({
      timeOfDay: 6000,
      phase: 'day',
      minutesUntilNight: 5.8, // 7000 ticks at 20 per second
      minutesUntilDay: 0,
      daylightCycle: true,
    });
    expect(worldTime(12_500, true)).toMatchObject({ phase: 'evening', minutesUntilNight: 0.4 });
    expect(worldTime(18_000, true)).toMatchObject({
      phase: 'night',
      minutesUntilNight: 0,
      minutesUntilDay: 5,
    });
    expect(worldTime(23_500, true)).toMatchObject({ phase: 'dawn', minutesUntilDay: 0.4 });
    // Day times accumulate over days: only the time of day matters.
    expect(worldTime(3 * 24_000 + 1000, false)).toMatchObject({
      timeOfDay: 1000,
      phase: 'day',
      daylightCycle: false,
    });
  });

  it('decodes S03, whose day time is negated while the daylight cycle is off', () => {
    const frame = (worldAge: bigint, dayTime: bigint): Reader => {
      const b = Buffer.alloc(16);
      b.writeBigInt64BE(worldAge, 0);
      b.writeBigInt64BE(dayTime, 8);
      return new Reader(b);
    };
    expect(decodePlay(0x03, frame(123_456n, 13_000n))).toEqual({
      type: 'time-update',
      worldAge: 123_456,
      dayTicks: 13_000,
      daylightCycle: true,
    });
    expect(decodePlay(0x03, frame(123_456n, -1_000n))).toMatchObject({
      dayTicks: 1000,
      daylightCycle: false,
    });
  });
});
