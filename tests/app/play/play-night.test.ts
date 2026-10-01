import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncConfigToDatabase, type AgentDeps } from '../../src/app/agent-loop.ts';
import { DEFAULT_SESSION_LIMITS, runSession } from '../../src/app/live-session.ts';
import { liveShelter } from '../../src/app/live-play.ts';
import {
  DEFAULT_PLAY_LIMITS,
  describePlayEvent,
  runPlay,
  type PlayEvent,
} from '../../src/app/play.ts';
import { Gtnh1710Client } from '../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { NIGHT_PIT_KEY } from '../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../src/system1/decision-provider.ts';
import { systemClock } from '../../src/util/clock.ts';
import { sequentialIds } from '../../src/util/ids.ts';
import { BLOCK, PLACE_TEST_BLOCK_REGISTRY, type BlockFn } from '../bot/gtnh1710/chunk-fixtures.ts';
import { FakeGtnhServer } from '../bot/gtnh1710/fake-server.ts';

/** Bedrock at 0, stone at 100, dirt at 101-104, grass at 105: the fake player stands at y=106. */
const solidGround: BlockFn = (_x, y) =>
  y === 0
    ? BLOCK.bedrock
    : y === 100
      ? BLOCK.stone
      : y > 100 && y < 105
        ? BLOCK.dirt
        : y === 105
          ? BLOCK.grass
          : BLOCK.air;

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-night-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake server at dusk (1.7 real minutes before night: shelter time) over solid ground, the
 * real client with digging, placing and walking in a terrain fence, and the agent loop with
 * the deterministic router and no planner (code's blueprints run as known steps).
 */
async function setup() {
  const fake = new FakeGtnhServer({
    blocks: PLACE_TEST_BLOCK_REGISTRY,
    world: solidGround,
    dayTicks: 11_000,
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
        fence: { min: { x: -14, y: 96, z: -18 }, max: { x: 4, y: 112, z: 2 } },
        stopFile: join(dir, 'STOP'),
      },
      digging: { enabled: true },
      placing: { enabled: true },
    },
  });
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    explorationBoundary: config.safety.boundary,
  });
  clients.push(client);
  await client.connect();
  const repos = createRepositories(openDatabase(IN_MEMORY), systemClock);
  syncConfigToDatabase(config, repos);
  const agent: AgentDeps = {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner: null,
    clock: systemClock,
    newId: sequentialIds(),
  };
  return { fake, config, client, repos, agent };
}

