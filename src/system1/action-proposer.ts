import type { ActionSpec } from '../domain/actions.ts';
import type { Position } from '../domain/common.ts';
import type { DecisionResult } from '../domain/decisions.ts';
import type { GameState } from '../domain/game-state.ts';
import {
  availableApprovedFood,
  findStorage,
  generatorNeedingFuel,
  isWithin,
  selectDepositCandidate,
  type RouterContext,
} from './state-queries.ts';

/** What the agent loop should do with a decision: run one action, or consult the planner. */
export type Proposal =
  { kind: 'action'; spec: ActionSpec; reason: string } | { kind: 'planner'; reason: string };

/** Arrival radius used for approach moves, kept inside interaction reach. */
function approachTolerance(ctx: RouterContext): number {
  return Math.max(0.5, Math.min(2, ctx.safety.config.interactionReach - 1));
}

function pause(question: string): Proposal {
  return {
    kind: 'action',
    spec: { type: 'PAUSE_AND_ASK_USER', args: { question } },
    reason: question,
  };
}

function moveTo(target: Position, ctx: RouterContext, why: string): Proposal {
  return {
    kind: 'action',
    spec: { type: 'MOVE_TO', args: { target, tolerance: approachTolerance(ctx) } },
    reason: why,
  };
}

/**
 * Converts one System 1 decision into exactly one proposed action (or a planner
 * request). Interaction decisions first approach the target if it is out of reach,
 * so each cycle performs a single small step. If the decision cannot be turned into
 * a concrete action, the result is PAUSE_AND_ASK_USER.
 */
export function proposeAction(
  decision: DecisionResult,
  state: GameState,
  ctx: RouterContext,
): Proposal {
  const reach = ctx.safety.config.interactionReach;
  const why = `${decision.decision} (${decision.reasonCodes.join(', ')})`;

  switch (decision.decision) {
    case 'PAUSE_AND_ASK_USER':
      return pause(`Paused: ${decision.reasonCodes.join(', ')}. Please review the agent state.`);

    case 'RETREAT_HOME':
      return {
        kind: 'action',
        spec: {
          type: 'RETURN_TO_SAFE_LOCATION',
          args: { locationName: ctx.routing.homeLocationName },
        },
        reason: why,
      };

    case 'EAT': {
      const food = availableApprovedFood(state, ctx);
      if (food === null) return pause('EAT was decided but no approved food is in the inventory.');
      return { kind: 'action', spec: { type: 'EAT_FOOD', args: { item: food } }, reason: why };
    }

    case 'EMPTY_INVENTORY': {
      const dump = findStorage(state, ctx.routing.dumpContainerId);
      const candidate = selectDepositCandidate(state, ctx);
      if (dump === null || !dump.position.known || candidate === null) {
        return pause(
          'EMPTY_INVENTORY was decided but there is no known dump container or depositable item.',
        );
      }
      if (!isWithin(state, dump.position.value, reach)) {
        return moveTo(dump.position.value, ctx, `${why}: approach ${dump.id}`);
      }
      return {
        kind: 'action',
        spec: {
          type: 'DEPOSIT_ITEM',
          args: { containerId: dump.id, item: candidate.item, quantity: candidate.quantity },
        },
        reason: why,
      };
    }

    case 'REFUEL_GENERATOR': {
      const refuel = generatorNeedingFuel(state, ctx);
      if (refuel === null || !refuel.generator.position.known) {
        return pause('REFUEL_GENERATOR was decided but no refuelable generator was found.');
      }
      if (!isWithin(state, refuel.generator.position.value, reach)) {
        return moveTo(
          refuel.generator.position.value,
          ctx,
          `${why}: approach ${refuel.generator.id}`,
        );
      }
      return {
        kind: 'action',
        spec: {
          type: 'REFUEL_KNOWN_GENERATOR',
          args: {
            generatorId: refuel.generator.id,
            fuelItem: refuel.fuelItem,
            quantity: refuel.quantity,
          },
        },
        reason: why,
      };
    }

    case 'WAIT_FOR_MACHINE':
      return {
        kind: 'action',
        spec: { type: 'WAIT', args: { durationMs: ctx.routing.machineWaitMs } },
        reason: why,
      };

    case 'EXECUTE_KNOWN_SAFE_STEP': {
      const step = state.knownRecipeState?.nextKnownSafeStep ?? null;
      if (step === null)
        return pause('EXECUTE_KNOWN_SAFE_STEP was decided but no known step exists.');
      return { kind: 'action', spec: step, reason: why };
    }

    case 'REQUEST_PLANNER':
      return { kind: 'planner', reason: why };
  }
}
