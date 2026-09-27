import { randomUUID } from 'node:crypto';

/** Produces unique IDs with a readable prefix, e.g. `act_…`, `cyc_…`. */
export type IdGenerator = (prefix: string) => string;

export const randomIds: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

/** Deterministic IDs for tests and fixtures: `act_0001`, `act_0002`, … per prefix. */
export function sequentialIds(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };
}
