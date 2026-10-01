/**
 * Times the world survey (src/bot/gtnh1710/world-survey.ts) on the bench terrain of
 * tests/bot/gtnh1710/survey-terrain.ts: the 17 x 17 chunks a client holds with the server's
 * view distance of 8, with a desert, a forest, plains, hills, a river and a lake. For each spot:
 * a near-only re-survey and a full one (far sight too), as medians of warm runs. Offline:
 * nothing connects. The survey runs in the client's event loop between packets, so a typical
 * full survey should stay well under 20 ms.
 *
 * Usage: node scripts/survey-bench.ts [--runs 21]
 */
import { parseArgs } from 'node:util';
import type { Registry } from '../src/bot/gtnh1710/registry.ts';
import {
  buildSurveyTables,
  surveyAround,
  type ChunkSighting,
} from '../src/bot/gtnh1710/world-survey.ts';
import { DIG_TEST_BLOCK_REGISTRY } from '../tests/bot/gtnh1710/chunk-fixtures.ts';
import { surveyTerrain } from '../tests/bot/gtnh1710/survey-terrain.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '21' } } });
const runs = Math.max(3, Math.min(201, Number(values.runs) || 21));

const SPOTS: ReadonlyArray<readonly [string, number, number]> = [
  ['desert (spawn)', 8.5, 8.5],
  ['river bank', 0.5, 30.5],
  ['forest', -80.5, 20.5],
  ['plains', -100.5, 100.5],
  ['hilltop', 60.5, 0.5],
  ['by the lake', -50.5, -60.5],
];

const built = performance.now();
const { store, column } = surveyTerrain();
const registry: Registry = {
  blocks: new Map(DIG_TEST_BLOCK_REGISTRY),
  items: new Map(),
  blockSubstitutions: [],
  itemSubstitutions: [],
};
const tables = buildSurveyTables(registry);
const world = { chunkColumn: (cx: number, cz: number) => store.column(cx, cz) };
process.stdout.write(
  `bench terrain: ${store.size} chunks, built in ${(performance.now() - built).toFixed(0)} ms\n`,
);

const eyeAt = (x: number, z: number) => {
  const c = column(Math.floor(x), Math.floor(z));
  return { x, y: Math.max(c.ground, 61) + 1 + 1.62, z };
};
/** Median, min and max of `runs` timed calls. */
function time(f: () => unknown): string {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    f();
    t.push(performance.now() - start);
  }
  t.sort((a, b) => a - b);
  const ms = (n: number | undefined): string => (n ?? NaN).toFixed(1);
  return `${ms(t[runs >> 1])} ms (${ms(t[0])}-${ms(t[runs - 1])})`;
}
const totals = (s: readonly ChunkSighting[]): string => {
  const sum = new Map<string, number>();
  for (const c of s) {
    for (const [k, n] of Object.entries(c.counts)) sum.set(k, (sum.get(k) ?? 0) + (n ?? 0));
  }
  return [...sum].map(([k, n]) => `${k} ${n}`).join(', ');
};

// Warm up (the JIT), then time each spot.
for (const [, x, z] of SPOTS) {
  for (let i = 0; i < 5; i++) surveyAround(world, tables, eyeAt(x, z), true);
}
for (const [name, x, z] of SPOTS) {
  const eye = eyeAt(x, z);
  const near = time(() => surveyAround(world, tables, eye, false));
  const full = time(() => surveyAround(world, tables, eye, true));
  const seen = surveyAround(world, tables, eye, true);
  process.stdout.write(
    `${name} (${x}, ${eye.y.toFixed(2)}, ${z}): near ${near}; near + far ${full}; ` +
      `${seen.length} chunk(s), ${seen.filter((c) => !c.near).length} from afar: ${totals(seen)}\n`,
  );
}
