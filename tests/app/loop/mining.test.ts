import { describe, expect, it } from 'vitest';
import { runSingleCycle, type CycleResult } from '../../../src/app/loop/agent-loop.ts';
import { syncConfigToDatabase } from '../../../src/app/loop/agent-memory.ts';
import { MOCK_CONFIG } from '../../../src/app/mock/scenarios.ts';
import type { MockResourceBlock, MockWorld } from '../../../src/bot/mock-minecraft-client.ts';
import { defaultConfig } from '../../../src/config/env.ts';
import type { ActionSpec } from '../../../src/domain/actions.ts';
import { distance } from '../../../src/domain/geometry.ts';
import { parseToolName, usesLeft } from '../../../src/domain/tools.ts';
import type { SeenChunk } from '../../../src/domain/world-memory.ts';
import type { Plan, PlannerRequest, PlannerResponse } from '../../../src/planner/plan-schema.ts';
import type { PlannerProvider } from '../../../src/planner/planner-provider.ts';
import { DeterministicDecisionProvider } from '../../../src/system1/decision-provider.ts';
import { sequentialIds } from '../../../src/util/ids.ts';
import { makeWorld, memoryRepos, T0, testClock, testConfig } from '../../fixtures/index.ts';

// Mining on the mock world, end to end: the route in the planner request, the planner's
// plan, and then every action as the agent loop runs it (validated against the safety
// policy, executed by the mock client, verified), one per cycle.

const ORE = 'gregtech:gt.blockores';
// GT raw ores (gt.metaitem.03 at 5000 + the material id): iron 32, copper 35, tin 57.
const RAW_IRON = 'gregtech:gt.metaitem.03@5032';
const RAW_COPPER = 'gregtech:gt.metaitem.03@5035';
const RAW_TIN = 'gregtech:gt.metaitem.03@5057';

type Step = Plan['steps'][number]['action'];
const planOf = (goal: string, steps: Step[]): PlannerResponse => ({
  kind: 'plan',
  plan: {
    goal,
    steps: steps.map((action, i) => ({ step: i + 1, action, rationale: 'the route says so' })),
    requiresUserApproval: false,
    explanation: 'Craft what the route says; code digs the blocks one by one.',
    failureHandling: {
      onStepFailure: 'REPLAN',
      maxRetriesPerStep: 1,
      escalationMessage: 'Could not mine.',
    },
  },
});

/**
 * The mock world as `mutate` makes it (no stored items, no known step), with a task needing
 * `requirements`, and a planner that answers each request with `next(request, world)`.
 */
async function mining(opts: {
  requirements: Record<string, number>;
  mutate: (w: MockWorld) => void;
  next: (request: PlannerRequest, world: MockWorld) => PlannerResponse;
  explore?: boolean;
  seen?: SeenChunk[];
}) {
  const clock = testClock();
  const { world, client } = makeWorld((w) => {
    w.recipe = null; // no known step: System 1 asks for the plan
    w.containers = []; // nothing stored: the route digs
    w.task = {
      taskId: 'task-mining',
      goal: 'Mine',
      subgoal: null,
      status: 'active',
      requirements: opts.requirements,
    };
    opts.mutate(w);
  }, clock);
  await client.connect();
  const repos = memoryRepos(clock);
  const config =
    opts.explore === true
      ? defaultConfig({
          ...MOCK_CONFIG,
          minecraft: { movement: { enabled: true, mode: 'follow' } },
        })
      : testConfig();
  syncConfigToDatabase(config, repos);
  if (opts.seen !== undefined) repos.worldMemory.remember(opts.seen);
  const requests: PlannerRequest[] = [];
  const planner: PlannerProvider = {
    name: 'scripted',
    plan: (request) => {
      requests.push(request);
      return Promise.resolve(opts.next(request, world));
    },
  };
  const deps = {
    config,
    client,
    repos,
    decisionProvider: new DeterministicDecisionProvider(),
    planner,
    clock,
    newId: sequentialIds(),
  };
  const taskId = 'task-mining';
  return {
    world,
    repos,
    requests,
    /** Cycles until `stop` holds after one (at most `max`). */
    async until(stop: () => boolean, max = 400): Promise<CycleResult[]> {
      const results: CycleResult[] = [];
      while (results.length < max) {
        clock.advance(500);
        results.push(await runSingleCycle(deps));
        if (stop()) break;
      }
      return results;
    },
    journal: (): string[] => repos.memory.journal(taskId).map((e) => e.text),
    performed: (): ActionSpec[] =>
      client.performed.map((p) => ({ type: p.action.type, args: p.action.args }) as ActionSpec),
    logged: () => repos.actions.recent(1000, taskId),
  };
}

/** Whether the inventory holds a wooden pickaxe the agent may still dig with. */
const usablePickaxe = (items: Record<string, number>): boolean =>
  Object.entries(items).some(([name, count]) => {
    const t = parseToolName(name);
    return (
      count > 0 && t?.tool.item === 'minecraft:wooden_pickaxe' && usesLeft(t.tool, t.damage) >= 1
    );
  });

