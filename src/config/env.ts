import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { EntityIdSchema, ItemNameSchema, LocationNameSchema } from '../domain/common.ts';
import { NamedLocationSchema, SafetyConfigSchema } from '../domain/safety.ts';
import { checkPrivateHost, checkPrivateUrl } from './network.ts';

/** Integer block coordinates (a block, not a point). */
const BlockPositionSchema = z.strictObject({
  x: z.int().min(-30_000_000).max(30_000_000),
  y: z.int().min(1).max(254),
  z: z.int().min(-30_000_000).max(30_000_000),
});

/** Largest fence the walker searches (blocks per side). */
export const MAX_FENCE_SIDE = 64;
/** Largest height range of a terrain fence (feet levels). A single level walks the flat way. */
export const MAX_FENCE_HEIGHT = 32;

/**
 * Walking (the only world-changing ability of the live client). Off by default: the
 * client walks only with `enabled` true AND a fence, on the fence's single level.
 */
export const MovementConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    /**
     * Blocks the player's feet may be in (inclusive). One level (min.y === max.y) walks the
     * flat pen way; a height range walks terrain (steps up, drops of up to 2).
     * The player's whole body must stay inside. Null refuses all movement.
     */
    fence: z
      .strictObject({ min: BlockPositionSchema, max: BlockPositionSchema })
      .nullable()
      .default(null),
    /** While this file exists no walk starts, and a walk in progress stops at its next step. */
    stopFile: z.string().min(1).max(500).default('./data/STOP'),
    /** A hostile or unidentified entity this close stops a MOVE_TO walk. */
    threatRadius: z.number().min(1).max(64).default(10),
    /** Longest single walk (path length in blocks). */
    maxPathLength: z.number().min(1).max(128).default(32),
  })
  .superRefine((m, ctx) => {
    if (m.fence === null) return;
    const { min, max } = m.fence;
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', path: ['fence'], message });
    };
    if (max.y - min.y > MAX_FENCE_HEIGHT) {
      issue(`fence height range must be at most ${MAX_FENCE_HEIGHT} blocks`);
    }
    if (min.x > max.x || min.y > max.y || min.z > max.z) issue('fence min must be <= max');
    if (max.x - min.x + 1 > MAX_FENCE_SIDE || max.z - min.z + 1 > MAX_FENCE_SIDE) {
      issue(`fence sides must be at most ${MAX_FENCE_SIDE} blocks`);
    }
  });
export type MovementConfig = z.infer<typeof MovementConfigSchema>;

/**
 * Vanilla chests (the second world-changing ability: moving items). Off by default. Only
 * chests listed here are ever opened, and only if the block there is a minecraft:chest.
 */
export const ContainersConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  chests: z
    .record(
      EntityIdSchema,
      z.strictObject({
        name: z.string().min(1).max(100),
        position: BlockPositionSchema,
      }),
    )
    .default({}),
});
export type ContainersConfig = z.infer<typeof ContainersConfigSchema>;

/** Highest dig height the config accepts (blocks above the fence's feet level). */
export const MAX_DIG_HEIGHT_ABOVE_FENCE = 8;

/**
 * Breaking blocks (DIG_BLOCK; the third world-changing ability). Off by default. It also
 * needs the movement fence: only allowlisted blocks inside the fence's columns, from its
 * feet level up to `maxHeightAboveFence` above it, are ever dug (never the floor below).
 */
export const DiggingConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Blocks from the fence's level (the feet level) up to this many above it may be dug. */
  maxHeightAboveFence: z.int().min(0).max(MAX_DIG_HEIGHT_ABOVE_FENCE).default(4),
});
export type DiggingConfig = z.infer<typeof DiggingConfigSchema>;

/**
 * Placing blocks (PLACE_BLOCK; approved 2026-09-30). Off by default. Like digging it also
 * needs the movement fence: only allowlisted plain blocks, only into cells inside the
 * fence's columns, from its feet level up to `maxHeightAboveFence` above it.
 */
export const PlacingConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  /** Cells from the fence's level (the feet level) up to this many above it may be filled. */
  maxHeightAboveFence: z.int().min(0).max(MAX_DIG_HEIGHT_ABOVE_FENCE).default(4),
});
export type PlacingConfig = z.infer<typeof PlacingConfigSchema>;

/**
 * Crafting (the third world-changing ability: it consumes items). Off by default. The
 * player's own 2x2 grid needs no table; 3x3 recipes use only the crafting tables listed
 * here, and only if the block there is a minecraft:crafting_table.
 */
export const CraftingConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  tables: z
    .record(
      EntityIdSchema,
      z.strictObject({
        name: z.string().min(1).max(100),
        position: BlockPositionSchema,
      }),
    )
    .default({}),
});
export type CraftingConfig = z.infer<typeof CraftingConfigSchema>;

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
     * Send idle "still here" packets (at the player's current position) so the server
     * ticks the player and reports health/food. Only walking (below) changes that position.
     */
    presenceTicks: z.boolean().default(true),
    /** After joining, how long to wait for the first health and inventory packets. */
    initialStateGraceMs: z.int().min(0).max(30_000).default(3_000),
    movement: MovementConfigSchema.prefault({}),
    containers: ContainersConfigSchema.prefault({}),
    digging: DiggingConfigSchema.prefault({}),
    placing: PlacingConfigSchema.prefault({}),
    crafting: CraftingConfigSchema.prefault({}),
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
  /**
   * `mock`: fixture plans (mock scenarios only; the live agent gets none). `ollama`: a local
   * model (llm.plannerModel) proposes plans, validated like any other. `none`: no planner.
   */
  provider: z.enum(['mock', 'none', 'ollama']).default('mock'),
  maxPlanSteps: z.int().min(1).max(16).default(8),
  recentHistoryLimit: z.int().min(0).max(50).default(10),
});
export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

