import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gtnh1710Client } from '../../../src/bot/gtnh1710/gtnh-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { createAction, type ActionSpec } from '../../../src/domain/actions.ts';
import { mintValidatedAction } from '../../../src/domain/validated-action.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { FakeGtnhServer, type FakeServerOptions } from './fixtures/fake-server.ts';

// The flat fake world of the walking tests: grass at y=105, the player at (-4.5, 106, -7.5).
const FEET_Y = 106;
const FENCE = { min: { x: -9, y: FEET_Y, z: -12 }, max: { x: -1, y: FEET_Y, z: -4 } };
const OWNER = {
  kind: 'player' as const,
  entityId: 900,
  name: 'DankAxon',
  x: -2.5,
  y: FEET_Y,
  z: -5.5,
};

let dir = '';
const servers: FakeGtnhServer[] = [];
const clients: Gtnh1710Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-chat-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(owners: string[] = ['DankAxon'], options: FakeServerOptions = {}) {
  const server = new FakeGtnhServer({ entities: [OWNER], ...options });
  servers.push(server);
  const config = defaultConfig({
    minecraft: {
      host: '127.0.0.1',
      port: await server.listen(),
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 5_000,
      initialStateGraceMs: 2_000,
      owners,
      movement: { enabled: true, fence: FENCE, stopFile: join(dir, 'STOP') },
    },
  });
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    retryDelayMs: 50,
  });
  clients.push(client);
  await client.connect();
  return { server, client };
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
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Chat lines as a 1.7.10 server builds them (see chat.test.ts for the live captures). */
const name = (n: string) => ({
  clickEvent: { action: 'suggest_command', value: `/msg ${n} ` },
  text: n,
});
const whisperFrom = (from: string, text: string): string =>
  JSON.stringify({
    italic: true,
    color: 'gray',
    translate: 'commands.message.display.incoming',
    with: [name(from), { extra: [text], text: '' }],
  });
const chatFrom = (from: string, text: string): string =>
  JSON.stringify({ translate: 'chat.type.text', with: [name(from), { extra: [text], text: '' }] });

describe('owners command the client in chat (fake server)', () => {
  it("keeps an owner's whisper and prefixed public chat; ignores everything else", async () => {
    const { server, client } = await start();
    server.sendChat(
      '{"translate":"chat.type.announcement","with":["Rcon",{"extra":["!stop"],"text":""}]}',
    );
    server.sendChat('"§lWelcome to GregTech: New Horizons §a2.8.4"');
    server.sendChat(whisperFrom('DankAxon', 'come here'));
    server.sendChat(chatFrom('DankAxon', 'hello everyone'));
    server.sendChat(chatFrom('Mallory', '!follow'));
    server.sendChat(whisperFrom('dankaxon', '!stop'));
    server.sendChat(chatFrom('DankAxon', '!follow'));
    await vi.waitFor(() => expect(client.ownerMessagesWaiting()).toBe(true));
    await delay(200);
    expect(client.takeOwnerMessages().map((m) => [m.sender, m.text, m.via])).toEqual([
      ['DankAxon', 'come here', 'whisper'],
      ['DankAxon', '!follow', 'public'],
    ]);
    expect(client.ownerMessagesWaiting()).toBe(false);
    expect(client.takeOwnerMessages()).toEqual([]);
    // Reading chat sent nothing.
    expect(server.chat).toEqual([]);
  });

  it('with no owners configured, no chat is ever a command', async () => {
    const { server, client } = await start([]);
    server.sendChat(whisperFrom('DankAxon', '!come'));
    await delay(300);
    expect(client.takeOwnerMessages()).toEqual([]);
    expect(client.whisper('DankAxon', 'hi')).toMatch(/not one of the bot's owners/);
  });

  it('whispers only to owners: plain lines, at most three, one a second', async () => {
    const { server, client } = await start();
    expect(client.whisper('Mallory', 'hi')).toMatch(/not one of the bot's owners/);
    expect(client.whisper('DankAxon', `§cDone:\n${'word '.repeat(80)}`)).toBeNull();
    const times: number[] = [];
    for (let n = 1; n <= 3; n++) {
      await vi.waitFor(() => expect(server.chat.length).toBe(n), { timeout: 3_000 });
      times.push(Date.now());
    }
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(900);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBeGreaterThanOrEqual(900);
    for (const l of server.chat) {
      expect(l).toMatch(/^\/tell DankAxon [^/§]/);
      expect(l.length).toBeLessThanOrEqual(100);
    }
    expect(server.chat[0]).toMatch(/^\/tell DankAxon Done: word word/);
    expect(server.chat[2]).toMatch(/\.\.\.$/);
    // The server's echo of the bot's own whispers (it names DankAxon) is never a command.
    await delay(200);
    expect(client.takeOwnerMessages()).toEqual([]);
    // Only whispers were ever sent on C01.
    expect(server.playPacketIds().filter((id) => id === 0x01)).toHaveLength(3);
  }, 15_000);

  it('a stop in chat stops a walk at its next step, and does not latch like halt()', async () => {
    const { server, client } = await start();
    const walk = perform(client, moveTo(-8.5, -11.5));
    await vi.waitFor(() => expect(server.walkSteps().length).toBeGreaterThanOrEqual(3));
    server.sendChat(whisperFrom('DankAxon', '!stop'));
    const result = await walk;
    expect(result).toMatchObject({ ok: false, code: 'FAILED' });
    expect(result.message).toMatch(/stopped by DankAxon/);
    const sent = server.walkSteps().length;
    // Until the play loop has taken the stop, nothing new starts...
    expect((await perform(client, moveTo(-2.5, -5.5))).message).toMatch(/stopped by DankAxon/);
    expect(server.walkSteps()).toHaveLength(sent);
    expect(client.takeOwnerMessages().map((m) => m.text)).toEqual(['!stop']);
    // ...and then walking works again: an interrupt is not halt()'s lasting latch.
    client.clearInterrupt();
    expect(await perform(client, moveTo(-2.5, -5.5))).toMatchObject({ ok: true, code: 'OK' });
    // halt() still lasts.
    client.halt('operator said stop');
    client.clearInterrupt();
    expect((await perform(client, moveTo(-4.5, -7.5))).message).toMatch(/operator said stop/);
  });

  it('knows where a player it sees is, by exact name', async () => {
    const { server, client } = await start();
    expect(client.playerPosition('DankAxon')).toEqual({ x: -2.5, y: FEET_Y, z: -5.5 });
    expect(client.playerPosition('dankaxon')).toBeNull();
    expect(client.playerPosition('Mallory')).toBeNull();
    server.moveEntity(900, 1, 0, 0);
    await vi.waitFor(() => expect(client.playerPosition('DankAxon')?.x).toBe(-1.5));
    server.destroyEntities([900]);
    await vi.waitFor(() => expect(client.playerPosition('DankAxon')).toBeNull());
  });
});
