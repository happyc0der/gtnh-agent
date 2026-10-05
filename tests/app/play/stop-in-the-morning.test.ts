import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { DEFAULT_SESSION_LIMITS, runSession } from '../../../src/app/loop/live-session.ts';
import { liveCommands, liveShelter } from '../../../src/app/play/live-play.ts';
import {
  DEFAULT_PLAY_LIMITS,
  runPlay,
  type PlayDeps,
  type PlayEvent,
} from '../../../src/app/play/play.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import {
  BLOCK,
  PLACE_TEST_BLOCK_REGISTRY,
  type BlockFn,
} from '../../bot/gtnh1710/fixtures/chunk-fixtures.ts';
import { FakeGtnhServer } from '../../bot/gtnh1710/fixtures/fake-server.ts';

// An independent review, 2026-10-05: the bot digs out of its night pit in the morning; its owner
// whispers "stop", sees it dig on (unanswered: the morning round runs before the command round),
// and says it again. The roof's dig, halted twice, was refused as a repeated failure of the
// leave-shelter task from then on, every session, every play: the bot could not dig out at all.
// Now a stopped step is no failure and spends no try, and the stop is answered between sessions.
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
  dir = mkdtempSync(join(tmpdir(), 'gtnh-r22-morning-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const whisper = (text: string): string =>
  JSON.stringify({
    italic: true,
    color: 'gray',
    translate: 'commands.message.display.incoming',
    with: [
      { clickEvent: { action: 'suggest_command', value: '/msg DankAxon ' }, text: 'DankAxon' },
      { extra: text.split(' ').flatMap((w, i) => (i === 0 ? [w] : [' ', w])), text: '' },
    ],
  });

describe('"stop" twice while it digs out of its pit in the morning', () => {
  it('is answered, and the way out goes on: the bot is out', async () => {
    const fake = new FakeGtnhServer({
      blocks: PLACE_TEST_BLOCK_REGISTRY,
      world: solidGround,
      dayTicks: 11_000,
      entities: [{ kind: 'player', entityId: 900, name: 'DankAxon', x: -1.5, y: 106, z: -11.5 }],
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
        owners: ['DankAxon'],
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
    const timeNow = async () => {
      const s = await client.observe();
      return s.time.known ? s.time.value : null;
    };
    let exitSessions = 0;
    const deps = (): PlayDeps => ({
      repos,
      inventory: async () => {
        const s = await client.observe();
        return s.inventory.known ? s.inventory.value.items : null;
      },
      time: timeNow,
      shelter: liveShelter(client, config, repos),
      session: async (limits, hooks) => {
        if (repos.memory.getValue(CURRENT_TASK_KEY) === 'leave-shelter') {
          exitSessions += 1;
          if (exitSessions <= 2) {
            fake.sendChat(whisper(exitSessions === 1 ? 'stop' : 'stop!'));
            await vi.waitFor(() => expect(client.ownerMessagesWaiting()).toBe(true));
          }
        }
        return runSession(agent, limits, hooks);
      },
      commands: liveCommands(client, config, repos, null),
      // The night passes while the agent waits in the pit: the server says it is morning.
      sleep: async () => {
        fake.setTime(1_000);
        await vi.waitFor(async () => expect((await timeNow())?.timeOfDay).toBeLessThan(2_000));
      },
    });
    const events: PlayEvent[] = [];
    const limits = { ...DEFAULT_PLAY_LIMITS, session: { ...DEFAULT_SESSION_LIMITS, pauseMs: 0 } };
    const first = await runPlay(deps(), limits, {
      stopRequested: () => null,
      onEvent: (e) => events.push(e),
    });
    const cycles = (es: PlayEvent[]) => es.flatMap((e) => (e.kind === 'cycle' ? [e.summary] : []));
    // The pit and its roof at dusk, then the morning: the roof's dig halted twice, then dug.
    expect(cycles(events).slice(0, 7)).toEqual([
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_DOWN -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> PLACE_BLOCK -> succeeded',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> failed',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> failed',
      'EXECUTE_KNOWN_SAFE_STEP -> DIG_BLOCK -> succeeded',
    ]);
    expect(cycles(events).join('\n')).not.toContain('REPEATED_FAILURE');
    expect(first.stopReason).not.toContain('REPEATED_FAILURE');
    // Out of the pit, on the ground.
    expect(client.world.ownPosition?.y ?? 0).toBeGreaterThanOrEqual(106);
    // Both stops answered.
    expect(repos.commands.recent(5).map((c) => [c.rawText, c.status])).toEqual([
      ['stop!', 'done'],
      ['stop', 'done'],
    ]);
  }, 120_000);
});
