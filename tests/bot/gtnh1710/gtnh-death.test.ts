import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { FakeGtnhServer } from './fixtures/fake-server.ts';

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-death-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(health = 20) {
  const fake = new FakeGtnhServer({ health: { health, food: 0, saturation: 0 } });
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
    },
  });
  const logs: string[] = [];
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    log: (line) => logs.push(line),
  });
  clients.push(client);
  await client.connect();
  return { server: fake, client, logs };
}

describe('Gtnh1710Client death', () => {
  it('asks to respawn once when the player dies, as a player clicks Respawn, and says so', async () => {
    // A dead player stays dead until its client asks; whoever logs in next finds it dead.
    const { server, client, logs } = await start();
    await vi.waitFor(() => expect(client.world.health).toBe(20));
    server.combatSim.hurtPlayer(20);
    await vi.waitFor(() => expect(server.clientStatus).toEqual([0]), { timeout: 3_000 });
    await vi.waitFor(() => expect(client.world.health).toBe(20), { timeout: 3_000 });
    expect(logs.some((l) => /THE PLAYER DIED .*asking the server to respawn it/.test(l))).toBe(
      true,
    );
    // Once per death.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(server.clientStatus).toEqual([0]);
  });

  it('logging in dead, it is respawned before connect() returns (play never acts on a corpse)', async () => {
    // Seen live 2026-10-04: play acted on the dead player's last spot, took a Random Things
    // soul on its corpse for an unidentified mob and logged off before the respawn was asked,
    // login after login.
    const { server, client } = await start(0);
    expect(server.clientStatus).toEqual([0]);
    expect(client.world.health).toBe(20);
  });
});
