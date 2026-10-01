import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { digWaitTicks } from '../../../src/domain/dig-time.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig, type DiggingConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105; the fence mirrors
// the real test pen one level lower. Digging covers the fence's columns, y 106..110.
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };

/** Test blocks, each set up to pass or fail exactly one rule. */
const AT = {
  /** Right next to the player (east): in reach and in pickup range. */
  dirt: { x: -4, y: 106, z: -8 },
  /** In reach, but its drop lands out of pickup range. */
  farDirt: { x: -1, y: 106, z: -8 },
  wetDirt: { x: -6, y: 106, z: -10 },
  water: { x: -7, y: 106, z: -10 },
  chestDirt: { x: -6, y: 106, z: -6 },
  chest: { x: -7, y: 106, z: -6 },
  sandTopped: { x: -3, y: 106, z: -6 },
  sand: { x: -3, y: 107, z: -6 },
  stone: { x: -2, y: 106, z: -10 },
  outsideFence: { x: -10, y: 106, z: -8 },
  outOfReach: { x: -9, y: 106, z: -12 },
} as const;

const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
/** Not the grass floor (y=105), of which the scan lists only the nearest few. */
const notFloor = (r: { block: string; position: { y: number } }): boolean =>
  !(r.block === 'minecraft:grass' && r.position.y === 105);
const WORLD = new Map<string, number>([
  [key(AT.dirt), BLOCK.dirt],
  [key(AT.farDirt), BLOCK.dirt],
  [key(AT.wetDirt), BLOCK.dirt],
  [key(AT.water), BLOCK.water],
  [key(AT.chestDirt), BLOCK.dirt],
  [key(AT.chest), BLOCK.chest],
  [key(AT.sandTopped), BLOCK.dirt],
  [key(AT.sand), BLOCK.sand],
  [key(AT.stone), BLOCK.stone],
  [key(AT.outsideFence), BLOCK.dirt],
  [key(AT.outOfReach), BLOCK.dirt],
]);

let dir = '';
let stopFile = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-dig-'));
  stopFile = join(dir, 'STOP');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  server: FakeServerOptions = {},
  digging: Partial<DiggingConfig> = {},
  protectedItems: string[] = [],
) {
  const fake = new FakeGtnhServer({
    blocks: DIG_TEST_BLOCK_REGISTRY,
    blockOverrides: WORLD,
    chests: [{ ...AT.chest, size: 27, items: [] }],
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
      digging: { enabled: true, ...digging },
    },
    safety: { protectedItems },
  });
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
  });
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
const dig = (p: { x: number; y: number; z: number }): ActionSpec => ({
  type: 'DIG_BLOCK',
  args: { position: { x: p.x, y: p.y, z: p.z } },
});
const digPackets = (server: FakeGtnhServer) => server.playPacketIds().filter((id) => id === 0x07);
const blocksOf = (s: GameState) => {
  if (!s.nearbyBlocks.known) throw new Error(`nearby blocks unknown: ${s.nearbyBlocks.reason}`);
  return s.nearbyBlocks.value;
};

describe('Gtnh1710Client digging on terrain', () => {
  it('digs sand in the ground next to it, faces it, and steps into the hole for the drop', async () => {
    // Sand in the grass floor south-west of the player's block, stone under it.
    const sand = { x: -5, y: 105, z: -9 };
    const terrain = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
    const fake = new FakeGtnhServer({
      blocks: DIG_TEST_BLOCK_REGISTRY,
      blockOverrides: new Map([
        [key(sand), BLOCK.sand],
        [key({ ...sand, y: 104 }), BLOCK.stone],
      ]),
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
        movement: { enabled: true, fence: terrain, stopFile },
        digging: { enabled: true },
      },
    });
    const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
    clients.push(client);
    await client.connect();

    // The scan sees the sand one level below the feet (and a sample of the grass floor).
    const before = blocksOf(await client.observe());
    expect(before.resources.filter(notFloor).map((r) => [r.block, key(r.position)])).toEqual([
      ['minecraft:sand', key(sand)],
    ]);

    const result = await perform(client, dig(sand));
    expect(result).toMatchObject({
      ok: true,
      data: {
        block: 'minecraft:sand',
        dropCollected: true,
        drops: '1 x minecraft:sand',
        walkedToDrop: true,
      },
    });
    expect(result.message).toMatch(
      /walked to the drop at \(-5, 105, -9\) and picked up 1 x minecraft:sand/,
    );
    // It looked down at the block before digging, and stands in the hole now.
    expect(fake.playPacketIds().indexOf(0x05)).toBeLessThan(fake.playPacketIds().indexOf(0x07));
    expect(fake.walkSteps().at(-1)).toMatchObject({ x: -4.5, feetY: 105, z: -8.5, onGround: true });
    expect(fake.digSim.pickedUp).toEqual([{ item: 'minecraft:sand', count: 1 }]);
  }, 15_000);
});

