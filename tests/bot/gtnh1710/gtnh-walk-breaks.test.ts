import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105, in a terrain fence.
// A two-block-high wall of leaves crosses the whole fence at x = -3, as the leaf bushes stood
// round the logs in the Hot Forest (seen live 2026-10-01): no walk gets past it without
// breaking a leaf or two.
const FEET_Y = 106;
const TERRAIN = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
const WALL_X = -3;
const WALL = new Map<string, number>();
for (let z = TERRAIN.min.z; z <= TERRAIN.max.z; z++) {
  for (const y of [FEET_Y, FEET_Y + 1]) WALL.set(`${WALL_X},${y},${z}`, BLOCK.leaves);
}
/** Vanilla 1.7.10's sapling (block and item id 6), for leaves that drop one. */
const SAPLING = 6;

let dir = '';
let stopFile = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-walk-breaks-'));
  stopFile = join(dir, 'STOP');
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(server: FakeServerOptions = {}, digging = true) {
  const fake = new FakeGtnhServer({
    blocks: [...DIG_TEST_BLOCK_REGISTRY, [SAPLING, 'minecraft:sapling']],
    blockOverrides: WALL,
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
      movement: { enabled: true, fence: TERRAIN, stopFile },
      digging: { enabled: digging },
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
const moveTo = (x: number, z: number): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y: FEET_Y, z }, tolerance: 0.5 },
});
/** Beyond the wall, on the player's row. */
const BEYOND = moveTo(-1.5, -7.5);

/** The play packets the client sent, in order: walking steps (C06, their x) and digs (C07). */
function stepsAndDigs(server: FakeGtnhServer): Array<{ step: number } | { dig: number }> {
  return server.received
    .filter((p) => p.state === 'play' && (p.id === 0x06 || p.id === 0x07))
    .map((p) => (p.id === 0x06 ? { step: p.body.readDoubleBE(0) } : { dig: p.body.readUInt8(0) }));
}
/** A step whose body (0.3 each side) reaches into the wall's column. */
const inWall = (p: { step: number } | { dig: number }): boolean =>
  'step' in p && p.step + 0.3 > WALL_X;

