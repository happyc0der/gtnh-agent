import { z } from 'zod';
import {
  BlockPositionSchema,
  EntityIdSchema,
  ItemNameSchema,
  LocationNameSchema,
  MAX_TRANSFER_QUANTITY,
  PositionSchema,
  TimestampSchema,
} from './common.ts';

/**
 * The complete allowlist of in-game actions. Anything not listed here is rejected
 * by schema validation before it reaches the safety policy or the executor.
 *
 * Deliberately absent: lava interaction, dropping items, combat, block placing,
 * electrical-network or multiblock changes, and rare-item consumption. Blocks are broken
 * only by DIG_BLOCK, and only blocks on its allowlist (src/domain/blocks.ts).
 */
export const ACTION_TYPES = [
  'OBSERVE_STATE',
  'MOVE_TO',
  'WAIT',
  'EAT_FOOD',
  'RETURN_TO_SAFE_LOCATION',
  'OPEN_CONTAINER',
  'DEPOSIT_ITEM',
  'WITHDRAW_ITEM',
  'INSPECT_MACHINE',
  'REFUEL_KNOWN_GENERATOR',
  'DIG_BLOCK',
  'PAUSE_AND_ASK_USER',
] as const;

export const ActionTypeSchema = z.enum(ACTION_TYPES);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ACTION_ORIGINS = ['deterministic-router', 'planner', 'user', 'test'] as const;
export const ActionOriginSchema = z.enum(ACTION_ORIGINS);
export type ActionOrigin = z.infer<typeof ActionOriginSchema>;

export const MAX_WAIT_MS = 60_000;
export const MAX_REFUEL_QUANTITY = 64;

const quantity = z.int().min(1).max(MAX_TRANSFER_QUANTITY);

// ---------------------------------------------------------------------------
// Action specs: the type + bounded arguments. Plans and recipe steps use specs.
// ---------------------------------------------------------------------------

export const ObserveStateSpec = z.strictObject({
  type: z.literal('OBSERVE_STATE'),
  args: z.strictObject({}),
});
export const MoveToSpec = z.strictObject({
  type: z.literal('MOVE_TO'),
  args: z.strictObject({
    target: PositionSchema,
    /** Arrival radius in blocks. */
    tolerance: z.number().min(0.5).max(5),
  }),
});
export const WaitSpec = z.strictObject({
  type: z.literal('WAIT'),
  args: z.strictObject({ durationMs: z.int().min(50).max(MAX_WAIT_MS) }),
});
export const EatFoodSpec = z.strictObject({
  type: z.literal('EAT_FOOD'),
  args: z.strictObject({ item: ItemNameSchema }),
});
export const ReturnToSafeLocationSpec = z.strictObject({
  type: z.literal('RETURN_TO_SAFE_LOCATION'),
  args: z.strictObject({ locationName: LocationNameSchema }),
});
export const OpenContainerSpec = z.strictObject({
  type: z.literal('OPEN_CONTAINER'),
  args: z.strictObject({ containerId: EntityIdSchema }),
});
export const DepositItemSpec = z.strictObject({
  type: z.literal('DEPOSIT_ITEM'),
  args: z.strictObject({ containerId: EntityIdSchema, item: ItemNameSchema, quantity }),
});
export const WithdrawItemSpec = z.strictObject({
  type: z.literal('WITHDRAW_ITEM'),
  args: z.strictObject({ containerId: EntityIdSchema, item: ItemNameSchema, quantity }),
});
export const InspectMachineSpec = z.strictObject({
  type: z.literal('INSPECT_MACHINE'),
  args: z.strictObject({ machineId: EntityIdSchema }),
});
export const RefuelKnownGeneratorSpec = z.strictObject({
  type: z.literal('REFUEL_KNOWN_GENERATOR'),
  args: z.strictObject({
    generatorId: EntityIdSchema,
    fuelItem: ItemNameSchema,
    quantity: z.int().min(1).max(MAX_REFUEL_QUANTITY),
  }),
});
/**
 * Break ONE block: an allowlisted natural block (logs, leaves, dirt, grass, sand, gravel,
 * clay) that the observation lists within reach. See docs/action-contract.md.
 */
export const DigBlockSpec = z.strictObject({
  type: z.literal('DIG_BLOCK'),
  args: z.strictObject({ position: BlockPositionSchema }),
});
export const PauseAndAskUserSpec = z.strictObject({
  type: z.literal('PAUSE_AND_ASK_USER'),
  args: z.strictObject({ question: z.string().min(1).max(500) }),
});

export const ActionSpecSchema = z.discriminatedUnion('type', [
  ObserveStateSpec,
  MoveToSpec,
  WaitSpec,
  EatFoodSpec,
  ReturnToSafeLocationSpec,
  OpenContainerSpec,
  DepositItemSpec,
  WithdrawItemSpec,
  InspectMachineSpec,
  RefuelKnownGeneratorSpec,
  DigBlockSpec,
  PauseAndAskUserSpec,
]);
export type ActionSpec = z.infer<typeof ActionSpecSchema>;
export type ActionSpecOf<T extends ActionType> = Extract<ActionSpec, { type: T }>;

// ---------------------------------------------------------------------------
// Postconditions: what must be observably true after the action.
// ---------------------------------------------------------------------------

