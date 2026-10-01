import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUserAction, syncConfigToDatabase } from '../../../src/app/agent-loop.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import {
  decodePlay,
  writeItemStack,
  type ItemStackData,
} from '../../../src/bot/gtnh1710/packets.ts';
import { FrameDecoder, Reader } from '../../../src/bot/gtnh1710/wire.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { RecipeId } from '../../../src/domain/recipes.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK } from './chunk-fixtures.ts';
import {
  FakeChestSim,
  type FakeIngredient,
  type FakeRecipe,
  type FakeStack,
} from './fake-chests.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5); the table is next to it.
const TABLE = { x: -4, y: 106, z: -6 };
const NOT_A_TABLE = { x: -5, y: 106, z: -6 };
const ID = {
  log: 17,
  planks: 5,
  stick: 280,
  coal: 263,
  torch: 50,
  table: 58,
  chest: 54,
  flint: 318,
  diamond: 264,
};
const ITEMS: Array<[number, string]> = [
  [ID.log, 'minecraft:log'],
  [ID.planks, 'minecraft:planks'],
  [ID.stick, 'minecraft:stick'],
  [ID.coal, 'minecraft:coal'],
  [ID.torch, 'minecraft:torch'],
  [ID.table, 'minecraft:crafting_table'],
  [ID.chest, 'minecraft:chest'],
  [ID.flint, 'minecraft:flint'],
  [ID.diamond, 'minecraft:diamond'],
];

const anyOf = (id: number): FakeIngredient => ({ id, damage: 'any' });
const exact = (id: number, damage = 0): FakeIngredient => ({ id, damage });

/** The server's recipes, GTNH-like: they differ from the agent's table on purpose (sticks). */
const SERVER_RECIPES: FakeRecipe[] = [
  // GregTech's nerfed planks: one log anywhere gives 2 planks of its kind.
  { shapeless: [exact(ID.log, 0)], result: { id: ID.planks, count: 2, damage: 0 } },
  // A sticks recipe that gives 2, while the agent's table expects 4.
  {
    shaped: [[anyOf(ID.planks)], [anyOf(ID.planks)]],
    result: { id: ID.stick, count: 2, damage: 0 },
  },
  // GTNH torches: coal above a stick gives 3.
  { shaped: [[exact(ID.coal)], [exact(ID.stick)]], result: { id: ID.torch, count: 3, damage: 0 } },
  // GTNH chest: logs in the corners, planks on the sides, flint in the middle.
  {
    shaped: [
      [anyOf(ID.log), anyOf(ID.planks), anyOf(ID.log)],
      [anyOf(ID.planks), exact(ID.flint), anyOf(ID.planks)],
      [anyOf(ID.log), anyOf(ID.planks), anyOf(ID.log)],
    ],
    result: { id: ID.chest, count: 1, damage: 0 },
  },
  // No crafting-table recipe at all: GTNH removes the vanilla one.
];

