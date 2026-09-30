import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { EntityIdSchema, ItemNameSchema, LocationNameSchema } from '../domain/common.ts';
import { NamedLocationSchema, SafetyConfigSchema } from '../domain/safety.ts';
import { checkPrivateHost } from './network.ts';

export const MinecraftConfigSchema = z
  .strictObject({
    host: z.string().min(1).max(253).default('127.0.0.1'),
    port: z.int().min(1).max(65535).default(25565),
    username: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,16}$/)
      .default('gtnh_agent'),
    /** `offline` is for a private server in offline mode. No credentials are stored by this project. */
    auth: z.enum(['offline', 'microsoft']).default('offline'),
    /** GTNH runs Minecraft 1.7.10 + Forge. Mineflayer support for it is UNVERIFIED. */
    version: z.string().min(1).max(20).default('1.7.10'),
    /** Hostnames (not IPs) you have verified point at a private server, e.g. a Tailscale name. */
    allowedHostnames: z.array(z.string().min(1).max(253)).max(20).default([]),
    /** Must be explicitly true before MineflayerClient will open a socket. */
    enableLiveConnection: z.boolean().default(false),
    connectTimeoutMs: z.int().min(1000).max(120_000).default(15_000),
    /**
     * Text that MUST appear in the server's MOTD before a live client logs in, so the
     * agent can never join the wrong server (e.g. another server on the same machine).
     * Live connections are refused while this is null.
     */
    serverIdentityMarker: z.string().min(3).max(64).nullable().default(null),
    /**
     * Send idle "still here" packets (at the exact server-assigned position) so the server
     * ticks the player and reports health/food. Never sends a different position.
     */
    presenceTicks: z.boolean().default(true),
    /** After joining, how long to wait for the first health and inventory packets. */
    initialStateGraceMs: z.int().min(0).max(30_000).default(3_000),
  })
  .superRefine((mc, ctx) => {
    const check = checkPrivateHost(mc.host, mc.allowedHostnames);
    if (!check.ok) ctx.addIssue({ code: 'custom', path: ['host'], message: check.reason });
  });
export type MinecraftConfig = z.infer<typeof MinecraftConfigSchema>;

