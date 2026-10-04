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
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './fixtures/chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The fake player stands at (-4.5, 106, -7.5) on a grass floor at y=105, in a terrain fence.
// A stone wall two high crosses the whole fence at x = -3, with a wooden door in it on the
// player's row, closed (facing 0: its panel along the cell's west edge, across the way east).
const FEET_Y = 106;
const TERRAIN = { min: { x: -9, y: 100, z: -12 }, max: { x: -1, y: 110, z: -4 } };
const WALL_X = -3;
const DOOR = { x: WALL_X, y: FEET_Y, z: -8 };
const WOODEN_DOOR = 64;
const WALL = new Map<string, number>();
for (let z = TERRAIN.min.z; z <= TERRAIN.max.z; z++) {
  for (const y of [FEET_Y, FEET_Y + 1]) WALL.set(`${WALL_X},${y},${z}`, BLOCK.stone);
}
WALL.set(`${DOOR.x},${DOOR.y},${DOOR.z}`, WOODEN_DOOR);
WALL.set(`${DOOR.x},${DOOR.y + 1},${DOOR.z}`, WOODEN_DOOR);
/** The lower half: facing 0, closed; the upper half: bit 8. */
const METAS = new Map<string, number>([
  [`${DOOR.x},${DOOR.y},${DOOR.z}`, 0],
  [`${DOOR.x},${DOOR.y + 1},${DOOR.z}`, 8],
]);

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-doors-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(server: FakeServerOptions = {}, allowDoors = true) {
  const fake = new FakeGtnhServer({
    blocks: [...DIG_TEST_BLOCK_REGISTRY, [WOODEN_DOOR, 'minecraft:wooden_door']],
    blockOverrides: WALL,
    blockMeta: METAS,
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
      movement: {
        enabled: true,
        fence: TERRAIN,
        stopFile: join(dir, 'STOP'),
        path: { allowDoors },
      },
    },
  });
  const client = new Gtnh1710Client({ config: config.minecraft, clock: systemClock });
  clients.push(client);
  await client.connect();
  return { server: fake, client };
}

const ids = sequentialIds();
function perform(client: Gtnh1710Client, spec: ActionSpec) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, null, new Date()));
}
/** Beyond the wall, on the player's row. */
const BEYOND: ActionSpec = {
  type: 'MOVE_TO',
  args: { target: { x: -1.5, y: FEET_Y, z: -7.5 }, tolerance: 0.5 },
};

describe('Gtnh1710Client walks through a door (MOVE_TO, doors allowed)', () => {
  it('opens the door in its way, walks through, and closes it again behind', async () => {
    const { server, client } = await start();
    const result = await perform(client, BEYOND);
    expect(result, result.message).toMatchObject({ ok: true, code: 'OK' });
    expect(result.message).toMatch(/went through 1 door\(s\) or gate\(s\), left as found/);
    // Two clicks on the door's lower half: its west face from the near side, then its east
    // face from beyond; nothing placed.
    const clicks = server.placeSim.placements.filter((p) => p.face !== 255);
    expect(clicks.map((c) => [c.x, c.y, c.z, c.face, c.placed])).toEqual([
      [DOOR.x, DOOR.y, DOOR.z, 4, false],
      [DOOR.x, DOOR.y, DOOR.z, 5, false],
    ]);
    // The door is closed again, as the client sees it too; the player stands beyond it.
    const world = client.world.walkWorld();
    expect(world?.metaAt?.(DOOR.x, DOOR.y, DOOR.z)).toBe(0);
    expect(client.world.ownPosition).toMatchObject({ x: -1.5, y: FEET_Y, z: -7.5 });
  }, 15_000);

  it('never through a door with doors not allowed', async () => {
    const { server, client } = await start({}, false);
    const result = await perform(client, BEYOND);
    expect(result).toMatchObject({ ok: false });
    expect(server.placeSim.placements.filter((p) => p.face !== 255)).toEqual([]);
  }, 15_000);
});