export const DecisionsConfigSchema = z.strictObject({
  /**
   * System 1. `deterministic`: the rule router. `ollama`: a local model (llm.decisionModel)
   * chooses, always inside SafetyFirstDecisionProvider (the router's safety decisions and
   * pauses win; invalid model output pauses).
   */
  provider: z.enum(['deterministic', 'ollama']).default('deterministic'),
});
export type DecisionsConfig = z.infer<typeof DecisionsConfigSchema>;

/** An Ollama model name such as `qwen3:14b` or `namespace/model:tag`. */
const ModelNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/, 'expected an Ollama model name like qwen3:14b');

/** The local model server (Ollama). Used only when a provider above is `ollama`. */
export const LlmConfigSchema = z
  .strictObject({
    /** Only loopback, private-LAN or Tailscale addresses, or an allowlisted hostname. */
    baseUrl: z.string().min(1).max(500).default('http://127.0.0.1:11434'),
    /** Hostnames (not IPs) you have verified are private; checked again by DNS on every request. */
    allowedHostnames: z.array(z.string().min(1).max(253)).max(20).default([]),
    plannerModel: ModelNameSchema.default('qwen3:14b'),
    decisionModel: ModelNameSchema.default('qwen2.5:0.5b'),
    /** Per request, including loading the model. A timeout escalates (planner) or pauses (decisions). */
    timeoutMs: z.int().min(1000).max(600_000).default(120_000),
    /** How long Ollama keeps a model in memory after a request: short, the GPU is shared. */
    keepAlive: z
      .string()
      .regex(/^\d{1,5}(ms|s|m|h)$/, 'expected a duration like 30s or 5m')
      .default('30s'),
  })
  .superRefine((llm, ctx) => {
    const check = checkPrivateUrl(llm.baseUrl, llm.allowedHostnames, 'OLLAMA_ALLOWED_HOSTNAMES');
    if (!check.ok) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: check.reason });
  });
export type LlmConfig = z.infer<typeof LlmConfigSchema>;

export const MemoryConfigSchema = z.strictObject({
  /**
   * How long remembered container contents stay usable for planning checks (a withdrawal's
   * "enough in the container" precondition). The live client re-reads the real contents
   * before moving anything, so memory never decides what is clicked.
   */
  containerContentsMaxAgeMs: z.int().min(0).max(86_400_000).default(600_000),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const AgentConfigSchema = z.strictObject({
  minecraft: MinecraftConfigSchema.prefault({}),
  database: z.strictObject({ path: z.string().min(1).default('./data/agent.sqlite') }).prefault({}),
  safety: SafetyConfigSchema.prefault({}),
  routing: RoutingConfigSchema.prefault({}),
  planner: PlannerConfigSchema.prefault({}),
  decisions: DecisionsConfigSchema.prefault({}),
  llm: LlmConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
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
  if ((v = e('MC_ENABLE_MOVEMENT'))) set(['minecraft', 'movement', 'enabled'], v === 'true');
  if ((v = e('MC_MOVEMENT_FENCE_MIN')))
    set(['minecraft', 'movement', 'fence', 'min'], xyz('MC_MOVEMENT_FENCE_MIN', v));
  if ((v = e('MC_MOVEMENT_FENCE_MAX')))
    set(['minecraft', 'movement', 'fence', 'max'], xyz('MC_MOVEMENT_FENCE_MAX', v));
  if ((v = e('MC_MOVEMENT_STOP_FILE'))) set(['minecraft', 'movement', 'stopFile'], v);
  if ((v = e('MC_ENABLE_CONTAINERS'))) set(['minecraft', 'containers', 'enabled'], v === 'true');
  if ((v = e('MC_ENABLE_DIGGING'))) set(['minecraft', 'digging', 'enabled'], v === 'true');
  if ((v = e('MC_ENABLE_PLACING'))) set(['minecraft', 'placing', 'enabled'], v === 'true');
  if ((v = e('MC_ENABLE_CRAFTING'))) set(['minecraft', 'crafting', 'enabled'], v === 'true');
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
  if ((v = e('AGENT_PLANNER'))) set(['planner', 'provider'], v);
  if ((v = e('AGENT_DECISIONS'))) set(['decisions', 'provider'], v);
  if ((v = e('OLLAMA_URL'))) set(['llm', 'baseUrl'], v);
  if ((v = e('OLLAMA_ALLOWED_HOSTNAMES'))) set(['llm', 'allowedHostnames'], list(v));
  if ((v = e('OLLAMA_PLANNER_MODEL'))) set(['llm', 'plannerModel'], v);
  if ((v = e('OLLAMA_DECISION_MODEL'))) set(['llm', 'decisionModel'], v);
  if ((v = e('OLLAMA_TIMEOUT_MS'))) set(['llm', 'timeoutMs'], num('OLLAMA_TIMEOUT_MS', v));
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
