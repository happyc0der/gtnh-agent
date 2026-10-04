import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { decodeFmlRuntimeMessage, decodePlay } from '../../../src/bot/gtnh1710/packets.ts';
import { encodeString, Reader } from '../../../src/bot/gtnh1710/wire.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { BlockPosition } from '../../../src/domain/common.ts';
import type { GameState, InteractableBlock } from '../../../src/domain/game-state.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import type {
  FakeIngredient,
  FakeModBlock,
  FakeRecipe,
  FakeStack,
} from './fixtures/fake-chests.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105.
const FURNACE = { x: -4, y: 106, z: -6 };
const TABLE = { x: -5, y: 106, z: -6 };
const IRON_CHEST = { x: -3, y: 106, z: -8 };
const DIRT_CHEST = { x: -3, y: 106, z: -9 };
const DRIVE = { x: -6, y: 106, z: -8 };
const ENDER = { x: -6, y: 106, z: -7 };
const TRAPPED = { x: -3, y: 106, z: -7 };
const FAR_FURNACE = { x: 3, y: 106, z: -7 };

const B = {
  furnace: 61,
  litFurnace: 62,
  ironChest: 3000,
  drive: 3001,
  ender: 3002,
};
const BLOCKS: Array<[number, string]> = [
  ...TEST_BLOCK_REGISTRY,
  [B.furnace, 'minecraft:furnace'],
  [B.litFurnace, 'minecraft:lit_furnace'],
  [B.ironChest, 'IronChest:BlockIronChest'],
  [B.drive, 'appliedenergistics2:tile.BlockDrive'],
  [B.ender, 'EnderStorage:enderChest'],
];
const ID = {
  stone: 1,
  cobble: 4,
  planks: 5,
  log: 17,
  coal: 263,
  stick: 280,
  diamond: 264,
  flint: 318,
  chest: 54,
  cell: 4000,
};
const ITEMS: Array<[number, string]> = [
  [ID.stone, 'minecraft:stone'],
  [ID.cobble, 'minecraft:cobblestone'],
  [ID.planks, 'minecraft:planks'],
  [ID.log, 'minecraft:log'],
  [ID.coal, 'minecraft:coal'],
  [ID.stick, 'minecraft:stick'],
  [ID.diamond, 'minecraft:diamond'],
  [ID.flint, 'minecraft:flint'],
  [ID.chest, 'minecraft:chest'],
  [ID.cell, 'appliedenergistics2:item.ItemBasicStorageCell.1k'],
];
const INVENTORY: NonNullable<FakeServerOptions['inventory']> = [
  { slot: 9, id: ID.cobble, count: 20, damage: 0 },
  { slot: 10, id: ID.planks, count: 6, damage: 0 },
  { slot: 11, id: ID.coal, count: 3, damage: 0 },
  { slot: 12, id: ID.diamond, count: 1, damage: 0 },
  { slot: 13, id: ID.log, count: 4, damage: 0 },
  { slot: 14, id: ID.flint, count: 1, damage: 0 },
];
const anyOf = (id: number): FakeIngredient => ({ id, damage: 'any' });
const RECIPES: FakeRecipe[] = [
  {
    shaped: [
      [anyOf(ID.log), anyOf(ID.planks), anyOf(ID.log)],
      [anyOf(ID.planks), { id: ID.flint, damage: 0 }, anyOf(ID.planks)],
      [anyOf(ID.log), anyOf(ID.planks), anyOf(ID.log)],
    ],
    result: { id: ID.chest, count: 1, damage: 0 },
  },
];
const stacks = (n: number, fill: Record<number, FakeStack>): Array<FakeStack | null> =>
  Array.from({ length: n }, (_, i) => fill[i] ?? null);

const MOD_BLOCKS: FakeModBlock[] = [
  {
    ...IRON_CHEST,
    modId: 'IronChest',
    guiId: 0,
    slots: stacks(54, { 3: { id: ID.cobble, count: 7, damage: 0 } }),
  },
  { ...DIRT_CHEST, modId: 'IronChest', guiId: 7, slots: [null] },
  {
    ...DRIVE,
    modId: 'appliedenergistics2',
    guiId: 3,
    slots: stacks(10, { 0: { id: ID.cell, count: 1, damage: 0 } }),
  },
  { ...ENDER, modId: 'EnderStorage', guiId: 0, slots: stacks(27, {}) },
];

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-interact-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const key = (p: BlockPosition): string => `${p.x},${p.y},${p.z}`;

