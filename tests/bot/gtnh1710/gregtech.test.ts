import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeGregTechMessage,
  machineFlags,
  machineNamesFor,
  machineStatus,
  unpackCoordinates,
} from '../../../src/bot/gtnh1710/gregtech.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { ProtocolError } from '../../../src/bot/gtnh1710/wire.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import {
  DEFAULT_MODS,
  FakeGtnhServer,
  gtBlockEventsMessage,
  gtOreMessage,
  gtTileEntityMessage,
  type FakeServerOptions,
} from './fixtures/fake-server.ts';

// Common data bytes: works (64) | active (8) | facing.
const IDLE = 64;
const BUSY = 64 | 8;
const OFF = 0;
const MACERATOR_LV = 301;
const STEAM_MACERATOR = 106;
/** Not a machine id (GregTech pipes and cables use ids outside MetaTileEntityIDs). */
const PIPE_ID = 5101;

describe('GregTech channel decoding', () => {
  it('decodes a machine tile entity, as sent for (3, 200, -9) on the test server', () => {
    expect(decodeGregTechMessage(gtTileEntityMessage(3, 200, -9, MACERATOR_LV, 69))).toEqual({
      type: 'gt-tile-entity',
      x: 3,
      y: 200,
      z: -9,
      metaTileId: MACERATOR_LV,
      common: 69,
    });
  });

  it('decodes batched block events, including negative coordinates', () => {
    const message = gtBlockEventsMessage(-1, [
      { x: 3, y: 200, z: -3, eventId: 0, value: 64 },
      { x: -29_999_999, y: 5, z: 29_999_999, eventId: 7, value: 255 },
    ]);
    expect(decodeGregTechMessage(message)).toEqual({
      type: 'gt-block-events',
      dimension: -1,
      events: [
        { x: 3, y: 200, z: -3, eventId: 0, value: 64 },
        { x: -29_999_999, y: 5, z: 29_999_999, eventId: 7, value: 255 },
      ],
    });
  });

  it('unpacks GTNHLib coordinates with sign extension', () => {
    const pack = (x: number, y: number, z: number): bigint =>
      BigInt.asIntN(
        64,
        ((BigInt(x) & 0x3ffffffn) << 38n) |
          (BigInt(y) & 0xfffn) |
          ((BigInt(z) & 0x3ffffffn) << 12n),
      );
    for (const [x, y, z] of [
      [0, 0, 0],
      [-1, -1, -1],
      [-5, 200, -8],
      [33_554_431, 2047, -33_554_432],
    ] as const) {
      expect(unpackCoordinates(pack(x, y, z))).toEqual({ x, y, z });
    }
  });

  it('decodes the material of an ore (PacketOres), as GregTech sends it for an exposed ore', () => {
    // Iron (32) in black granite (+3000).
    expect(decodeGregTechMessage(gtOreMessage(-120, 37, 455, 3032))).toEqual({
      type: 'gt-ore',
      x: -120,
      y: 37,
      z: 455,
      meta: 3032,
    });
    expect(() => decodeGregTechMessage(gtOreMessage(1, 2, 3, 32).subarray(0, 9))).toThrow(
      ProtocolError,
    );
  });

  it('counts other packet types, and refuses truncated or oversized messages', () => {
    expect(decodeGregTechMessage(Buffer.from([4, 1, 2, 3]))).toEqual({
      type: 'gt-other',
      packetType: 4,
    });
    const full = gtTileEntityMessage(1, 2, 3, MACERATOR_LV, IDLE);
    expect(() => decodeGregTechMessage(full.subarray(0, full.length - 2))).toThrow(ProtocolError);
    const huge = Buffer.alloc(9);
    huge.writeUInt8(2, 0);
    huge.writeInt32BE(1_000_000, 5);
    expect(() => decodeGregTechMessage(huge)).toThrow(/count 1000000 out of range/);
  });

  it('turns the common data byte into flags and an agent status', () => {
    expect(machineFlags(69)).toEqual({ facing: 'east', active: false, works: true });
    expect(machineFlags(BUSY | 2)).toEqual({ facing: 'north', active: true, works: true });
    expect([
      machineStatus(IDLE),
      machineStatus(BUSY),
      machineStatus(OFF),
      machineStatus(8),
    ]).toEqual(['idle', 'busy', 'error', 'error']);
  });

  it('names machines only for the GregTech version the table was made from', () => {
    expect(machineNamesFor('5.09.51.482')?.get(MACERATOR_LV)).toBe('MACERATOR_LV');
    expect(machineNamesFor('5.09.51.482')?.get(PIPE_ID)).toBeUndefined();
    expect(machineNamesFor('5.09.52.0')).toBeNull();
    expect(machineNamesFor(undefined)).toBeNull();
  });
});

const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
});

async function start(options: FakeServerOptions = {}) {
  const server = new FakeGtnhServer(options);
  servers.push(server);
  const port = await server.listen();
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
    },
  }).minecraft;
  const client = new Gtnh1710Client({ config, clock: systemClock, retryDelayMs: 50 });
  clients.push(client);
  await client.connect();
  return { server, client };
}

async function machinesOf(client: Gtnh1710Client) {
  return (await client.observe()).machines.map((m) => `${m.id} ${m.name} ${m.status}`);
}

