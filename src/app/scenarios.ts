import type { MockMinecraftClient, MockWorld } from '../bot/mock-minecraft-client.ts';
import type { AgentConfigInput } from '../config/env.ts';
import type { ActionType } from '../domain/actions.ts';
import type { Decision } from '../domain/decisions.ts';
import type { PlannerFixture } from '../planner/mock-planner-provider.ts';
import type { CycleStatus } from './agent-loop.ts';

/**
 * Named, deterministic mock situations for the CLI and the integration tests.
 * Item/machine names are placeholders, not verified GTNH identifiers.
 */
export interface Scenario {
  name: string;
  description: string;
  world(): MockWorld;
  setup?(client: MockMinecraftClient): void;
  plannerFixtures?: PlannerFixture[];
  /** What a single cycle is expected to do (asserted by tests/app/scenarios.test.ts). */
  expect: { decision: Decision; actionType: ActionType; status: CycleStatus };
}

export const MOCK_CONFIG: AgentConfigInput = {
  database: { path: './data/agent.sqlite' },
  locations: {
    home: {
      dimension: 'overworld',
      position: { x: 0, y: 64, z: 0 },
      kind: 'safe',
      note: 'mock base',
    },
  },
  routing: { homeLocationName: 'home', dumpContainerId: 'chest.main', keepItems: [] },
  safety: { protectedItems: ['minecraft:diamond', 'minecraft:nether_star'] },
};

export function baseWorld(taskId: string): MockWorld {
  return {
    player: { position: { x: 1, y: 64, z: 1 }, dimension: 'overworld', health: 20, hunger: 18 },
    inventory: {
      items: {
        'minecraft:bread': 6,
        'minecraft:coal': 16,
        'minecraft:cobblestone': 64,
        'minecraft:iron_ore': 12,
        'minecraft:diamond': 1,
      },
      capacitySlots: 36,
    },
    hostiles: [],
    unclassified: [],
    hazards: [],
    // A dirt block next to the player, the ground under it, and a small tree further off.
    resourceBlocks: [
      { block: 'minecraft:dirt', position: { x: 2, y: 64, z: 1 } },
      { block: 'minecraft:grass', position: { x: 1, y: 63, z: 1 } },
      { block: 'minecraft:log', position: { x: -2, y: 64, z: 4 } },
      { block: 'minecraft:leaves', position: { x: -2, y: 65, z: 4 } },
    ],
    removedBlocks: [],
    containers: [
      {
        id: 'chest.main',
        name: 'Main storage chest',
        position: { x: 3, y: 64, z: 0 },
        items: { 'minecraft:cobblestone': 128 },
      },
    ],
    generators: [
      {
        id: 'gen.1',
        name: 'Mock fuel generator',
        position: { x: -3, y: 64, z: 0 },
        fuel: { 'minecraft:coal': 8 },
        acceptedFuels: ['minecraft:coal', 'minecraft:charcoal'],
      },
    ],
    machines: [
      {
        id: 'machine.macerator.1',
        name: 'Macerator (mock)',
        position: { x: -1, y: 64, z: 3 },
        status: 'idle',
        powered: true,
        lastInspectedAt: null,
      },
    ],
    craftingTables: [
      { id: 'table.main', name: 'Crafting table (mock)', position: { x: 2, y: 64, z: -2 } },
    ],
    craftingResults: {},
    openContainerId: null,
    task: { taskId, goal: 'Process iron ore', subgoal: 'Check the macerator', status: 'active' },
    recipe: {
      target: 'crushed iron ore (mock)',
      missingComponents: {},
      requiredMachineIds: ['machine.macerator.1'],
      nextKnownSafeStep: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
    },
    foodValues: { 'minecraft:bread': 5, 'minecraft:cooked_beef': 8 },
    unobservable: [],
    observationLagMs: 0,
    reach: 4.5,
    blocksPerSecond: 4.3,
  };
}

