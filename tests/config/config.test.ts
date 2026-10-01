import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MineflayerClient } from '../../src/bot/mineflayer-client.ts';
import { defaultConfig, loadConfig } from '../../src/config/env.ts';
import {
  assertPrivateDestination,
  checkPrivateHost,
  checkPrivateUrl,
  isPrivateIpAddress,
} from '../../src/config/network.ts';
import { testClock } from '../fixtures/index.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const emptyDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'gtnh-agent-cfg-'));
  dirs.push(d);
  return d;
};

describe('configuration', () => {
  it('defaults are local and safe', () => {
    const c = defaultConfig();
    expect(c.minecraft).toMatchObject({
      host: '127.0.0.1',
      auth: 'offline',
      enableLiveConnection: false,
    });
    expect(c.safety.boundary.allowedDimensions).toEqual(['overworld']);
    expect(c.planner.provider).toBe('mock');
  });

  it('loads a JSON file, then applies environment overrides', () => {
    const dir = emptyDir();
    writeFileSync(
      join(dir, 'agent.config.json'),
      JSON.stringify({ safety: { minHealth: 12, protectedItems: ['minecraft:diamond'] } }),
    );
    const { config, configFile } = loadConfig({
      cwd: dir,
      env: {
        SAFETY_MIN_HEALTH: '14',
        SAFETY_PROTECTED_ITEMS: 'minecraft:emerald',
        SAFETY_BOUNDARY_MIN: '-10,0,-10',
      },
    });
    expect(configFile).toContain('agent.config.json');
    expect(config.safety.minHealth).toBe(14);
    expect(config.safety.protectedItems).toEqual(['minecraft:diamond', 'minecraft:emerald']);
    expect(config.safety.boundary.min).toEqual({ x: -10, y: 0, z: -10 });
    expect(config.safety.boundary.max).toEqual({ x: 256, y: 255, z: 256 });
  });

  it('digging is off unless enabled, and its heights are bounded', () => {
    expect(defaultConfig().minecraft.digging).toEqual({ enabled: false, maxHeightAboveFence: 4 });
    const { config } = loadConfig({ cwd: emptyDir(), env: { MC_ENABLE_DIGGING: 'true' } });
    expect(config.minecraft.digging.enabled).toBe(true);
    expect(() =>
      defaultConfig({ minecraft: { digging: { enabled: true, maxHeightAboveFence: 9 } } }),
    ).toThrow();
  });

  it('rejects invalid values with a readable error', () => {
    expect(() => loadConfig({ cwd: emptyDir(), env: { SAFETY_MIN_HEALTH: 'lots' } })).toThrow(
      /must be a number/,
    );
    expect(() => loadConfig({ cwd: emptyDir(), env: { MC_PORT: '99999' } })).toThrow(
      /minecraft.port/,
    );
    expect(() =>
      loadConfig({ cwd: emptyDir(), env: { AGENT_CONFIG_FILE: 'missing.json' } }),
    ).toThrow(/not found/);
  });

  it('refuses public servers', () => {
    expect(() => loadConfig({ cwd: emptyDir(), env: { MC_HOST: '8.8.8.8' } })).toThrow(/public IP/);
    expect(() => loadConfig({ cwd: emptyDir(), env: { MC_HOST: 'mc.hypixel.net' } })).toThrow(
      /MC_ALLOWED_HOSTNAMES/,
    );
    expect(
      loadConfig({ cwd: emptyDir(), env: { MC_HOST: 'msi', MC_ALLOWED_HOSTNAMES: 'msi' } }).config
        .minecraft.host,
    ).toBe('msi');
  });
});

