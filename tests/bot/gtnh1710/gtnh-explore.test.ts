import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runUserAction } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK } from './chunk-fixtures.ts';
import {
  BOUNDARY,
  explore,
  explorerHarness,
  exploreWorld,
  FEET_Y,
  perform,
  positionOf,
  SPAWN,
} from './explore-world.ts';
import { spawnFrame } from './fake-server.ts';

const harness = explorerHarness();
beforeEach(harness.setup);
afterEach(harness.cleanup);

// Walks take real time (4 blocks a second), and the test files run side by side.
describe('EXPLORE', { timeout: 30_000 }, () => {
  it('walks in hops into the next biome, with chunks arriving on the way, and remembers what it saw', async () => {
    const { server, client } = await harness.start();
    client.takeSeenChunks(); // what was seen at the spawn
    const r = await perform(client, explore('south', 24));
    expect(r, r.message).toMatchObject({ ok: true, code: 'OK' });
    expect(r.data['hops']).toBeGreaterThanOrEqual(2);
    expect(r.data['walked']).toBeLessThanOrEqual(24);
    expect(r.data['progress']).toBeGreaterThan(16);
    expect((await positionOf(client)).z).toBeGreaterThan(SPAWN.z + 16);
    expect(r.message).toMatch(/Hot Forest/);
    // Open ground ahead: it stopped because maxDistance was spent, not for want of a way (seen
    // live: "no way further" a few blocks short, remembered as a dead end each time).
    expect(String(r.data['stoppedBecause'])).toMatch(/^walked (nearly )?the whole maxDistance/);
    // Every step was an ordinary walking step, at most 0.2 blocks from the one before.
    let prev = { x: SPAWN.x, z: SPAWN.z };
    for (const s of server.walkSteps()) {
      expect(Math.hypot(s.x - prev.x, s.z - prev.z)).toBeLessThanOrEqual(0.2 + 1e-9);
      prev = s;
    }
    // World memory: the forest's chunks, with their biome and the trees seen (the examples
    // are real log positions).
    const seen = client.takeSeenChunks();
    const forest = seen.filter((c) => c.biome?.name === 'Hot Forest');
    expect(forest.length).toBeGreaterThan(0);
    const logs = forest.flatMap((c) => c.examples.log ?? []);
    expect(logs.length).toBeGreaterThan(0);
    for (const p of logs) expect(exploreWorld(p.x, p.y, p.z)).toBe(BLOCK.log);
    expect(seen.every((c) => c.dimension === 'overworld')).toBe(true);
  });

  it('stops at the edge of the exploration boundary', async () => {
    const { client } = await harness.start();
    const r = await perform(client, explore('west', 32));
    expect(r, r.message).toMatchObject({ ok: true });
    expect(r.data['stoppedBecause']).toBe('reached the edge of the exploration boundary');
    const at = await positionOf(client);
    expect(at.x).toBeGreaterThanOrEqual(BOUNDARY.min.x + 0.3);
    expect(at.x).toBeLessThan(SPAWN.x - 6);
  });

  it('stops at a river it cannot cross, and sees the riverbank on the way', async () => {
    const { client } = await harness.start();
    const r = await perform(client, explore({ x: 60, z: 20 }, 48));
    expect(r, r.message).toMatchObject({ ok: true });
    expect(String(r.data['stoppedBecause'])).toMatch(/^no way further/);
    const at = await positionOf(client);
    expect(at.x).toBeGreaterThan(36);
    expect(at.x).toBeLessThan(40); // never into the water at x 40..44
    const river = client.takeSeenChunks().filter((c) => c.biome?.name === 'River Oasis');
    expect(river.some((c) => (c.counts.water ?? 0) > 0)).toBe(true);
    expect(river.some((c) => (c.counts.gravel ?? 0) > 0)).toBe(true);
  });

  it('a hostile mob coming near stops it (FAILED, with how far it got)', async () => {
    const { server, client } = await harness.start();
    const going = perform(client, explore('north', 32));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(10));
    server.broadcast(
      spawnFrame({ kind: 'mob', entityId: 900, mobType: 54, x: 30.5, y: FEET_Y, z: 12 }),
    );
    const r = await going;
    expect(r).toMatchObject({ ok: false, code: 'FAILED' });
    expect(r.message).toMatch(/hostile entity minecraft:Zombie/);
    expect(r.data['walked']).toBeGreaterThan(0);
  });

  it('is refused at night, when the time of day is unknown, and while the stop file exists', async () => {
    const night = await harness.start({ dayTicks: 18_000 });
    expect(await perform(night.client, explore('south', 16))).toMatchObject({
      ok: false,
      code: 'REFUSED',
      message: expect.stringMatching(/it is night: the agent explores only in daylight/) as string,
    });
    const unknown = await harness.start({ dayTicks: null });
    expect((await perform(unknown.client, explore('south', 16))).message).toMatch(
      /the time of day is unknown/,
    );
    const halted = await harness.start();
    writeFileSync(halted.stopFile, 'stop');
    expect((await perform(halted.client, explore('south', 16))).message).toMatch(
      /stop file .* exists/,
    );
    for (const s of [night.server, unknown.server, halted.server]) {
      expect(s.walkSteps()).toHaveLength(0);
    }
  });

  it('goes through the executor: validated, explored, verified, and stored in world memory', async () => {
    const { client, config } = await harness.start();
    const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
    syncConfigToDatabase(config, repos);
    const result = await runUserAction(
      {
        config,
        client,
        repos,
        decisionProvider: new DeterministicDecisionProvider(),
        planner: null,
        clock: systemClock,
        newId: sequentialIds(),
      },
      explore('south', 16),
      'test: explore south',
    );
    expect(result.status, result.summary).toBe('succeeded');
    expect(result.outcome?.verification?.checks.map((c) => c.name)).toEqual([
      'execution-ok',
      'observation-fresh',
      'explored-progress',
      'explored-bounded',
    ]);
    expect(repos.worldMemory.count('overworld')).toBeGreaterThan(20);
    const spawnChunk = repos.worldMemory.get('overworld', 1, 1);
    expect(spawnChunk?.biome?.name).toBe('Hot Desert');
    expect(spawnChunk?.counts.sand).toBeGreaterThan(50);
  });
});
