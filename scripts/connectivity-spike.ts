/**
 * Read-only connectivity spike against a PRIVATE GTNH test server
 * (docs/gtnh-compatibility.md, testing protocol step 1).
 *
 * It answers one question: can a Node client join a Forge 1.7.10 GTNH server?
 *
 *   1. Refuses non-private hosts (same guard as the agent config).
 *   2. Server-list ping; refuses to log in unless the server identifies itself as the
 *      test server (MOTD marker) AND is an FML server running GregTech.
 *   3. Login attempt with raw minecraft-protocol (records every packet name, kicks, errors).
 *   4. Login attempt through the agent's own MineflayerClient adapter.
 *
 * It never sends chat, commands or movement, and disconnects on its own.
 * Results are printed and saved under data/spike/ (gitignored).
 *
 * Usage: node scripts/connectivity-spike.ts [--host 127.0.0.1] [--port 25570]
 *        [--marker gtnh-agent-test] [--timeout 45000] [--ping-only]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import mc from 'minecraft-protocol';
import { z } from 'zod';
import { MineflayerClient } from '../src/bot/mineflayer-client.ts';
import { defaultConfig } from '../src/config/env.ts';
import { checkPrivateHost } from '../src/config/network.ts';
import { systemClock } from '../src/util/clock.ts';
import { errorMessage } from '../src/util/json.ts';
import { statusPing } from '../src/bot/gtnh1710/status-ping.ts';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '25570' },
    marker: { type: 'string', default: 'gtnh-agent-test' },
    timeout: { type: 'string', default: '45000' },
    username: { type: 'string', default: 'gtnh_agent' },
    'ping-only': { type: 'boolean', default: false },
  },
});
const host = values.host;
const port = Number(values.port);
const timeoutMs = Number(values.timeout);
const VERSION = '1.7.10';

const ModInfoSchema = z.object({
  type: z.string(),
  modList: z.array(z.object({ modid: z.string(), version: z.string() })),
});

type Json = Record<string, unknown>;
const report: Json = { startedAt: new Date().toISOString(), host, port, version: VERSION };

function describe(description: unknown): string {
  if (typeof description === 'string') return description;
  if (description !== null && typeof description === 'object') {
    const d = description as { text?: unknown; extra?: unknown[] };
    const extra = Array.isArray(d.extra) ? d.extra.map(describe).join('') : '';
    return `${typeof d.text === 'string' ? d.text : ''}${extra}`;
  }
  return '';
}

async function pingServer(): Promise<{ ok: boolean; summary: Json }> {
  // minecraft-protocol's ping() uses the legacy format for 1.7.10 (no Forge mod list),
  // so use a minimal 1.7 status request instead.
  const result = await statusPing(host, port, timeoutMs);
  if (result.kind === 'disconnect') {
    return { ok: false, summary: { refusedWith: result.text } };
  }
  if (result.kind === 'error') throw new Error(result.error);
  const raw = result.json;
  const motd = describe(raw['description']);
  const modinfo = ModInfoSchema.safeParse(raw['modinfo']);
  const mods = modinfo.success ? modinfo.data.modList : [];
  const find = (id: string) => mods.find((m) => m.modid.toLowerCase() === id)?.version ?? null;
  const summary: Json = {
    motd,
    version: raw['version'],
    players: raw['players'],
    modinfoType: modinfo.success ? modinfo.data.type : null,
    modCount: mods.length,
    forge: find('forge'),
    gregtech: find('gregtech'),
    dreamcraft: find('dreamcraft'),
    lwjgl3ify: find('lwjgl3ify'),
    modList: mods,
  };
  const identityOk =
    motd.includes(values.marker) &&
    modinfo.success &&
    modinfo.data.type === 'FML' &&
    find('gregtech') !== null;
  return { ok: identityOk, summary };
}

function rawLoginAttempt(): Promise<Json> {
  return new Promise((resolve) => {
    const packets: string[] = [];
    const channels = new Set<string>();
    const result: Json = { packets, channels: [] };
    let settled = false;
    const client = mc.createClient({
      host,
      port,
      username: values.username,
      auth: 'offline',
      version: VERSION,
      hideErrors: true,
    });
    const finish = (outcome: string, extra: Json = {}): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Object.assign(result, { outcome, ...extra, channels: [...channels] });
      try {
        client.end('connectivity spike finished');
      } catch {
        /* already closed */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout', { afterMs: timeoutMs }), timeoutMs);

    client.on('packet', (data: Json, meta: { name: string; state: string }) => {
      if (packets.length < 200) packets.push(`${meta.state}:${meta.name}`);
      if (meta.name === 'custom_payload' && typeof data['channel'] === 'string')
        channels.add(data['channel']);
      if (meta.name === 'disconnect' || meta.name === 'kick_disconnect') {
        finish('kicked', { state: meta.state, reason: data['reason'] });
      }
      if (meta.state === 'play' && meta.name === 'login') {
        // Joined. Stay just long enough to see the first position packet, then leave.
        setTimeout(() => finish('joined'), 3000);
      }
    });
    client.on('error', (error: Error) => finish('error', { error: error.message }));
    client.on('end', (reason: string) => finish('connection-ended', { reason }));
  });
}

