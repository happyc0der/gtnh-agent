import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCommandLine, type Cli } from '../../../src/app/commands/cli-context.ts';
import { commandCommand, commandsCommand } from '../../../src/app/commands/cli-records.ts';
import { playCommand, reconnectDelay } from '../../../src/app/commands/cli-runs.ts';
import { defaultConfig, type AgentConfigInput } from '../../../src/config/env.ts';
import { openDatabase } from '../../../src/persistence/database.ts';
import { OWNER_PAUSED_KEY } from '../../../src/persistence/memory-repository.ts';
import { createRepositories } from '../../../src/persistence/repositories.ts';
import { systemClock } from '../../../src/util/clock.ts';
import { FakeGtnhServer } from '../../bot/gtnh1710/fixtures/fake-server.ts';

let dir = '';
const servers: FakeGtnhServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gtnh-cli-commands-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A CLI invocation, as cli.ts builds it, with what it prints collected. */
function cli(argv: string[], config: AgentConfigInput = {}) {
  const { positionals, values } = parseCommandLine(argv);
  const printed: unknown[] = [];
  const c: Cli = {
    command: positionals[0] ?? '',
    args: positionals.slice(1),
    values,
    config: defaultConfig({
      ...config,
      minecraft: {
        owners: ['DankAxon'],
        ...config.minecraft,
        movement: { stopFile: join(dir, 'STOP'), ...config.minecraft?.movement },
      },
    }),
    configFile: null,
    dbPath: join(dir, 'agent.sqlite'),
    print: (v) => void printed.push(v),
    log: undefined,
  };
  return { cli: c, printed };
}

/** stderr, as the commands write their progress to it. */
function stderr(): string[] {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
}

describe('cli command / commands', () => {
  it('queues a command as if the first owner whispered it, and lists them', () => {
    // As typed: pnpm cli command "!goto 120 64 -40" (quoted: "-40" alone would be an option).
    const queued = cli(['command', '!goto 120 64 -40']);
    expect(commandCommand(queued.cli)).toBe(0);
    expect(queued.printed[0]).toMatchObject({
      id: 1,
      sender: 'DankAxon',
      text: '!goto 120 64 -40',
      command: 'go to 120 64 -40',
      status: 'queued',
    });
    const db = openDatabase(join(dir, 'agent.sqlite'));
    expect(createRepositories(db, systemClock).commands.get(1)).toMatchObject({
      source: 'cli',
      command: { verb: 'goto', x: 120, y: 64, z: -40 },
    });
    db.close();
    const listed = cli(['commands']);
    expect(commandsCommand(listed.cli)).toBe(0);
    expect(listed.printed[0]).toMatchObject([{ id: 1, status: 'queued', source: 'cli' }]);
  });

  it('refuses at once what the play loop would refuse: a typo, natural language without a model, no owner', () => {
    const err = stderr();
    expect(commandCommand(cli(['command', '!goto', '10']).cli)).toBe(1);
    expect(commandCommand(cli(['command', 'bring', 'me', 'wood']).cli)).toBe(1);
    expect(commandCommand(cli(['command', '!come'], { minecraft: { owners: [] } }).cli)).toBe(1);
    expect(commandCommand(cli(['command']).cli)).toBe(1);
    expect(err.join('')).toMatch(/usage: !goto/);
    expect(err.join('')).toMatch(/natural language needs a translator: AGENT_COMMANDS=ollama/);
    expect(err.join('')).toMatch(/no owner is configured \(MC_OWNERS\)/);
    // With a translator, natural language is queued for it.
    const nl = cli(['command', 'bring', 'me', 'wood'], { commands: { translator: 'ollama' } });
    expect(commandCommand(nl.cli)).toBe(0);
    expect(nl.printed[0]).toMatchObject({
      command: 'natural language: the model translates it when play takes it',
    });
  });
});

describe('cli play --listen: staying reachable', () => {
  it('backs off 5 s, 15 s, 60 s, then every 2 minutes', () => {
    expect([0, 1, 2, 3, 4, 10].map(reconnectDelay)).toEqual([
      5_000, 15_000, 60_000, 120_000, 120_000, 120_000,
    ]);
  });

  it('a connection that fails is tried again until the stop file (and is an error without --listen)', async () => {
    // A port nothing listens on.
    const probe = createServer();
    const port = await new Promise<number>((r) =>
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address();
        r(typeof a === 'object' && a !== null ? a.port : 0);
      }),
    );
    await new Promise((r) => probe.close(r));
    const minecraft = {
      host: '127.0.0.1',
      port,
      enableLiveConnection: true,
      serverIdentityMarker: 'gtnh-agent-test',
      connectTimeoutMs: 1_000,
    };
    const err = stderr();
    await expect(playCommand(cli(['play', '--live'], { minecraft }).cli)).rejects.toThrow();

    const listening = cli(['play', '--live', '--listen'], { minecraft });
    const run = playCommand(listening.cli);
    await vi.waitFor(() => expect(err.join('')).toMatch(/could not connect \(attempt 1\)/), {
      timeout: 5_000,
    });
    expect(err.join('')).toMatch(/trying again in 5 s/);
    writeFileSync(join(dir, 'STOP'), 'stop');
    expect(await run).toBe(0);
    expect(listening.printed.at(-1)).toMatchObject({
      stopReason: expect.stringMatching(/the stop file .* exists \(while reconnecting\)/) as string,
    });
  }, 20_000);

  it('reconnects after the connection drops, and a fresh play is not paused', async () => {
    const fake = new FakeGtnhServer();
    servers.push(fake);
    const port = await fake.listen();
    const db = openDatabase(join(dir, 'agent.sqlite'));
    createRepositories(db, systemClock).memory.setValue(OWNER_PAUSED_KEY, 'DankAxon said stop');
    db.close();
    const err = stderr();
    const play = cli(['play', '--live', '--listen'], {
      minecraft: {
        host: '127.0.0.1',
        port,
        enableLiveConnection: true,
        serverIdentityMarker: 'gtnh-agent-test',
        connectTimeoutMs: 5_000,
        initialStateGraceMs: 1_000,
      },
    });
    const run = playCommand(play.cli);
    // Nothing to do on this server (no quest book): it waits for commands, online.
    await vi.waitFor(() => expect(err.join('')).toMatch(/idle: .*waiting for commands/), {
      timeout: 10_000,
    });
    expect(fake.logins).toBe(1);
    fake.dropAll();
    await vi.waitFor(() => expect(err.join('')).toMatch(/the connection was lost/), {
      timeout: 10_000,
    });
    await vi.waitFor(() => expect(fake.logins).toBe(2), { timeout: 15_000 });
    writeFileSync(join(dir, 'STOP'), 'stop');
    expect(await run).toBe(0);
    expect(play.printed.at(-1)).toMatchObject({
      stopReason: expect.stringMatching(/the stop file .* exists/) as string,
    });
    // The pause from before this play was cleared when it started.
    expect(err.join('')).not.toMatch(/paused: DankAxon said stop/);
  }, 45_000);
});