export const PostconditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('STATE_OBSERVED') }),
  z.strictObject({
    kind: z.literal('PLAYER_NEAR'),
    target: PositionSchema,
    tolerance: z.number().min(0.5).max(5),
  }),
  z.strictObject({ kind: z.literal('TIME_ELAPSED'), minMs: z.int().min(0).max(MAX_WAIT_MS) }),
  z.strictObject({ kind: z.literal('FOOD_CONSUMED'), item: ItemNameSchema }),
  z.strictObject({ kind: z.literal('AT_SAFE_LOCATION'), locationName: LocationNameSchema }),
  z.strictObject({ kind: z.literal('CONTAINER_OPEN'), containerId: EntityIdSchema }),
  z.strictObject({
    kind: z.literal('ITEMS_MOVED'),
    direction: z.enum(['player_to_container', 'container_to_player']),
    containerId: EntityIdSchema,
    item: ItemNameSchema,
    quantity,
  }),
  z.strictObject({ kind: z.literal('MACHINE_INSPECTED'), machineId: EntityIdSchema }),
  z.strictObject({
    kind: z.literal('GENERATOR_REFUELED'),
    generatorId: EntityIdSchema,
    fuelItem: ItemNameSchema,
    quantity: z.int().min(1).max(MAX_REFUEL_QUANTITY),
  }),
  /** The observed block at the position is air (the observation saw the block removed). */
  z.strictObject({ kind: z.literal('BLOCK_REMOVED'), position: BlockPositionSchema }),
  z.strictObject({ kind: z.literal('USER_NOTIFIED') }),
]);
export type Postcondition = z.infer<typeof PostconditionSchema>;

/**
 * The postcondition is derived from the spec in code. Proposers (including a
 * future LLM planner) cannot weaken it: validation rejects any action whose
 * declared postcondition differs from this derivation.
 */
export function expectedPostconditionFor(spec: ActionSpec): Postcondition {
  switch (spec.type) {
    case 'OBSERVE_STATE':
      return { kind: 'STATE_OBSERVED' };
    case 'MOVE_TO':
      return { kind: 'PLAYER_NEAR', target: spec.args.target, tolerance: spec.args.tolerance };
    case 'WAIT':
      return { kind: 'TIME_ELAPSED', minMs: spec.args.durationMs };
    case 'EAT_FOOD':
      return { kind: 'FOOD_CONSUMED', item: spec.args.item };
    case 'RETURN_TO_SAFE_LOCATION':
      return { kind: 'AT_SAFE_LOCATION', locationName: spec.args.locationName };
    case 'OPEN_CONTAINER':
      return { kind: 'CONTAINER_OPEN', containerId: spec.args.containerId };
    case 'DEPOSIT_ITEM':
      return {
        kind: 'ITEMS_MOVED',
        direction: 'player_to_container',
        containerId: spec.args.containerId,
        item: spec.args.item,
        quantity: spec.args.quantity,
      };
    case 'WITHDRAW_ITEM':
      return {
        kind: 'ITEMS_MOVED',
        direction: 'container_to_player',
        containerId: spec.args.containerId,
        item: spec.args.item,
        quantity: spec.args.quantity,
      };
    case 'INSPECT_MACHINE':
      return { kind: 'MACHINE_INSPECTED', machineId: spec.args.machineId };
    case 'REFUEL_KNOWN_GENERATOR':
      return {
        kind: 'GENERATOR_REFUELED',
        generatorId: spec.args.generatorId,
        fuelItem: spec.args.fuelItem,
        quantity: spec.args.quantity,
      };
    case 'DIG_BLOCK':
      return { kind: 'BLOCK_REMOVED', position: spec.args.position };
    case 'PAUSE_AND_ASK_USER':
      return { kind: 'USER_NOTIFIED' };
  }
}

// ---------------------------------------------------------------------------
// Full actions: spec + metadata. Built only through createAction().
// ---------------------------------------------------------------------------

export const ActionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,80}$/);

const actionMetadata = {
  actionId: ActionIdSchema,
  reason: z.string().min(1).max(500),
  origin: ActionOriginSchema,
  timestamp: TimestampSchema,
  expectedPostcondition: PostconditionSchema,
  taskId: EntityIdSchema.nullable(),
};

export const ActionSchema = z.discriminatedUnion('type', [
  ObserveStateSpec.extend(actionMetadata),
  MoveToSpec.extend(actionMetadata),
  WaitSpec.extend(actionMetadata),
  EatFoodSpec.extend(actionMetadata),
  ReturnToSafeLocationSpec.extend(actionMetadata),
  OpenContainerSpec.extend(actionMetadata),
  DepositItemSpec.extend(actionMetadata),
  WithdrawItemSpec.extend(actionMetadata),
  InspectMachineSpec.extend(actionMetadata),
  RefuelKnownGeneratorSpec.extend(actionMetadata),
  DigBlockSpec.extend(actionMetadata),
  PauseAndAskUserSpec.extend(actionMetadata),
]);
export type Action = z.infer<typeof ActionSchema>;

export interface CreateActionInput {
  spec: ActionSpec;
  reason: string;
  origin: ActionOrigin;
  taskId: string | null;
}

export interface CreateActionDeps {
  newId: (prefix: string) => string;
  now: () => Date;
}

/** Builds a schema-valid action with the code-derived postcondition. Throws on invalid input. */
export function createAction(input: CreateActionInput, deps: CreateActionDeps): Action {
  const spec = ActionSpecSchema.parse(input.spec);
  return ActionSchema.parse({
    ...spec,
    actionId: deps.newId('act'),
    reason: input.reason,
    origin: input.origin,
    timestamp: deps.now().toISOString(),
    expectedPostcondition: expectedPostconditionFor(spec),
    taskId: input.taskId,
  });
}

export function toSpec(action: Action): ActionSpec {
  return ActionSpecSchema.parse({ type: action.type, args: action.args });
}

export function isAllowlistedActionType(type: unknown): type is ActionType {
  return ActionTypeSchema.safeParse(type).success;
}