function scenario(
  name: string,
  description: string,
  expect: Scenario['expect'],
  mutate: (w: MockWorld) => void = () => undefined,
  extra: Pick<Scenario, 'setup' | 'plannerFixtures'> = {},
): Scenario {
  return {
    name,
    description,
    expect,
    world: () => {
      const w = baseWorld(`task-${name}`);
      mutate(w);
      return w;
    },
    ...extra,
  };
}

const noKnownStep = (w: MockWorld): void => {
  if (w.recipe !== null) w.recipe.nextKnownSafeStep = null;
};

/** The task's known next step digs the block at (x, y, z). */
const digStep =
  (x: number, y: number, z: number) =>
  (w: MockWorld): void => {
    if (w.recipe !== null) {
      w.recipe.nextKnownSafeStep = { type: 'DIG_BLOCK', args: { position: { x, y, z } } };
    }
  };

const fetchPlan = {
  goal: 'Fetch cobblestone for the next step',
  steps: [
    {
      step: 1,
      action: {
        type: 'WITHDRAW_ITEM',
        args: { containerId: 'chest.main', item: 'minecraft:cobblestone', quantity: 64 },
      },
      rationale: 'Cobblestone is needed and the main chest has some.',
    },
    {
      step: 2,
      action: { type: 'INSPECT_MACHINE', args: { machineId: 'machine.macerator.1' } },
      rationale: 'Confirm the macerator is idle before continuing.',
    },
  ],
  requiresUserApproval: false,
  explanation: 'Two low-risk steps using only known containers and machines.',
  failureHandling: {
    onStepFailure: 'PAUSE_AND_ASK_USER',
    maxRetriesPerStep: 1,
    escalationMessage: 'Could not fetch cobblestone.',
  },
};

