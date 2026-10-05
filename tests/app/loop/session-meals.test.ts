import { describe, expect, it } from 'vitest';
import type { AgentDeps } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { runSession } from '../../../src/app/loop/live-session.ts';
import { MOCK_CONFIG } from '../../../src/app/mock/scenarios.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import { CURRENT_TASK_KEY } from '../../../src/persistence/memory-repository.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { makeWorld, memoryRepos, testClock } from '../../fixtures/index.ts';

describe('a meal in a task session', () => {
  it('keeps the session going, as a rest does: low health, hungry, food carried', async () => {
    // An independent review, 2026-10-05: EAT [LOW_HEALTH] ended its session, so the morning's
    // way out counted each meal as a failed try, and a goal each as a session for nothing.
    const clock = testClock();
    const { world, client } = makeWorld((w) => {
      w.player.health = 5;
      w.player.hunger = 12;
      w.player.position = { x: 40, y: 61, z: 40 };
      w.inventory.items = { 'minecraft:melon': 10 };
      w.foodValues = { 'minecraft:melon': 1 }; // Hunger Overhaul: a melon slice restores 1
      w.task = { taskId: 'task-x', goal: 'test', subgoal: null, status: 'active' };
      w.recipe = null;
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = defaultConfig(MOCK_CONFIG);
    syncConfigToDatabase(config, repos);
    repos.tasks.ensure({ id: 'task-x', goal: 'test', subgoal: null, status: 'active' });
    repos.memory.setValue(CURRENT_TASK_KEY, 'task-x');
    const deps: AgentDeps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: null,
      clock,
      newId: sequentialIds(),
    };
    const run = await runSession(
      deps,
      { maxCycles: 4, maxMinutes: 1, pauseMs: 0 },
      { stopRequested: () => null },
    );
    // Two meals (12 -> 14), then rests: one session to the limit.
    expect(run.stopKind).toBe('limit');
    expect(run.cycles.map((c) => c.summary.split(' -> ')[0])).toEqual([
      'EAT',
      'EAT',
      'REST',
      'REST',
    ]);
    expect(world.player.hunger).toBe(14);
  });
});
