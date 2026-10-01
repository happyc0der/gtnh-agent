import { z } from 'zod';
import {
  BlockPositionSchema,
  COORDINATE_LIMIT,
  EntityIdSchema,
  EntityNumberSchema,
  ItemNameSchema,
  LocationNameSchema,
  MAX_TRANSFER_QUANTITY,
  PositionSchema,
  TimestampSchema,
} from './common.ts';
import { PlaceableBlockSchema, PlaceableItemSchema, placedBlockOf } from './blocks.ts';
import { QuestIdSchema } from './quest-book.ts';
import { ingredientRequirements, MAX_CRAFT_TIMES, RECIPES, RecipeIdSchema } from './recipes.ts';

/**
 * The complete allowlist of in-game actions. Anything not listed here is rejected
 * by schema validation before it reaches the safety policy or the executor.
 *
 * Deliberately absent: lava interaction, dropping items, electrical-network or multiblock
 * changes, and rare-item consumption. Blocks are broken only by DIG_BLOCK and placed only by
 * PLACE_BLOCK, each only with the blocks on its allowlist (src/domain/blocks.ts). Blocks are
 * right-clicked only by the window actions, and only blocks with an interaction profile or on
 * the observe-only allowlist (src/domain/interactions.ts). The only combat is ATTACK_ENTITY
 * on one observed hostile or farm animal (src/domain/combat.ts).
 */
