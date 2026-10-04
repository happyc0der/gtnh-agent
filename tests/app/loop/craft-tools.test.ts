import { describe, expect, it } from 'vitest';
import { runSingleCycle, type CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import type { ActionSpec } from '../../../src/domain/actions.ts';
import type { PlannerRequest, PlannerResponse } from '../../../src/planner/plan-schema.ts';
import type { PlannerProvider } from '../../../src/planner/planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { makeWorld, memoryRepos, testClock, testConfig } from '../../fixtures/index.ts';
import { ROUTE_PLANNER } from '../../../src/planner/route-plan.ts';
import { routeActions } from '../../fixtures/route-actions.ts';

const TOOLS = {
  'minecraft:wooden_pickaxe': 1,
  'minecraft:wooden_shovel': 1,
  'minecraft:wooden_axe': 1,
  'minecraft:wooden_hoe': 1,
};

/**
 * A planner that does what the route says: the actions its lines end with, in order, as many
 * as a plan may hold (a model is told to; the route gives it the exact arguments).
 */
function routeFollower(requests: PlannerRequest[]): PlannerProvider {
  return {
    name: 'route-follower',
    plan: (request): Promise<PlannerResponse> => {
      requests.push(request);
      const actions = routeActions(request.route?.steps ?? []).slice(0, request.maxPlanSteps);
      if (actions.length === 0) {
        return Promise.resolve({
          kind: 'escalation',
          escalation: { reason: 'OTHER', message: 'nothing to do', questionForUser: 'Now what?' },
        });
      }
      return Promise.resolve({
        kind: 'plan',
        plan: {
          goal: 'Craft the four wooden tools',
          steps: actions.map((action, i) => ({
            step: i + 1,
            action,
            rationale: 'the route says so',
          })),
          requiresUserApproval: false,
          explanation: 'Follow the route: its steps name the exact actions.',
          failureHandling: {
            onStepFailure: 'REPLAN',
            maxRetriesPerStep: 1,
            escalationMessage: 'Could not craft the tools.',
          },
        },
      });
    },
  };
}

// Loading the knowledge base takes a moment on a busy machine.
describe('the quest "Tools" on the mock world', { timeout: 60_000 }, () => {
  it('from logs, flint and the table it holds: planks and sticks in the 2x2 grid, the table placed, the tools at it', async () => {
    const clock = testClock();
    const { world, client } = makeWorld((w) => {
      // The bot's inventory after "Crafting Time" (and its bread); no table configured or seen.
      w.inventory.items = {
        'minecraft:log': 10,
        'minecraft:flint': 2,
        'minecraft:crafting_table': 1,
        'minecraft:bread': 6,
      };
      w.craftingTables = [];
      w.recipe = null; // no known step: System 1 asks the planner
      w.task = {
        taskId: 'quest-0:5',
        goal: 'Age 0 quest "Tools": craft a wooden pickaxe, shovel, axe and hoe',
        subgoal: null,
        status: 'active',
        requirements: TOOLS,
      };
    }, clock);
    await client.connect();
    const repos = memoryRepos(clock);
    const config = testConfig();
    syncConfigToDatabase(config, repos);
    const requests: PlannerRequest[] = [];
    const deps = {
      config,
      client,
      repos,
      decisionProvider: new DeterministicDecisionProvider(),
      planner: routeFollower(requests),
      clock,
      newId: sequentialIds(),
    };
    const results: CycleResult[] = [];
    const done = (): boolean =>
      Object.entries(TOOLS).every(([item, n]) => (world.inventory.items[item] ?? 0) >= n);
    while (!done() && results.length < 40) {
      clock.advance(500);
      results.push(await runSingleCycle(deps));
    }

    expect(done()).toBe(true);
    expect(
      results.every((r) => r.status === 'succeeded'),
      results.map((r) => r.summary).join('\n'),
    ).toBe(true);
    // Every step of the route an exact action with what is held (the table placed first, on
    // the floor beside the player, the 3x3 crafts at it): code followed the route itself
    // (route-plan.ts), and the model was never asked.
    expect(requests).toHaveLength(0);
    expect(repos.plans.latestForTask('quest-0:5')?.planner).toBe(ROUTE_PLANNER);

    const performed = client.performed.map(
      (p) => ({ type: p.action.type, args: p.action.args }) as ActionSpec,
    );
    expect(performed[0]).toEqual({
      type: 'PLACE_BLOCK',
      args: { position: { x: 2, y: 65, z: 1 }, item: 'minecraft:crafting_table' },
    });
    const crafts = performed.flatMap((a) => (a.type === 'CRAFT_ITEM' ? [a.args] : []));
    expect(crafts).toHaveLength(performed.length - 1);
    const tableOf = (recipe: string): Array<string | null> =>
      crafts.filter((c) => c.recipe === recipe).map((c) => c.craftingTableId);
    expect(new Set([...tableOf('planks_oak'), ...tableOf('sticks')])).toEqual(new Set([null]));
    for (const recipe of [
      'minecraft:wooden_pickaxe#1',
      'wooden_shovel',
      'wooden_axe',
      'minecraft:wooden_hoe#1',
    ]) {
      expect(tableOf(recipe), recipe).toEqual(['crafting_table:2.65.1']);
    }
    // Every step verified; the table stands where it was placed, and nothing else was used.
    expect(results.every((r) => r.outcome?.verification?.verified !== false)).toBe(true);
    expect(world.placedBlocks).toEqual([
      { block: 'minecraft:crafting_table', position: { x: 2, y: 65, z: 1 } },
    ]);
    expect(world.inventory.items).toMatchObject({
      ...TOOLS,
      'minecraft:flint': 2,
      'minecraft:crafting_table': 0,
      'minecraft:bread': 6,
    });
  });
});
