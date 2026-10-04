/**
 * Times the pathfinder (src/bot/gtnh1710/pathing/) on the bench terrain of
 * tests/bot/gtnh1710/fixtures/survey-terrain.ts: 17 x 17 chunks with hills, a forest, a desert,
 * a river and a lake. For each spot, a path across a play area of 64 x 64 columns and 32
 * levels around it (from near one corner to near the opposite one): the search, the execution
 * plan and its validation, as medians of warm runs. Then a search that expands 100,000 nodes
 * (a goal far outside a larger area), and the flood behind GATHER's stand spots (every feet
 * block a walk reaches within about 64 blocks of walking, with MOVE_TO's breaks: the natural
 * blocks a hand digs, at a hand's dig time), once per observation. Offline: nothing connects.
 *
 * Usage: node scripts/path-bench.ts [--runs 11]
 */
import { parseArgs } from 'node:util';
import { planExecution } from '../src/bot/gtnh1710/pathing/execute.ts';
import { goalBlock } from '../src/bot/gtnh1710/pathing/goals.ts';
import { floodPath, planPath, type PathOptions } from '../src/bot/gtnh1710/pathing/search.ts';
import { WALK_ONE_BLOCK } from '../src/bot/gtnh1710/pathing/costs.ts';
import { digWaitTicks } from '../src/domain/dig-time.ts';
import { isDiggableBlock } from '../src/domain/blocks.ts';
import { validatePlan } from '../src/bot/gtnh1710/pathing/validate.ts';
import type { Fence, Vec3 } from '../src/bot/gtnh1710/walking.ts';
import { benchWalkWorld } from '../tests/bot/gtnh1710/fixtures/path-worlds.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '11' } } });
const runs = Math.max(3, Math.min(101, Number(values.runs) || 11));

const built = performance.now();
const { world, column } = benchWalkWorld();
process.stdout.write(`bench terrain built in ${(performance.now() - built).toFixed(0)} ms\n`);

const OPTIONS: PathOptions = {
  parkour: true,
  canBreak: (c) =>
    world.blockName(world.blockAt(c.x, c.y, c.z) ?? -1) === 'minecraft:leaves' ? 10 : null,
  maxNodes: 200_000,
  maxTimeMs: 10_000,
};

/** Median, min and max of `runs` timed calls. */
function time<T>(f: () => T): { text: string; last: T } {
  const t: number[] = [];
  let last = f();
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    last = f();
    t.push(performance.now() - start);
  }
  t.sort((a, b) => a - b);
  const ms = (n: number | undefined): string => (n ?? NaN).toFixed(1);
  return { text: `${ms(t[runs >> 1])} ms (${ms(t[0])}-${ms(t[runs - 1])})`, last };
}

/** A dry feet block near (x, z): the column's top + 1. */
function feetNear(x: number, z: number): Vec3 | null {
  for (let r = 0; r < 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const c = column(x + dx, z + dz);
        if (!c.water) return { x: x + dx + 0.5, y: c.ground + 1, z: z + dz + 0.5 };
      }
    }
  }
  return null;
}

const SPOTS: ReadonlyArray<readonly [string, number, number]> = [
  ['desert', 8, 8],
  ['river bank', 0, 30],
  ['forest', -80, 20],
  ['plains', -90, 90],
  ['hills', 60, 0],
  ['by the lake', -50, -60],
];
/** Placing too: bridges and pillars widen every node's choices. */
const PLACING: PathOptions = {
  ...OPTIONS,
  bridge: true,
  pillar: true,
  canPlace: () => true,
  throwaway: { count: 32, block: 'minecraft:dirt' },
};

