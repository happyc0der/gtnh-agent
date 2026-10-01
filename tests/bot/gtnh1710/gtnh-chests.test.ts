import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type AgentConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK } from './fixtures/chunk-fixtures.ts';
import type { FakeChest, FakeStack } from './fixtures/fake-chests.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5); the chests are next to it.
const CHEST = { x: -5, y: 106, z: -6 };
const TRAP = { x: -4, y: 106, z: -6 };
const ID = { cobble: 4, diamond: 264, bread: 297 };
const ITEMS: Array<[number, string]> = [
  [ID.cobble, 'minecraft:cobblestone'],
  [ID.diamond, 'minecraft:diamond'],
  [ID.bread, 'minecraft:bread'],
  [263, 'minecraft:coal'],
  [7495, 'gregtech:gt.metaitem.01'],
  [9001, 'BuildCraft|Core:engineBlock'],
  [9002, 'Natura:N Crops'],
];
const CHEST_ITEMS: FakeChest['items'] = [
  { slot: 0, id: ID.cobble, count: 64, damage: 0 },
  { slot: 1, id: ID.cobble, count: 64, damage: 0 },
  { slot: 2, id: ID.diamond, count: 3, damage: 0 },
  { slot: 3, id: ID.bread, count: 5, damage: 0, nbt: true },
];

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];
// Each test has its own stop file, so a halted agent (data/STOP) never affects the tests.
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-chests-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  options: { server?: FakeServerOptions; containersEnabled?: boolean } = {},
): Promise<{ server: FakeGtnhServer; client: Gtnh1710Client; config: AgentConfig }> {
  const server = new FakeGtnhServer({
    items: ITEMS,
    chests: [{ ...CHEST, size: 27, items: CHEST_ITEMS }],
    blockOverrides: new Map([
      [`${CHEST.x},${CHEST.y},${CHEST.z}`, BLOCK.chest],
      [`${TRAP.x},${TRAP.y},${TRAP.z}`, BLOCK.trappedChest],
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
      containers: {
        enabled: options.containersEnabled ?? true,
        chests: {
          'chest.test': { name: 'Test chest', position: CHEST },
          'chest.trap': { name: 'Trapped chest', position: TRAP },
        },
      },
    },
    safety: { protectedItems: ['minecraft:diamond'] },
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
const open = (containerId = 'chest.test'): ActionSpec => ({
  type: 'OPEN_CONTAINER',
  args: { containerId },
});
const withdraw = (item: string, quantity: number): ActionSpec => ({
  type: 'WITHDRAW_ITEM',
  args: { containerId: 'chest.test', item, quantity },
});
const deposit = (item: string, quantity: number): ActionSpec => ({
  type: 'DEPOSIT_ITEM',
  args: { containerId: 'chest.test', item, quantity },
});
const total = (stacks: Array<FakeStack | null>, id: number): number =>
  stacks.reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);

describe('Gtnh1710Client vanilla chests', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({ containersEnabled: false });
    expect(await perform(client, open())).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
    expect(server.playPacketIds().filter((id) => [0x08, 0x0e].includes(id))).toEqual([]);
  });

  it('opens a configured chest with an empty hand and reports its contents', async () => {
    const { server, client } = await start({
      server: {
        items: ITEMS,
        // Something in the selected hotbar slot: the client must switch to an empty one.
        inventory: [{ slot: 36, id: ID.bread, count: 2, damage: 0 }],
      },
    });
    expect(await perform(client, open())).toMatchObject({ ok: true });
    expect(server.chestSim?.activations).toEqual([{ ...CHEST, heldSlot: 1 }]);

    const state = await client.observe();
    expect(state.openContainerId).toBe('chest.test');
    expect(state.storage.find((s) => s.id === 'chest.test')?.items).toEqual({
      known: true,
      value: { 'minecraft:cobblestone': 128, 'minecraft:diamond': 3, 'minecraft:bread': 5 },
    });
    expect(state.storage.find((s) => s.id === 'chest.trap')?.items.known).toBe(false);
  });

  it('withdraws an exact partial amount: player +10, chest -10, nothing dropped', async () => {
    const { server, client } = await start();
    const result = await perform(client, withdraw('minecraft:cobblestone', 10));
    expect(result).toMatchObject({ ok: true });
    const state = await client.observe();
    expect(state.inventory.known && state.inventory.value.items['minecraft:cobblestone']).toBe(10);
    expect(state.storage[0]?.items).toMatchObject({
      known: true,
      value: { 'minecraft:cobblestone': 118 },
    });
    const sim = server.chestSim;
    expect(total(sim?.chestContents(CHEST.x, CHEST.y, CHEST.z) ?? [], ID.cobble)).toBe(118);
    expect(total(sim?.playerSlots() ?? [], ID.cobble)).toBe(10);
    expect(sim?.clicks.every((c) => c.accepted)).toBe(true);
    expect(sim?.cursor).toBeNull();
    expect(sim?.dropped).toEqual([]);
  });

  it('withdraws across stacks and deposits back, keeping every count exact', async () => {
    const { server, client } = await start();
    expect(await perform(client, withdraw('minecraft:cobblestone', 100))).toMatchObject({
      ok: true,
    });
    expect(await perform(client, deposit('minecraft:cobblestone', 70))).toMatchObject({ ok: true });
    const state = await client.observe();
    expect(state.inventory.known && state.inventory.value.items['minecraft:cobblestone']).toBe(30);
    const sim = server.chestSim;
    expect(total(sim?.chestContents(CHEST.x, CHEST.y, CHEST.z) ?? [], ID.cobble)).toBe(98);
    expect(total(sim?.playerSlots() ?? [], ID.cobble)).toBe(30);
    expect(sim?.dropped).toEqual([]);
  });

  it('refuses before any click: too few, NBT stacks, a trapped chest, an unknown chest', async () => {
    const { server, client } = await start();
    const refusals: Array<[ActionSpec, RegExp]> = [
      [withdraw('minecraft:cobblestone', 200), /only 128 available/],
      [withdraw('minecraft:bread', 1), /only 0 available without NBT data/],
      [open('chest.trap'), /is minecraft:trapped_chest, not a minecraft:chest/],
      [open('chest.nope'), /is not a configured chest/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    expect(server.chestSim?.clicks).toEqual([]);
  });

  it('recovers from a rejected click: the stack goes back, nothing is dropped', async () => {
    const { server, client } = await start({ server: { rejectClicks: [2] } });
    const result = await perform(client, withdraw('minecraft:cobblestone', 10));
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/click 2 of 12 was rejected; the cursor was emptied/);
    const sim = server.chestSim;
    expect(sim?.cursor).toBeNull();
    expect(sim?.dropped).toEqual([]);
    // Nothing was lost: chest + player still hold all 128.
    expect(
      total(sim?.chestContents(CHEST.x, CHEST.y, CHEST.z) ?? [], ID.cobble) +
        total(sim?.playerSlots() ?? [], ID.cobble),
    ).toBe(128);
    // The client's view matches the server's again.
    const state = await client.observe();
    const inChest = state.storage[0]?.items;
    expect(inChest?.known && inChest.value['minecraft:cobblestone']).toBe(
      total(sim?.chestContents(CHEST.x, CHEST.y, CHEST.z) ?? [], ID.cobble),
    );
  });

  it('goes through the executor: validated, moved and verified on both sides', async () => {
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
    // Before the chest is opened its contents are unknown, so a withdrawal is refused.
    expect(
      (await runUserAction(deps, withdraw('minecraft:cobblestone', 10), 'test')).summary,
    ).toMatch(/rejected \[preconditions: contents of chest.test are unknown\]/);
    expect((await runUserAction(deps, open(), 'test')).status).toBe('succeeded');
    const moved = await runUserAction(deps, withdraw('minecraft:cobblestone', 10), 'test');
    expect(moved.status).toBe('succeeded');
    expect(
      moved.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(expect.arrayContaining(['PASS player-inventory-delta', 'PASS container-delta']));
    // Protected items never move, whatever a human asks.
    expect((await runUserAction(deps, withdraw('minecraft:diamond', 1), 'test')).summary).toMatch(
      /rejected \[PROTECTED_ITEM\]/,
    );
    expect(server.chestSim?.dropped).toEqual([]);
  });
});
