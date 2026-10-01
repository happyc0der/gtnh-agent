import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction, syncConfigToDatabase } from '../../../src/app/agent-loop.ts';
import { digWaitTicks } from '../../../src/bot/gtnh1710/digging.ts';
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
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

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

async function start(server: FakeServerOptions = {}, digging: Partial<DiggingConfig> = {}) {
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

describe('Gtnh1710Client digging', () => {
  it('is off unless enabled, and then sends nothing', async () => {
    const { server, client } = await start({}, { enabled: false });
    expect(await perform(client, dig(AT.dirt))).toMatchObject({
      ok: false,
      code: 'NOT_IMPLEMENTED',
    });
    expect(digPackets(server)).toEqual([]);
  });

  it('observes the diggable blocks at or above the feet, nearest first (not the grass floor)', async () => {
    const { client } = await start();
    const blocks = blocksOf(await client.observe());
    expect(blocks.scanRadius).toBe(16);
    expect(blocks.removed).toEqual([]);
    expect(blocks.resources[0]).toEqual({ block: 'minecraft:dirt', position: AT.dirt });
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
    // Nothing below the feet level: the grass floor at y=105 is never listed.
    expect(blocks.resources.every((r) => r.position.y >= FEET_Y)).toBe(true);
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
    // Nothing but the allowed packets: keep-alive, idle ticks, echoes, hotbar, digging, FML.
    expect(
      server.playPacketIds().every((id) => [0x00, 0x03, 0x06, 0x07, 0x09, 0x17].includes(id)),
    ).toBe(true);
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
    expect(blocks.resources[0]?.position).toEqual(AT.dirt);
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