const INVENTORY: NonNullable<FakeServerOptions['inventory']> = [
  { slot: 9, id: ID.log, count: 5, damage: 0 },
  { slot: 10, id: ID.coal, count: 3, damage: 0 },
  { slot: 11, id: ID.stick, count: 4, damage: 0 },
  { slot: 12, id: ID.planks, count: 10, damage: 0 },
  { slot: 13, id: ID.flint, count: 2, damage: 0 },
  { slot: 14, id: ID.diamond, count: 1, damage: 0 },
];

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];
// Each test has its own stop file, so a halted agent (data/STOP) never affects the tests.
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-crafting-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  options: {
    server?: FakeServerOptions;
    craftingEnabled?: boolean;
    protectedItems?: string[];
  } = {},
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: AgentConfig }> {
  const server = new FakeGtnhServer({
    items: ITEMS,
    inventory: INVENTORY,
    tables: [TABLE],
    recipes: SERVER_RECIPES,
    // The block next to the table is a real chest (and so, not a crafting table).
    chests: [{ ...NOT_A_TABLE, size: 27, items: [{ slot: 0, id: ID.log, count: 8, damage: 0 }] }],
    blockOverrides: new Map([
      [`${TABLE.x},${TABLE.y},${TABLE.z}`, BLOCK.craftingTable],
      [`${NOT_A_TABLE.x},${NOT_A_TABLE.y},${NOT_A_TABLE.z}`, BLOCK.chest],
    ]),
    ...options.server,
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
      movement: { stopFile: join(dir, 'STOP') },
      crafting: {
        enabled: options.craftingEnabled ?? true,
        tables: {
          'table.test': { name: 'Test table', position: TABLE },
          'table.fake': { name: 'A chest, not a table', position: NOT_A_TABLE },
        },
      },
      containers: {
        enabled: true,
        chests: { 'chest.test': { name: 'Test chest', position: NOT_A_TABLE } },
      },
    },
    safety: { protectedItems: options.protectedItems ?? ['minecraft:diamond'] },
  });
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
  });
  clients.push(client);
  await client.connect();
  return { server, client, config };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const craft = (
  recipe: RecipeId,
  times: number,
  craftingTableId: string | null = null,
): ActionSpec => ({
  type: 'CRAFT_ITEM',
  args: { recipe, times, craftingTableId },
});
/** Waits (bounded) until the fake server has caught up with what the client sent. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for the fake server');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const total = (stacks: Array<FakeStack | null>, id: number, damage = 0): number =>
  stacks.reduce((n, s) => n + (s?.id === id && s.damage === damage ? s.count : 0), 0);
const empty = (stacks: Array<FakeStack | null>): boolean => stacks.every((s) => s === null);

/** Nothing on the server's cursor, nothing in either crafting grid, nothing dropped. */
function expectClean(server: FakeGtnhServer): void {
  const sim = server.chestSim;
  expect(sim.cursor).toBeNull();
  expect(empty(sim.craftingGrids().inventory)).toBe(true);
  expect(empty(sim.craftingGrids().table)).toBe(true);
  expect(sim.dropped).toEqual([]);
}

describe('the fake server behaves like the verified 1.7.10 server', () => {
  const log = (count: number): ItemStackData => ({ id: ID.log, count, damage: 0, hasNbt: false });
  function fake() {
    const frames: Buffer[] = [];
    const sim = new FakeChestSim({
      chests: [],
      recipes: SERVER_RECIPES,
      playerInventory: [{ slot: 9, id: ID.log, count: 5, damage: 0 }],
      modularUi: false,
      rejectClicks: new Set(),
      send: (f) => frames.push(f),
    });
    const sent = () =>
      frames
        .splice(0)
        .flatMap((f) => new FrameDecoder().push(f))
        .map((f) => decodePlay(f.packetId, f.body));
    let action = 0;
    const click = (slot: number, button: 0 | 1, claimed: ItemStackData | null): void => {
      action += 1;
      const b = Buffer.alloc(6);
      b.writeInt8(0, 0); // window 0
      b.writeInt16BE(slot, 1);
      b.writeInt8(button, 3);
      b.writeInt16BE(action, 4);
      const body = Buffer.concat([b, Buffer.from([0]), writeItemStack(claimed, false)]);
      sim.handle(0x0e, new Reader(body));
    };
    return { sim, sent, click };
  }

  it('sends nothing after an accepted click; a rejected click re-sends the window, result included', () => {
    const { sim, sent, click } = fake();
    click(9, 0, log(5)); // pick up the logs
    click(1, 1, null); // one into the 2x2 grid: the result is now 2 planks, but not sent
    click(9, 0, null); // the other 4 back
    expect(sent().map((p) => p.type)).toEqual([
      'confirm-transaction',
      'confirm-transaction',
      'confirm-transaction',
    ]);
    // An empty slot with an empty cursor, claiming a log: rejected, and nothing changes.
    click(10, 0, log(1));
    const resync = sent();
    expect(resync.map((p) => p.type)).toEqual(['confirm-transaction', 'window-items', 'set-slot']);
    const items = resync[1]?.type === 'window-items' ? resync[1].items : [];
    expect([items[0], items[1], items[9], items[10]]).toEqual([
      { id: ID.planks, count: 2, damage: 0, hasNbt: false },
      log(1),
      log(4),
      null,
    ]);
    expect(sim.cursor).toBeNull();
  });

  it('drops the grid and the cursor when window 0 closes or the player leaves', () => {
    for (const end of ['close', 'disconnect'] as const) {
      const { sim, click } = fake();
      click(9, 0, log(5));
      click(1, 1, null);
      if (end === 'close') sim.handle(0x0d, new Reader(Buffer.from([0])));
      else sim.onDisconnect();
      expect(sim.dropped, end).toEqual([
        { id: ID.log, count: 4, damage: 0 },
        { id: ID.log, count: 1, damage: 0 },
      ]);
    }
  });

  it('a click on the result slot takes the whole result and one item from every grid slot', () => {
    const { sim, sent, click } = fake();
    click(9, 0, log(5));
    click(1, 1, null);
    click(9, 0, null); // the 4 logs back
    click(0, 1, { id: ID.planks, count: 2, damage: 0, hasNbt: false }); // even a right-click
    expect(sent().every((p) => p.type === 'confirm-transaction')).toBe(true);
    expect(sim.clicks.every((c) => c.accepted)).toBe(true);
    expect(sim.cursor).toEqual({ id: ID.planks, count: 2, damage: 0 });
    expect(sim.craftingGrids().inventory).toEqual([null, null, null, null]);
    expect(sim.crafts).toBe(1);
  });
});

