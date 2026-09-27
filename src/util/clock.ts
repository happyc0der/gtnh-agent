/** Injectable time source so every component (and every test) is deterministic. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(date: Date | string): void;
}

/** A clock that only moves when told to. Used by tests and by the mock world. */
export function manualClock(start: Date | string = '2026-01-01T00:00:00.000Z'): ManualClock {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      if (!Number.isFinite(ms) || ms < 0)
        throw new RangeError('ManualClock.advance: ms must be >= 0');
      current += ms;
    },
    set: (date: Date | string) => {
      current = new Date(date).getTime();
    },
  };
}
