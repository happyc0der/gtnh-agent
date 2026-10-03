import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { routeForPlanner } from '../../../src/planner/planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { routeActions } from '../../fixtures/route-actions.ts';
import { PLACE_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import type { FakeIngredient, FakeRecipe, FakeStack } from './fixtures/fake-chests.ts';
import { FakeGtnhServer } from './fixtures/fake-server.ts';

// The quest "Tools" on the fake server, from the bot's own inventory after "Crafting Time"
// (logs, flint, the crafting table it made): the route, followed as a planner would, crafts
// planks and sticks in the 2x2 grid, places the table, and crafts the four tools at it. The
// fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105, inside the test fence.
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };
const ID = {
  log: 17,
  planks: 5,
  stick: 280,
  flint: 318,
  table: 58,
  sword: 268,
  shovel: 269,
  pickaxe: 270,
  axe: 271,
  hoe: 290,
};
const ITEMS: Array<[number, string]> = [
  [ID.stick, 'minecraft:stick'],
  [ID.flint, 'minecraft:flint'],
  [ID.table, 'minecraft:crafting_table'],
  [ID.sword, 'minecraft:wooden_sword'],
  [ID.shovel, 'minecraft:wooden_shovel'],
  [ID.pickaxe, 'minecraft:wooden_pickaxe'],
  [ID.axe, 'minecraft:wooden_axe'],
  [ID.hoe, 'minecraft:wooden_hoe'],
];
const P: FakeIngredient = { id: ID.planks, damage: 'any' };
const S: FakeIngredient = { id: ID.stick, damage: 0 };
const tool = (id: number): FakeStack => ({ id, count: 1, damage: 0 });

/** GTNH 2.8.4's recipes for these, as the server matches them (the tools' are vanilla's). */
const RECIPES: FakeRecipe[] = [
  { shapeless: [{ id: ID.log, damage: 0 }], result: { id: ID.planks, count: 2, damage: 0 } },
  { shaped: [[P], [P]], result: { id: ID.stick, count: 2, damage: 0 } },
  {
    shaped: [
      [P, P, P],
      [null, S, null],
      [null, S, null],
    ],
    result: tool(ID.pickaxe),
  },
  { shaped: [[P], [S], [S]], result: tool(ID.shovel) },
  {
    shaped: [
      [P, P],
      [P, S],
      [null, S],
    ],
    result: tool(ID.axe),
  },
  {
    shaped: [
      [P, P],
      [null, S],
      [null, S],
    ],
    result: tool(ID.hoe),
  },
  { shaped: [[P], [P], [S]], result: tool(ID.sword) },
];

const TOOLS = {
  'minecraft:wooden_pickaxe': 1,
  'minecraft:wooden_shovel': 1,
  'minecraft:wooden_axe': 1,
  'minecraft:wooden_hoe': 1,
};

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-tools-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The quest's goal as play hands it to a session: the current task, with what it needs. */
const withGoal = (state: GameState, requirements: Record<string, number>): GameState => ({
  ...state,
  currentTask: {
    taskId: 'quest-0:5',
    goal: 'Age 0 quest "Tools": craft a wooden pickaxe, shovel, axe and hoe',
    subgoal: null,
    status: 'active',
    requirements,
  },
});