for (const [label, cx, cz, options] of SPOTS.flatMap(([name, x, z]) => [
  [name, x, z, OPTIONS] as const,
  [`${name}, placing`, x, z, PLACING] as const,
])) {
  const name = label;
  const ground = column(cx, cz).ground;
  const area: Fence = {
    min: { x: cx - 32, y: ground - 15, z: cz - 32 },
    max: { x: cx + 31, y: ground + 16, z: cz + 31 },
  };
  const from = feetNear(cx - 28, cz - 28);
  const to = feetNear(cx + 27, cz + 27);
  if (from === null || to === null) continue;
  const goal = goalBlock(Math.floor(to.x), to.y, Math.floor(to.z));
  const search = time(() => planPath(world, area, from, goal, options));
  const r = search.last;
  const steps = time(() => planExecution(world, area, from, r.movements));
  const plan = steps.last;
  const check = time(() => validatePlan(world, area, from, plan));
  process.stdout.write(
    `${name}: ${r.status}${r.status === 'reached' ? '' : ` (${r.reason})`} in ${r.movements.length} movements, ${r.nodesExpanded} nodes; ` +
      `search ${search.text}; steps ${steps.text} (${plan.ok ? `${plan.ticks} ticks` : plan.reason}); ` +
      `validation ${check.text} (${check.last.ok ? 'valid' : check.last.reason})\n`,
  );
}

// 100,000 nodes: a goal far outside a 256 x 256 x 32 area (the largest the search takes).
const ground = column(8, 8).ground;
const big: Fence = {
  min: { x: -120, y: ground - 15, z: -120 },
  max: { x: 135, y: ground + 16, z: 135 },
};
const start = feetNear(8, 8);
if (start !== null) {
  for (const [label, options] of [
    ['walking', OPTIONS],
    ['placing', PLACING],
  ] as const) {
    const many = time(() =>
      planPath(world, big, start, goalBlock(2000, ground, 2000), { ...options, maxNodes: 100_000 }),
    );
    process.stdout.write(
      `100k nodes, ${label}: ${many.last.nodesExpanded} expanded, ${many.last.nodesOpened} opened, ` +
        `${many.last.stop}: ${many.text}\n`,
    );
  }
}

// The stand spots' flood, as observation.ts makes it every observation: a 64 x 64 x 32 play
// area around each spot, MOVE_TO's walk policy (breaking what a hand digs, at its dig time;
// placing with 32 throwaway blocks), at most 32 x 2 blocks of walking (path-actions.ts).
const HAND_BREAK: PathOptions['canBreak'] = (c) => {
  const name = world.blockName(world.blockAt(c.x, c.y, c.z) ?? -1);
  if (name === undefined || !isDiggableBlock(name)) return null;
  if (/stone|ore|granite|netherrack|clay/.test(name) && name !== 'minecraft:clay') return null;
  return digWaitTicks(name);
};
for (const [name, cx, cz] of SPOTS) {
  const at = feetNear(cx, cz);
  if (at === null) continue;
  const g = column(cx, cz).ground;
  const playArea: Fence = {
    min: { x: cx - 32, y: g - 15, z: cz - 32 },
    max: { x: cx + 31, y: g + 16, z: cz + 31 },
  };
  for (const [label, extra] of [
    ['breaking', {}],
    [
      'breaking and placing',
      {
        bridge: true,
        pillar: true,
        canPlace: () => true,
        throwaway: { count: 32, block: 'minecraft:dirt' },
      },
    ],
  ] as const) {
    const flood = time(() =>
      floodPath(world, playArea, at, {
        parkour: true,
        maxFall: 3,
        canBreak: HAND_BREAK,
        maxBreaks: 24,
        ...extra,
        maxCost: 32 * WALK_ONE_BLOCK * 2,
        maxNodes: 40_000,
        maxTimeMs: 10_000,
      }),
    );
    process.stdout.write(
      `stand-spot flood, ${name}, ${label}: ${flood.last.size} feet blocks, ${flood.last.nodesExpanded} expanded${flood.last.cut ? ' (cut)' : ''}: ${flood.text}
`,
    );
  }
}
