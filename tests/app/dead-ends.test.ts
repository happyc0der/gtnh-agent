import { describe, expect, it } from 'vitest';
import { explorationFor } from '../../src/app/agent-loop.ts';
import { readDeadEnds, rememberDeadEnd, withoutDeadEnds } from '../../src/app/dead-ends.ts';
import { MOCK_CONFIG } from '../../src/app/scenarios.ts';
import { defaultConfig } from '../../src/config/env.ts';
import type { ExplorationSummary, SeenChunk } from '../../src/domain/world-memory.ts';
import { makeState, memoryRepos, T0, testClock } from '../fixtures/index.ts';

const NO_WAY =
  'not exploring: no way further: no walkable spot in the play area gets closer to the target ' +
  '(water, a cliff, a wall or unloaded chunks are in the way)';
const explore = (x: number, z: number) => ({
  type: 'EXPLORE' as const,
  args: { toward: { x, z }, maxDistance: 64 },
});
const at = (x: number, z: number) => ({ x, y: 64, z });

describe('dead ends', () => {
  it('remembers the point of an EXPLORE that found no way further, and nothing else', () => {
    const { memory } = memoryRepos(testClock());
    rememberDeadEnd(memory, explore(49, 49), { ok: false, message: NO_WAY }, at(40, 63));
    // Not a dead end: it got going, it failed for another reason, it explored a direction.
    rememberDeadEnd(memory, explore(10, 10), { ok: true, message: 'explored 40 blocks' }, at(0, 0));
    rememberDeadEnd(memory, explore(10, 10), { ok: false, message: 'it is dark' }, at(0, 0));
    rememberDeadEnd(
      memory,
      { type: 'EXPLORE', args: { toward: 'north', maxDistance: 64 } },
      { ok: false, message: NO_WAY },
      at(0, 0),
    );
    expect(readDeadEnds(memory)).toEqual([{ toward: { x: 49, z: 49 }, from: at(40, 63) }]);
  });

  it('leaves out places and biome patches near a dead end, while the player is near it', () => {
    const summary: ExplorationSummary = {
      chunksSeen: 3,
      directions: {} as ExplorationSummary['directions'],
      places: [
        {
          resource: 'log',
          x: 49,
          y: 81,
          z: 49,
          distance: 17,
          direction: 'north_east',
          count: 9,
          biome: 'Hot Forest',
          seenMinutesAgo: 3,
        },
        {
          resource: 'log',
          x: 10,
          y: 70,
          z: 90,
          distance: 30,
          direction: 'south_west',
          count: 4,
          biome: 'Hot Forest',
          seenMinutesAgo: 3,
        },
      ],
      biomes: [
        { biome: 'Hot Forest', chunks: 9, x: 52, z: 44, distance: 21, direction: 'north_east' },
        { biome: 'Bamboo Forest', chunks: 2, x: 56, z: 90, distance: 30, direction: 'south_east' },
      ],
    };
    const deadEnds = [{ toward: { x: 49, z: 49 }, from: at(40, 63) }];
    const here = withoutDeadEnds(summary, deadEnds, at(41, 62));
    expect(here.places.map((p) => [p.x, p.z])).toEqual([[10, 90]]);
    expect(here.biomes.map((b) => b.biome)).toEqual(['Bamboo Forest']);
    // From somewhere else the point may well be reachable: nothing is left out.
    expect(withoutDeadEnds(summary, deadEnds, at(100, 63))).toEqual(summary);
  });

  it('is applied to the summary the planner gets', () => {
    const repos = memoryRepos(testClock());
    const config = defaultConfig({
      ...MOCK_CONFIG,
      minecraft: { movement: { enabled: true, mode: 'follow' } },
    });
    const seen: SeenChunk = {
      dimension: 'overworld',
      chunkX: 0,
      chunkZ: 4,
      biome: { id: 229, name: 'Hot Forest', share: 1 },
      counts: { log: 12 },
      examples: { log: [{ x: 3, y: 64, z: 70 }] },
      seenAt: T0,
    };
    repos.worldMemory.remember([seen]);
    const state = makeState(); // the player stands at (1, 64, 1)
    const now = new Date(T0);
    expect(explorationFor(config, repos, state, now)?.places).toHaveLength(1);
    rememberDeadEnd(repos.memory, explore(3, 70), { ok: false, message: NO_WAY }, at(1, 1));
    expect(explorationFor(config, repos, state, now)?.places).toEqual([]);
  });
});