describe('mining stone: 64 cobblestone from a few logs', () => {
  // Two rows of stone two high along z = 5 and 6 (x -7 to 10), each dug from the north side
  // (z 4.5) as the live client lists stand spots; the crafting table stands at (2, 64, -2).
  const stone = (): MockResourceBlock[] =>
    [5, 6].flatMap((z) =>
      [64, 65].flatMap((y) =>
        Array.from({ length: 18 }, (_, i) => ({
          block: 'minecraft:stone' as const,
          position: { x: i - 7, y, z },
          standAt: { x: i - 6.5, y: 64, z: 4.5 },
        })),
      ),
    );
  const TABLE = { x: 2, y: 64, z: -2 };

  it('crafts a wooden pickaxe at the table, digs stone, and a second pickaxe when the first wears out', async () => {
    const g = await mining({
      requirements: { 'minecraft:cobblestone': 64 },
      mutate: (w) => {
        w.inventory.items = { 'minecraft:log': 6, 'minecraft:bread': 6 };
        w.resourceBlocks = stone();
      },
      // What the route says: a pickaxe first (when none is usable), then GATHER the rest.
      next: (_request, w) => {
        const items = w.inventory.items;
        const steps: Step[] = [];
        if (!usablePickaxe(items)) {
          if (distance(w.player.position, TABLE) > 4) {
            steps.push({
              type: 'MOVE_TO',
              args: { target: { x: 2.5, y: 64, z: 0.5 }, tolerance: 1 },
            });
          }
          const planks = items['minecraft:planks'] ?? 0;
          if (planks < 5) {
            steps.push({
              type: 'CRAFT_ITEM',
              args: {
                recipe: 'planks_oak',
                times: Math.ceil((5 - planks) / 2),
                craftingTableId: null,
              },
            });
          }
          steps.push(
            { type: 'CRAFT_ITEM', args: { recipe: 'sticks', times: 1, craftingTableId: null } },
            {
              type: 'CRAFT_ITEM',
              args: {
                recipe: 'minecraft:wooden_pickaxe#1',
                times: 1,
                craftingTableId: 'table.main',
              },
            },
          );
        }
        const held = items['minecraft:cobblestone'] ?? 0;
        steps.push({ type: 'GATHER', args: { block: 'minecraft:stone', count: 64 - held } });
        return planOf('Get 64 cobblestone', steps);
      },
    });
    await g.until(() => (g.world.inventory.items['minecraft:cobblestone'] ?? 0) >= 64);

    // The route the planner was given: planks, sticks, the pickaxe, then stone.
    const first = g.requests[0]?.route?.steps.join('\n') ?? '';
    expect(first).toMatch(/craft .*minecraft:wooden_pickaxe/);
    expect(first).toMatch(
      /gather 64 minecraft:cobblestone: dig minecraft:stone .*pickaxe level >= 0/,
    );

    expect(g.world.inventory.items['minecraft:cobblestone']).toBe(64);
    const performed = g.performed();
    const pickaxes = performed.filter(
      (a) => a.type === 'CRAFT_ITEM' && a.args.recipe === 'minecraft:wooden_pickaxe#1',
    );
    expect(pickaxes).toHaveLength(2);
    // Every dig had a pickaxe that harvests stone: none was refused, none failed.
    const digs = g.logged().filter((a) => a.actionType === 'DIG_BLOCK');
    expect(digs).toHaveLength(64);
    expect(digs.every((a) => a.status === 'succeeded')).toBe(true);
    // The first pickaxe was used to its last safe use (59 digs) and kept; the second dug 5.
    expect(g.world.inventory.items).toMatchObject({
      'minecraft:wooden_pickaxe@59': 1,
      'minecraft:wooden_pickaxe@5': 1,
    });
    // The GATHER that wore it out ended on the policy's refusal (the worn pickaxe harvests
    // nothing more), and the planner, asked again, got a route that makes a new pickaxe.
    expect(g.journal()).toContainEqual(
      expect.stringMatching(
        /^GATHER 64 minecraft:stone ended: none of the \d+ minecraft:stone in view can be dug now \(nearest \(-?\d+, \d+, \d+\): NOT_DIGGABLE\).*; 59 dug, 59\/64 gathered/,
      ),
    );
    expect(g.requests).toHaveLength(2);
    const second = g.requests[1]?.route?.steps.join('\n') ?? '';
    expect(second).toContain('have 59 / need 64');
    expect(second).toContain(
      'tool: pickaxe level >= 0 for dig minecraft:stone: get minecraft:wooden_pickaxe first',
    );
    expect(g.journal().at(-1)).toBe('plan #2 done: Get 64 cobblestone');
  });
});

