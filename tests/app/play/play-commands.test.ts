import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { DEFAULT_SESSION_LIMITS, runSession } from '../../../src/app/loop/live-session.ts';
import { liveCommands, standbyReason } from '../../../src/app/play/live-play.ts';
import { describePlayEvent } from '../../../src/app/play/narration.ts';
import { DEFAULT_PLAY_LIMITS, runPlay, type PlayEvent } from '../../../src/app/play/play.ts';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { IN_MEMORY, openDatabase } from '../../../src/persistence/database.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { BLOCK, type BlockFn } from '../../bot/gtnh1710/fixtures/chunk-fixtures.ts';
import { FakeGtnhServer } from '../../bot/gtnh1710/fixtures/fake-server.ts';

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
  dir = mkdtempSync(join(tmpdir(), 'gtnh-commands-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The fake server by day with the owner (DankAxon) standing 7 blocks east of the bot, the real
 * client walking a terrain fence, and the real agent loop with the deterministic router and no
 * planner: an owner's travel steps are code's known steps, validated, walked and verified.
 */
async function setup() {
  const fake = new FakeGtnhServer({
    world: solidGround,
    entities: [{ kind: 'player', entityId: 900, name: 'DankAxon', x: 2.5, y: 106, z: -7.5 }],
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
  const play = (events: PlayEvent[]) =>
    runPlay(
      {
        repos,
        inventory: async () => {
          const s = await client.observe();
          return s.inventory.known ? s.inventory.value.items : null;
        },
        session: (limits, hooks) => runSession(agent, limits, hooks),
        commands: liveCommands(client, config, repos, null),
        sleep: () => new Promise((r) => setTimeout(r, 20)),
      },
      { ...DEFAULT_PLAY_LIMITS, session: { ...DEFAULT_SESSION_LIMITS, pauseMs: 0 } },
      { stopRequested: () => null, onEvent: (e) => events.push(e) },
    );
  return { fake, config, client, repos, play };
}

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

describe('an owner commands the bot in chat (fake server, real client and agent loop)', () => {
  it('!come: walks to the owner as a checked known step, and whispers OK and Done', async () => {
    const { fake, client, repos, play } = await setup();
    fake.sendChat(whisper('!come'));
    await vi.waitFor(() => expect(client.ownerMessagesWaiting()).toBe(true));
    const events: PlayEvent[] = [];
    const result = await play(events);
    // Nothing else to do afterwards: no quest book on this server.
    expect(result.stopReason).toMatch(/quest goals need the server's quest book/);
    const cycles = events.flatMap((e) => (e.kind === 'cycle' ? [e.summary] : []));
    expect(cycles).toEqual(['EXECUTE_KNOWN_SAFE_STEP -> MOVE_TO -> succeeded']);
    const at = client.world.ownPosition;
    expect(at).not.toBeNull();
    const fromOwner = Math.hypot((at?.x ?? 0) - 2.5, (at?.z ?? 0) + 7.5);
    expect(fromOwner).toBeLessThanOrEqual(2.5);
    expect(fromOwner).toBeGreaterThanOrEqual(1);
    expect(repos.commands.get(1)).toMatchObject({ status: 'done', command: { verb: 'come' } });
    // The replies went out as whispers to the owner, a second apart; the server's echo of
    // them was never taken for a command.
    await vi.waitFor(() => expect(fake.chat).toHaveLength(2), { timeout: 4_000 });
    expect(fake.chat[0]).toBe('/tell DankAxon OK: coming to you');
    expect(fake.chat[1]).toMatch(/^\/tell DankAxon Done: here, [\d.]+ blocks? from you$/);
    expect(client.takeOwnerMessages()).toEqual([]);
    expect(events.map((e) => describePlayEvent(e))).toContain(
      'COMMAND #1 (DankAxon): OK: coming to you',
    );
  }, 30_000);

  it('!stop stops the walk in progress at once, cancels the command and pauses play', async () => {
    const { fake, client, repos, play } = await setup();
    fake.sendChat(whisper('!goto 3 106 -16'));
    await vi.waitFor(() => expect(client.ownerMessagesWaiting()).toBe(true));
    const events: PlayEvent[] = [];
    const playing = play(events);
    // Mid-walk, the owner says stop: the client stops the walk at its next step.
    await vi.waitFor(() => expect(fake.walkSteps().length).toBeGreaterThanOrEqual(5), {
      timeout: 10_000,
    });
    fake.sendChat(whisper('stop'));
    const result = await playing;
    expect(result.stopReason).toBe(
      'paused: DankAxon said stop: nothing else to do (cli play --listen stays online for commands)',
    );
    const walk = events.find((e) => e.kind === 'cycle');
    expect(walk?.kind === 'cycle' && walk.detail).toMatch(/stopped by DankAxon/);
    const at = client.world.ownPosition;
    expect(Math.hypot((at?.x ?? 0) - 3.5, (at?.z ?? 0) + 15.5)).toBeGreaterThan(2);
    expect(repos.commands.get(1)).toMatchObject({ status: 'cancelled' });
    expect(repos.commands.get(2)).toMatchObject({ status: 'done', command: { verb: 'stop' } });
    await vi.waitFor(() => expect(fake.chat).toHaveLength(2), { timeout: 4_000 });
    expect(fake.chat).toEqual([
      '/tell DankAxon OK: going to 3 106 -16',
      '/tell DankAxon OK: stopped (go to 3 106 -16). I wait for !resume or a new command',
    ]);
    // The interrupt did not last: the bot may walk again (a later play, a new command).
    client.clearInterrupt();
    expect(standbyReason(await client.observe(), defaultConfig(), repos)).toBeNull();
  }, 30_000);
});
