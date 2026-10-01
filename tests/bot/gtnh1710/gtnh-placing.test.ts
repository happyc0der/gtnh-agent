import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { PlaceableItem } from '../../../src/domain/blocks.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, PLACE_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeItem, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105: its body is in the
// cells (-5, 106, -8) and (-5, 107, -8), its eyes at y 107.62. The fence mirrors the real
// test pen one level lower; placing covers its columns, y 106..110.
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };

/** Cells and blocks, each set up to pass or fail exactly one rule. */
const AT = {
  /** On the grass floor two blocks east of the player: placed against the grass below. */
  floor: { x: -3, y: 106, z: -8 },
  /** Tall grass on the floor: replaced by the placed block. */
  grass: { x: -3, y: 106, z: -7 },
  /** Over the player's head, against the stone east of it. */
  overHead: { x: -5, y: 108, z: -8 },
  overHeadStone: { x: -4, y: 108, z: -8 },
  /** Beside a floating stone, with air under it: only blocks that do not fall. */
  besideStone: { x: -3, y: 107, z: -9 },
  floatingStone: { x: -2, y: 107, z: -9 },
  chest: { x: -7, y: 106, z: -6 },
  nextToChest: { x: -6, y: 106, z: -6 },
  water: { x: -7, y: 106, z: -10 },
  nextToWater: { x: -6, y: 106, z: -10 },
  flower: { x: -6, y: 106, z: -8 },
  outsideFence: { x: -10, y: 106, z: -8 },
  outOfReach: { x: -9, y: 106, z: -12 },
} as const;

const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
const WORLD = new Map<string, number>([
  [key(AT.grass), BLOCK.tallgrass],
  [key(AT.overHeadStone), BLOCK.stone],
  [key(AT.floatingStone), BLOCK.stone],
  [key(AT.chest), BLOCK.chest],
  [key(AT.water), BLOCK.water],
  [key(AT.flower), BLOCK.yellowFlower],
]);

/** Cobblestone in the selected hotbar slot, sand next to it, planks in the main inventory. */
const INVENTORY: FakeItem[] = [
  { slot: 36, id: BLOCK.cobblestone, count: 10, damage: 0 },
  { slot: 37, id: BLOCK.sand, count: 5, damage: 0 },
  { slot: 20, id: BLOCK.planks, count: 7, damage: 2 },
];

let dir = '';
let stopFile = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-place-'));
  stopFile = join(dir, 'STOP');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  server: FakeServerOptions = {},
  minecraft: { placing?: boolean; digging?: boolean } = {},
) {
  const fake = new FakeGtnhServer({
    blocks: PLACE_TEST_BLOCK_REGISTRY,
    blockOverrides: WORLD,
    chests: [{ ...AT.chest, size: 27, items: [] }],
    inventory: INVENTORY,
    ...server,
  });
  servers.push(fake);
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await fake.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      movement: { enabled: true, fence: FENCE, stopFile },
      containers: {
        enabled: true,
        chests: { 'chest.test': { name: 'Test chest', position: AT.chest } },
      },
      digging: { enabled: minecraft.digging ?? false },
      placing: { enabled: minecraft.placing ?? true },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client, config };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
const place = (
  p: { x: number; y: number; z: number },
  item: PlaceableItem = 'minecraft:cobblestone',
): ActionSpec => ({ type: 'PLACE_BLOCK', args: { position: { x: p.x, y: p.y, z: p.z }, item } });
const placePackets = (server: FakeGtnhServer) => server.playPacketIds().filter((id) => id === 0x08);
const blocksOf = (s: GameState) => {
  if (!s.nearbyBlocks.known) throw new Error(`nearby blocks unknown: ${s.nearbyBlocks.reason}`);
  return s.nearbyBlocks.value;
};
const items = (s: GameState) => (s.inventory.known ? s.inventory.value.items : null);

