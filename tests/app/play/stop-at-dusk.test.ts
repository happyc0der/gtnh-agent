import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { DEFAULT_SESSION_LIMITS, runSession } from '../../../src/app/loop/live-session.ts';
import { liveCommands, liveShelter } from '../../../src/app/play/live-play.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayEvent } from '../../../src/app/play/play.ts';
import { describePlayEvent } from '../../../src/app/play/narration.ts';
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

// An independent review, 2026-10-05: at dusk the bot digs its night pit, and its owner whispers
// "stop" (to end a follow, say), then, seeing it dig on, "stop!" again. Each stop halted the
// dig, unanswered (the night round runs before the command round); the halted digs counted as
// failures, the third try was refused as a repeated failure, and the bot spent the night
// offline with no shelter. Now a stopped step is no failure and spends no try, and the stop is
// answered at once: the pit is dug, and the bot shelters.
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
  dir = mkdtempSync(join(tmpdir(), 'gtnh-stop-dusk-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A whisper from DankAxon, as vanilla builds it. */
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

describe('"stop" while it digs its night pit', () => {
  it('is answered at once, and the pit is dug all the same: no night offline', async () => {
    const fake = new FakeGtnhServer({
      blocks: PLACE_TEST_BLOCK_REGISTRY,
      world: solidGround,
      dayTicks: 11_000,
      entities: [{ kind: 'player', entityId: 900, name: 'DankAxon', x: -2.5, y: 106, z: -7.5 }],
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
    let pitSessions = 0;
    const events: PlayEvent[] = [];
    const sheltered = (): boolean =>
      events.some((e) => e.kind === 'night' && e.message.startsWith('sheltered:'));
    const result = await runPlay(
      {
        repos,
        inventory: async () => {
          const s = await client.observe();
          return s.inventory.known ? s.inventory.value.items : null;
        },
        time: async () => {
          const s = await client.observe();
          return s.time.known ? s.time.value : null;
        },
        shelter: liveShelter(client, config, repos),
        session: async (limits, hooks) => {
          if (repos.memory.getValue(CURRENT_TASK_KEY) === 'night-shelter') {
            pitSessions += 1;
            // As each of the first two pit sessions starts, the owner whispers a stop.
            if (pitSessions <= 2) {
              fake.sendChat(whisper(pitSessions === 1 ? 'stop' : 'stop!'));
              await vi.waitFor(() => expect(client.ownerMessagesWaiting()).toBe(true));
            }
          }
          return runSession(agent, limits, hooks);
        },
        commands: liveCommands(client, config, repos, null),
        sleep: () => new Promise((r) => setTimeout(r, 20)),
      },
      { ...DEFAULT_PLAY_LIMITS, session: { ...DEFAULT_SESSION_LIMITS, pauseMs: 0 } },
      {
        stopRequested: () => (sheltered() ? 'test over: sheltered' : null),
        onEvent: (e) => events.push(e),
      },
    );
    const told = events.map((e) => describePlayEvent(e)).join('\n');
    expect(told).toContain('halted: stopped by DankAxon');
    // The night in the pit, not offline.
    expect(result.night).toBeNull();
    expect(sheltered()).toBe(true);
    expect(pitSessions).toBeGreaterThanOrEqual(3);
    expect(told).not.toContain('REPEATED_FAILURE');
    // Both stops answered, before the pit was done.
    expect(repos.commands.recent(5).map((c) => [c.rawText, c.status])).toEqual([
      ['stop!', 'done'],
      ['stop', 'done'],
    ]);
    await vi.waitFor(() => expect(fake.chat.length).toBeGreaterThanOrEqual(2), {
      timeout: 6_000,
    });
    expect(fake.chat.every((line) => line.startsWith('/tell DankAxon OK: stopped'))).toBe(true);
  }, 90_000);
});
