import type { ActionSpec } from '../domain/actions.ts';
import type { SafetyViolation } from '../domain/safety.ts';

/**
 * Items an action would consume, move or burn. Protected items may never appear here.
 * Exhaustive on purpose: adding an action type forces a decision about its items.
 */
export function itemsTouchedBy(spec: ActionSpec): string[] {
  switch (spec.type) {
    case 'EAT_FOOD':
      return [spec.args.item];
    case 'DEPOSIT_ITEM':
    case 'WITHDRAW_ITEM':
      return [spec.args.item];
    case 'REFUEL_KNOWN_GENERATOR':
      return [spec.args.fuelItem];
    // DIG_BLOCK uses an empty hand and only adds the block's drop to the inventory.
    case 'OBSERVE_STATE':
    case 'MOVE_TO':
    case 'WAIT':
    case 'RETURN_TO_SAFE_LOCATION':
    case 'OPEN_CONTAINER':
    case 'INSPECT_MACHINE':
    case 'DIG_BLOCK':
    case 'PAUSE_AND_ASK_USER':
      return [];
  }
}

/** Matches an item against the protected set. `gregtech:foo` also protects `gregtech:foo@<meta>`. */
export function isProtected(item: string, protectedItems: ReadonlySet<string>): boolean {
  if (protectedItems.has(item)) return true;
  const at = item.indexOf('@');
  return at !== -1 && protectedItems.has(item.slice(0, at));
}

export function checkProtectedItems(
  spec: ActionSpec,
  protectedItems: ReadonlySet<string>,
): SafetyViolation[] {
  return itemsTouchedBy(spec)
    .filter((item) => isProtected(item, protectedItems))
    .map((item) => ({
      code: 'PROTECTED_ITEM' as const,
      severity: 'pause' as const,
      message: `${spec.type} would use protected item ${item}`,
      details: { item, actionType: spec.type },
    }));
}

export function mergeProtectedItems(...sources: Iterable<string>[]): ReadonlySet<string> {
  const merged = new Set<string>();
  for (const source of sources) for (const item of source) merged.add(item);
  return merged;
}
