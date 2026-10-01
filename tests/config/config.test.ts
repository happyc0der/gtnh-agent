import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MineflayerClient } from '../../src/bot/mineflayer-client.ts';
import { defaultConfig, loadConfig } from '../../src/config/env.ts';
import {
  assertPrivateDestination,
  checkPrivateHost,
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
