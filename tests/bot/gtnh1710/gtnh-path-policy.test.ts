import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import { defaultConfig, type PathConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, PLACE_TEST_BLOCK_REGISTRY, type BlockFn } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeItem, type FakeServerOptions } from './fixtures/fake-server.ts';

// The walk policies (minecraft.movement.path, path-policy.ts) on the fake server, which checks
// every move as a 1.7.10 server does. The player starts at (-4.5, 106, -7.5) on grass at
// y=105 over dirt and stone, in a strip one block wide (z = -8): no way round anything. East
// of it, each test sets a cliff, a gap or a trench.
const FEET_Y = 106;
const STRIP = { min: { x: -9, y: 96, z: -8 }, max: { x: 6, y: 112, z: -8 } };
const START = { x: -4.5, y: FEET_Y, z: -7.5 };

/** Ground whose grass top is at `top(x)` (no block at all where it is null: a hole). */
function terrain(top: (x: number) => number | null): BlockFn {
  return (x, y) => {
    const t = top(x);
    if (y === 0) return BLOCK.bedrock;
    if (t === null || y > t) return BLOCK.air;
    if (y === t) return BLOCK.grass;
    return y >= t - 2 ? BLOCK.dirt : BLOCK.stone;
  };
}
/** Three blocks higher from x = -2 east: a cliff no jump climbs (its top at y=109's feet). */
const CLIFF = terrain((x) => (x >= -2 ? 108 : 105));
const CLIFF_FEET = 109;
/** Two blocks higher: one pillar block, then a jump. */
const LOW_CLIFF = terrain((x) => (x >= -2 ? 107 : 105));
/** A gap two wide (x -2 and -1) with nothing under it: no floor to fall onto. */
const CHASM = terrain((x) => (x === -2 || x === -1 ? null : 105));
/** A trench one wide (x = -2), two deep: falling in is safe, climbing out is not possible. */
const TRENCH = terrain((x) => (x === -2 ? 103 : 105));
/** A gap one wide (x = -2) with nothing under it. */
const SHAFT = terrain((x) => (x === -2 ? null : 105));

const COBBLE: FakeItem = { slot: 36, id: BLOCK.cobblestone, count: 10, damage: 0 };
const dirt = (count: number): FakeItem => ({ slot: 37, id: BLOCK.dirt, count, damage: 0 });

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-path-policy-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(
  world: BlockFn,
  opts: {
    inventory?: FakeItem[];
    placing?: boolean;
    digging?: boolean;
    path?: Partial<PathConfig>;
    server?: FakeServerOptions;
  } = {},
) {
  const fake = new FakeGtnhServer({
    blocks: PLACE_TEST_BLOCK_REGISTRY,
    world,
    spawn: { x: START.x, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z: START.z, yaw: 0, pitch: 0 },
    inventory: opts.inventory ?? [COBBLE],
    ...opts.server,
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
      movement: { enabled: true, fence: STRIP, stopFile: join(dir, 'STOP'), path: opts.path ?? {} },
      digging: { enabled: opts.digging ?? false },
      placing: { enabled: opts.placing ?? true },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec, protectedItems: string[] = []) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date(), protectedItems));
}
const moveTo = (x: number, y: number): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y, z: -7.5 }, tolerance: 0.5 },
});

async function positionOf(client: Gtnh1710Client) {
  const p = (await client.observe()).player.position;
  if (!p.known) throw new Error('position unknown');
  return p.value;
}

