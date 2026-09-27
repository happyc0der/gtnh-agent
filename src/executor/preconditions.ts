import type { Action } from '../domain/actions.ts';
import type { Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance } from '../domain/geometry.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';

export interface PreconditionResult {
  ok: boolean;
  failures: string[];
  /** World position the client should use (e.g. the resolved safe location). */
  resolvedTarget: Position | null;
}

/**
 * Feasibility checks: can this action physically succeed from the current state?
 * (Whether it is *allowed* is the safety policy's job.) Any failure blocks execution.
 */
export function checkPreconditions(
  action: Action,
  state: GameState,
  ctx: SafetyContext,
): PreconditionResult {
  const failures: string[] = [];
  let resolvedTarget: Position | null = null;
  const reach = ctx.config.interactionReach;
  const position = state.player.position.known ? state.player.position.value : null;
  const inventory = state.inventory.known ? state.inventory.value : null;
  const have = (item: string): number => inventory?.items[item] ?? 0;

  const requirePosition = (): Position | null => {
    if (position === null) failures.push('player position is unknown');
    return position;
  };
  const requireInReach = (
    what: string,
    target: { known: boolean } & ({ known: true; value: Position } | { known: false }),
  ): void => {
    const p = requirePosition();
    if (!target.known) {
      failures.push(`${what} position is unknown`);
      return;
    }
    if (p !== null && distance(p, target.value) > reach) {
      failures.push(
        `${what} is ${distance(p, target.value).toFixed(1)} blocks away (reach ${reach})`,
      );
    }
  };
  const requireInventory = (): void => {
    if (inventory === null) failures.push('inventory is unknown');
  };

  switch (action.type) {
    case 'OBSERVE_STATE':
    case 'WAIT':
    case 'PAUSE_AND_ASK_USER':
      break;

    case 'MOVE_TO':
      requirePosition();
      resolvedTarget = action.args.target;
      break;

    case 'RETURN_TO_SAFE_LOCATION': {
      requirePosition();
      const location = ctx.locations.get(action.args.locationName);
      if (location === undefined) failures.push(`unknown location "${action.args.locationName}"`);
      else resolvedTarget = location.position;
      break;
    }

    case 'EAT_FOOD':
      requireInventory();
      if (have(action.args.item) < 1) failures.push(`no ${action.args.item} in inventory`);
      if (state.player.hunger.known && state.player.hunger.value >= 20)
        failures.push('player is not hungry');
      break;

    case 'OPEN_CONTAINER':
    case 'DEPOSIT_ITEM':
    case 'WITHDRAW_ITEM': {
      const container = state.storage.find((s) => s.id === action.args.containerId);
      if (container === undefined) {
        failures.push(`container ${action.args.containerId} is not known`);
        break;
      }
      requireInReach(`container ${container.id}`, container.position);
      if (action.type === 'DEPOSIT_ITEM') {
        requireInventory();
        if (have(action.args.item) < action.args.quantity) {
          failures.push(
            `inventory holds ${have(action.args.item)} ${action.args.item}, need ${action.args.quantity}`,
          );
        }
      }
      if (action.type === 'WITHDRAW_ITEM') {
        requireInventory();
        if (!container.items.known) failures.push(`contents of ${container.id} are unknown`);
        else if ((container.items.value[action.args.item] ?? 0) < action.args.quantity) {
          failures.push(
            `${container.id} does not hold ${action.args.quantity} ${action.args.item}`,
          );
        }
        if (inventory !== null && inventory.usedSlots >= inventory.capacitySlots)
          failures.push('inventory is full');
      }
      break;
    }

    case 'INSPECT_MACHINE': {
      const machine = state.machines.find((m) => m.id === action.args.machineId);
      if (machine === undefined) failures.push(`machine ${action.args.machineId} is not known`);
      else requireInReach(`machine ${machine.id}`, machine.position);
      break;
    }

    case 'REFUEL_KNOWN_GENERATOR': {
      const generator = state.power.generators.find((g) => g.id === action.args.generatorId);
      if (generator === undefined) {
        failures.push(`generator ${action.args.generatorId} is not known`);
        break;
      }
      requireInReach(`generator ${generator.id}`, generator.position);
      requireInventory();
      if (have(action.args.fuelItem) < action.args.quantity) {
        failures.push(
          `inventory holds ${have(action.args.fuelItem)} ${action.args.fuelItem}, need ${action.args.quantity}`,
        );
      }
      break;
    }
  }
  return { ok: failures.length === 0, failures, resolvedTarget };
}