export const RoutingConfigSchema = z.strictObject({
  /** Safe location RETREAT_HOME returns to. */
  homeLocationName: LocationNameSchema.default('home'),
  /** Storage container EMPTY_INVENTORY deposits into; null disables EMPTY_INVENTORY. */
  dumpContainerId: EntityIdSchema.nullable().default(null),
  machineWaitMs: z.int().min(100).max(60_000).default(5_000),
  refuelQuantity: z.int().min(1).max(64).default(8),
  /** Items EMPTY_INVENTORY never deposits (tools, etc.). Foods and fuels are always kept. */
  keepItems: z.array(ItemNameSchema).max(200).default([]),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

export const PlannerConfigSchema = z.strictObject({
  /** Only `mock` exists in this milestone. A local-LLM provider is future work. */
  provider: z.enum(['mock', 'none']).default('mock'),
  maxPlanSteps: z.int().min(1).max(16).default(8),
  recentHistoryLimit: z.int().min(0).max(50).default(10),
});
export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export const AgentConfigSchema = z.strictObject({
  minecraft: MinecraftConfigSchema.prefault({}),
  database: z.strictObject({ path: z.string().min(1).default('./data/agent.sqlite') }).prefault({}),
  safety: SafetyConfigSchema.prefault({}),
  routing: RoutingConfigSchema.prefault({}),
  planner: PlannerConfigSchema.prefault({}),
  locations: z.record(LocationNameSchema, NamedLocationSchema).default({}),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentConfigInput = z.input<typeof AgentConfigSchema>;

// ---------------------------------------------------------------------------
// Loading: built-in defaults <- JSON config file <- environment variables
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Json, override: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function xyz(name: string, value: string): { x: number; y: number; z: number } {
  const parts = list(value).map((p) => num(name, p));
  if (parts.length !== 3) throw new Error(`${name} must be "x,y,z", got "${value}"`);
  const [x, y, z] = parts as [number, number, number];
  return { x, y, z };
}

/** Environment overrides. Only non-secret settings are read; see .env.example. */
export function envOverrides(env: NodeJS.ProcessEnv): Json {
  const o: Json = {};
  const set = (path: string[], value: unknown): void => {
    let node = o;
    for (const key of path.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key] as Json;
    }
    node[path[path.length - 1] as string] = value;
  };
  const e = (name: string): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };

  let v: string | undefined;
  if ((v = e('MC_HOST'))) set(['minecraft', 'host'], v);
  if ((v = e('MC_PORT'))) set(['minecraft', 'port'], num('MC_PORT', v));
  if ((v = e('MC_USERNAME'))) set(['minecraft', 'username'], v);
  if ((v = e('MC_AUTH'))) set(['minecraft', 'auth'], v);
  if ((v = e('MC_VERSION'))) set(['minecraft', 'version'], v);
  if ((v = e('MC_ALLOWED_HOSTNAMES'))) set(['minecraft', 'allowedHostnames'], list(v));
  if ((v = e('MC_SERVER_MARKER'))) set(['minecraft', 'serverIdentityMarker'], v);
  if ((v = e('MC_PRESENCE_TICKS'))) set(['minecraft', 'presenceTicks'], v === 'true');
  if ((v = e('MC_ENABLE_LIVE_CONNECTION')))
    set(['minecraft', 'enableLiveConnection'], v === 'true');
  if ((v = e('AGENT_DB_PATH'))) set(['database', 'path'], v);
  if ((v = e('SAFETY_BOUNDARY_MIN')))
    set(['safety', 'boundary', 'min'], xyz('SAFETY_BOUNDARY_MIN', v));
  if ((v = e('SAFETY_BOUNDARY_MAX')))
    set(['safety', 'boundary', 'max'], xyz('SAFETY_BOUNDARY_MAX', v));
  if ((v = e('SAFETY_ALLOWED_DIMENSIONS')))
    set(['safety', 'boundary', 'allowedDimensions'], list(v));
  if ((v = e('SAFETY_MIN_HEALTH'))) set(['safety', 'minHealth'], num('SAFETY_MIN_HEALTH', v));
  if ((v = e('SAFETY_HUNGER_EAT_THRESHOLD')))
    set(['safety', 'hungerEatThreshold'], num('SAFETY_HUNGER_EAT_THRESHOLD', v));
  if ((v = e('SAFETY_MIN_HUNGER'))) set(['safety', 'minHunger'], num('SAFETY_MIN_HUNGER', v));
  if ((v = e('SAFETY_MAX_STATE_AGE_MS')))
    set(['safety', 'maxStateAgeMs'], num('SAFETY_MAX_STATE_AGE_MS', v));
  if ((v = e('SAFETY_HAZARD_RADIUS')))
    set(['safety', 'hazardAvoidanceRadius'], num('SAFETY_HAZARD_RADIUS', v));
  return o;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Explicit config file path; otherwise AGENT_CONFIG_FILE, then ./agent.config.json if present. */
  configFile?: string;
}

export interface LoadedConfig {
  config: AgentConfig;
  configFile: string | null;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = options.configFile ?? env['AGENT_CONFIG_FILE'];
  const candidate = resolve(cwd, explicit ?? 'agent.config.json');

  let fileJson: Json = {};
  let configFile: string | null = null;
  if (existsSync(candidate)) {
    const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
    if (!isPlainObject(parsed)) throw new Error(`${candidate} must contain a JSON object`);
    fileJson = parsed;
    configFile = candidate;
  } else if (explicit !== undefined) {
    throw new Error(`Config file not found: ${candidate}`);
  }

  // SAFETY_PROTECTED_ITEMS adds to (never replaces) the file's protected items.
  const merged = deepMerge(fileJson, envOverrides(env));
  const extraProtected = env['SAFETY_PROTECTED_ITEMS'];
  if (extraProtected !== undefined && extraProtected.trim() !== '') {
    const safety = isPlainObject(merged['safety']) ? merged['safety'] : {};
    const existing = Array.isArray(safety['protectedItems'])
      ? (safety['protectedItems'] as unknown[])
      : [];
    merged['safety'] = { ...safety, protectedItems: [...existing, ...list(extraProtected)] };
  }

  const result = AgentConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid agent configuration${configFile ? ` (${configFile})` : ''}:\n${issues}`,
    );
  }
  return { config: result.data, configFile };
}

/** Safe defaults with no file and no environment. Used by tests and the mock CLI. */
export function defaultConfig(overrides: AgentConfigInput = {}): AgentConfig {
  return AgentConfigSchema.parse(overrides);
}