describe('Gtnh1710Client collects drops it can walk to', () => {
  it('digs sand two blocks away and walks onto the spot to pick up the drop', async () => {
    // Sand in the grass floor two columns east of the player's block, stone under it.
    const sand = { x: -3, y: 105, z: -8 };
    const terrain = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
    const fake = new FakeGtnhServer({
      blocks: DIG_TEST_BLOCK_REGISTRY,
      blockOverrides: new Map([
        [key(sand), BLOCK.sand],
        [key({ ...sand, y: 104 }), BLOCK.stone],
      ]),
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
        movement: { enabled: true, fence: terrain, stopFile },
        digging: { enabled: true },
      },
    });
    const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
    clients.push(client);
    await client.connect();

    const result = await perform(client, dig(sand));
    expect(result).toMatchObject({
      ok: true,
      data: { dropCollected: true, drops: '1 x minecraft:sand', walkedToDrop: true },
    });
    expect(fake.walkSteps().at(-1)).toMatchObject({ x: -2.5, feetY: 105, z: -7.5, onGround: true });
    expect(fake.digSim.pickedUp).toEqual([{ item: 'minecraft:sand', count: 1 }]);
  }, 15_000);
});

describe('Gtnh1710Client digging', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({}, { enabled: false });
    expect(await perform(client, dig(AT.dirt))).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    expect(digPackets(server)).toEqual([]);
  });

  it('observes the diggable blocks at or above the feet, nearest first (and a sample of the floor)', async () => {
    const { client } = await start();
    const all = blocksOf(await client.observe());
    const blocks = { ...all, resources: all.resources.filter(notFloor) };
    expect(blocks.scanRadius).toBe(16);
    expect(blocks.removed).toEqual([]);
    // Each comes with where to stand to dig it: the dirt next to the player from right here.
    expect(blocks.resources[0]).toEqual({
      block: 'minecraft:dirt',
      position: AT.dirt,
      standAt: { x: -4.5, y: 106, z: -7.5 },
    });
    // The wet dirt (water next to it) cannot be dug from anywhere.
    expect(blocks.resources.find((r) => key(r.position) === key(AT.wetDirt))?.standAt).toBeNull();
    // Distance from the feet to each block's centre; ties (2.29 m) by position.
    expect(blocks.resources.map((r) => r.position)).toEqual([
      AT.dirt, // 1.12 m
      AT.wetDirt, // 2.29 m
      AT.chestDirt, // 2.29 m
      AT.sandTopped, // 2.87 m
      AT.sand, // 3.20 m
      AT.farDirt, // 4.03 m
      AT.outsideFence, // 5.02 m
      AT.outOfReach, // 5.68 m
    ]);
    expect(blocks.resources[4]?.block).toBe('minecraft:sand');
    // Below the feet level only sand, gravel and clay, plus the nearest few of the grass floor.
    expect(
      blocks.resources.every(
        (r) =>
          r.position.y >= FEET_Y ||
          ['minecraft:sand', 'minecraft:gravel', 'minecraft:clay'].includes(r.block),
      ),
    ).toBe(true);
    expect(all.resources.filter((r) => !notFloor(r)).length).toBeLessThanOrEqual(8);
  });

  it('keeps its own dig first in `removed` when many blocks turn to air after it', async () => {
    // Seen live: a chopped tree's leaves decayed, pushed the log's own dig out of `removed`,
    // and DIG_BLOCK's verification failed with the log in hand.
    const { server, client } = await start();
    const result = await perform(client, { type: 'DIG_BLOCK', args: { position: AT.dirt } });
    expect(result, result.message).toMatchObject({ ok: true });
    const records: Array<{ x: number; y: number; z: number; id: number }> = [];
    for (const z of [-11, -10])
      for (let x = -9; x <= -1; x++) records.push({ x, y: 105, z, id: 0 });
    records.push({ x: -9, y: 105, z: -5, id: 0 }, { x: -8, y: 105, z: -5, id: 0 });
    server.setBlocks(-1, -1, records);
    await vi.waitFor(async () => expect(blocksOf(await client.observe()).removed.length).toBe(16));
    expect(blocksOf(await client.observe()).removed[0]).toEqual(AT.dirt);
  }, 10_000);

  it('with a full hotbar, digs holding a plain block item, as with a bare hand', async () => {
    // Seen live: the hotbar full of sand, dirt, logs and saplings, and every dig refused.
    const { server, client } = await start({
      inventory: Array.from({ length: 9 }, (_, j) => ({
        slot: 36 + j,
        id: BLOCK.sand,
        count: 10,
        damage: 0,
      })),
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result, result.message).toMatchObject({ ok: true, data: { block: 'minecraft:dirt' } });
    expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 2]);
  });

  it('digs with an empty hand: start, the dig time, finish; the block turns to air and the drop is picked up', async () => {
    const { server, client } = await start({
      // Bread in the selected hotbar slot: the client must switch to an empty one first.
      inventory: [{ slot: 36, id: 297, count: 2, damage: 0 }],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({
      ok: true,
      code: 'OK',
      data: { block: 'minecraft:dirt', dropCollected: true, drops: '1 x minecraft:dirt' },
    });
    expect(result.message).toMatch(/the drop reached the inventory: 1 x minecraft:dirt/);

    // C09 to an empty slot, then exactly start and finish, both with an empty hand.
    expect(server.chestSim.heldSlot).toBe(1);
    const digs = server.digSim.digs;
    expect(digs.map((d) => [d.status, d.x, d.y, d.z, d.emptyHand])).toEqual([
      [0, AT.dirt.x, AT.dirt.y, AT.dirt.z, true],
      [2, AT.dirt.x, AT.dirt.y, AT.dirt.z, true],
    ]);
    // The face turned to the eyes: they are 1.12 above the block's centre and 1.0 west of
    // it, so the top face (1).
    expect(digs[0]?.face).toBe(1);
    // It waited the full margin: vanilla 15 ticks x 1.25 + 2 = 21 ticks.
    expect(digWaitTicks('minecraft:dirt')).toBe(21);
    expect((digs[1]?.at ?? 0) - (digs[0]?.at ?? 0)).toBeGreaterThanOrEqual(21 * 50 - 5);
    expect(server.digSim.broken).toEqual([{ ...AT.dirt, name: 'minecraft:dirt', late: false }]);

    const state = await client.observe();
    const blocks = blocksOf(state);
    expect(blocks.removed).toEqual([AT.dirt]);
    expect(blocks.resources.some((r) => key(r.position) === key(AT.dirt))).toBe(false);
    expect(state.inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:dirt': 1, 'minecraft:bread': 2 } },
    });
    // Like a player: it faced the block (C05) and swung its arm (C0A) while digging.
    const ids = server.playPacketIds();
    expect(ids.indexOf(0x05)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(0x05)).toBeLessThan(ids.indexOf(0x07));
    expect(ids.filter((id) => id === 0x0a).length).toBeGreaterThanOrEqual(5); // every 4 of 21 ticks
    // Nothing but the allowed packets: keep-alive, idle ticks, look, echoes, digging, hotbar,
    // arm swings, FML.
    expect(ids.every((id) => [0x00, 0x03, 0x05, 0x06, 0x07, 0x09, 0x0a, 0x17].includes(id))).toBe(
      true,
    );
  }, 10_000);

  it('breaks a HarvestCraft garden on the dig start (hardness 0): no wait, no finish; its 3 drops are picked up', async () => {
    // A berry garden on the grass floor next to the player, and one beside water (refused:
    // water would flow into the freed cell).
    const BERRY_GARDEN = 3001;
    const garden = { x: -4, y: 106, z: -8 };
    const wetGarden = { x: -6, y: 106, z: -10 };
    const { server, client } = await start({
      blocks: [...DIG_TEST_BLOCK_REGISTRY, [BERRY_GARDEN, 'harvestcraft:berrygarden']],
      items: [
        [297, 'minecraft:bread'],
        [6001, 'harvestcraft:strawberryItem'],
      ],
      inventory: [],
      blockOverrides: new Map([
        ...WORLD,
        [key(garden), BERRY_GARDEN],
        [key(wetGarden), BERRY_GARDEN],
      ]),
    });
    const listed = blocksOf(await client.observe()).resources.filter(
      (r) => r.block === 'harvestcraft:berrygarden',
    );
    expect(listed.map((r) => r.position)).toContainEqual(garden);

    const wet = await perform(client, dig(wetGarden));
    expect(wet).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(wet.message).toMatch(/touches minecraft:water/);

    const started = Date.now();
    const result = await perform(client, dig(garden));
    expect(result).toMatchObject({
      ok: true,
      data: {
        block: 'harvestcraft:berrygarden',
        dropCollected: true,
        drops: '3 x harvestcraft:strawberryItem',
      },
    });
    // The start only: the server broke it at once, and a finish would find air.
    expect(server.digSim.digs.map((d) => [d.status, d.x, d.y, d.z])).toEqual([
      [0, garden.x, garden.y, garden.z],
    ]);
    expect(server.digSim.broken).toEqual([
      { ...garden, name: 'harvestcraft:berrygarden', late: false },
    ]);
    // No dig time was waited (a dirt block takes 21 ticks, over a second).
    expect(Date.now() - started).toBeLessThan(1_000 + 600);
    expect((await client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'harvestcraft:strawberryItem': 3 } },
    });
  }, 10_000);

  it('reports a drop that fell out of pickup range instead of claiming it', async () => {
    const { server, client } = await start();
    const result = await perform(client, dig(AT.farDirt));
    expect(result).toMatchObject({ ok: true, data: { dropCollected: false, drops: '' } });
    expect(result.message).toMatch(/no drop reached the inventory/);
    expect(server.digSim.pickedUp).toEqual([]);
    expect(blocksOf(await client.observe()).removed).toEqual([AT.farDirt]);
  }, 10_000);

  it('refuses before sending anything', async () => {
    const { server, client } = await start();
    const refusals: Array<[ActionSpec, RegExp]> = [
      [dig(AT.outsideFence), /outside the fence's columns/],
      [dig({ ...AT.dirt, y: FEET_Y + 5 }), /outside the dig heights y=106..110/],
      [dig({ ...AT.dirt, y: FEET_Y - 1 }), /outside the dig heights .*never the floor/],
      [dig(AT.outOfReach), /blocks from the eyes \(max 4.5\)/],
      [dig(AT.stone), /minecraft:stone, which is not on the dig allowlist/],
      [dig({ x: -3, y: 106, z: -7 }), /is air: there is nothing to dig/],
      [dig(AT.wetDirt), /touches minecraft:water/],
      [dig(AT.chestDirt), /touches minecraft:chest/],
      [dig(AT.sandTopped), /minecraft:sand on top of .* would fall into the hole/],
    ];
    for (const [spec, reason] of refusals) {
      const r = await perform(client, spec);
      expect(r, reason.source).toMatchObject({ ok: false, code: 'REFUSED' });
      expect(r.message).toMatch(reason);
    }
    writeFileSync(stopFile, 'stop');
    expect((await perform(client, dig(AT.dirt))).message).toMatch(/stop file .* exists/);
    unlinkSync(stopFile);
    client.halt('operator said stop');
    expect((await perform(client, dig(AT.dirt))).message).toMatch(/halted: operator said stop/);
    expect(digPackets(server)).toEqual([]);
  });

  it('stops and cancels when halted mid-dig', async () => {
    const { server, client } = await start();
    const digging = perform(client, dig(AT.dirt));
    await vi.waitFor(() => expect(server.digSim.digs.length).toBe(1));
    client.halt('operator said stop');
    const result = await digging;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/stopped: halted: operator said stop/);
    // start, then cancel (it reaches the server a moment after the client reports)
    await vi.waitFor(() => expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 1]));
    expect(server.digSim.broken).toEqual([]);
  });

  it('cancels when lava appears next to the block while digging', async () => {
    const { server, client } = await start();
    const digging = perform(client, dig(AT.dirt));
    await vi.waitFor(() => expect(server.digSim.digs.length).toBe(1));
    server.setBlock(AT.dirt.x + 1, AT.dirt.y, AT.dirt.z - 1, BLOCK.lava);
    const result = await digging;
    expect(result.message).toMatch(/it is no longer safe to dig: it is next to minecraft:lava/);
    await vi.waitFor(() => expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 1]));
  });

  it('walking and chests wait while a dig runs', async () => {
    const { server, client } = await start();
    const digging = perform(client, dig(AT.dirt));
    await vi.waitFor(() => expect(server.digSim.digs.length).toBe(1));
    const walk = await perform(client, {
      type: 'MOVE_TO',
      args: { target: { x: -6.5, y: FEET_Y, z: -8.5 }, tolerance: 0.5 },
    });
    expect(walk).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(walk.message).toMatch(/the player is digging/);
    const chest = await perform(client, {
      type: 'OPEN_CONTAINER',
      args: { containerId: 'chest.test' },
    });
    expect(chest).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(chest.message).toMatch(/the player is digging/);
    expect(await digging).toMatchObject({ ok: true });
    expect(server.walkSteps()).toEqual([]);
    expect(server.chestSim.activations).toEqual([]);
  }, 10_000);

  it('a start the server refuses (the block is re-sent) stops the dig and cancels', async () => {
    const { server, client } = await start({ dig: { refuseStart: true } });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/the server sent the block again while digging/);
    await vi.waitFor(() => expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 1]));
  });

  it('a break cancelled by a mod (air, then the block again) fails', async () => {
    const { server, client } = await start({ dig: { cancelBreak: true } });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: false, code: 'FAILED', data: { airNow: false } });
    expect(result.message).toMatch(
      /re-sent the block at \(-4, 106, -8\) after the finish \(updates 0, 3\)/,
    );
    expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 2]);
    const blocks = blocksOf(await client.observe());
    expect(blocks.removed).toEqual([]);
    expect(blocks.resources.filter(notFloor)[0]?.position).toEqual(AT.dirt);
  }, 10_000);

  it('a finish the server judges too early is re-sent and fails; vanilla then breaks it on its own', async () => {
    // As if a mod made dirt 4x harder on the server: 70% of 60 ticks is more than we wait.
    const { server, client } = await start({ dig: { hardness: { 'minecraft:dirt': 2 } } });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(
      /re-sent the block .* after the finish \(updates 3\).*too early/,
    );
    expect(server.digSim.broken).toEqual([]);
    // The server's own timer reaches 100% (60 ticks after the start) and breaks it anyway.
    await vi.waitFor(() => expect(server.digSim.broken).toHaveLength(1), { timeout: 4_000 });
    expect(server.digSim.broken[0]).toMatchObject({ late: true });
    await vi.waitFor(async () =>
      expect(blocksOf(await client.observe()).removed).toEqual([AT.dirt]),
    );
  }, 15_000);

  it('goes through the executor: validated, dug and verified (BLOCK_REMOVED)', async () => {
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
    const done = await runUserAction(deps, dig(AT.dirt), 'test');
    expect(done.status).toBe('succeeded');
    expect(
      done.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(['PASS execution-ok', 'PASS observation-fresh', 'PASS block-removed']);
    // The safety policy refuses what the observation does not list as diggable.
    expect((await runUserAction(deps, dig(AT.stone), 'test')).summary).toMatch(
      /rejected \[NOT_DIGGABLE\]/,
    );
    expect((await runUserAction(deps, dig(AT.dirt), 'test')).summary).toMatch(
      /rejected \[NOT_DIGGABLE\]/,
    );
  }, 10_000);
});

