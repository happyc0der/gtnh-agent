import type { Action } from '../domain/actions.ts';
import { ENGAGE_RADIUS } from '../domain/combat.ts';
import type { Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock, formatPosition } from '../domain/geometry.ts';
import {
  craftingRecipe,
  describeIngredient,
  ingredientRequirements,
  needsCraftingTable,
} from '../domain/recipes.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';
import { questBookPreconditions } from './quest-book-checks.ts';

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

    case 'EXPLORE': {
      const p = requirePosition();
      const toward = action.args.toward;
      if (p !== null && typeof toward !== 'string') {
        const d = Math.hypot(toward.x - p.x, toward.z - p.z);
        if (d < 2) failures.push(`the EXPLORE target is only ${d.toFixed(1)} blocks away`);
      }
      break;
    }

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

    case 'CRAFT_ITEM': {
      requireInventory();
      // The same recipe data the client fills the grid from (src/domain/recipes.ts): the
      // hand-verified table's, or the knowledge base's, whose ingredients may be any of an
      // ore-dictionary entry's kinds.
      const recipe = craftingRecipe(action.args.recipe);
      if (recipe === null) {
        failures.push(`${action.args.recipe} is not a recipe CRAFT_ITEM can make`);
        break;
      }
      const times = action.args.times;
      if (inventory !== null) {
        for (const req of ingredientRequirements(recipe)) {
          const need = req.perCraft * times;
          const held = req.anyOf.reduce((n, item) => n + have(item), 0);
          if (held < need) {
            failures.push(
              `inventory holds ${held} of ${describeIngredient(req.anyOf, req.label)}, need ${need} for ${times} x ${recipe.id}`,
            );
          }
        }
      }
      const tableId = action.args.craftingTableId;
      if (tableId === null) {
        if (needsCraftingTable(recipe)) {
          failures.push(`${recipe.id} needs a crafting table (its pattern does not fit 2x2)`);
        }
      } else {
        const table = state.craftingTables.find((t) => t.id === tableId);
        if (table === undefined) failures.push(`crafting table ${tableId} is not known`);
        else requireInReach(`crafting table ${table.id}`, table.position);
      }
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

    case 'INTERACT_BLOCK':
    case 'SMELT':
    case 'TAKE_OUTPUT': {
      // Reach is measured like the game does: from the eyes to the block.
      const p = requirePosition();
      const target = action.args.position;
      if (p !== null && eyeDistanceToBlock(p, target) > reach) {
        failures.push(
          `block ${formatPosition(target)} is ${eyeDistanceToBlock(p, target).toFixed(1)} blocks from the eyes (reach ${reach})`,
        );
      }
      if (action.type === 'SMELT') {
        requireInventory();
        const { input, quantity, fuel, fuelQuantity } = action.args;
        const need = new Map<string, number>([[input, quantity]]);
        if (fuelQuantity > 0) need.set(fuel, (need.get(fuel) ?? 0) + fuelQuantity);
        if (inventory !== null) {
          for (const [item, n] of need) {
            if (have(item) < n) failures.push(`inventory holds ${have(item)} ${item}, need ${n}`);
          }
        }
      }
      if (action.type === 'TAKE_OUTPUT') {
        // The output goes into an empty slot (results are never merged into other stacks).
        requireInventory();
        if (inventory !== null && inventory.usedSlots >= inventory.capacitySlots) {
          failures.push('inventory is full (no empty slot for the furnace output)');
        }
        const furnace = state.interactables.known
          ? state.interactables.value.blocks.find(
              (b) =>
                b.position.x === target.x && b.position.y === target.y && b.position.z === target.z,
            )?.furnace
          : undefined;
        // Seen empty is no proof (it may have filled since); seen holding another item is.
        const output = furnace?.seen?.output ?? null;
        if (output !== null && output.item !== action.args.item) {
          failures.push(
            `the furnace's output was last seen holding ${output.count} ${output.item}, not ${action.args.item}`,
          );
        }
      }
      break;
    }

    case 'ATTACK_ENTITY': {
      // The player does not move: the target must be close enough to come within strike
      // reach during the burst (a hostile walks up; an animal must already be near).
      requirePosition();
      if (!state.nearbyEntities.known) {
        failures.push('nearby entities are unknown');
        break;
      }
      const target = state.nearbyEntities.value.entities.find((e) => e.id === action.args.entityId);
      if (target === undefined) {
        failures.push(`entity ${action.args.entityId} is not near the player`);
      } else if (target.distance > ENGAGE_RADIUS) {
        failures.push(
          `${target.type} ${target.id} is ${target.distance.toFixed(1)} blocks away (engages within ${ENGAGE_RADIUS})`,
        );
      }
      break;
    }

    case 'DIG_BLOCK': {
      // Reach is measured like the game does: from the eyes to the block.
      const p = requirePosition();
      const target = action.args.position;
      if (p !== null && eyeDistanceToBlock(p, target) > reach) {
        failures.push(
          `block ${formatPosition(target)} is ${eyeDistanceToBlock(p, target).toFixed(1)} blocks from the eyes (reach ${reach})`,
        );
      }
      // The drop needs somewhere to go, or it is left lying in the world.
      requireInventory();
      if (inventory !== null && inventory.usedSlots >= inventory.capacitySlots) {
        failures.push('inventory is full (no room for the drop)');
      }
      break;
    }

    case 'DIG_DOWN': {
      // The block under the feet is always within reach; its drop needs somewhere to go.
      requirePosition();
      requireInventory();
      if (inventory !== null && inventory.usedSlots >= inventory.capacitySlots) {
        failures.push('inventory is full (no room for the drop)');
      }
      break;
    }

    case 'PLACE_BLOCK': {
      // Reach is measured from the eyes to the cell, like digging.
      const p = requirePosition();
      const target = action.args.position;
      if (p !== null && eyeDistanceToBlock(p, target) > reach) {
        failures.push(
          `cell ${formatPosition(target)} is ${eyeDistanceToBlock(p, target).toFixed(1)} blocks from the eyes (reach ${reach})`,
        );
      }
      requireInventory();
      if (inventory !== null && have(action.args.item) < 1) {
        failures.push(`inventory holds no ${action.args.item} to place`);
      }
      break;
    }

    case 'SUBMIT_QUEST':
    case 'CHECK_QUEST_BOX':
    case 'CLAIM_QUEST_REWARD':
      failures.push(...questBookPreconditions(action, state));
      break;
  }
  return { ok: failures.length === 0, failures, resolvedTarget };
}