describe('Gtnh1710Client machine observation', () => {
  it('reports GregTech machines near the player with their status (power stays unknown)', async () => {
    const { server, client } = await start();
    server.sendGregTech(gtTileEntityMessage(-3, 106, -7, MACERATOR_LV, BUSY));
    server.sendGregTech(gtTileEntityMessage(-6, 106, -7, STEAM_MACERATOR, IDLE));
    server.sendGregTech(gtTileEntityMessage(-4, 106, -10, MACERATOR_LV, OFF));
    server.sendGregTech(gtTileEntityMessage(-5, 106, -5, PIPE_ID, 0b111111)); // a pipe: ignored
    server.sendGregTech(gtTileEntityMessage(100, 106, 100, MACERATOR_LV, IDLE)); // too far
    await vi.waitFor(async () => expect(await machinesOf(client)).toHaveLength(3));

    const state = await client.observe();
    expect(state.machines.map((m) => `${m.id} ${m.name} ${m.status}`)).toEqual([
      // nearest first: the player stands at (-4.5, 106, -7.5)
      'gt:-6.106.-7 STEAM_MACERATOR idle',
      'gt:-3.106.-7 MACERATOR_LV busy',
      'gt:-4.106.-10 MACERATOR_LV error',
    ]);
    expect(state.machines[0]?.powered).toEqual({
      known: false,
      reason: 'GregTech does not send stored energy to clients',
    });
  });

  it('follows state changes (block event 0) and forgets machines whose block is replaced', async () => {
    const { server, client } = await start();
    server.sendGregTech(gtTileEntityMessage(-3, 106, -7, MACERATOR_LV, BUSY));
    server.sendGregTech(gtTileEntityMessage(-6, 106, -7, MACERATOR_LV, IDLE));
    await vi.waitFor(async () => expect(await machinesOf(client)).toHaveLength(2));

    // The recipe finished; another event type (7: light) and another dimension change nothing.
    server.sendGregTech(
      gtBlockEventsMessage(0, [
        { x: -3, y: 106, z: -7, eventId: 0, value: IDLE },
        { x: -6, y: 106, z: -7, eventId: 7, value: 0 },
      ]),
    );
    server.sendGregTech(
      gtBlockEventsMessage(-1, [{ x: -6, y: 106, z: -7, eventId: 0, value: OFF }]),
    );
    await vi.waitFor(async () =>
      expect(await machinesOf(client)).toEqual([
        'gt:-6.106.-7 MACERATOR_LV idle',
        'gt:-3.106.-7 MACERATOR_LV idle',
      ]),
    );

    // Re-sending the same block keeps the machine; replacing it with air removes it.
    server.setBlock(-3, 106, -7, BLOCK.gtMachines);
    server.setBlock(-6, 106, -7, BLOCK.air);
    await vi.waitFor(async () =>
      expect(await machinesOf(client)).toEqual(['gt:-3.106.-7 MACERATOR_LV idle']),
    );
  });

  it('tracks no machines for another GregTech version, or after an undecodable message', async () => {
    const other = await start({
      mods: DEFAULT_MODS.map((m) =>
        m.modid === 'gregtech_nh' ? { ...m, version: '5.09.52.0' } : m,
      ),
    });
    other.server.sendGregTech(gtTileEntityMessage(-3, 106, -7, MACERATOR_LV, BUSY));
    await new Promise((r) => setTimeout(r, 200));
    expect(await machinesOf(other.client)).toEqual([]);

    const { server, client } = await start();
    server.sendGregTech(gtTileEntityMessage(-3, 106, -7, MACERATOR_LV, BUSY));
    await vi.waitFor(async () => expect(await machinesOf(client)).toHaveLength(1));
    server.sendGregTech(Buffer.from([0, 1, 2])); // truncated tile entity
    server.sendGregTech(gtTileEntityMessage(-6, 106, -7, MACERATOR_LV, IDLE));
    await new Promise((r) => setTimeout(r, 200));
    expect(await machinesOf(client)).toEqual([]);
  });
});

describe('Gtnh1710Client ore materials', () => {
  const GT_ORES = 4200;
  const oresOf = async (client: Gtnh1710Client): Promise<string[]> => {
    const state = await client.observe();
    if (!state.nearbyBlocks.known) return [];
    return state.nearbyBlocks.value.resources
      .filter((r) => r.block === 'gregtech:gt.blockores')
      .map((r) => `${r.position.x},${r.position.y},${r.position.z} ${r.ore ?? '?'}`);
  };

  it('lists the material the server sent with its ore, and forgets it with the ore', async () => {
    // Two ores on the ground beside the player (it stands at (-4.5, 106, -7.5)).
    const { server, client } = await start({
      blocks: [...DIG_TEST_BLOCK_REGISTRY, [GT_ORES, 'gregtech:gt.blockores']],
      blockOverrides: new Map([
        ['-3,106,-7', GT_ORES],
        ['-6,106,-7', GT_ORES],
      ]),
    });
    await vi.waitFor(async () => expect(await oresOf(client)).toHaveLength(2));
    server.sendGregTech(gtOreMessage(-3, 106, -7, 32));
    await vi.waitFor(async () =>
      expect((await oresOf(client)).sort()).toEqual(['-3,106,-7 32', '-6,106,-7 ?']),
    );
    // Dug: no ore there, and no material with what replaces it.
    server.setBlock(-3, 106, -7, BLOCK.air);
    server.setBlock(-3, 106, -7, GT_ORES);
    await vi.waitFor(async () =>
      expect((await oresOf(client)).sort()).toEqual(['-3,106,-7 ?', '-6,106,-7 ?']),
    );
  });
});