export const SCENARIOS: readonly Scenario[] = [
  scenario('nominal', 'Active task with a known safe next step (inspect the macerator).', {
    decision: 'EXECUTE_KNOWN_SAFE_STEP',
    actionType: 'INSPECT_MACHINE',
    status: 'succeeded',
  }),
  scenario(
    'hungry',
    'Food level 8 with bread in the inventory.',
    { decision: 'EAT', actionType: 'EAT_FOOD', status: 'succeeded' },
    (w) => {
      w.player.hunger = 8;
    },
  ),
  scenario(
    'low-health',
    'Health 6, away from home.',
    { decision: 'RETREAT_HOME', actionType: 'RETURN_TO_SAFE_LOCATION', status: 'succeeded' },
    (w) => {
      w.player.health = 6;
      w.player.position = { x: 40, y: 64, z: 40 };
    },
  ),
  scenario(
    'lava-nearby',
    'Known lava 2 blocks from the player, away from home.',
    { decision: 'RETREAT_HOME', actionType: 'RETURN_TO_SAFE_LOCATION', status: 'succeeded' },
    (w) => {
      w.player.position = { x: 30, y: 64, z: 30 };
      w.hazards = [{ kind: 'lava', position: { x: 32, y: 63, z: 30 } }];
    },
  ),
  scenario(
    'hostiles-nearby',
    'A hostile mob 4 blocks away.',
    { decision: 'RETREAT_HOME', actionType: 'RETURN_TO_SAFE_LOCATION', status: 'succeeded' },
    (w) => {
      w.player.position = { x: 20, y: 64, z: 20 };
      w.hostiles = [{ x: 24, y: 64, z: 20 }];
    },
  ),
  scenario(
    'inventory-full',
    'Inventory full, main chest within reach.',
    { decision: 'EMPTY_INVENTORY', actionType: 'DEPOSIT_ITEM', status: 'succeeded' },
    (w) => {
      Object.assign(w.inventory.items, {
        'minecraft:cobblestone': 64 * 20,
        'minecraft:gravel': 64 * 8,
        'minecraft:dirt': 64 * 4,
      });
    },
  ),
  scenario(
    'inventory-full-far',
    'Inventory full, main chest out of reach: approach it first.',
    { decision: 'EMPTY_INVENTORY', actionType: 'MOVE_TO', status: 'succeeded' },
    (w) => {
      w.player.position = { x: 25, y: 64, z: 0 };
      Object.assign(w.inventory.items, {
        'minecraft:cobblestone': 64 * 20,
        'minecraft:gravel': 64 * 8,
        'minecraft:dirt': 64 * 4,
      });
    },
  ),
  scenario(
    'generator-out-of-fuel',
    'The known generator is empty and the player carries approved coal.',
    { decision: 'REFUEL_GENERATOR', actionType: 'REFUEL_KNOWN_GENERATOR', status: 'succeeded' },
    (w) => {
      const g = w.generators[0];
      if (g !== undefined) g.fuel = {};
    },
  ),
  scenario(
    'machine-busy',
    'The macerator the task needs is busy.',
    { decision: 'WAIT_FOR_MACHINE', actionType: 'WAIT', status: 'succeeded' },
    (w) => {
      const m = w.machines[0];
      if (m !== undefined) m.status = 'busy';
    },
  ),
  scenario(
    'no-task',
    'Nothing to do: no active task.',
    { decision: 'PAUSE_AND_ASK_USER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    (w) => {
      w.task = null;
      w.recipe = null;
    },
  ),
  scenario(
    'needs-planner',
    'Active task with no known step; the mock planner returns a 2-step plan (one step per run).',
    { decision: 'REQUEST_PLANNER', actionType: 'WITHDRAW_ITEM', status: 'succeeded' },
    noKnownStep,
    {
      plannerFixtures: [
        { name: 'fetch-cobblestone', when: {}, response: { kind: 'plan', plan: fetchPlan } },
      ],
    },
  ),
  scenario(
    'planner-needs-approval',
    'The planner returns a plan that requires user approval.',
    { decision: 'REQUEST_PLANNER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    noKnownStep,
    {
      plannerFixtures: [
        {
          name: 'approval',
          when: {},
          response: { kind: 'plan', plan: { ...fetchPlan, requiresUserApproval: true } },
        },
      ],
    },
  ),
  scenario(
    'planner-escalates',
    'The planner has no plan and escalates.',
    { decision: 'REQUEST_PLANNER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    noKnownStep,
    { plannerFixtures: [] },
  ),
  scenario(
    'planner-invalid-output',
    'The planner output contains a non-allowlisted PLACE_BLOCK step.',
    { decision: 'REQUEST_PLANNER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    noKnownStep,
    {
      plannerFixtures: [
        {
          name: 'place-block',
          when: {},
          response: {
            kind: 'plan',
            plan: {
              ...fetchPlan,
              steps: [
                {
                  step: 1,
                  action: { type: 'PLACE_BLOCK', args: { x: 0, y: 64, z: 0 } },
                  rationale: 'build',
                },
              ],
            },
          },
        },
      ],
    },
  ),
  scenario(
    'planner-unsafe-plan',
    'The planner plan is well-formed but deposits a protected item.',
    { decision: 'REQUEST_PLANNER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    noKnownStep,
    {
      plannerFixtures: [
        {
          name: 'deposit-diamond',
          when: {},
          response: {
            kind: 'plan',
            plan: {
              ...fetchPlan,
              steps: [
                {
                  step: 1,
                  action: {
                    type: 'DEPOSIT_ITEM',
                    args: { containerId: 'chest.main', item: 'minecraft:diamond', quantity: 1 },
                  },
                  rationale: 'Store the diamond.',
                },
              ],
            },
          },
        },
      ],
    },
  ),
  scenario(
    'stale-state',
    'The observation is 60 s old: fail closed.',
    { decision: 'PAUSE_AND_ASK_USER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    (w) => {
      w.observationLagMs = 60_000;
    },
  ),
  scenario(
    'unknown-health',
    'Health cannot be observed: fail closed.',
    { decision: 'PAUSE_AND_ASK_USER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    (w) => {
      w.unobservable = ['health'];
    },
  ),
  scenario(
    'out-of-bounds',
    'The player is outside the configured boundary.',
    { decision: 'PAUSE_AND_ASK_USER', actionType: 'PAUSE_AND_ASK_USER', status: 'paused' },
    (w) => {
      w.player.position = { x: 1000, y: 64, z: 0 };
    },
  ),
  scenario(
    'protected-item-step',
    'The known next step would deposit a protected diamond: rejected.',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DEPOSIT_ITEM', status: 'rejected' },
    (w) => {
      if (w.recipe !== null) {
        w.recipe.nextKnownSafeStep = {
          type: 'DEPOSIT_ITEM',
          args: { containerId: 'chest.main', item: 'minecraft:diamond', quantity: 1 },
        };
      }
    },
  ),
  scenario(
    'dig',
    'The known next step digs the dirt block next to the player: dug, the drop collected, verified.',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DIG_BLOCK', status: 'succeeded' },
    digStep(2, 64, 1),
  ),
  scenario(
    'dig-under-feet',
    'The known next step would dig the grass block the player stands on: rejected (not listed).',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DIG_BLOCK', status: 'rejected' },
    digStep(1, 63, 1),
  ),
  scenario(
    'dig-sand-overhead',
    "The known next step would dig sand right above the player's head: rejected (UNSAFE_DIG).",
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DIG_BLOCK', status: 'rejected' },
    (w) => {
      w.resourceBlocks.push({ block: 'minecraft:sand', position: { x: 1, y: 66, z: 1 } });
      digStep(1, 66, 1)(w);
    },
  ),
  scenario(
    'dig-not-diggable',
    'The known next step would dig the storage chest, which is not a diggable block: rejected.',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DIG_BLOCK', status: 'rejected' },
    digStep(3, 64, 0),
  ),
  scenario(
    'dig-verification-fails',
    'The client claims it dug, but the block is still there: postcondition check fails.',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'DIG_BLOCK', status: 'verification_failed' },
    digStep(2, 64, 1),
    { setup: (client) => client.silentNoop('DIG_BLOCK') },
  ),
  scenario(
    'craft-known-step',
    'The known next step crafts planks from logs in the 2x2 grid.',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'CRAFT_ITEM', status: 'succeeded' },
    (w) => {
      w.inventory.items['minecraft:log'] = 4;
      if (w.recipe !== null) {
        w.recipe.nextKnownSafeStep = {
          type: 'CRAFT_ITEM',
          args: { recipe: 'planks_oak', times: 2, craftingTableId: null },
        };
      }
    },
  ),
  scenario(
    'craft-recipe-differs',
    "The server's recipe differs from the agent's table (vanilla's 4 sticks, not GregTech's 2): nothing is crafted.",
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'CRAFT_ITEM', status: 'failed' },
    (w) => {
      w.inventory.items['minecraft:planks'] = 4;
      w.craftingResults.sticks = { item: 'minecraft:stick', count: 4 };
      if (w.recipe !== null) {
        w.recipe.nextKnownSafeStep = {
          type: 'CRAFT_ITEM',
          args: { recipe: 'sticks', times: 1, craftingTableId: null },
        };
      }
    },
  ),
  scenario(
    'action-fails',
    'The client reports failure for the inspection (run 3x on one DB to see escalation).',
    { decision: 'EXECUTE_KNOWN_SAFE_STEP', actionType: 'INSPECT_MACHINE', status: 'failed' },
    () => undefined,
    {
      setup: (client) => client.failNext('INSPECT_MACHINE', 'simulated: machine GUI did not open'),
    },
  ),
  scenario(
    'verification-fails',
    'The client claims it ate, but nothing changed: postcondition check fails.',
    { decision: 'EAT', actionType: 'EAT_FOOD', status: 'verification_failed' },
    (w) => {
      w.player.hunger = 8;
    },
    { setup: (client) => client.silentNoop('EAT_FOOD') },
  ),
];

export function findScenario(name: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.name === name);
}