describe('the quest "Tools" on the fake server', { timeout: 60_000 }, () => {
  it('crafts planks and sticks in the 2x2 grid, places the table, and the four tools at it', async () => {
    const server = new FakeGtnhServer({
      blocks: PLACE_TEST_BLOCK_REGISTRY,
      items: ITEMS,
      recipes: RECIPES,
      inventory: [
        { slot: 9, id: ID.log, count: 10, damage: 0 },
        { slot: 10, id: ID.flint, count: 2, damage: 0 },
        // The table it made in "Crafting Time", in hand.
        { slot: 36, id: ID.table, count: 1, damage: 0 },
      ],
    });
    servers.push(server);
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await server.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: FENCE, stopFile: join(dir, 'STOP') },
        crafting: { enabled: true, tables: {} },
        placing: { enabled: true },
      },
    });
    const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
    clients.push(client);
    await client.connect();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock: systemClock,
      newId: sequentialIds(),
    };

    // The route from the live inventory: no table known, one held.
    const route = routeForPlanner(withGoal(await client.observe(), TOOLS));
    const steps = route?.steps ?? [];
    const station = steps.find((s) => s.startsWith('station: crafting_table:'));
    expect(station).toMatch(
      /^station: crafting_table: minecraft:crafting_table is held: place it => PLACE_BLOCK \{"position":\{"x":-?\d+,"y":106,"z":-?\d+\},"item":"minecraft:crafting_table"\}/,
    );
    const actions = routeActions(steps);
    const place = actions[0];
    if (place?.type !== 'PLACE_BLOCK') throw new Error(`first action: ${place?.type}`);
    const table = `crafting_table:${place.args.position.x}.${place.args.position.y}.${place.args.position.z}`;
    const crafts = actions.slice(1).flatMap((a) => (a.type === 'CRAFT_ITEM' ? [a.args] : []));
    expect(crafts).toHaveLength(actions.length - 1);
    // Planks and sticks in the 2x2 grid; the tools at the table it places, GTNH's pickaxe and
    // hoe by the knowledge base's ids, the shovel and axe by the hand-verified table's.
    const where = (recipe: string): Array<string | null> =>
      crafts.filter((c) => c.recipe === recipe).map((c) => c.craftingTableId);
    expect(new Set([...where('planks_oak'), ...where('sticks')])).toEqual(new Set([null]));
    for (const recipe of [
      'minecraft:wooden_pickaxe#1',
      'wooden_shovel',
      'wooden_axe',
      'minecraft:wooden_hoe#1',
    ]) {
      expect(where(recipe), recipe).toEqual([table]);
    }

    // Each action as a planner's plan step runs: validated, executed, verified.
    const summaries: string[] = [];
    for (const spec of actions) {
      const r = await runUserAction(deps, spec, 'the route says so');
      summaries.push(r.summary);
      expect(r.status, `${spec.type} ${JSON.stringify(spec.args)}: ${r.summary}`).toBe('succeeded');
    }
    expect(summaries[0]).toBe('USER -> PLACE_BLOCK -> succeeded');

    const state = await client.observe();
    expect(state.craftingTables.map((t) => t.id)).toEqual([table]);
    expect(state.inventory.known && state.inventory.value.items).toMatchObject({
      ...TOOLS,
      'minecraft:flint': 2,
    });
    const items = state.inventory.known ? state.inventory.value.items : {};
    expect(items['minecraft:crafting_table']).toBeUndefined();
    // The server agrees: the table stands where the route said, the tools are in the inventory,
    // and nothing was dropped or left in a grid.
    expect(server.placeSim.placed).toEqual([
      { ...place.args.position, name: 'minecraft:crafting_table' },
    ]);
    const sim = server.chestSim;
    for (const id of [ID.pickaxe, ID.shovel, ID.axe, ID.hoe]) {
      expect(sim.playerSlots().filter((s) => s?.id === id)).toHaveLength(1);
    }
    expect(sim.cursor).toBeNull();
    expect(sim.craftingGrids().inventory.every((s) => s === null)).toBe(true);
    expect(sim.dropped).toEqual([]);
    // The table was opened with an empty hand, as a crafting table window, for each tool.
    expect(sim.openedTypes.every((t) => t === 1)).toBe(true);
    expect(sim.openedTypes.length).toBeGreaterThanOrEqual(1);
  });

  it('a furnace it holds goes on the floor beside it, and then opens as a furnace', async () => {
    const FURNACE_BLOCK = 61;
    const server = new FakeGtnhServer({
      blocks: [
        ...PLACE_TEST_BLOCK_REGISTRY,
        [FURNACE_BLOCK, 'minecraft:furnace'],
        [62, 'minecraft:lit_furnace'],
      ],
      items: ITEMS,
      inventory: [{ slot: 36, id: FURNACE_BLOCK, count: 1, damage: 0 }],
    });
    servers.push(server);
    const config = defaultConfig({
      minecraft: {
        host: '127.0.0.1',
        port: await server.listen(),
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 2_000,
        movement: { enabled: true, fence: FENCE, stopFile: join(dir, 'STOP') },
        placing: { enabled: true },
        interact: { enabled: true },
      },
    });
    const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
    clients.push(client);
    await client.connect();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock: systemClock,
      newId: sequentialIds(),
    };
    // North of the player, on the grass: a cell the observation lists, that takes sand too.
    const at = { x: -5, y: FEET_Y, z: -9 };
    const placed = await runUserAction(
      deps,
      { type: 'PLACE_BLOCK', args: { position: at, item: 'minecraft:furnace' } },
      'test',
    );
    expect(placed.status, placed.summary).toBe('succeeded');
    expect(
      placed.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual([
      'PASS execution-ok',
      'PASS observation-fresh',
      'PASS block-placed',
      'PASS item-used',
    ]);
    const state = await client.observe();
    const listed = state.interactables.known
      ? state.interactables.value.blocks.find((b) => b.position.x === at.x && b.position.z === at.z)
      : undefined;
    expect(listed).toMatchObject({ profile: 'furnace', block: 'minecraft:furnace', position: at });
    const opened = await runUserAction(
      deps,
      { type: 'INTERACT_BLOCK', args: { position: at } },
      'test',
    );
    expect(opened.status, opened.summary).toBe('succeeded');
    expect(server.chestSim.openedTypes).toEqual([2]);
  });
});