describe('local model configuration', () => {
  it('defaults keep the deterministic router and the mock planner, with a local Ollama', () => {
    const c = defaultConfig();
    expect(c.planner.provider).toBe('mock');
    expect(c.decisions.provider).toBe('deterministic');
    expect(c.llm).toEqual({
      baseUrl: 'http://127.0.0.1:11434',
      allowedHostnames: [],
      plannerModel: 'qwen3:14b',
      decisionModel: 'qwen2.5:0.5b',
      timeoutMs: 120_000,
      keepAlive: '30s',
    });
  });

  it('environment variables select the providers and models', () => {
    const { config } = loadConfig({
      cwd: emptyDir(),
      env: {
        AGENT_PLANNER: 'ollama',
        AGENT_DECISIONS: 'ollama',
        OLLAMA_URL: 'http://100.101.102.103:11434',
        OLLAMA_PLANNER_MODEL: 'gemma4:12b',
        OLLAMA_DECISION_MODEL: 'qwen3:14b',
        OLLAMA_TIMEOUT_MS: '30000',
      },
    });
    expect(config.planner.provider).toBe('ollama');
    expect(config.decisions.provider).toBe('ollama');
    expect(config.llm).toMatchObject({
      baseUrl: 'http://100.101.102.103:11434',
      plannerModel: 'gemma4:12b',
      decisionModel: 'qwen3:14b',
      timeoutMs: 30_000,
    });
  });

  it.each([
    [{ AGENT_PLANNER: 'openai' }, /planner.provider/],
    [{ AGENT_DECISIONS: 'llm' }, /decisions.provider/],
    [{ OLLAMA_URL: 'http://8.8.8.8:11434' }, /public IP/],
    [{ OLLAMA_URL: 'https://api.example.com' }, /OLLAMA_ALLOWED_HOSTNAMES/],
    [{ OLLAMA_URL: 'http://user:secret@127.0.0.1:11434' }, /credentials/],
    [{ OLLAMA_URL: 'ftp://127.0.0.1' }, /http/],
    [{ OLLAMA_PLANNER_MODEL: 'qwen3:14b; rm -rf /' }, /model name/],
    [{ OLLAMA_TIMEOUT_MS: 'soon' }, /must be a number/],
  ])('rejects %o', (env, message) => {
    expect(() => loadConfig({ cwd: emptyDir(), env })).toThrow(message);
  });

  it('accepts a model server hostname only when allowlisted', () => {
    expect(
      loadConfig({
        cwd: emptyDir(),
        env: { OLLAMA_URL: 'http://msi:11434', OLLAMA_ALLOWED_HOSTNAMES: 'msi' },
      }).config.llm.baseUrl,
    ).toBe('http://msi:11434');
  });
});

describe('checkPrivateUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://localhost:11434', true],
    ['http://[::1]:11434', true],
    ['http://127.1:11434', true],
    ['http://192.168.1.5:11434/ollama', true],
    ['https://100.64.1.2', true],
    ['http://0x7f000001:11434', true],
    ['http://8.8.8.8:11434', false],
    ['http://[2001:4860:4860::8888]:11434', false],
    ['http://ollama.local:11434', false],
    ['http://127.0.0.1:11434/#x', false],
    ['javascript:alert(1)', false],
  ])('%s ok=%s', (url, ok) => {
    expect(checkPrivateUrl(url, [], 'OLLAMA_ALLOWED_HOSTNAMES').ok).toBe(ok);
  });
});

describe('private network guard', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.32.0.1', false],
    ['192.168.1.10', true],
    ['100.101.102.103', true],
    ['100.128.0.1', false],
    ['8.8.8.8', false],
    ['::1', true],
    ['fd7a:115c:a1e0::1', true],
    ['2001:4860:4860::8888', false],
    ['::ffff:192.168.1.1', true],
  ])('%s private=%s', (ip, expected) => {
    expect(isPrivateIpAddress(ip)).toBe(expected);
  });

  it('hostnames must be allowlisted', () => {
    expect(checkPrivateHost('localhost', [])).toMatchObject({ ok: true });
    expect(checkPrivateHost('myserver', [])).toMatchObject({ ok: false });
    expect(checkPrivateHost('MyServer', ['myserver'])).toMatchObject({
      ok: true,
      kind: 'allowlisted-hostname',
    });
  });

  it('allowlisted hostnames must resolve only to private addresses', async () => {
    await expect(
      assertPrivateDestination('msi', ['msi'], () => Promise.resolve(['100.64.0.5'])),
    ).resolves.toBeUndefined();
    await expect(
      assertPrivateDestination('msi', ['msi'], () => Promise.resolve(['100.64.0.5', '1.2.3.4'])),
    ).rejects.toThrow(/non-private/);
  });

  it('MineflayerClient refuses to connect unless live connection is explicitly enabled', async () => {
    const client = new MineflayerClient(defaultConfig().minecraft, testClock());
    await expect(client.connect()).rejects.toThrow(/live connection is disabled/);
    await expect(client.observe()).rejects.toThrow(/not connected/);
  });
});
