import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { Gtnh1710Client } from '../../../../src/bot/gtnh1710/gtnh-client.ts';
import { PLAYER_EYE_HEIGHT } from '../../../../src/bot/gtnh1710/packets.ts';
import { defaultConfig, type MovementConfig } from '../../../../src/config/env.ts';
import {
  createAction,
  type ActionSpec,
  type ExploreToward,
} from '../../../../src/domain/actions.ts';
import type { Position } from '../../../../src/domain/common.ts';
import { mintValidatedAction } from '../../../../src/domain/validated-action.ts';
import { systemClock } from '../../../../src/util/clock.ts';
import { sequentialIds } from '../../../../src/util/ids.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY } from './chunk-fixtures.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fake-server.ts';

/**
 * A world bigger than one play area, streamed as the player walks:
 *  - a desert (sand; biome 230 Hot Desert) for z < 32, x < 38, where the player starts;
 *  - a forest (grass, a tree every 7 blocks; 229 Hot Forest) for z >= 32, x < 38;
 *  - a river (water x 40..44, gravel and sand on the west bank, clay on the east bank;
 *    211 River Oasis) for x 38..46, which cannot be walked across;
 *  - plains (grass; 1 Plains) for x >= 47.
 * The ground's top is y=63, so the feet are at y=64. The exploration boundary's west edge is
 * x=20, 10 blocks west of the spawn.
 */
export const GROUND = 63;
export const FEET_Y = GROUND + 1;
export const SPAWN = { x: 30.5, z: 20.5 };
export const BOUNDARY = { min: { x: 20, y: 0, z: -100 }, max: { x: 200, y: 255, z: 200 } };
const mod = (n: number, m: number): number => ((n % m) + m) % m;

export function exploreWorld(x: number, y: number, z: number): number {
  if (y === 0) return BLOCK.bedrock;
  if (y <= GROUND - 3) return BLOCK.stone;
  if (x >= 40 && x <= 44) return y <= GROUND ? BLOCK.water : BLOCK.air;
  if (x >= 38 && x <= 46) {
    if (y !== GROUND) return y < GROUND ? BLOCK.sand : BLOCK.air;
    if (x <= 39) return mod(z, 2) === 0 ? BLOCK.gravel : BLOCK.sand;
    return x === 45 && mod(z, 3) === 0 ? BLOCK.clay : BLOCK.sand;
  }
  if (x < 38 && z < 32) return y <= GROUND ? BLOCK.sand : BLOCK.air;
  if (y < GROUND) return y <= GROUND - 2 ? BLOCK.stone : BLOCK.dirt;
  if (y === GROUND) return BLOCK.grass;
  // Trees at x and z multiples of 7 (z >= 35): trunk y 64..67, leaves around its top.
  const tx = Math.round(x / 7) * 7;
  const tz = Math.round(z / 7) * 7;
  if (tx < 38 && tz >= 35) {
    const dx = Math.abs(x - tx);
    const dz = Math.abs(z - tz);
    if (dx === 0 && dz === 0 && y <= GROUND + 4) return BLOCK.log;
    if (dx <= 1 && dz <= 1 && (y === GROUND + 4 || y === GROUND + 5)) return BLOCK.leaves;
  }
  return BLOCK.air;
}

export function exploreBiome(x: number, z: number): number {
  if (x >= 47) return 1;
  if (x >= 38) return 211;
  return z >= 32 ? 229 : 230;
}

/** Fake servers and clients for one test file; `cleanup` after each test. */
export function explorerHarness() {
  let dir = '';
  const servers: FakeGtnhServer[] = [];
  const clients: Gtnh1710Client[] = [];

  const setup = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'gtnh-explore-'));
  };
  const cleanup = async (): Promise<void> => {
    for (const c of clients.splice(0)) await c.disconnect();
    for (const s of servers.splice(0)) await s.close();
    rmSync(dir, { recursive: true, force: true });
  };

  /**
   * The explore world with chunks streamed and the movement mode 'follow' (a 16-block play
   * area), the clock at `dayTicks` (null: the server sends no time). Waits for the clock.
   */
  const start = async (
    opts: {
      server?: FakeServerOptions;
      movement?: Partial<MovementConfig>;
      dayTicks?: number | null;
      boundary?: boolean;
    } = {},
  ) => {
    const dayTicks = opts.dayTicks === undefined ? 6000 : opts.dayTicks;
    const server = new FakeGtnhServer({
      blocks: DIG_TEST_BLOCK_REGISTRY,
      world: exploreWorld,
      biomeAt: exploreBiome,
      streamChunks: true,
      spawn: { x: SPAWN.x, eyeY: FEET_Y + PLAYER_EYE_HEIGHT, z: SPAWN.z, yaw: 0, pitch: 0 },
      ...(dayTicks === null ? {} : { dayTicks }),
      ...opts.server,
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
          enabled: true,
          mode: 'follow',
          // A small play area, so a short walk already leaves the first one behind.
          area: { side: 16, height: 8 },
          maxPathLength: 12,
          stopFile: join(dir, 'STOP'),
          ...opts.movement,
        },
      },
      safety: { boundary: { ...BOUNDARY, allowedDimensions: ['overworld'] } },
    });
    const client = new Gtnh1710Client({
      config: config.minecraft,
      clock: systemClock,
      retryDelayMs: 50,
      ...(opts.boundary === false ? {} : { explorationBoundary: config.safety.boundary }),
    });
    clients.push(client);
    await client.connect();
    if (dayTicks !== null) {
      await vi.waitFor(async () => expect((await client.observe()).time.known).toBe(true));
    }
    return { server, client, config, stopFile: join(dir, 'STOP') };
  };

  return { setup, cleanup, start };
}

const ids = sequentialIds();
/** Performs one action as the executor would (a retreat needs its resolved target). */
export function perform(
  client: Gtnh1710Client,
  spec: ActionSpec,
  resolvedTarget: Position | null = null,
) {
  const action = createAction(
    { spec, reason: 'test', origin: 'test', taskId: null },
    { newId: ids, now: () => new Date() },
  );
  return client.perform(mintValidatedAction(action, resolvedTarget, new Date()));
}

export const moveTo = (x: number, z: number): ActionSpec => ({
  type: 'MOVE_TO',
  args: { target: { x, y: FEET_Y, z }, tolerance: 0.5 },
});

export const explore = (toward: ExploreToward, maxDistance: number): ActionSpec => ({
  type: 'EXPLORE',
  args: { toward, maxDistance },
});

export async function positionOf(client: Gtnh1710Client) {
  const p = (await client.observe()).player.position;
  if (!p.known) throw new Error('position unknown');
  return p.value;
}
