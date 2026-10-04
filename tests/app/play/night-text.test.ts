import { describe, expect, it } from 'vitest';
import { nightReason } from '../../../src/app/play/night.ts';
import { worldTime } from '../../../src/domain/game-state.ts';

describe('nightReason', () => {
  it('says when the night comes by day, and how long until sunrise after', () => {
    // Seen live: "it is day (0 min until sunrise)" as it went offline for 11 minutes.
    expect(nightReason(worldTime(11_500, true))).toMatch(/^it is day \(night in 1\.3 min\)/);
    expect(nightReason(worldTime(12_500, true))).toMatch(
      /^it is evening \(9\.6 min until sunrise\)/,
    );
  });
});
