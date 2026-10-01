import { isKnownOreMember } from './ore-dictionary.ts';

/**
 * How Better Questing matches inventory items against a quest item (ItemComparison.StackMatch
 * and OreDictionaryMatch), as far as the agent can tell from its inventory naming
 * (`name` or `name@damage`):
 *  - the same item with the same damage, or any damage when the quest item uses the wildcard
 *    (32767). BQ also accepts any damage when the quest's item is damageable (a tool); the
 *    agent cannot tell which items are, so it undercounts worn tools;
 *  - or a member of the quest item's ore dictionary name. The agent only knows Forge's own
 *    vanilla members (src/domain/ore-dictionary.ts), a lower bound.
 */
export interface QuestItemRef {
  item: string;
  anyDamage: boolean;
  oreDict: string | null;
}

export const baseItem = (item: string): string => item.replace(/@\d+$/, '');

/** The same item (and damage, unless any damage is allowed). */
export function matchesExactly(q: QuestItemRef, inventoryItem: string): boolean {
  return q.anyDamage ? baseItem(inventoryItem) === baseItem(q.item) : inventoryItem === q.item;
}

/** The inventory item certainly counts for the quest item. */
export function certainlyCounts(q: QuestItemRef, inventoryItem: string): boolean {
  return (
    matchesExactly(q, inventoryItem) ||
    (q.oreDict !== null && isKnownOreMember(q.oreDict, inventoryItem))
  );
}

/** How many of the quest item the inventory certainly holds (a lower bound). */
export function heldFor(inventory: Readonly<Record<string, number>>, q: QuestItemRef): number {
  return Object.entries(inventory)
    .filter(([name]) => certainlyCounts(q, name))
    .reduce((n, [, count]) => n + count, 0);
}

/**
 * Free inventory slots a reward claim needs. Better Questing puts reward items into the
 * inventory with addItemStackToInventory and DROPS what does not fit, so this is generous:
 * every reward item in stacks of at most 16 (the smallest stackable size in vanilla), plus two
 * spare slots for unstackable rewards that come more than one at a time.
 */
export function rewardSlotsNeeded(items: ReadonlyArray<{ count: number }>): number {
  return items.reduce((n, i) => n + Math.ceil(i.count / 16), 0) + 2;
}

/**
 * The server MIGHT take this inventory item for the quest item (an upper bound): the same
 * registry name with any damage (damageable items match any damage in BQ), or ANY item when
 * the quest item names an ore dictionary entry, whose members the agent cannot list.
 */
export function mayBeTakenFor(q: QuestItemRef, inventoryItem: string): boolean {
  return q.oreDict !== null || baseItem(inventoryItem) === baseItem(q.item);
}
