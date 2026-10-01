import { z } from 'zod';

/**
 * Explicit representation of observability. Anything the agent cannot reliably
 * observe (common with GTNH machines, power and modded GUIs) is `{ known: false }`
 * with a reason, never a guessed default value.
 */
export type Known<T> = { known: true; value: T } | { known: false; reason: string };

export function knownSchema<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion('known', [
    z.strictObject({ known: z.literal(true), value }),
    z.strictObject({ known: z.literal(false), reason: z.string().min(1).max(200) }),
  ]);
}

export function known<T>(value: T): Known<T> {
  return { known: true, value };
}

export function unknown(reason: string): { known: false; reason: string } {
  return { known: false, reason };
}