async function mineflayerAttempt(): Promise<Json> {
  const base = defaultConfig().minecraft;
  const client = new MineflayerClient(
    {
      ...base,
      host,
      port,
      username: values.username,
      version: VERSION,
      enableLiveConnection: true, // in-memory, for this spike only
      connectTimeoutMs: timeoutMs,
    },
    systemClock,
  );
  try {
    await client.connect();
  } catch (error) {
    return { outcome: 'failed', error: errorMessage(error) };
  }
  try {
    const state = await client.observe();
    return {
      outcome: 'joined',
      observed: {
        position: state.player.position,
        dimension: state.player.dimension,
        health: state.player.health,
        hunger: state.player.hunger,
        inventory: state.inventory.known ? 'known' : state.inventory,
      },
    };
  } catch (error) {
    return { outcome: 'joined-but-observe-failed', error: errorMessage(error) };
  } finally {
    await client.disconnect();
  }
}

async function main(): Promise<number> {
  const hostCheck = checkPrivateHost(host, []);
  if (!hostCheck.ok) {
    console.error(`Refusing: ${hostCheck.reason}`);
    return 1;
  }

  let ping: { ok: boolean; summary: Json };
  try {
    ping = await pingServer();
  } catch (error) {
    report['ping'] = { error: errorMessage(error) };
    return save(1, 'Server did not answer a status ping (is it running and done loading?)');
  }
  const pingShort = { ...ping.summary, modList: '(full list in the saved report)' };
  report['ping'] = ping.summary;
  console.log('PING', JSON.stringify(pingShort, null, 2));
  if (!ping.ok) {
    return save(
      1,
      `Refusing to log in: server is not identified as the GTNH test server (need MOTD "${values.marker}", FML, gregtech).`,
    );
  }
  if (values['ping-only']) return save(0, 'Ping only.');

  report['rawLogin'] = await rawLoginAttempt();
  console.log('RAW LOGIN', JSON.stringify(report['rawLogin'], null, 2));

  report['mineflayer'] = await mineflayerAttempt();
  console.log('MINEFLAYER', JSON.stringify(report['mineflayer'], null, 2));
  return save(0, 'Done.');
}

function save(code: number, message: string): number {
  report['finishedAt'] = new Date().toISOString();
  report['message'] = message;
  const dir = join('data', 'spike');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `connectivity-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`${message}\nSaved ${file}`);
  return code;
}

main().then(
  (code) => {
    process.exitCode = code;
    // mineflayer/protocol sockets can keep the loop alive briefly after end().
    setTimeout(() => process.exit(code), 2000).unref();
  },
  (error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  },
);
