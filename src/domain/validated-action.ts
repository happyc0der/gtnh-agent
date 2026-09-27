import type { Action } from './actions.ts';
import type { Position } from './common.ts';

declare const validatedBrand: unique symbol;

/**
 * An action that has passed schema, safety and precondition validation.
 *
 * MinecraftClient.perform() only accepts this type, and clients call
 * assertValidatedAction() at runtime, so a hand-built or mutated object is refused
 * even if it type-checks. Only the ActionExecutor mints these (enforced by lint).
 */
export interface ValidatedAction {
  readonly action: Readonly<Action>;
  /** Resolved world position for location-named actions (e.g. RETURN_TO_SAFE_LOCATION). */
  readonly resolvedTarget: Readonly<Position> | null;
  readonly validatedAt: string;
  readonly [validatedBrand]: true;
}

const minted = new WeakSet<object>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** For ActionExecutor only. Copies and deep-freezes the action so it cannot change after validation. */
export function mintValidatedAction(
  action: Action,
  resolvedTarget: Position | null,
  validatedAt: Date,
): ValidatedAction {
  const token = deepFreeze({
    action: structuredClone(action),
    resolvedTarget: resolvedTarget === null ? null : structuredClone(resolvedTarget),
    validatedAt: validatedAt.toISOString(),
  }) as unknown as ValidatedAction;
  minted.add(token);
  return token;
}

export function isValidatedAction(value: unknown): value is ValidatedAction {
  return value !== null && typeof value === 'object' && minted.has(value);
}

export function assertValidatedAction(value: unknown): asserts value is ValidatedAction {
  if (!isValidatedAction(value)) {
    throw new Error('Refusing to perform an action that was not minted by the ActionExecutor');
  }
}