describe('Gtnh1710Client placing', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({}, { placing: false });
    expect(await perform(client, place(AT.floor))).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    expect(placePackets(server)).toEqual([]);
  });

  it('observes the cells a block could go into inside the fence, nearest first', async () => {
    const { client } = await start();
    const blocks = blocksOf(await client.observe());
    // Nearest first: the cell over the head (0.88 from the eyes; the stone beside it holds a
    // block), the cell under that stone (1.01, against its bottom face), then the floor cells
    // around the feet (1.50; ties by position).
    expect(blocks.placeable.slice(0, 5)).toEqual([
      { position: AT.overHead, takesFalling: false },
      { position: { x: -4, y: 107, z: -8 }, takesFalling: false },
      { position: { x: -5, y: 106, z: -9 }, takesFalling: true },
      { position: { x: -5, y: 106, z: -7 }, takesFalling: true },
      { position: { x: -4, y: 106, z: -8 }, takesFalling: true },
    ]);
    const listed = (p: { x: number; y: number; z: number }) =>
      blocks.placeable.find((c) => key(c.position) === key(p));
    expect(listed(AT.floor)).toEqual({ position: AT.floor, takesFalling: true });
    expect(listed(AT.grass)).toEqual({ position: AT.grass, takesFalling: true });
    expect(listed(AT.overHead)).toEqual({ position: AT.overHead, takesFalling: false });
    expect(listed(AT.besideStone)).toEqual({ position: AT.besideStone, takesFalling: false });
    for (const p of [AT.nextToChest, AT.nextToWater, AT.flower, AT.water, AT.outsideFence]) {
      expect(listed(p), key(p)).toBeUndefined();
    }
    // Never a cell of the player's own body.
    expect(
      blocks.placeable.some(
        (c) => c.position.x === -5 && c.position.z === -8 && c.position.y <= 107,
      ),
    ).toBe(false);
    expect(blocks.placed).toEqual([]);
  });

  it('places like a player: faces the face, clicks it with the held stack, and swings the arm', async () => {
    const { server, client } = await start();
    const result = await perform(client, place(AT.floor));
    expect(result).toMatchObject({
      ok: true,
      code: 'OK',
      data: {
        block: 'minecraft:cobblestone',
        against: 'minecraft:grass at (-3, 105, -8), face 1',
        stackUsed: true,
        stackBefore: 10,
        stackAfter: 9,
      },
    });
    // The clicked block and face, the stack exactly as held, the cursor on the face's centre.
    expect(server.placeSim.placements).toEqual([
      {
        x: -3,
        y: 105,
        z: -8,
        face: 1,
        claimed: { id: BLOCK.cobblestone, count: 10, damage: 0 },
        held: { id: BLOCK.cobblestone, count: 10, damage: 0 },
        cursor: [8, 16, 8],
        placed: true,
      },
    ]);
    expect(server.placeSim.placed).toEqual([{ ...AT.floor, name: 'minecraft:cobblestone' }]);
    const ids = server.playPacketIds();
    expect(ids.indexOf(0x05)).toBeLessThan(ids.indexOf(0x08));
    expect(ids.lastIndexOf(0x0a)).toBeGreaterThan(ids.indexOf(0x08));
    expect(ids.every((id) => [0x00, 0x03, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x17].includes(id))).toBe(
      true,
    );

    const state = await client.observe();
    expect(blocksOf(state).placed).toEqual([
      { block: 'minecraft:cobblestone', position: AT.floor },
    ]);
    expect(blocksOf(state).placeable.some((c) => key(c.position) === key(AT.floor))).toBe(false);
    expect(items(state)).toMatchObject({ 'minecraft:cobblestone': 9 });
  }, 10_000);

  it('replaces tall grass, and places against a side face (over its head, to seal a pit)', async () => {
    const { server, client } = await start();
    expect(await perform(client, place(AT.grass, 'minecraft:sand'))).toMatchObject({ ok: true });
    // Sand with nothing under it, or over the head, is refused before anything is sent.
    for (const p of [AT.overHead, AT.besideStone]) {
      const sand = await perform(client, place(p, 'minecraft:sand'));
      expect(sand, key(p)).toMatchObject({ ok: false, code: 'REFUSED' });
    }
    const sealed = await perform(client, place(AT.overHead));
    expect(sealed).toMatchObject({
      ok: true,
      data: { against: 'minecraft:stone at (-4, 108, -8), face 4', stackAfter: 9 },
    });
    expect(server.placeSim.placements.map((p) => [p.x, p.y, p.z, p.face, ...p.cursor])).toEqual([
      [-3, 105, -7, 1, 8, 16, 8], // the grass floor under the tall grass
      [-4, 108, -8, 4, 0, 8, 8], // the stone's west face
    ]);
    expect(server.placeSim.placed.map((p) => p.name)).toEqual([
      'minecraft:sand',
      'minecraft:cobblestone',
    ]);
  }, 10_000);

  it('moves a stack from the main inventory into an empty hotbar slot first', async () => {
    const { server, client } = await start();
    const result = await perform(client, place(AT.floor, 'minecraft:planks@2'));
    expect(result).toMatchObject({ ok: true, data: { stackBefore: 7, stackAfter: 6 } });
    expect(result.message).toMatch(
      /moved minecraft:planks@2 from inventory slot 20 to hotbar slot 2/,
    );
    // Two confirmed window-0 clicks: pick the stack up, put it into the first empty hotbar slot.
    expect(server.chestSim.clicks.map((c) => [c.windowId, c.slot, c.button, c.accepted])).toEqual([
      [0, 20, 0, true],
      [0, 38, 0, true],
    ]);
    expect(server.chestSim.heldSlot).toBe(2);
    expect(server.chestSim.cursor).toBeNull();
    expect(items(await client.observe())).toMatchObject({ 'minecraft:planks@2': 6 });
  }, 10_000);

  it('refuses without a stack it could hold', async () => {
    // Planks only in the main inventory, and no empty hotbar slot to move them into.
    const full = Array.from({ length: 9 }, (_, j): FakeItem => ({
      slot: 36 + j,
      id: 297,
      count: 1,
      damage: 0,
    }));
    const { server, client } = await start({
      items: [[297, 'minecraft:bread']],
      inventory: [...full, { slot: 20, id: BLOCK.planks, count: 7, damage: 2 }],
    });
    const r = await perform(client, place(AT.floor, 'minecraft:planks@2'));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/no minecraft:planks@2 in the hotbar, and no empty hotbar slot/);
    expect((await perform(client, place(AT.floor, 'minecraft:log'))).message).toMatch(
      /no minecraft:log without NBT data in the inventory/,
    );
    expect(server.chestSim.clicks).toEqual([]);
    expect(placePackets(server)).toEqual([]);
  });

  it('refuses before sending anything', async () => {
    const { server, client } = await start();
    const refusals: Array<[ActionSpec, RegExp]> = [
      [place(AT.outsideFence), /outside the fence's columns/],
      [place({ ...AT.floor, y: FEET_Y + 5 }), /outside the place heights y=106\.\.110/],
      [place({ ...AT.floor, y: FEET_Y - 1 }), /outside the place heights .*never the floor/],
      [place(AT.outOfReach), /blocks from the eyes \(max 4\.5\)/],
      [place(AT.water), /holds minecraft:water/],
      [place(AT.flower), /holds minecraft:yellow_flower/],
      [place({ x: -5, y: 107, z: -8 }), /a cell the player's body is in/],
      [place(AT.nextToChest), /touches minecraft:chest/],
      [place(AT.nextToWater), /touches minecraft:water/],
      // Above the chest: it would be the only block to click.
      [place({ ...AT.chest, y: 107 }), /touches minecraft:chest/],
      [place(AT.besideStone, 'minecraft:gravel'), /would fall: minecraft:air is under it/],
      [place(AT.overHead, 'minecraft:sand'), /in a column the player stands in/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r, reason.source).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    writeFileSync(stopFile, 'stop');
    expect((await perform(client, place(AT.floor))).message).toMatch(/stop file .* exists/);
    unlinkSync(stopFile);
    client.halt('operator said stop');
    expect((await perform(client, place(AT.floor))).message).toMatch(/halted: operator said stop/);
    expect(placePackets(server)).toEqual([]);
  });

  it('refuses a cell an entity may be in', async () => {
    // A cow (passive: not a threat) 1.5 blocks east of the cell.
    const { server, client } = await start({
      entities: [{ kind: 'mob', entityId: 501, mobType: 92, x: -1.5, y: 106, z: -7.5 }],
    });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(
      /an entity at \(-1\.5, 106\.0, -7\.5\) is in or next to \(-3, 106, -8\)/,
    );
    expect(placePackets(server)).toEqual([]);
  });

  it('refuses while a hostile mob is near', async () => {
    const { server, client } = await start({
      entities: [{ kind: 'mob', entityId: 502, mobType: 54, x: 0.5, y: 106, z: -7.5 }],
    });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/hostile entity minecraft:Zombie 5\.0 blocks away/);
    expect(placePackets(server)).toEqual([]);
  });

  it('when the server refuses (an entity the client never saw), fails and keeps the stack', async () => {
    const { server, client } = await start({
      place: { hiddenEntities: [{ x: -2.5, y: 106, z: -7.5, width: 0.6, height: 1.8 }] },
    });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'FAILED', data: { placedNow: false } });
    expect(r.message).toMatch(
      /the server did not place minecraft:cobblestone at \(-3, 106, -8\) \(it sent minecraft:air\)/,
    );
    expect(server.placeSim.placements[0]).toMatchObject({ placed: false });
    // The server re-sent the held slot unchanged.
    expect(items(await client.observe())).toMatchObject({ 'minecraft:cobblestone': 10 });
    expect(blocksOf(await client.observe()).placed).toEqual([]);
  }, 10_000);

  it('a placement cancelled by a mod (the cell restored) fails', async () => {
    const { server, client } = await start({ place: { cancelPlace: true } });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(server.placeSim.placed).toEqual([]);
    expect(items(await client.observe())).toMatchObject({ 'minecraft:cobblestone': 10 });
  }, 10_000);

  it('a click the server finds out of its reach fails (no slot re-send then)', async () => {
    const { server, client } = await start({ place: { reach: 2 } });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(/did not place .* \(it sent minecraft:air\)/);
    expect(server.chestSim.activations).toEqual([]);
  }, 10_000);

  it('sand that falls on the server after all (its support went) fails', async () => {
    const { server, client } = await start();
    server.placeSim.onPlaced = (x, y, z) => server.setBlock(x, y - 1, z, 0);
    const r = await perform(client, place(AT.floor, 'minecraft:sand'));
    expect(r).toMatchObject({ ok: false, code: 'FAILED', data: { placedNow: false } });
    expect(r.message).toMatch(/it sent minecraft:sand, .*minecraft:air/);
    await vi.waitFor(() => expect(server.placeSim.fell).toHaveLength(1));
  }, 10_000);

  it('a clicked block that turns out to have a window: nothing placed, the window closed again', async () => {
    // The server has a chest where the client was never told of one (a lost update).
    const { server, client } = await start({
      chests: [
        { ...AT.chest, size: 27, items: [] },
        { x: -3, y: 105, z: -8, size: 27, items: [] },
      ],
    });
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(
      /clicking minecraft:grass at \(-3, 105, -8\), face 1 opened a window \(type 0\) instead of placing; it was closed again/,
    );
    expect(server.placeSim.placed).toEqual([]);
    await vi.waitFor(() => expect(server.chestSim.openWindowId).toBeNull());
    expect(items(await client.observe())).toMatchObject({ 'minecraft:cobblestone': 10 });
  }, 10_000);

  it('is refused while a dig runs', async () => {
    const { server, client } = await start(
      { blockOverrides: new Map([...WORLD, [key({ x: -4, y: 106, z: -8 }), BLOCK.dirt]]) },
      { digging: true },
    );
    const digging = perform(client, {
      type: 'DIG_BLOCK',
      args: { position: { x: -4, y: 106, z: -8 } },
    });
    await vi.waitFor(() => expect(server.digSim.digs.length).toBe(1));
    const r = await perform(client, place(AT.floor));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/the player is digging/);
    expect(await digging).toMatchObject({ ok: true });
    expect(placePackets(server)).toEqual([]);
  }, 10_000);

  it('goes through the executor: validated, placed and verified (BLOCK_PLACED)', async () => {
    const { client, config } = await start();
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
    const done = await runUserAction(deps, place(AT.floor), 'test');
    expect(done.status).toBe('succeeded');
    expect(
      done.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual([
      'PASS execution-ok',
      'PASS observation-fresh',
      'PASS block-placed',
      'PASS item-used',
    ]);
    // The cell is no longer empty, so it is no longer placeable: the policy refuses.
    expect((await runUserAction(deps, place(AT.floor), 'test')).summary).toMatch(
      /rejected \[NOT_PLACEABLE\]/,
    );
    // Sand over the head is refused by the policy before the client sees it.
    expect(
      (await runUserAction(deps, place(AT.overHead, 'minecraft:sand'), 'test')).summary,
    ).toMatch(/rejected \[UNSAFE_PLACE\]/);
  }, 10_000);
});