/** Item ids the tool tests use (the vanilla 1.7.10 numbering). */
const TOOL = { bread: 297, shovel: 269, axe: 271, stoneAxe: 275, ironShovel: 256 } as const;
const TOOL_ITEMS: Array<[number, string]> = [
  [TOOL.bread, 'minecraft:bread'],
  [TOOL.shovel, 'minecraft:wooden_shovel'],
  [TOOL.axe, 'minecraft:wooden_axe'],
  [TOOL.stoneAxe, 'minecraft:stone_axe'],
  [TOOL.ironShovel, 'minecraft:iron_shovel'],
];

describe('Gtnh1710Client digging with tools', () => {
  it('digs dirt with the wooden shovel in hand: 12 ticks instead of 21; it wears by one, as reported', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      inventory: [{ slot: 36, id: TOOL.shovel, count: 1, damage: 0 }],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({
      ok: true,
      data: {
        block: 'minecraft:dirt',
        ticks: 12,
        tool: 'minecraft:wooden_shovel',
        toolUsesLeft: 58,
        dropCollected: true,
        drops: '1 x minecraft:dirt',
      },
    });
    expect(result.message).toMatch(/in 12 ticks with minecraft:wooden_shovel \(58 uses left\)/);
    expect(digWaitTicks('minecraft:dirt', 2)).toBe(12);

    // The server dug with the shovel (already in hand: no hotbar change), for the shorter time.
    const digs = server.digSim.digs;
    expect(digs.map((d) => [d.status, d.held])).toEqual([
      [0, 'minecraft:wooden_shovel@0'],
      [2, 'minecraft:wooden_shovel@0'],
    ]);
    const elapsed = (digs[1]?.at ?? 0) - (digs[0]?.at ?? 0);
    expect(elapsed).toBeGreaterThanOrEqual(12 * 50 - 5);
    expect(elapsed).toBeLessThan(21 * 50);
    expect(server.playPacketIds()).not.toContain(0x09);
    expect(server.digSim.broken).toEqual([
      { ...AT.dirt, name: 'minecraft:dirt', late: false, held: 'minecraft:wooden_shovel@0' },
    ]);
    expect(server.chestSim.playerSlots()[36]).toMatchObject({ id: TOOL.shovel, damage: 1 });

    // The worn shovel shows its damage; the drop is not mistaken for it.
    const state = await client.observe();
    expect(state.inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:dirt': 1, 'minecraft:wooden_shovel@1': 1 } },
    });
    expect(state.player.heldTool).toEqual({
      known: true,
      value: { item: 'minecraft:wooden_shovel', durabilityFraction: 58 / 59 },
    });
  }, 10_000);

  it('moves a shovel from the main inventory into an empty hotbar slot first (two confirmed clicks)', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      inventory: [
        { slot: 36, id: TOOL.bread, count: 2, damage: 0 },
        { slot: 9, id: TOOL.shovel, count: 1, damage: 5 },
      ],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({
      ok: true,
      data: { ticks: 12, tool: 'minecraft:wooden_shovel', toolUsesLeft: 53 },
    });
    const sim = server.chestSim;
    // Pick it up from slot 9, put it down in the first empty hotbar slot (37), hold that.
    expect(sim.clicks.map((c) => [c.windowId, c.slot, c.button, c.accepted])).toEqual([
      [0, 9, 0, true],
      [0, 37, 0, true],
    ]);
    expect(sim.heldSlot).toBe(1);
    expect(sim.playerSlots()[9]).toBeNull();
    expect(sim.playerSlots()[37]).toMatchObject({ id: TOOL.shovel, damage: 6 });
    expect(sim.cursor).toBeNull();
    expect(sim.dropped).toEqual([]);
    expect(server.digSim.digs[0]?.held).toBe('minecraft:wooden_shovel@5');
  }, 10_000);

  it('passes over a worn-out shovel, one with NBT data and a disabled iron shovel: an empty hand', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      inventory: [
        // The agent's limit: one more use would be its 60th (the server allows 64).
        { slot: 36, id: TOOL.shovel, count: 1, damage: 59 },
        // IguanaTweaks makes it dig nothing on this server: not on the agent's allowlist.
        { slot: 37, id: TOOL.ironShovel, count: 1, damage: 0 },
        { slot: 38, id: TOOL.shovel, count: 1, damage: 0, nbt: true },
      ],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: true, data: { ticks: 21, tool: null, toolUsesLeft: null } });
    expect(result.data['toolNote']).toMatch(
      /worn out \(damage 59, the agent stops at 59\); minecraft:wooden_shovel has NBT data/,
    );
    expect(result.message).toMatch(
      /with an empty hand \(not used: minecraft:wooden_shovel is worn out/,
    );
    // The first empty hotbar slot (3) was held; nothing wore.
    expect(server.chestSim.heldSlot).toBe(3);
    expect(server.digSim.digs.map((d) => d.held)).toEqual([null, null]);
    expect(server.chestSim.playerSlots()[36]).toMatchObject({ damage: 59 });
  }, 10_000);

  it('takes the fastest axe for a log: a stone axe from the main inventory over the wooden one in hand', async () => {
    const log = { x: -6, y: 106, z: -8 };
    const { server, client } = await start({
      items: TOOL_ITEMS,
      blockOverrides: new Map([...WORLD, [key(log), BLOCK.log]]),
      inventory: [
        { slot: 36, id: TOOL.axe, count: 1, damage: 0 },
        { slot: 9, id: TOOL.stoneAxe, count: 1, damage: 0 },
      ],
    });
    const result = await perform(client, dig(log));
    expect(result).toMatchObject({
      ok: true,
      data: {
        block: 'minecraft:log',
        ticks: 21,
        tool: 'minecraft:stone_axe',
        toolUsesLeft: 130,
        drops: '1 x minecraft:log',
      },
    });
    expect(server.digSim.digs[0]?.held).toBe('minecraft:stone_axe@0');
    expect(server.chestSim.playerSlots()[37]).toMatchObject({ id: TOOL.stoneAxe, damage: 1 });
    expect(server.chestSim.playerSlots()[36]).toMatchObject({ id: TOOL.axe, damage: 0 });
  }, 10_000);

  it('never holds a protected tool: the executor hands the protected items to the client', async () => {
    const { server, client, config } = await start(
      { items: TOOL_ITEMS, inventory: [{ slot: 36, id: TOOL.shovel, count: 1, damage: 0 }] },
      {},
      ['minecraft:wooden_shovel'],
    );
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
    const done = await runUserAction(deps, dig(AT.dirt), 'test');
    expect(done.status).toBe('succeeded');
    expect(done.outcome?.execution?.data).toMatchObject({ tool: null, ticks: 21 });
    expect(done.outcome?.execution?.data['toolNote']).toMatch(/is a protected item/);
    expect(server.digSim.digs.map((d) => d.held)).toEqual([null, null]);
    expect(server.chestSim.playerSlots()[36]).toMatchObject({ damage: 0 });
  }, 10_000);

  it('stops and cancels when the tool in hand changes while digging', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      inventory: [{ slot: 36, id: TOOL.shovel, count: 1, damage: 0 }],
    });
    const digging = perform(client, dig(AT.dirt));
    await vi.waitFor(() => expect(server.digSim.digs.length).toBe(1));
    server.chestSim.setPlayerSlot(36, null); // e.g. an operator cleared the slot
    const result = await digging;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/stopped: the tool in hand changed/);
    await vi.waitFor(() => expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 1]));
    expect(server.digSim.broken).toEqual([]);
  });

  it('a rejected click while moving the tool: the cursor goes back into the inventory, no dig', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      rejectClicks: [1], // the server applies the pick-up, rejects it and re-sends the window
      inventory: [
        { slot: 36, id: TOOL.bread, count: 2, damage: 0 },
        { slot: 9, id: TOOL.shovel, count: 1, damage: 0 },
      ],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(
      /the minecraft:wooden_shovel could not be moved into the hotbar: a click was rejected/,
    );
    const sim = server.chestSim;
    expect(sim.cursor).toBeNull();
    expect(sim.dropped).toEqual([]);
    expect(sim.playerSlots().filter((s) => s?.id === TOOL.shovel)).toHaveLength(1);
    expect(digPackets(server)).toEqual([]);
  }, 10_000);

  it('refuses when the tool cannot reach the hotbar and there is no empty hand either', async () => {
    const { server, client } = await start({
      items: TOOL_ITEMS,
      inventory: [
        ...Array.from({ length: 9 }, (_, j) => ({
          slot: 36 + j,
          id: TOOL.bread,
          count: 1,
          damage: 0,
        })),
        { slot: 9, id: TOOL.shovel, count: 1, damage: 0 },
      ],
    });
    const result = await perform(client, dig(AT.dirt));
    expect(result).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(result.message).toMatch(
      /no empty hotbar slot \(to move the minecraft:wooden_shovel into, or to dig with an empty hand\)/,
    );
    expect(digPackets(server)).toEqual([]);
    expect(server.chestSim.clicks).toEqual([]);
  });
});