describe('mining ore: 16 raw iron ore, from an ore place world memory remembers', () => {
  // A GT ore vein 43 blocks east, out of the scan's sight: two walls (x 44 and 45, z -3 to 3,
  // y 64 to 66) with a gap at (44, 64..65, 0) under an overhanging ore, the ore world memory
  // saw. Mostly iron (metadata 2: level 2), some copper (1); the overhanging one is of level
  // 3, and right above the head once the player stands in the gap. Which ore is which only a
  // dig shows (the material is in the tile entity), as live.
  const COPPER = new Set(['44,64,-1', '44,65,1', '45,64,2', '45,65,-2', '44,66,-3', '45,66,0']);
  const LEVEL_3 = '44,66,0';
  const vein = (): MockResourceBlock[] =>
    [44, 45].flatMap((x) =>
      [64, 65, 66].flatMap((y) =>
        Array.from({ length: 7 }, (_, i) => i - 3).flatMap((z): MockResourceBlock[] => {
          if (x === 44 && z === 0 && y < 66) return [];
          const k = `${x},${y},${z}`;
          const [meta, item] =
            k === LEVEL_3 ? [3, RAW_TIN] : COPPER.has(k) ? [1, RAW_COPPER] : [2, RAW_IRON];
          return [
            {
              block: ORE,
              position: { x, y, z },
              standAt: { x: 43.5, y: 64, z: z + 0.5 },
              meta,
              drop: { item, count: 1 },
            },
          ];
        }),
      ),
    );
  const seen: SeenChunk = {
    dimension: 'overworld',
    chunkX: 2,
    chunkZ: 0,
    near: true,
    biome: { id: 3, name: 'Extreme Hills', share: 1 },
    counts: { ore: 40, stone: 200 },
    examples: { ore: [{ x: 44, y: 66, z: 0 }] },
    seenAt: T0,
  };

  it("walks to the remembered ores, digs them with a Tinkers' pickaxe, and passes over one it cannot harvest", async () => {
    const g = await mining({
      requirements: { [RAW_IRON]: 16 },
      explore: true,
      seen: [seen],
      mutate: (w) => {
        w.inventory.items = { 'TConstruct:pickaxe': 1, 'minecraft:bread': 6 };
        // A pickaxe of level 2 (its NBT data, which the client reads; the observation shows
        // only the name, so the planner and the policy do not know its level).
        w.toolNbt = {
          'TConstruct:pickaxe': {
            InfiTool: {
              HarvestLevel: 2,
              MiningSpeed: 500,
              Damage: 0,
              TotalDurability: 400,
              Broken: 0,
              Shoddy: 0,
            },
          },
        };
        w.resourceBlocks = vein();
      },
      // What the route's GATHER hint says, for what is still missing.
      next: (_request, w) =>
        planOf('Mine 16 iron ore', [
          {
            type: 'GATHER',
            args: { block: ORE, item: RAW_IRON, count: 16 - (w.inventory.items[RAW_IRON] ?? 0) },
          },
        ]),
    });
    await g.until(() => (g.world.inventory.items[RAW_IRON] ?? 0) >= 16);

    // The route named the GATHER, the place world memory remembers, and the level iron needs.
    const route = g.requests[0]?.route?.steps.join('\n') ?? '';
    expect(route).toContain(`GATHER {"block":"${ORE}","item":"${RAW_IRON}"}`);
    expect(route).toMatch(/remembered \(Extreme Hills\).* \(44, 66, 0\)/);
    expect(route).toMatch(/needs a pickaxe level >= 2/);

    const performed = g.performed();
    // None in view: the step first heads for the remembered place (43 m, and 8 to spare).
    expect(performed[0]).toEqual({
      type: 'EXPLORE',
      args: { toward: { x: 44.5, z: 0.5 }, maxDistance: 51 },
    });
    expect(g.world.inventory.items[RAW_IRON]).toBe(16);
    // The copper ores in its way were dug too (only a dig shows an ore's material).
    expect(g.world.inventory.items[RAW_COPPER] ?? 0).toBeGreaterThan(0);
    // The level-3 ore: the client refused it (no dig sent), and the step passed it over.
    const digs = g.logged().filter((a) => a.actionType === 'DIG_BLOCK');
    const failed = digs.filter((a) => a.status !== 'succeeded');
    expect(failed).toHaveLength(1);
    expect(JSON.stringify(failed[0]?.action)).toContain('"x":44,"y":66,"z":0');
    expect(g.world.resourceBlocks.some((r) => r.meta === 3)).toBe(true);
    expect(g.world.inventory.items[RAW_TIN]).toBeUndefined();
    // The Tinkers' pickaxe wore by one per dig (its NBT damage).
    const dug = digs.length - failed.length;
    expect(g.world.toolNbt?.['TConstruct:pickaxe']?.['InfiTool']).toMatchObject({ Damage: dug });
    // One plan did it all: the refusal was one failure, and the next dig succeeded.
    expect(g.requests).toHaveLength(1);
    const head = `GATHER 16 ${ORE} for ${RAW_IRON}`;
    expect(g.journal()).toEqual([
      'new plan #1: Mine 16 iron ore (1 steps)',
      `${head} (plan #1 step 1) started: counts ${RAW_IRON}, 0 held; 0 ${ORE} for ${RAW_IRON} listed in view`,
      expect.stringMatching(new RegExp(`^${escape(head)}: 16 dug, \\d+/16 gathered`)),
      expect.stringMatching(
        new RegExp(`^${escape(head)} done; ${dug} dug, 16/16 gathered, ${dug + 2} action`),
      ),
      'plan #1 done: Mine 16 iron ore',
    ]);
  });
});

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