describe('Gtnh1710Client walks through leaves (MOVE_TO over terrain, digging enabled)', () => {
  it('breaks the two leaves in its way, upper first, each sent and confirmed, then walks on', async () => {
    const { server, client } = await start();
    const result = await perform(client, BEYOND);
    expect(result).toMatchObject({ ok: true, code: 'OK', data: { broken: 2, drops: '' } });
    expect(result.message).toMatch(
      /^walked 3\.00 blocks in \d+ steps; broke 2 leaves on the way: \(-3, 107, -8\), \(-3, 106, -8\)$/,
    );
    // As DIG_BLOCK digs: C07 start and finish, an empty hand, the head-level leaf first.
    expect(server.digSim.digs.map((d) => [d.status, d.x, d.y, d.z, d.emptyHand])).toEqual([
      [0, WALL_X, 107, -8, true],
      [2, WALL_X, 107, -8, true],
      [0, WALL_X, 106, -8, true],
      [2, WALL_X, 106, -8, true],
    ]);
    expect(server.digSim.broken.map((b) => [b.x, b.y, b.z, b.late])).toEqual([
      [WALL_X, 107, -8, false],
      [WALL_X, 106, -8, false],
    ]);
    // It waited each leaf's dig time: 10 ticks by hand.
    const [start1, finish1] = server.digSim.digs;
    expect((finish1?.at ?? 0) - (start1?.at ?? 0)).toBeGreaterThanOrEqual(10 * 50 - 5);
    // Every dig came before the body entered the wall's column, and the walk ended beyond it.
    const order = stepsAndDigs(server);
    const lastDig = order.findLastIndex((p) => 'dig' in p);
    expect(order.findIndex(inWall)).toBeGreaterThan(lastDig);
    expect(server.walkSteps().at(-1)).toMatchObject({ x: -1.5, feetY: FEET_Y, z: -7.5 });
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -1.5, y: FEET_Y, z: -7.5 },
    });
    // Nothing but the walking and digging packets: keep-alive, idle ticks, look, steps, digs,
    // arm swings, FML.
    expect(
      server.playPacketIds().every((id) => [0x00, 0x03, 0x05, 0x06, 0x07, 0x0a, 0x17].includes(id)),
    ).toBe(true);
  }, 15_000);

  it('only with digging enabled: otherwise the wall refuses the walk, and nothing is sent', async () => {
    const { server, client } = await start({}, false);
    const result = await perform(client, BEYOND);
    expect(result).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(result.message).toMatch(/no walkable path to the target inside the fence/);
    expect(server.digSim.digs).toEqual([]);
    expect(server.walkSteps()).toEqual([]);
  });

  it('a break the server refuses stops the walk before the wall: cancelled, nothing entered', async () => {
    const { server, client } = await start({ dig: { refuseStart: true } });
    const result = await perform(client, BEYOND);
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(
      /^walk stopped after \d+ of \d+ steps: breaking \(-3, 107, -8\) out of the way failed: dig of minecraft:leaves at \(-3, 107, -8\) stopped: the server sent the block again while digging/,
    );
    await vi.waitFor(() => expect(server.digSim.digs.map((d) => d.status)).toEqual([0, 1]));
    expect(server.digSim.broken).toEqual([]);
    // It stopped where it broke from, on the ground before the wall.
    expect(stepsAndDigs(server).some(inWall)).toBe(false);
    expect((await client.observe()).player.position).toEqual({
      known: true,
      value: { x: -3.5, y: FEET_Y, z: -7.5 },
    });
    // Nothing is left running: idle ticks go on, and the next walk (no break) goes.
    const idle = server.idleTicks;
    await vi.waitFor(() => expect(server.idleTicks).toBeGreaterThan(idle));
    expect(await perform(client, moveTo(-6.5, -7.5))).toMatchObject({ ok: true });
  }, 15_000);

  it('re-checks each break just before it: lava next to the leaf stops the walk, no dig sent', async () => {
    const { server, client } = await start();
    const walk = perform(client, BEYOND);
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(1));
    // Diagonally above the head-level leaf, and next to no block the walk stands in.
    server.setBlock(-2, FEET_Y + 2, -9, BLOCK.lava);
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(
      /breaking \(-3, 107, -8\) out of the way failed: not digging: it is next to minecraft:lava at \(-2, 108, -9\)/,
    );
    expect(server.digSim.digs).toEqual([]);
    expect(stepsAndDigs(server).some(inWall)).toBe(false);
  }, 15_000);

  it('picks up what the leaves drop during the walk, and reports it', async () => {
    const sapling = { item: 'minecraft:sapling', count: 1 };
    const { server, client } = await start({
      dig: { drops: { 'minecraft:leaves': sapling } },
    });
    const result = await perform(client, BEYOND);
    expect(result).toMatchObject({ ok: true, data: { broken: 2, drops: '2 x minecraft:sapling' } });
    expect(result.message).toMatch(/; picked up 2 x minecraft:sapling$/);
    expect(server.digSim.pickedUp).toEqual([sapling, sapling]);
    // The saplings are in before the walk reports: the next action's checks do not see them.
    expect((await client.observe()).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:sapling': 2 } },
    });
  }, 15_000);

  it('fetches a drop the leaves keep it from: no walk without breaking, so one that breaks its way', async () => {
    // Dirt beyond the wall, in reach (no line of sight is needed to dig): its drop lands in
    // its own cell, out of pickup reach, and no walk gets there without breaking a leaf.
    const dirt = { x: -2, y: FEET_Y, z: -9 };
    const blocks = new Map(WALL);
    blocks.set(`${dirt.x},${dirt.y},${dirt.z}`, BLOCK.dirt);
    const { server, client } = await start({ blockOverrides: blocks });
    const result = await perform(client, {
      type: 'DIG_BLOCK',
      args: { position: dirt },
    });
    expect(result).toMatchObject({
      ok: true,
      data: { dropCollected: true, drops: '1 x minecraft:dirt', walkedToDrop: true },
    });
    expect(result.message).toMatch(/picked up 1 x minecraft:dirt/);
    expect(server.digSim.pickedUp).toContainEqual({ item: 'minecraft:dirt', count: 1 });
    // Its way through the wall: two leaves broken (upper first), never a block placed.
    const digs = stepsAndDigs(server).filter((p) => 'dig' in p);
    expect(digs.length).toBeGreaterThanOrEqual(2 * 3); // the dirt's and two leaves' start/finish
    expect(server.received.filter((p) => p.state === 'play' && p.id === 0x08)).toHaveLength(0);
  }, 20_000);

  it('goes through the executor: validated, walked (breaking) and verified (PLAYER_NEAR)', async () => {
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
    const done = await runUserAction(deps, BEYOND, 'test');
    expect(done.status).toBe('succeeded');
    expect(done.outcome?.execution?.data).toMatchObject({ broken: 2 });
    expect(
      done.outcome?.verification?.checks.map((c) => `${c.passed ? 'PASS' : 'FAIL'} ${c.name}`),
    ).toEqual(['PASS execution-ok', 'PASS observation-fresh', 'PASS player-near-target']);
  }, 15_000);
});
