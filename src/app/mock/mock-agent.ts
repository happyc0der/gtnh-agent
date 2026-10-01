import { MockMinecraftClient } from '../bot/mock-minecraft-client.ts';
import { AgentConfigSchema, type AgentConfig, type AgentConfigInput } from '../config/env.ts';
import type { OllamaClientDeps } from '../llm/ollama-client.ts';
import { IN_MEMORY, openDatabase, type Db } from '../persistence/database.ts';
import { createRepositories, type Repositories } from '../persistence/repositories.ts';
import { manualClock, type ManualClock } from '../util/clock.ts';
import { randomIds, type IdGenerator } from '../util/ids.ts';
import { runSingleCycle, syncConfigToDatabase, type CycleResult } from './agent-loop.ts';
import { createProviders } from './providers.ts';
import { MOCK_CONFIG, type Scenario } from './scenarios.ts';

export interface MockRunOptions {
  /** SQLite path, or ':memory:'. */
  dbPath?: string;
  /** Extra config merged over MOCK_CONFIG (e.g. from the environment/config file). */
  config?: AgentConfigInput;
  clock?: ManualClock;
  newId?: IdGenerator;
  /** Reuse an open database (tests). */
  db?: Db;
  /** Model-client dependencies when a provider is `ollama` (tests serve recorded replies). */
  llm?: OllamaClientDeps;
}

export interface MockRun {
  result: CycleResult;
  client: MockMinecraftClient;
  repos: Repositories;
  config: AgentConfig;
  db: Db;
}

/**
 * Wires a MockMinecraftClient, SQLite and the configured providers (by default the
 * deterministic router and the scenario's fixture planner); runs ONE cycle.
 */
export async function runMockScenario(
  scenario: Scenario,
  options: MockRunOptions = {},
): Promise<MockRun> {
  const config = AgentConfigSchema.parse({
    ...MOCK_CONFIG,
    ...options.config,
    locations: { ...MOCK_CONFIG.locations, ...options.config?.locations },
    database: { path: options.dbPath ?? options.config?.database?.path ?? IN_MEMORY },
  });
  const clock = options.clock ?? manualClock(new Date());
  const newId = options.newId ?? randomIds;
  const db = options.db ?? openDatabase(config.database.path);
  const repos = createRepositories(db, clock);
  syncConfigToDatabase(config, repos);

  const client = new MockMinecraftClient(scenario.world(), clock);
  scenario.setup?.(client);
  await client.connect();
  try {
    const result = await runSingleCycle({
      config,
      client,
      repos,
      ...createProviders(config, {
        plannerFixtures: scenario.plannerFixtures ?? [],
        ...(options.llm ? { llm: options.llm } : {}),
      }),
      clock,
      newId,
    });
    return { result, client, repos, config, db };
  } finally {
    await client.disconnect();
  }
}