describe('Gtnh1710Client crafting', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({ craftingEnabled: false });
    expect(await perform(client, craft('planks_oak', 1))).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    expect(server.playPacketIds().filter((id) => [0x08, 0x0d, 0x0e].includes(id))).toEqual([]);
  });

  it('crafts in the 2x2 inventory grid: exact counts, one sync per craft, nothing dropped', async () => {
    const { server, client } = await start();
    const result = await perform(client, craft('planks_oak', 3));
    expect(result).toMatchObject({ ok: true, data: { crafts: 3 } });

    const state = await client.observe();
    expect(state.inventory.known && state.inventory.value.items).toMatchObject({
      'minecraft:log': 2,
      'minecraft:planks': 16,
    });
    const sim = server.chestSim;
    expect(sim.crafts).toBe(3);
    expect(total(sim.playerSlots(), ID.log)).toBe(2);
    expect(total(sim.playerSlots(), ID.planks)).toBe(16);
    // Each result went into its own empty slot (results are never merged into stacks).
    expect(
      sim
        .playerSlots()
        .filter((s) => s?.id === ID.planks)
        .map((s) => s?.count),
    ).toEqual([10, 2, 2, 2]);
    // Every click was in window 0; the only rejected ones are the syncs (start, 3 crafts, end).
    expect(sim.clicks.every((c) => c.windowId === 0)).toBe(true);
    expect(sim.clicks.filter((c) => !c.accepted)).toHaveLength(5);
    // The sync click is a left-click on an empty slot: it changed nothing.
    expect(sim.openedTypes).toEqual([]);
    expectClean(server);
  });

  it('places two different ingredients (coal above a stick), using a stack up completely', async () => {
    const { server, client } = await start();
    expect(await perform(client, craft('torch_coal', 3))).toMatchObject({ ok: true });
    const state = await client.observe();
    const items = state.inventory.known ? state.inventory.value.items : {};
    expect(items).toMatchObject({ 'minecraft:stick': 1, 'minecraft:torch': 9 });
    expect(items['minecraft:coal']).toBeUndefined();
    expect(server.chestSim.crafts).toBe(3);
    // The used-up coal slot (10) took the last result.
    expect(server.chestSim.playerSlots()[10]).toMatchObject({ id: ID.torch, count: 3 });
    expectClean(server);
  });

  it('crafts right after using a chest: the chest window is closed first, the inventory carries over', async () => {
    const { server, client } = await start();
    const withdraw: ActionSpec = {
      type: 'WITHDRAW_ITEM',
      args: { containerId: 'chest.test', item: 'minecraft:log', quantity: 3 },
    };
    expect(await perform(client, withdraw)).toMatchObject({ ok: true });
    expect((await client.observe()).openContainerId).toBe('chest.test');
    const result = await perform(client, craft('planks_oak', 8));
    expect(result).toMatchObject({ ok: true, data: { crafts: 8 } });
    const state = await client.observe();
    expect(state.openContainerId).toBeNull();
    const items = state.inventory.known ? state.inventory.value.items : {};
    expect(items['minecraft:log']).toBeUndefined();
    expect(items['minecraft:planks']).toBe(26);
    expect(total(server.chestSim.playerSlots(), ID.planks)).toBe(26);
    expect(server.chestSim.clicks.filter((c) => c.windowId === 0)).not.toHaveLength(0);
    expectClean(server);
  });

  it('crafts a 3x3 recipe at a configured crafting table, then closes it with an empty grid', async () => {
    const { server, client } = await start();
    const result = await perform(client, craft('chest', 1, 'table.test'));
    expect(result).toMatchObject({ ok: true, data: { crafts: 1 } });

    const sim = server.chestSim;
    // Opened with an empty hand (slot 36, hotbar 0, is empty), as a crafting table window.
    expect(sim.activations).toEqual([{ ...TABLE, heldSlot: 0 }]);
    expect(sim.openedTypes).toEqual([1]);
    await until(() => sim.openWindowId === null);
    expect(server.playPacketIds().filter((id) => id === 0x0d)).toHaveLength(1);
    const state = await client.observe();
    expect(state.openContainerId).toBeNull();
    expect(state.inventory.known && state.inventory.value.items).toMatchObject({
      'minecraft:log': 1,
      'minecraft:planks': 6,
      'minecraft:flint': 1,
      'minecraft:chest': 1,
    });
    expect(total(sim.playerSlots(), ID.chest)).toBe(1);
    expectClean(server);
  });

  it("takes nothing when the server's result differs, and puts every ingredient back", async () => {
    const { server, client } = await start();
    const before = await client.observe();
    const result = await perform(client, craft('sticks', 2));
    expect(result).toMatchObject({
      ok: false,
      code: 'FAILED',
      data: { crafts: 0, observedResult: '2 x minecraft:stick' },
    });
    expect(result.message).toMatch(
      /the server's crafting result for sticks is 2 x minecraft:stick, not the expected 4 x minecraft:stick/,
    );
    const after = await client.observe();
    expect(after.inventory).toEqual(before.inventory);
    expect(server.chestSim.crafts).toBe(0);
    expect(total(server.chestSim.playerSlots(), ID.planks)).toBe(10);
    expectClean(server);
  });

  it('reports an empty result for a pattern the server has no recipe for', async () => {
    const { server, client } = await start();
    const result = await perform(client, craft('crafting_table', 1));
    expect(result).toMatchObject({ ok: false, code: 'FAILED', data: { observedResult: 'empty' } });
    expect(result.message).toMatch(/is empty, not the expected 1 x minecraft:crafting_table/);
    expect(total(server.chestSim.playerSlots(), ID.planks)).toBe(10);
    expectClean(server);
  });

  it('recovers from a rejected click: the cursor and the grid go back into the inventory', async () => {
    // Click 1 is the opening sync, 2 picks up the logs, 3 puts one into the grid: rejected
    // (the server still applies it, as 1.7.10 does, then re-sends the window).
    const { server, client } = await start({ server: { rejectClicks: [3] } });
    const result = await perform(client, craft('planks_oak', 1));
    expect(result).toMatchObject({ ok: false, code: 'FAILED', data: { crafts: 0 } });
    expect(result.message).toMatch(/craft 1 of 1: a click was rejected/);
    const sim = server.chestSim;
    expect(total(sim.playerSlots(), ID.log)).toBe(5);
    expect(sim.playerSlots()[9]).toEqual({ id: ID.log, count: 5, damage: 0, nbt: undefined });
    expectClean(server);
    const state = await client.observe();
    expect(state.inventory.known && state.inventory.value.items['minecraft:log']).toBe(5);
  });

  it('refuses before any click: too few, NBT-only ingredients, no table, an unknown or wrong block', async () => {
    const { server, client } = await start({
      server: {
        items: ITEMS,
        inventory: [...INVENTORY, { slot: 15, id: ID.log, count: 3, damage: 0 }],
      },
    });
    const refusals: Array<[ActionSpec, RegExp]> = [
      [craft('planks_oak', 9), /craft 9 of 9: not enough ingredients .* minecraft:log/],
      [craft('chest', 1), /chest needs a crafting table/],
      [craft('chest', 1, 'table.nope'), /table.nope is not a configured crafting table/],
      [craft('chest', 1, 'table.fake'), /is minecraft:chest, not a minecraft:crafting_table/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    expect(server.chestSim.clicks).toEqual([]);
    expect(server.chestSim.activations).toEqual([]);
  });

  it('never uses stacks with NBT data', async () => {
    const { server, client } = await start({
      server: {
        items: ITEMS,
        inventory: [{ slot: 9, id: ID.log, count: 4, damage: 0, nbt: true }],
      },
    });
    const r = await perform(client, craft('planks_oak', 1));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(server.chestSim.clicks).toEqual([]);
  });

  it('stops between crafts when halted, with the grid empty', async () => {
    const { server, client } = await start();
    // During the first craft (click 4 puts the logs back), a Ctrl+C arrives.
    server.chestSim.onClick = (n) => {
      if (n === 4) client.halt('test halt');
    };
    const result = await perform(client, craft('planks_oak', 3));
    expect(result).toMatchObject({ ok: false, code: 'FAILED', data: { crafts: 1 } });
    expect(result.message).toMatch(/stopped after 1 of 3 crafts: halted: test halt/);
    expect(server.chestSim.crafts).toBe(1);
    expect(total(server.chestSim.playerSlots(), ID.planks)).toBe(12);
    expectClean(server);
  });

  it('returns leftovers before disconnecting when the server stopped answering mid-craft', async () => {
    const { server, client } = await start();
    const sim = server.chestSim;
    // After click 2 (the logs are on the cursor) the server stops answering clicks.
    sim.onClick = (n) => {
      if (n === 2) sim.ignoreClicks = true;
    };
    const result = await perform(client, craft('planks_oak', 1));
    expect(result).toMatchObject({ ok: false, code: 'ERROR' });
    expect(result.message).toMatch(/^ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR/);
    expect(sim.cursor).toEqual({ id: ID.log, count: 5, damage: 0, nbt: undefined });

    // The server answers again; disconnecting first puts the logs back instead of dropping them.
    sim.ignoreClicks = false;
    await client.disconnect();
    await until(() => sim.disconnects === 1);
    expect(total(sim.playerSlots(), ID.log)).toBe(5);
    expect(sim.dropped).toEqual([]);
  }, 20_000);

  it('goes through the executor: validated, crafted and verified; protected ingredients are refused', async () => {
    const { server, client, config } = await start({
      protectedItems: ['minecraft:diamond', 'minecraft:flint'],
    });
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
    const crafted = await runUserAction(deps, craft('planks_oak', 2), 'test');
    expect(crafted.status).toBe('succeeded');
    expect(
      crafted.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(
      expect.arrayContaining([
        'PASS result-delta',
        'PASS ingredient-delta-1',
        'PASS other-items-unchanged',
      ]),
    );
    // The chest needs flint, which is protected: never used, whatever a human asks.
    expect((await runUserAction(deps, craft('chest', 1, 'table.test'), 'test')).summary).toMatch(
      /rejected \[PROTECTED_ITEM\]/,
    );
    // A recipe the server does not share fails, and the executor reports it.
    const differs = await runUserAction(deps, craft('sticks', 1), 'test');
    expect(differs.status).toBe('failed');
    expect(server.chestSim.activations).toEqual([]);
    expectClean(server);
  });
});
