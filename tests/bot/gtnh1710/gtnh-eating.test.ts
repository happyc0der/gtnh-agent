import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// Seen live: the agent had an apple and hunger fell, but EAT_FOOD was not implemented, so every
// EAT failed until the repeated-failure rule stopped play.
const APPLE = 260;
const ITEMS: Array<[number, string]> = [
  [APPLE, 'minecraft:apple'],
  [297, 'minecraft:bread'],
  [3, 'minecraft:dirt'],
];
/** Window-0 slots: 9-35 the main inventory, 36-44 the hotbar. */
const hotbar = (j: number): number => 36 + j;

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-eat-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(server: FakeServerOptions = {}) {
  const fake = new FakeGtnhServer({
    items: ITEMS,
    edible: [[APPLE, 4]],
    health: { health: 20, food: 12, saturation: 5 },
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
      movement: { stopFile: join(dir, 'STOP') },
      eating: { enabled: true },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client };
}

const ids = sequentialIds();
function eat(client: Gtnh1710Client, item: string) {
  const spec: ActionSpec = { type: 'EAT_FOOD', args: { item } };
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}

async function apples(client: Gtnh1710Client): Promise<number> {
  const state = await client.observe();
  return state.inventory.known ? (state.inventory.value.items['minecraft:apple'] ?? 0) : -1;
}

describe('Gtnh1710Client eating', () => {
  it('holds the food and uses it in the air, then waits for the server to eat it', async () => {
    const { server, client } = await start({
      inventory: [
        { slot: hotbar(0), id: 3, count: 10, damage: 0 },
        { slot: hotbar(2), id: APPLE, count: 3, damage: 0 },
      ],
    });
    const r = await eat(client, 'minecraft:apple');
    expect(r, r.message).toMatchObject({ ok: true, data: { foodBefore: 12, foodAfter: 16 } });
    expect(r.message).toBe('ate 1 x minecraft:apple: food 12 -> 16');
    expect(server.eatsStarted).toBe(1);
    expect(server.chestSim.heldSlot).toBe(2);
    expect(await apples(client)).toBe(2);
    expect((await client.observe()).player.hunger).toEqual({ known: true, value: 16 });
  });

  it('moves food from the main inventory into a free hotbar slot first', async () => {
    const { server, client } = await start({
      inventory: [
        { slot: hotbar(0), id: 3, count: 10, damage: 0 },
        { slot: 12, id: APPLE, count: 1, damage: 0 },
      ],
    });
    const r = await eat(client, 'minecraft:apple');
    expect(r, r.message).toMatchObject({ ok: true });
    expect(server.eatsStarted).toBe(1);
    expect(await apples(client)).toBe(0);
  });

  it('swaps food into a full hotbar, with a plain stack there (seen live: hungry, unable to eat)', async () => {
    // Dirt (id 3) in every hotbar slot, the apple in the main inventory.
    const { server, client } = await start({
      inventory: [
        ...Array.from({ length: 9 }, (_, j) => ({ slot: hotbar(j), id: 3, count: 10, damage: 0 })),
        { slot: 12, id: APPLE, count: 1, damage: 0 },
      ],
    });
    const r = await eat(client, 'minecraft:apple');
    expect(r, r.message).toMatchObject({ ok: true });
    expect(server.eatsStarted).toBe(1);
    expect(await apples(client)).toBe(0);
    // The dirt it swapped out went where the apple was.
    expect(server.chestSim.playerSlots()[12]).toMatchObject({ id: 3, count: 10 });
    expect(server.chestSim.cursor).toBeNull();
  });

  it('ends the spawn protection with an empty-handed click on the ground, then eats', async () => {
    // Seen live: right after joining, AngerMod's spawn protection kept every EAT from working.
    const { server, client } = await start({
      spawnProtection: true,
      inventory: [{ slot: hotbar(2), id: APPLE, count: 3, damage: 0 }],
    });
    expect(server.spawnProtected).toBe(true);
    const r = await eat(client, 'minecraft:apple');
    expect(r, r.message).toMatchObject({ ok: true, data: { foodBefore: 12, foodAfter: 16 } });
    expect(server.spawnProtected).toBe(false);
    // One click, on the grass underfoot (y 105), with nothing in hand; then the use in the air.
    const clicks = server.placeSim.placements.filter((p) => p.face !== 255);
    expect(clicks).toMatchObject([{ x: -5, y: 105, z: -8, face: 1, claimed: null, held: null }]);
    expect(server.eatsStarted).toBe(1);
    expect(await apples(client)).toBe(2);
  });

  it('clicks the ground with the food itself while protected when no hotbar slot is free', async () => {
    // Seen live: a full hotbar, so no empty hand to end the protection, and no meal at all.
    // An apple places nothing on the ground (ItemFood has no use on a block).
    const full = Array.from({ length: 9 }, (_, j) => ({
      slot: hotbar(j),
      id: j === 0 ? APPLE : 3,
      count: 5,
      damage: 0,
    }));
    const { server, client } = await start({ spawnProtection: true, inventory: full });
    const r = await eat(client, 'minecraft:apple');
    expect(r, r.message).toMatchObject({ ok: true });
    expect(server.spawnProtected).toBe(false);
    const clicks = server.placeSim.placements.filter((p) => p.face !== 255);
    expect(clicks).toMatchObject([{ x: -5, y: 105, z: -8, face: 1 }]);
    expect(server.eatsStarted).toBe(1);
  });

  it('refuses at full food, without the food, or when the server never finishes', async () => {
    const full = await start({
      health: { health: 20, food: 20, saturation: 5 },
      inventory: [{ slot: hotbar(0), id: APPLE, count: 1, damage: 0 }],
    });
    expect(await eat(full.client, 'minecraft:apple')).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: expect.stringMatching(/not hungry/) as string,
    });
    expect(full.server.eatsStarted).toBe(0);

    const none = await start({ inventory: [{ slot: hotbar(0), id: 3, count: 5, damage: 0 }] });
    expect(await eat(none.client, 'minecraft:apple')).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: expect.stringMatching(/no minecraft:apple in the inventory/) as string,
    });

    // Bread the server does not let it eat (not edible here): the use is sent, nothing is eaten.
    const stale = await start({ inventory: [{ slot: hotbar(0), id: 297, count: 1, damage: 0 }] });
    const r = await eat(stale.client, 'minecraft:bread');
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(/did not finish eating/);
  }, 20_000);
});