export const ACTION_TYPES = [
  'OBSERVE_STATE',
  'MOVE_TO',
  'EXPLORE',
  'WAIT',
  'EAT_FOOD',
  'RETURN_TO_SAFE_LOCATION',
  'OPEN_CONTAINER',
  'DEPOSIT_ITEM',
  'WITHDRAW_ITEM',
  'INSPECT_MACHINE',
  'REFUEL_KNOWN_GENERATOR',
  'DIG_BLOCK',
  'PLACE_BLOCK',
  'CRAFT_ITEM',
  'INTERACT_BLOCK',
  'SMELT',
  'TAKE_OUTPUT',
  'ATTACK_ENTITY',
  'PAUSE_AND_ASK_USER',
  // Quest-book clicks (Better Questing): taken by the play loop, never by a plan.
  'SUBMIT_QUEST',
  'CHECK_QUEST_BOX',
  'CLAIM_QUEST_REWARD',
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
/** Longest EXPLORE: blocks walked (path length) in one action. */
export const MAX_EXPLORE_DISTANCE = 96;
/** Shortest EXPLORE worth asking for. */
export const MIN_EXPLORE_DISTANCE = 8;
/** Compass directions EXPLORE takes: north is -z, east is +x (Minecraft's own convention). */
export const EXPLORE_DIRECTIONS = [
  'north',
  'north_east',
  'east',
  'south_east',
  'south',
  'south_west',
  'west',
  'north_west',
] as const;
export const ExploreDirectionSchema = z.enum(EXPLORE_DIRECTIONS);
export type ExploreDirection = z.infer<typeof ExploreDirectionSchema>;
/** Where EXPLORE heads: a compass direction, or a point (x, z) of the world. */
export const ExploreTowardSchema = z.union([
  ExploreDirectionSchema,
  z.strictObject({
    x: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
    z: z.number().min(-COORDINATE_LIMIT).max(COORDINATE_LIMIT),
  }),
]);
export type ExploreToward = z.infer<typeof ExploreTowardSchema>;
const exploreDistance = z.int().min(MIN_EXPLORE_DISTANCE).max(MAX_EXPLORE_DISTANCE);
/**
 * Walk over land toward a direction or a point, in hops, at most `maxDistance` blocks, and
 * remember what was seen on the way. See docs/action-contract.md.
 */
export const ExploreSpec = z.strictObject({
  type: z.literal('EXPLORE'),
  args: z.strictObject({ toward: ExploreTowardSchema, maxDistance: exploreDistance }),
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
/**
 * Place ONE block the player carries (an allowlisted plain block: dirt, cobblestone, sand,
 * gravel, sandstone, planks, logs) into the empty cell at `position`, which the observation
 * lists as placeable. See docs/action-contract.md.
 */
export const PlaceBlockSpec = z.strictObject({
  type: z.literal('PLACE_BLOCK'),
  args: z.strictObject({ position: BlockPositionSchema, item: PlaceableItemSchema }),
});
/**
 * Craft `times` times with a recipe from the agent's table (src/domain/recipes.ts), in the
 * player's own 2x2 grid (craftingTableId null) or at a configured crafting table (3x3).
 */
export const CraftItemSpec = z.strictObject({
  type: z.literal('CRAFT_ITEM'),
  args: z.strictObject({
    recipe: RecipeIdSchema,
    times: z.int().min(1).max(MAX_CRAFT_TIMES),
    craftingTableId: EntityIdSchema.nullable(),
  }),
});
/** Largest number of items one SMELT puts into a furnace slot (one stack). */
export const MAX_SMELT_QUANTITY = 64;

/**
 * Right-click (open) ONE block that has an interaction profile, or that the operator
 * allowlisted to look at, with an empty hand, and report its window
 * (src/domain/interactions.ts).
 */
export const InteractBlockSpec = z.strictObject({
  type: z.literal('INTERACT_BLOCK'),
  args: z.strictObject({ position: BlockPositionSchema }),
});
/**
 * Put exactly `quantity` of `input` into a furnace's input slot and `fuelQuantity` of an
 * approved `fuel` into its fuel slot (0 = no fuel added). The furnace keeps them and
 * smelts on its own (200 ticks per item); TAKE_OUTPUT collects the result later.
 */
export const SmeltSpec = z.strictObject({
  type: z.literal('SMELT'),
  args: z.strictObject({
    position: BlockPositionSchema,
    input: ItemNameSchema,
    quantity: z.int().min(1).max(MAX_SMELT_QUANTITY),
    fuel: ItemNameSchema,
    fuelQuantity: z.int().min(0).max(MAX_SMELT_QUANTITY),
  }),
});
/** Take everything in a furnace's output slot, which must hold `item`, into the inventory. */
export const TakeOutputSpec = z.strictObject({
  type: z.literal('TAKE_OUTPUT'),
  args: z.strictObject({ position: BlockPositionSchema, item: ItemNameSchema }),
});
/**
 * Engage ONE observed entity for a short burst: strike it (with the best allowlisted weapon in
 * the hotbar, else an empty hand) whenever it is within reach, until it dies or the burst ends.
 * Only identified hostiles that fight in melee or at range, and unowned farm animals. The
 * player does not move. See docs/action-contract.md.
 */
export const AttackEntitySpec = z.strictObject({
  type: z.literal('ATTACK_ENTITY'),
  args: z.strictObject({ entityId: EntityNumberSchema }),
});
export const PauseAndAskUserSpec = z.strictObject({
  type: z.literal('PAUSE_AND_ASK_USER'),
  args: z.strictObject({ question: z.string().min(1).max(500) }),
});
/** Better Questing's task and reward indexes (what task_checkbox and choice_reward name). */
const QuestIndexSchema = z.int().min(0).max(1023);
/**
 * The quest book's "Submit" button (Better Questing quest_action 1, detect) for one quest the
 * server lists as active. Retrieval tasks marked consume TAKE the matching items. Verified by
 * the server recording the quest as completed.
 */
export const SubmitQuestSpec = z.strictObject({
  type: z.literal('SUBMIT_QUEST'),
  args: z.strictObject({ questId: QuestIdSchema }),
});
/** Ticks a checkbox task in the quest book (bq_standard task_checkbox). */
export const CheckQuestBoxSpec = z.strictObject({
  type: z.literal('CHECK_QUEST_BOX'),
  args: z.strictObject({ questId: QuestIdSchema, taskIndex: QuestIndexSchema }),
});
/**
 * Claims a completed quest's rewards (quest_action 0). `choice` selects the item of the quest's
 * choice reward (choice_reward first), and must be null when it has none.
 */
export const ClaimQuestRewardSpec = z.strictObject({
  type: z.literal('CLAIM_QUEST_REWARD'),
  args: z.strictObject({ questId: QuestIdSchema, choice: QuestIndexSchema.nullable() }),
});

export const ActionSpecSchema = z.discriminatedUnion('type', [
  ObserveStateSpec,
  MoveToSpec,
  ExploreSpec,
  WaitSpec,
  EatFoodSpec,
  ReturnToSafeLocationSpec,
  OpenContainerSpec,
  DepositItemSpec,
  WithdrawItemSpec,
  InspectMachineSpec,
  RefuelKnownGeneratorSpec,
  DigBlockSpec,
  PlaceBlockSpec,
  CraftItemSpec,
  InteractBlockSpec,
  SmeltSpec,
  TakeOutputSpec,
  AttackEntitySpec,
  PauseAndAskUserSpec,
  SubmitQuestSpec,
  CheckQuestBoxSpec,
  ClaimQuestRewardSpec,
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
  /**
   * The player is observably farther along the heading (toward the point, or in the
   * direction) by at least 1 block, and moved no more than maxDistance blocks.
   */
  z.strictObject({
    kind: z.literal('EXPLORED'),
    toward: ExploreTowardSchema,
    maxDistance: exploreDistance,
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
  /**
   * The observation saw the empty cell at the position become `block`, which is still there,
   * and the inventory holds exactly one `item` fewer.
   */
  z.strictObject({
    kind: z.literal('BLOCK_PLACED'),
    position: BlockPositionSchema,
    block: PlaceableBlockSchema,
    item: PlaceableItemSchema,
  }),
  z.strictObject({
    kind: z.literal('ITEMS_CRAFTED'),
    recipe: RecipeIdSchema,
    /** The result item and how many of it the inventory gains in total. */
    result: ItemNameSchema,
    quantity: z
      .int()
      .min(1)
      .max(MAX_CRAFT_TIMES * 64),
    /** Per pattern key: the items it may be made of, and how many of them are used in total. */
    ingredients: z
      .array(
        z.strictObject({
          anyOf: z.array(ItemNameSchema).min(1).max(16),
          quantity: z
            .int()
            .min(1)
            .max(MAX_CRAFT_TIMES * 9),
        }),
      )
      .min(1)
      .max(9),
  }),
  /** A window of the block at the position was opened and seen (still open, unless observe-only). */
  z.strictObject({ kind: z.literal('BLOCK_WINDOW_SEEN'), position: BlockPositionSchema }),
  /** The inventory lost exactly the input and fuel, and the furnace window shows them. */
  z.strictObject({
    kind: z.literal('FURNACE_LOADED'),
    position: BlockPositionSchema,
    input: ItemNameSchema,
    quantity: z.int().min(1).max(MAX_SMELT_QUANTITY),
    fuel: ItemNameSchema,
    fuelQuantity: z.int().min(0).max(MAX_SMELT_QUANTITY),
  }),
  /** The inventory gained exactly what the client took from the furnace's output slot. */
  z.strictObject({
    kind: z.literal('FURNACE_OUTPUT_TAKEN'),
    position: BlockPositionSchema,
    item: ItemNameSchema,
  }),
  /**
   * The observed entity took damage (its health fell, or the server showed it hurt when its
   * health is not known) or died, after the action started.
   */
  z.strictObject({ kind: z.literal('ENTITY_ATTACKED'), entityId: EntityNumberSchema }),
  z.strictObject({ kind: z.literal('USER_NOTIFIED') }),
  /** The server's quest book records the quest as completed (and only consume items left). */
  z.strictObject({ kind: z.literal('QUEST_COMPLETED'), questId: QuestIdSchema }),
  /** The server's quest book records the checkbox task as done (or the quest as completed). */
  z.strictObject({
    kind: z.literal('QUEST_TASK_CHECKED'),
    questId: QuestIdSchema,
    taskIndex: QuestIndexSchema,
  }),
  /** The server records the rewards as claimed, and the inventory gained exactly them. */
  z.strictObject({
    kind: z.literal('QUEST_REWARD_CLAIMED'),
    questId: QuestIdSchema,
    choice: QuestIndexSchema.nullable(),
  }),
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
    case 'EXPLORE':
      return { kind: 'EXPLORED', toward: spec.args.toward, maxDistance: spec.args.maxDistance };
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
    case 'PLACE_BLOCK':
      return {
        kind: 'BLOCK_PLACED',
        position: spec.args.position,
        block: placedBlockOf(spec.args.item),
        item: spec.args.item,
      };
    case 'CRAFT_ITEM': {
      const recipe = RECIPES[spec.args.recipe];
      const times = spec.args.times;
      return {
        kind: 'ITEMS_CRAFTED',
        recipe: recipe.id,
        result: recipe.result.item,
        quantity: recipe.result.count * times,
        ingredients: ingredientRequirements(recipe).map((r) => ({
          anyOf: [...r.anyOf],
          quantity: r.perCraft * times,
        })),
      };
    }
    case 'INTERACT_BLOCK':
      return { kind: 'BLOCK_WINDOW_SEEN', position: spec.args.position };
    case 'SMELT':
      return { kind: 'FURNACE_LOADED', ...spec.args };
    case 'TAKE_OUTPUT':
      return { kind: 'FURNACE_OUTPUT_TAKEN', ...spec.args };
    case 'ATTACK_ENTITY':
      return { kind: 'ENTITY_ATTACKED', entityId: spec.args.entityId };
    case 'PAUSE_AND_ASK_USER':
      return { kind: 'USER_NOTIFIED' };
    case 'SUBMIT_QUEST':
      return { kind: 'QUEST_COMPLETED', questId: spec.args.questId };
    case 'CHECK_QUEST_BOX':
      return {
        kind: 'QUEST_TASK_CHECKED',
        questId: spec.args.questId,
        taskIndex: spec.args.taskIndex,
      };
    case 'CLAIM_QUEST_REWARD':
      return {
        kind: 'QUEST_REWARD_CLAIMED',
        questId: spec.args.questId,
        choice: spec.args.choice,
      };
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
  ExploreSpec.extend(actionMetadata),
  WaitSpec.extend(actionMetadata),
  EatFoodSpec.extend(actionMetadata),
  ReturnToSafeLocationSpec.extend(actionMetadata),
  OpenContainerSpec.extend(actionMetadata),
  DepositItemSpec.extend(actionMetadata),
  WithdrawItemSpec.extend(actionMetadata),
  InspectMachineSpec.extend(actionMetadata),
  RefuelKnownGeneratorSpec.extend(actionMetadata),
  DigBlockSpec.extend(actionMetadata),
  PlaceBlockSpec.extend(actionMetadata),
  CraftItemSpec.extend(actionMetadata),
  InteractBlockSpec.extend(actionMetadata),
  SmeltSpec.extend(actionMetadata),
  TakeOutputSpec.extend(actionMetadata),
  AttackEntitySpec.extend(actionMetadata),
  PauseAndAskUserSpec.extend(actionMetadata),
  SubmitQuestSpec.extend(actionMetadata),
  CheckQuestBoxSpec.extend(actionMetadata),
  ClaimQuestRewardSpec.extend(actionMetadata),
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