async function start(
  options: {
    server?: FakeServerOptions;
    interact?: boolean;
    fence?: { min: BlockPosition; max: BlockPosition } | null;
  } = {},
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: AgentConfig }> {
  const server = new FakeGtnhServer({
    items: ITEMS,
    blocks: BLOCKS,
    inventory: INVENTORY,
    recipes: RECIPES,
    tables: [TABLE],
    furnaces: [FURNACE, FAR_FURNACE],
    smelting: [
      { input: { id: ID.cobble, damage: 0 }, result: { id: ID.stone, count: 1, damage: 0 } },
    ],
    fuels: new Map([
      [ID.planks, 300],
      [ID.coal, 1600],
      [ID.stick, 100],
    ]),
    modBlocks: MOD_BLOCKS,
    blockOverrides: new Map([
      [key(FURNACE), B.furnace],
      [key(FAR_FURNACE), B.furnace],
      [key(TABLE), BLOCK.craftingTable],
      [key(IRON_CHEST), B.ironChest],
      [key(DIRT_CHEST), B.ironChest],
      [key(DRIVE), B.drive],
      [key(ENDER), B.ender],
      [key(TRAPPED), BLOCK.trappedChest],
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
      movement: {
        stopFile: join(dir, 'STOP'),
        ...(options.fence === undefined ? {} : { fence: options.fence }),
      },
      interact: {
        enabled: options.interact ?? true,
        observeOnly: ['appliedenergistics2:*'],
      },
      containers: { enabled: true },
      crafting: { enabled: true },
    },
    safety: {
      protectedItems: ['minecraft:diamond'],
      approvedFuels: ['minecraft:planks', 'minecraft:coal', 'minecraft:diamond'],
    },
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
const interact = (position: BlockPosition): ActionSpec => ({
  type: 'INTERACT_BLOCK',
  args: { position },
});
const smelt = (
  quantity: number,
  fuelQuantity: number,
  fuel = 'minecraft:planks',
  input = 'minecraft:cobblestone',
  position: BlockPosition = FURNACE,
): ActionSpec => ({ type: 'SMELT', args: { position, input, quantity, fuel, fuelQuantity } });
const take = (item = 'minecraft:stone', position: BlockPosition = FURNACE): ActionSpec => ({
  type: 'TAKE_OUTPUT',
  args: { position, item },
});
const items = (s: GameState): Record<string, number> =>
  s.inventory.known ? s.inventory.value.items : {};
const listed = (s: GameState, p: BlockPosition): InteractableBlock | undefined =>
  s.interactables.known
    ? s.interactables.value.blocks.find((b) => key(b.position) === key(p))
    : undefined;
/** Waits (bounded) until a condition holds (the fake server or the client caught up). */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const count = (s: FakeStack | null | undefined): number => s?.count ?? 0;

describe('window packets', () => {
  it('decodes S31 Window Property and Forge OpenGui', () => {
    const body = Buffer.from([3, 0, 1, 0xff, 0x38]); // window 3, property 1, value -200
    expect(decodePlay(0x31, new Reader(body))).toEqual({
      type: 'window-property',
      windowId: 3,
      property: 1,
      value: -200,
    });
    const ints = Buffer.alloc(16);
    ints.writeInt32BE(11, 0);
    ints.writeInt32BE(-5, 4);
    ints.writeInt32BE(106, 8);
    ints.writeInt32BE(-6, 12);
    const open = Buffer.concat([Buffer.from([1, 0, 0, 0, 7]), encodeString('TConstruct'), ints]);
    expect(decodeFmlRuntimeMessage(open)).toEqual({
      type: 'fml-open-gui',
      windowId: 7,
      modId: 'TConstruct',
      guiId: 11,
      x: -5,
      y: 106,
      z: -6,
    });
  });
});

describe('Gtnh1710Client interacting with blocks', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({ interact: false });
    for (const spec of [interact(FURNACE), smelt(1, 1), take()]) {
      expect(await perform(client, spec)).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
    }
    expect(server.playPacketIds().filter((id) => [0x08, 0x0d, 0x0e].includes(id))).toEqual([]);
  });

  it('observes the blocks it may use: profiles, allowlisted mod blocks, found tables and storage', async () => {
    const { client } = await start();
    const state = await client.observe();
    expect(listed(state, FURNACE)).toEqual({
      profile: 'furnace',
      block: 'minecraft:furnace',
      position: FURNACE,
      furnace: { burning: false, seen: null },
    });
    expect(listed(state, TABLE)?.profile).toBe('crafting_table');
    expect(listed(state, IRON_CHEST)?.profile).toBe('iron_chest');
    expect(listed(state, DRIVE)).toMatchObject({
      profile: null,
      block: 'appliedenergistics2:tile.BlockDrive',
    });
    // Never listed: a trapped chest (opening it emits redstone) and a mod block nobody allowlisted.
    expect(listed(state, TRAPPED)).toBeUndefined();
    expect(listed(state, ENDER)).toBeUndefined();
    // A crafting table it found is usable for CRAFT_ITEM; a storage block it found is storage.
    expect(state.craftingTables.map((t) => t.id)).toContain('crafting_table:-5.106.-6');
    expect(state.storage.find((s) => s.id === 'iron_chest:-3.106.-8')).toMatchObject({
      name: 'Iron Chests chest at (-3, 106, -8)',
      items: { known: false },
    });
    expect(state.blockWindow).toBeNull();
  });

  it('opens a furnace with an empty hand and reports its slots and timers', async () => {
    const { server, client } = await start({
      server: {
        furnaces: [
          {
            ...FURNACE,
            input: { id: ID.cobble, count: 3, damage: 0 },
            fuel: { id: ID.planks, count: 2, damage: 0 },
            cookTicks: 50,
            burnTicks: 100,
            itemBurnTicks: 300,
          },
        ],
      },
    });
    const result = await perform(client, interact(FURNACE));
    expect(result).toMatchObject({ ok: true, data: { profile: 'furnace', opener: 'vanilla:2' } });
    const sim = server.chestSim;
    expect(sim.activations).toEqual([{ ...FURNACE, heldSlot: 0 }]);
    expect(sim.openedTypes).toEqual([2]);
    expect(sim.clicks).toEqual([]);
    const state = await client.observe();
    expect(state.blockWindow).toMatchObject({
      position: FURNACE,
      profile: 'furnace',
      opener: 'vanilla:2',
      title: 'container.furnace',
      slotCount: 39,
      containerSlots: 3,
      open: true,
      properties: { '0': 50, '1': 100, '2': 300 },
      slots: [
        { slot: 0, item: 'minecraft:cobblestone', count: 3, role: 'input', nbt: false },
        { slot: 1, item: 'minecraft:planks', count: 2, role: 'fuel', nbt: false },
      ],
    });
    expect(listed(state, FURNACE)?.furnace?.seen).toMatchObject({
      input: { item: 'minecraft:cobblestone', count: 3 },
      fuel: { item: 'minecraft:planks', count: 2 },
      output: null,
      cookTicks: 50,
      burnTicksLeft: 100,
      fuelItemTicks: 300,
    });
    // The inventory is read from the furnace window while it is open.
    expect(items(state)['minecraft:cobblestone']).toBe(20);
  });

  it('smelts: exact input and fuel in, the furnace cooks on its own, the output comes out exactly', async () => {
    const { server, client } = await start();
    const sim = server.chestSim;
    expect(await perform(client, smelt(8, 2))).toMatchObject({ ok: true });
    expect(sim.furnace(FURNACE.x, FURNACE.y, FURNACE.z)).toMatchObject({
      input: { id: ID.cobble, count: 8 },
      fuel: { id: ID.planks, count: 2 },
      output: null,
    });
    let state = await client.observe();
    expect(items(state)).toMatchObject({ 'minecraft:cobblestone': 12, 'minecraft:planks': 4 });
    expect(sim.cursor).toBeNull();
    expect(sim.dropped).toEqual([]);

    // 450 server ticks: it lights up, uses a plank, smelts 2 items, and keeps going.
    sim.tickFurnaces(450);
    const f = sim.furnace(FURNACE.x, FURNACE.y, FURNACE.z);
    expect(count(f?.output)).toBe(2);
    state = await untilState(
      client,
      (s) => outputCount(s) === 2 && listed(s, FURNACE)?.block === 'minecraft:lit_furnace',
    );
    const furnace = listed(state, FURNACE);
    expect(furnace?.block).toBe('minecraft:lit_furnace');
    expect(furnace?.furnace).toMatchObject({
      burning: true,
      seen: {
        input: { item: 'minecraft:cobblestone', count: 6 },
        output: { item: 'minecraft:stone', count: 2 },
        cookTicks: f?.cookTicks,
        burnTicksLeft: f?.burnTicks,
        fuelItemTicks: 300,
      },
    });

    const took = await perform(client, take());
    expect(took).toMatchObject({ ok: true, data: { item: 'minecraft:stone', taken: 2 } });
    state = await client.observe();
    expect(items(state)['minecraft:stone']).toBe(2);
    expect(sim.furnace(FURNACE.x, FURNACE.y, FURNACE.z)?.output).toBeNull();
    expect(sim.playerSlots().filter((s) => s?.id === ID.stone)).toEqual([
      { id: ID.stone, count: 2, damage: 0 },
    ]);
    expect(sim.cursor).toBeNull();
    expect(sim.dropped).toEqual([]);
  });

  it('handles the furnace lighting up between its clicks (a rejected click), keeping counts exact', async () => {
    const { server, client } = await start({
      server: {
        furnaces: [{ ...FURNACE, input: { id: ID.cobble, count: 5, damage: 0 } }],
      },
    });
    const sim = server.chestSim;
    // Click 1 picks up the planks, click 2 puts one into the empty fuel slot: the next server
    // tick lights the furnace and burns that plank before the client's next click.
    sim.onClick = (n) => {
      if (n === 2) sim.tickFurnaces(1);
    };
    const result = await perform(client, smelt(3, 3));
    expect(result).toMatchObject({ ok: true });
    expect(sim.clicks.some((c) => !c.accepted)).toBe(true);
    const f = sim.furnace(FURNACE.x, FURNACE.y, FURNACE.z);
    // 3 planks went in: one burns, two wait in the fuel slot; 3 more cobblestone joined the 5.
    expect(count(f?.fuel)).toBe(2);
    expect(f?.burnTicks).toBeGreaterThan(0);
    expect(count(f?.input)).toBe(8);
    const state = await client.observe();
    expect(items(state)).toMatchObject({ 'minecraft:cobblestone': 17, 'minecraft:planks': 3 });
    expect(sim.cursor).toBeNull();
    expect(sim.dropped).toEqual([]);
  });

  it('refuses before anything is sent: unknown, unlisted, never-opened, far or wrong blocks, bad fuels', async () => {
    const { server, client } = await start();
    const refusals: Array<[ActionSpec, RegExp]> = [
      [interact(ENDER), /CodeChickenCore packet the client does not recognise/],
      [interact(TRAPPED), /emits a redstone signal/],
      [interact(FAR_FURNACE), /blocks from the eyes \(max 4.5\)/],
      [interact({ x: -4, y: 110, z: -6 }), /there is no block/],
      [smelt(1, 1, 'minecraft:planks', 'minecraft:cobblestone', TABLE), /not a furnace/],
      [smelt(1, 1, 'minecraft:lava_bucket'), /lava is never used/],
      [smelt(1, 1, 'minecraft:cobblestone'), /not a known furnace fuel/],
      [smelt(30, 0), /more than the largest stack of this item seen \(20\)|only 20 available/],
      [take('minecraft:stone', FAR_FURNACE), /blocks from the eyes/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r, JSON.stringify(spec)).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    expect(server.chestSim.clicks).toEqual([]);
    // Only the over-large SMELT got as far as opening the furnace (it plans on the window).
    expect(server.chestSim.activations).toEqual([{ ...FURNACE, heldSlot: 0 }]);
  });

  it('takes nothing when the output is empty or another item', async () => {
    const { server, client } = await start();
    expect(await perform(client, take())).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: "the furnace's output slot is empty",
    });
    expect(await perform(client, smelt(2, 1))).toMatchObject({ ok: true });
    server.chestSim.tickFurnaces(201);
    await untilState(client, (s) => outputCount(s) === 1);
    const r = await perform(client, take('minecraft:coal'));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/output is 1 x minecraft:stone, not minecraft:coal/);
  });

  it('looks at an allowlisted mod GUI without a single click, closes it and learns its layout', async () => {
    const { server, client, config } = await start();
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
    const looked = await runUserAction(deps, interact(DRIVE), 'test');
    expect(looked.status).toBe('succeeded');
    expect(
      looked.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual([
      'PASS execution-ok',
      'PASS observation-fresh',
      'PASS window-seen',
      'PASS window-profile',
      'PASS window-state',
    ]);
    const sim = server.chestSim;
    expect(sim.clicks).toEqual([]);
    expect(sim.openedTypes).toEqual([-1]);
    await until(() => sim.openWindowId === null);
    const state = await client.observe();
    expect(state.blockWindow).toMatchObject({
      block: 'appliedenergistics2:tile.BlockDrive',
      profile: null,
      opener: 'fml:appliedenergistics2:3',
      slotCount: 46,
      containerSlots: null,
      // The player's inventory was recognised at the end of the window (it matched exactly).
      inventoryAt: 10,
      open: false,
    });
    expect(state.blockWindow?.slots[0]).toEqual({
      slot: 0,
      item: 'appliedenergistics2:item.ItemBasicStorageCell.1k',
      count: 1,
      role: null,
      nbt: false,
    });
    expect(state.inventory.known).toBe(true);
    const learned = repos.windowLayouts.list();
    expect(learned).toMatchObject([
      {
        block: 'appliedenergistics2:tile.BlockDrive',
        opener: 'fml:appliedenergistics2:3',
        slotCount: 46,
        profile: null,
        inventoryAt: 10,
        position: DRIVE,
      },
    ]);
    expect(learned[0]?.sample[0]).toMatchObject({ slot: 0, count: 1 });
  });

  it('with no empty hotbar slot: a profiled block opens holding a plain block, an observe-only one is refused', async () => {
    // An observe-only block may not answer a click, which would then place the held block.
    const hotbar = Array.from({ length: 9 }, (_, j) => ({
      slot: 36 + j,
      id: ID.cobble,
      count: 1,
      damage: 0,
    }));
    const { server, client } = await start({ server: { inventory: [...INVENTORY, ...hotbar] } });
    const drive = await perform(client, interact(DRIVE));
    expect(drive).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(drive.message).toMatch(/no empty hotbar slot to click with/);
    const furnace = await perform(client, interact(FURNACE));
    expect(furnace).toMatchObject({ ok: true });
    // Only the furnace was clicked: nothing placed beside the drive.
    expect(server.chestSim.activations.map((a) => `${a.x},${a.y},${a.z}`)).toEqual([key(FURNACE)]);
  });

  it('a mod window with the player inventory first: recorded, the inventory part located, never clicked', async () => {
    const { server, client } = await start({
      server: {
        modBlocks: [
          {
            ...DRIVE,
            modId: 'appliedenergistics2',
            guiId: 5,
            slots: stacks(4, { 2: { id: ID.cell, count: 1, damage: 0 } }),
            playerFirst: true,
          },
        ],
      },
    });
    expect(await perform(client, interact(DRIVE))).toMatchObject({ ok: true });
    expect(server.chestSim.clicks).toEqual([]);
    const state = await client.observe();
    expect(state.blockWindow).toMatchObject({ slotCount: 40, inventoryAt: 0, open: false });
  });

  it('goes through the executor: verified smelting; protected and unapproved fuels never used', async () => {
    const { server, client, config } = await start();
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
    const checks = (r: Awaited<ReturnType<typeof runUserAction>>): string[] =>
      r.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`) ?? [];

    const opened = await runUserAction(deps, interact(FURNACE), 'test');
    expect(opened.status).toBe('succeeded');
    const loaded = await runUserAction(deps, smelt(4, 1), 'test');
    expect(loaded.status).toBe('succeeded');
    expect(checks(loaded)).toEqual(
      expect.arrayContaining([
        'PASS inventory-delta minecraft:cobblestone',
        'PASS inventory-delta minecraft:planks',
        'PASS other-items-unchanged',
        'PASS furnace-open',
        'PASS furnace-holds-input',
      ]),
    );
    // A protected item is never fuel, even an "approved" one; an unapproved fuel neither.
    expect((await runUserAction(deps, smelt(1, 1, 'minecraft:diamond'), 'test')).summary).toMatch(
      /rejected \[PROTECTED_ITEM\]/,
    );
    expect((await runUserAction(deps, smelt(1, 1, 'minecraft:stick'), 'test')).summary).toMatch(
      /rejected \[NOT_APPROVED_FUEL\]/,
    );
    // Not observed as a furnace: refused by the safety policy before the client is asked.
    expect(
      (
        await runUserAction(
          deps,
          smelt(1, 1, 'minecraft:planks', 'minecraft:cobblestone', TABLE),
          'test',
        )
      ).summary,
    ).toMatch(/rejected \[NOT_INTERACTABLE\]/);

    server.chestSim.tickFurnaces(201);
    await untilState(client, (s) => outputCount(s) === 1);
    const took = await runUserAction(deps, take(), 'test');
    expect(took.status).toBe('succeeded');
    expect(checks(took)).toEqual(
      expect.arrayContaining([
        'PASS client-took',
        'PASS inventory-delta minecraft:stone',
        'PASS other-items-unchanged',
      ]),
    );
    expect(server.chestSim.dropped).toEqual([]);
  });

  it('Iron Chests: opened through its FML GUI (54 slots); exact deposits and withdrawals, verified', async () => {
    const { server, client, config } = await start();
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
    const id = 'iron_chest:-3.106.-8';
    expect(
      (await runUserAction(deps, { type: 'OPEN_CONTAINER', args: { containerId: id } }, 'test'))
        .status,
    ).toBe('succeeded');
    let state = await client.observe();
    expect(state.openContainerId).toBe(id);
    expect(state.storage.find((s) => s.id === id)?.items).toEqual({
      known: true,
      value: { 'minecraft:cobblestone': 7 },
    });
    const deposit = await runUserAction(
      deps,
      {
        type: 'DEPOSIT_ITEM',
        args: { containerId: id, item: 'minecraft:cobblestone', quantity: 10 },
      },
      'test',
    );
    expect(deposit.status).toBe('succeeded');
    const withdraw = await runUserAction(
      deps,
      {
        type: 'WITHDRAW_ITEM',
        args: { containerId: id, item: 'minecraft:cobblestone', quantity: 4 },
      },
      'test',
    );
    expect(withdraw.status).toBe('succeeded');
    expect(
      withdraw.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(expect.arrayContaining(['PASS player-inventory-delta', 'PASS container-delta']));
    const slots = server.chestSim.modBlockSlots(IRON_CHEST.x, IRON_CHEST.y, IRON_CHEST.z);
    expect(slots.reduce((n, s) => n + (s?.id === ID.cobble ? s.count : 0), 0)).toBe(13);
    state = await client.observe();
    expect(items(state)['minecraft:cobblestone']).toBe(14);
    // Remembered after the window closes (a new connection would recall it from memory).
    expect(repos.memory.recallContainer(id)?.items).toEqual({ 'minecraft:cobblestone': 13 });
    expect(server.chestSim.dropped).toEqual([]);
  });

  it('never puts anything into a dirt chest (its one slot takes only dirt)', async () => {
    const { server, client } = await start();
    const r = await perform(client, {
      type: 'DEPOSIT_ITEM',
      args: { containerId: 'iron_chest:-3.106.-9', item: 'minecraft:cobblestone', quantity: 1 },
    });
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/does not take items in every slot/);
    expect(server.chestSim.clicks).toEqual([]);
  });

  it('crafts at a crafting table it found (not configured), and closes it with an empty grid', async () => {
    const { server, client } = await start();
    const result = await perform(client, {
      type: 'CRAFT_ITEM',
      args: { recipe: 'chest', times: 1, craftingTableId: 'crafting_table:-5.106.-6' },
    });
    expect(result).toMatchObject({ ok: true, data: { crafts: 1 } });
    const sim = server.chestSim;
    expect(sim.activations).toEqual([{ ...TABLE, heldSlot: 0 }]);
    await until(() => sim.openWindowId === null);
    expect(items(await client.observe())['minecraft:chest']).toBe(1);
    expect(sim.dropped).toEqual([]);
  });

  it('inside a fence, blocks outside it are neither listed nor used', async () => {
    const fence = { min: { x: -6, y: 106, z: -8 }, max: { x: -4, y: 106, z: -6 } };
    const { client } = await start({ fence });
    const state = await client.observe();
    expect(listed(state, FURNACE)?.standAt).not.toBeUndefined();
    expect(listed(state, IRON_CHEST)).toBeUndefined();
    expect(state.storage.some((s) => s.id === 'iron_chest:-3.106.-8')).toBe(false);
    const r = await perform(client, interact(IRON_CHEST));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/outside the fence's columns/);
  });

  it('stops for the stop file and halt()', async () => {
    const { server, client } = await start();
    client.halt('test halt');
    const r = await perform(client, smelt(1, 1));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/halted: test halt/);
    expect(server.chestSim.activations).toEqual([]);
  });
});

/** Observes until `ok` holds (the client has caught up with the fake server), bounded. */
async function untilState(
  client: Gtnh1710Client,
  ok: (s: GameState) => boolean,
  timeoutMs = 2_000,
): Promise<GameState> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await client.observe();
    if (ok(s)) return s;
    if (Date.now() > end) throw new Error('timed out waiting for the observation');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const outputCount = (s: GameState): number | undefined =>
  listed(s, FURNACE)?.furnace?.seen?.output?.count;