describe('play through a night in the pit (fake server, real agent loop and client)', () => {
  it('at dusk digs the pit and roofs it as known steps, waits for the morning, digs a staircase out, then plays on', async () => {
    const { fake, config, client, repos, agent } = await setup();
    const timeNow = async () => {
      const s = await client.observe();
      return s.time.known ? s.time.value : null;
    };

    const shelter = liveShelter(client, config, repos);
    /** The pit's sites kept in agent memory at night (each different one once). */
    const sites = new Set<string>();
    const events: PlayEvent[] = [];
    const result = await runPlay(
      {
        repos,
        goal: {
          taskId: 'goal-dirt',
          name: 'get 6 minecraft:dirt',
          requirements: { 'minecraft:dirt': 6 },
        },
        inventory: async () => {
          const s = await client.observe();
          return s.inventory.known ? s.inventory.value.items : null;
        },
        time: timeNow,
        shelter: async (purpose) => {
          const status = await shelter(purpose);
          const site = repos.memory.getValue(NIGHT_PIT_KEY);
          if (purpose === 'night' && site !== null) sites.add(site);
          return status;
        },
        session: (limits, hooks) => runSession(agent, limits, hooks),
        // The night passes while the agent waits in the pit: the server says it is morning.
        sleep: async () => {
          fake.setTime(1_000);
          await vi.waitFor(async () => expect((await timeNow())?.timeOfDay).toBeLessThan(2_000));
        },
      },
      { ...DEFAULT_PLAY_LIMITS, session: { ...DEFAULT_SESSION_LIMITS, pauseMs: 0 } },
      { stopRequested: () => null, onEvent: (e) => events.push(e) },
    );

    // Every dig drop was collected: 3 from the pit, 1 roof used, 4 back on the way out.
    expect(result.stopReason).toBe('the goal "get 6 minecraft:dirt" is reached');
    const lines = events.map((e) => describePlayEvent(e));
    expect(lines.filter((l) => l.startsWith('goal:') || l.startsWith('night:'))).toEqual([
      'goal: "shelter for the night" - missing 1 minecraft:dirt',
      'night: sheltered: waiting for the morning (10.8 min)',
      'night: morning: leaving the shelter',
      'goal: "leave the shelter"',
    ]);
    // The night: three digs down and the roof, each code's known step, validated and verified.
    const cycles = events.flatMap((e) => (e.kind === 'cycle' ? [e.summary] : []));
    expect(cycles).toEqual([
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> PLACE_BLOCK -> succeeded',
      // The morning: the roof, a staircase east (upper block first), the walk out.
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> succeeded',
    ]);
    // What the server saw: the pit straight down in the player's column, the roof in the
    // ground layer, then the roof and the staircase dug.
    const at = (b: { x: number; y: number; z: number }) => `${b.x},${b.y},${b.z}`;
    expect(fake.digSim.broken.map(at)).toEqual([
      '-5,105,-8',
      '-5,104,-8',
      '-5,103,-8',
      '-5,105,-8',
      '-4,105,-8',
      '-4,104,-8',
      '-3,105,-8',
    ]);
    expect(fake.placeSim.placed).toEqual([{ x: -5, y: 105, z: -8, name: 'minecraft:dirt' }]);
    expect(fake.digSim.broken[3]?.name).toBe('minecraft:dirt'); // the roof, dug again
    // Out on the ground east of the pit, and play went on to the goal. Out of the pit, its
    // site is forgotten (it was kept for the night, to finish a pit started).
    expect(client.world.ownPosition).toEqual({ x: -1.5, y: 106, z: -7.5 });
    expect([...sites].map((s) => JSON.parse(s) as unknown)).toEqual([
      { x: -5, z: -8, groundY: 105 },
    ]);
    expect(repos.memory.getValue(NIGHT_PIT_KEY)).toBeNull();
    expect(repos.tasks.get('night-shelter')?.status).toBe('completed');
    expect(repos.tasks.get('leave-shelter')?.status).toBe('completed');
    expect(repos.memory.journal('leave-shelter').map((e) => e.text)).toEqual([
      "code's 5 step(s) done",
    ]);
    expect(repos.memory.journal('goal-dirt').at(-1)?.text).toBe(
      'GOAL "get 6 minecraft:dirt" reached',
    );
  }, 90_000);

  it('finishes a pit interrupted half-way from where it is, instead of starting another', async () => {
    const { fake, client, config, repos, agent } = await setup();
    const blueprints: string[][] = [];
    let done = false;
    const result = await runPlay(
      {
        repos,
        inventory: () => Promise.resolve({}),
        time: async () => {
          const s = await client.observe();
          return s.time.known ? s.time.value : null;
        },
        shelter: liveShelter(client, config, repos),
        session: (limits, hooks) => {
          blueprints.push(repos.memory.taskBlueprint('night-shelter') ?? []);
          return runSession(agent, limits, hooks);
        },
        sleep: () => {
          done = true; // sheltered: the test ends here
          return Promise.resolve();
        },
      },
      // Two cycles per session: the first session stops after two of the four steps.
      { ...DEFAULT_PLAY_LIMITS, session: { maxCycles: 2, maxMinutes: 5, pauseMs: 0 } },
      { stopRequested: () => (done ? 'sheltered' : null) },
    );
    expect(result.stopReason).toBe('sheltered');
    expect(blueprints).toEqual([
      [
        '1. dig down: the minecraft:grass under the feet at (-5, 105, -8)',
        '2. dig down: the minecraft:dirt under the feet at (-5, 104, -8)',
        '3. dig down: the minecraft:dirt under the feet at (-5, 103, -8)',
        '4. place minecraft:dirt at (-5, 105, -8): the roof, against the ground beside it',
      ],
      // The same pit (its site in agent memory), from two blocks down: no new pit below.
      [
        '1. dig down: the minecraft:dirt under the feet at (-5, 103, -8)',
        '2. place minecraft:dirt at (-5, 105, -8): the roof, against the ground beside it',
      ],
    ]);
    expect(fake.digSim.broken.map((b) => b.y)).toEqual([105, 104, 103]);
    expect(client.world.ownPosition).toEqual({ x: -4.5, y: 103, z: -7.5 });
  }, 60_000);
});
