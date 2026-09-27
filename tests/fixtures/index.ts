import { MockMinecraftClient, type MockWorld } from '../../src/bot/mock-minecraft-client.ts';
import { defaultConfig, type AgentConfig } from '../../src/config/env.ts';
import { createAction, type Action, type ActionSpec } from '../../src/domain/actions.ts';
import type { GameState } from '../../src/domain/game-state.ts';
import { MOCK_CONFIG, baseWorld } from '../../src/app/scenarios.ts';
import { IN_MEMORY, openDatabase } from '../../src/persistence/database.ts';
import { createRepositories, type Repositories } from '../../src/persistence/repositories.ts';
import type { SafetyContext } from '../../src/safety/safety-policy.ts';
import type { RouterContext } from '../../src/system1/state-queries.ts';
import { manualClock, type ManualClock } from '../../src/util/clock.ts';
import { sequentialIds } from '../../src/util/ids.ts';

export const T0 = '2026-01-01T12:00:00.000Z';

export function testConfig(): AgentConfig {
  return defaultConfig(MOCK_CONFIG);
}

export function testClock(): ManualClock {
  return manualClock(T0);
}

/** A world + client + state at T0. `mutate` edits the world before the snapshot. */
export function makeWorld(mutate: (w: MockWorld) => void = () => undefined, clock = testClock()) {
  const world = baseWorld('task-test');
  mutate(world);
  const client = new MockMinecraftClient(world, clock);
  return { world, client, clock, state: client.snapshot() };
}

export function makeState(mutate: (w: MockWorld) => void = () => undefined): GameState {
  return makeWorld(mutate).state;
}

export function safetyCtx(
  config: AgentConfig = testConfig(),
  now: Date = new Date(T0),
): SafetyContext {
  return {
    config: config.safety,
    protectedItems: new Set(config.safety.protectedItems),
    locations: new Map(Object.entries(config.locations)),
    now,
  };
}

export function routerCtx(
  config: AgentConfig = testConfig(),
  now: Date = new Date(T0),
): RouterContext {
  return { safety: safetyCtx(config, now), routing: config.routing };
}

const ids = sequentialIds();

export function action(spec: ActionSpec, taskId: string | null = 'task-test'): Action {
  return createAction(
    { spec, reason: 'test', origin: 'test', taskId },
    { newId: ids, now: () => new Date(T0) },
  );
}

export function memoryRepos(clock = testClock()): Repositories {
  return createRepositories(openDatabase(IN_MEMORY), clock);
}