describe('walk policies on the fake server', { timeout: 30_000 }, () => {
  it('pillars up a cliff with throwaway cobblestone: a jump, a block in the cell left, landed on', async () => {
    const { server, client } = await start(CLIFF);
    const r = await perform(client, moveTo(-1.5, CLIFF_FEET));
    expect(r, r.message).toMatchObject({ ok: true, data: { placed: 2, reached: true } });
    expect(r.message).toMatch(/placed 2 block\(s\): \(-3, 106, -8\), \(-3, 107, -8\)/);
    expect(server.placeSim.placed).toEqual([
      { x: -3, y: 106, z: -8, name: 'minecraft:cobblestone' },
      { x: -3, y: 107, z: -8, name: 'minecraft:cobblestone' },
    ]);
    // Each click against the top of the block under the feet (face 1), the cursor at its centre.
    expect(server.placeSim.placements.map((p) => [p.x, p.y, p.z, p.face, p.cursor])).toEqual([
      [-3, 105, -8, 1, [8, 16, 8]],
      [-3, 106, -8, 1, [8, 16, 8]],
    ]);
    expect(await positionOf(client)).toEqual({ x: -1.5, y: CLIFF_FEET, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
    expect(server.moveSim.falls).toEqual([]);

    // A cliff two high takes one block: up onto it, then a jump onto the cliff.
    const low = await start(LOW_CLIFF);
    expect(await perform(low.client, moveTo(-1.5, 108))).toMatchObject({
      ok: true,
      data: { placed: 1 },
    });
    expect(low.server.moveSim.corrections).toEqual([]);
  });

  it('bridges a chasm with nothing under it, clicking the side of the block underfoot', async () => {
    const { server, client } = await start(CHASM);
    const r = await perform(client, moveTo(0.5, FEET_Y));
    expect(r, r.message).toMatchObject({ ok: true, data: { placed: 2, reached: true } });
    expect(server.placeSim.placed.map((p) => [p.x, p.y, p.z])).toEqual([
      [-2, 105, -8],
      [-1, 105, -8],
    ]);
    // East faces (5) of the block underfoot, then of the block just placed.
    expect(server.placeSim.placements.map((p) => [p.x, p.y, p.z, p.face])).toEqual([
      [-3, 105, -8, 5],
      [-2, 105, -8, 5],
    ]);
    expect(await positionOf(client)).toEqual({ x: 0.5, y: FEET_Y, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
  });

  it('jumps a gap that is safe to fall into (parkour), and refuses with parkour off', async () => {
    const { server, client } = await start(TRENCH, { placing: false });
    const r = await perform(client, moveTo(0.5, FEET_Y));
    expect(r, r.message).toMatchObject({ ok: true, data: { reached: true } });
    // Off the ground over the trench, never down in it.
    const steps = server.walkSteps();
    expect(steps.some((s) => !s.onGround && s.x > -2 && s.x < -1)).toBe(true);
    expect(steps.every((s) => s.feetY >= FEET_Y - 1e-9)).toBe(true);
    expect(server.moveSim.corrections).toEqual([]);

    const off = await start(TRENCH, { placing: false, path: { allowParkour: false } });
    const refused = await perform(off.client, moveTo(0.5, FEET_Y));
    expect(refused).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(off.server.walkSteps()).toEqual([]);
  });

  it('jumps a gap with no floor under it only when parkourOverDeepGaps allows it', async () => {
    const safe = await start(SHAFT, { placing: false });
    expect(await perform(safe.client, moveTo(0.5, FEET_Y))).toMatchObject({
      ok: false,
      code: 'REFUSED',
    });
    const bold = await start(SHAFT, { placing: false, path: { parkourOverDeepGaps: true } });
    const r = await perform(bold.client, moveTo(0.5, FEET_Y));
    expect(r, r.message).toMatchObject({ ok: true });
    expect(bold.server.moveSim.corrections).toEqual([]);
  });

  it('a pillar block the server refuses: the jump comes back down where it began, and the walk stops', async () => {
    const { server, client } = await start(CLIFF, { server: { place: { cancelPlace: true } } });
    const r = await perform(client, moveTo(-1.5, CLIFF_FEET));
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(
      /the block placed at \(-3, 106, -8\) was not there in time \(refused\): came back down where the jump began/,
    );
    expect(server.placeSim.placed).toEqual([]);
    expect(await positionOf(client)).toEqual({ x: -2.5, y: FEET_Y, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
    expect(server.walkSteps().at(-1)).toMatchObject({ feetY: FEET_Y, onGround: true });
  });

  it('a pillar block the server places too late: the jump comes down, then up onto the block', async () => {
    // A lagging server places the block 0.7 s after the click, after the jump has landed back
    // where it began, into the player's own cell (the server leaves the placer out of its
    // check). The agent jumps up onto it, as a player gets out of a block it stands in.
    const { server, client } = await start(CLIFF, { server: { place: { lagMs: 700 } } });
    const r = await perform(client, moveTo(-1.5, CLIFF_FEET));
    expect(r).toMatchObject({ ok: false, code: 'FAILED', data: { placed: 1 } });
    expect(r.message).toMatch(
      /the block placed at \(-3, 106, -8\) was not there in time \(pending\); it came late, after the jump came back down: jumped up onto it/,
    );
    expect(server.placeSim.placed).toEqual([
      { x: -3, y: 106, z: -8, name: 'minecraft:cobblestone' },
    ]);
    expect(await positionOf(client)).toEqual({ x: -2.5, y: FEET_Y + 1, z: -7.5 });
    expect(server.moveSim.corrections).toEqual([]);
    expect(server.moveSim.falls).toEqual([]);
    expect(server.combatSim.playerHealth).toBe(20);
  });

  it('keeps the dirt reserve for the night shelter, and never places a protected item', async () => {
    // Five dirt, four kept: one to place, and the cliff needs two.
    const short = await start(CLIFF, { inventory: [dirt(5)] });
    const r = await perform(short.client, moveTo(-1.5, CLIFF_FEET));
    expect(r).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(r.message).toMatch(/placing at most 1 blocks/);
    // Six: two to place.
    const enough = await start(CLIFF, { inventory: [dirt(6)] });
    expect(await perform(enough.client, moveTo(-1.5, CLIFF_FEET))).toMatchObject({ ok: true });
    expect(enough.server.placeSim.placed.map((p) => p.name)).toEqual([
      'minecraft:dirt',
      'minecraft:dirt',
    ]);
    // Protected cobblestone is never placed.
    const kept = await start(CLIFF);
    const p = await perform(kept.client, moveTo(-1.5, CLIFF_FEET), ['minecraft:cobblestone']);
    expect(p).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(kept.server.placeSim.placements).toEqual([]);
  });

  it('places nothing within 3 blocks and breaks nothing within 4 blocks of another player', async () => {
    // The owner on the cliff, a block and a half from where a pillar would go: the agent
    // pillars farther back instead, out of the owner's way, and jumps the gap (falling into it
    // would be safe: three blocks) onto the cliff.
    const owner = {
      kind: 'player' as const,
      entityId: 77,
      name: 'Owner',
      x: -1.5,
      y: CLIFF_FEET,
      z: -7.5,
    };
    const near = await start(CLIFF, { server: { entities: [owner] } });
    const r = await perform(near.client, moveTo(-0.5, CLIFF_FEET));
    expect(r, r.message).toMatchObject({ ok: true, data: { reached: true } });
    expect(near.server.placeSim.placed.length).toBeGreaterThan(0);
    for (const p of near.server.placeSim.placed) {
      const dy = Math.max(0, owner.y - (p.y + 0.5), p.y + 0.5 - (owner.y + 1.8));
      expect(Math.hypot(p.x + 0.5 - owner.x, dy, p.z + 0.5 - owner.z)).toBeGreaterThan(3);
    }
    expect(near.server.moveSim.corrections).toEqual([]);
    expect(near.server.moveSim.falls).toEqual([]);
    // A dirt wall three high next to the owner: not broken; the same wall far from anyone is.
    const wall = new Map([
      ['-2,106,-8', BLOCK.dirt],
      ['-2,107,-8', BLOCK.dirt],
      ['-2,108,-8', BLOCK.dirt],
    ]);
    const walled: BlockFn = (x, y, z) => wall.get(`${x},${y},${z}`) ?? terrain(() => 105)(x, y, z);
    const blocked = await start(walled, {
      placing: false,
      digging: true,
      server: { entities: [{ ...owner, x: 0.5, y: FEET_Y, z: -7.5 }] },
    });
    expect(await perform(blocked.client, moveTo(-0.5, FEET_Y))).toMatchObject({
      ok: false,
      code: 'REFUSED',
    });
    expect(blocked.server.digSim.digs).toEqual([]);
    const free = await start(walled, { placing: false, digging: true });
    expect(await perform(free.client, moveTo(-0.5, FEET_Y))).toMatchObject({ ok: true });
  });
});
