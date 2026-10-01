import type { RoutingConfig } from '../config/env.ts';
import type { Position } from '../domain/common.ts';
import type { GameState, Generator, StorageContainer } from '../domain/game-state.ts';
import { distance } from '../domain/geometry.ts';
import type { NamedLocation } from '../domain/safety.ts';
import { isProtected } from '../safety/protected-items.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';

/**
 * The current task's latest plan, from agent memory: what a model's cadence
 * (src/system1/model-cadence.ts) needs to tell whether the open plan goes on or has ended.
 */
export interface PlanFacts {
  planId: number;
  /** The plan's status: `active` while it goes on (completed, failed... once it ended). */
  status: string;
  /** The step that runs next (1-based), and how many the plan has. */
  step: number;
  steps: number;
  /** That step's type (GATHER: a gather in progress); null once there is none. */
  stepType: string | null;
}

/** Inputs shared by the router and the decision-to-action proposer. Pure data. */
export interface RouterContext {
  safety: SafetyContext;
  routing: RoutingConfig;
  /**
   * The client may fight (minecraft.combat.enabled, MC_ENABLE_COMBAT). Without it System 1
   * never decides DEFEND: it retreats or pauses as before.
   */
  combatEnabled?: boolean;
  /**
   * The current task's latest plan (null: it has none). The rules ignore it; a model's
   * cadence uses it. Left out, a model at decision points treats every plan request as one.
   */
  plan?: PlanFacts | null;
}

/** Deterministic ordering for item names so ties never depend on object key order. */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function playerPosition(state: GameState): Position | null {
  return state.player.position.known ? state.player.position.value : null;
}

export function inventoryItems(state: GameState): Record<string, number> {
  return state.inventory.known ? state.inventory.value.items : {};
}

export function homeLocation(ctx: RouterContext): NamedLocation | null {
  const home = ctx.safety.locations.get(ctx.routing.homeLocationName);
  return home !== undefined && home.kind === 'safe' ? home : null;
}

/** A known safe location the player is not already at: somewhere RETREAT_HOME can go. */
export function canRetreat(state: GameState, ctx: RouterContext): boolean {
  const home = homeLocation(ctx);
  const p = playerPosition(state);
  return (
    home !== null && p !== null && distance(p, home.position) > ctx.safety.config.interactionReach
  );
}

export function isWithin(state: GameState, target: Position, radius: number): boolean {
  const p = playerPosition(state);
  return p !== null && distance(p, target) <= radius;
}

export function inventoryFillFraction(state: GameState): number | null {
  if (!state.inventory.known) return null;
  const { usedSlots, capacitySlots } = state.inventory.value;
  return usedSlots / capacitySlots;
}

/** First approved, unprotected food the player is carrying, in config order. */
export function availableApprovedFood(state: GameState, ctx: RouterContext): string | null {
  const items = inventoryItems(state);
  for (const food of ctx.safety.config.approvedFoods) {
    if ((items[food] ?? 0) > 0 && !isProtected(food, ctx.safety.protectedItems)) return food;
  }
  return null;
}

export function findStorage(state: GameState, id: string | null): StorageContainer | null {
  if (id === null) return null;
  return state.storage.find((s) => s.id === id) ?? null;
}

/**
 * The item EMPTY_INVENTORY should deposit next: the largest stack that is not
 * protected, not a kept item, and not an approved food or fuel. Ties by name.
 */
export function selectDepositCandidate(
  state: GameState,
  ctx: RouterContext,
): { item: string; quantity: number } | null {
  const keep = new Set([
    ...ctx.routing.keepItems,
    ...ctx.safety.config.approvedFoods,
    ...ctx.safety.config.approvedFuels,
  ]);
  const candidates = Object.entries(inventoryItems(state))
    .filter(
      ([item, qty]) => qty > 0 && !keep.has(item) && !isProtected(item, ctx.safety.protectedItems),
    )
    .sort(([a, qa], [b, qb]) => qb - qa || byName(a, b));
  const first = candidates[0];
  return first === undefined ? null : { item: first[0], quantity: Math.min(first[1], 36 * 64) };
}

export interface RefuelCandidate {
  generator: Generator;
  fuelItem: string;
  quantity: number;
}

/**
 * A known generator that is out of fuel and accepts an approved, unprotected fuel
 * the player carries. Generators with unknown status are never refueled.
 */
export function generatorNeedingFuel(state: GameState, ctx: RouterContext): RefuelCandidate | null {
  const items = inventoryItems(state);
  const generators = [...state.power.generators]
    .filter((g) => g.status === 'out_of_fuel' && g.position.known)
    .sort((a, b) => byName(a.id, b.id));
  for (const generator of generators) {
    for (const fuel of ctx.safety.config.approvedFuels) {
      const have = items[fuel] ?? 0;
      if (
        have > 0 &&
        generator.acceptedFuels.includes(fuel) &&
        !isProtected(fuel, ctx.safety.protectedItems)
      ) {
        return { generator, fuelItem: fuel, quantity: Math.min(have, ctx.routing.refuelQuantity) };
      }
    }
  }
  return null;
}
