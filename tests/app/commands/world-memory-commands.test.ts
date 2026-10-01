import { describe, expect, it } from 'vitest';
import { parseExploreToward } from '../../src/app/live-agent.ts';
import { describeKnownPlaces, parseMapPoint } from '../../src/app/world-memory-commands.ts';
import { known } from '../../src/domain/known.ts';
import { makeState, memoryRepos, testConfig } from '../fixtures/index.ts';

describe('the explore and places commands', () => {
  it('reads a direction or a point for EXPLORE, and a map point for places', () => {
    expect(parseExploreToward('north')).toBe('north');
    expect(parseExploreToward('South-East')).toBe('south_east');
    expect(parseExploreToward('120,-40')).toEqual({ x: 120, z: -40 });
    expect(parseExploreToward(' -3.5 , 7 ')).toEqual({ x: -3.5, z: 7 });
    expect(parseExploreToward('up')).toBeNull();
    expect(parseExploreToward('1,2,3')).toBeNull();
    expect(parseMapPoint('10,-20')).toEqual({ x: 10, z: -20 });
    expect(parseMapPoint('10,64,-20')).toEqual({ x: 10, z: -20 });
    expect(parseMapPoint('ten')).toBeNull();
  });

  it('describes world memory from a point, or from the last live observation', () => {
    const repos = memoryRepos();
    const config = testConfig();
    const now = new Date('2026-01-01T12:00:00.000Z');
    expect(describeKnownPlaces(repos, config, null, now)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/pass --at/) as string,
    });
    repos.worldMemory.remember([
      {
        dimension: 'overworld',
        chunkX: 2,
        chunkZ: 0,
        near: true,
        biome: { id: 211, name: 'River Oasis', share: 0.6 },
        counts: { clay: 4, water: 40 },
        examples: { clay: [{ x: 45, y: 63, z: 3 }], water: [{ x: 41, y: 63, z: 3 }] },
        seenAt: '2026-01-01T11:50:00.000Z',
      },
    ]);
    const fromPoint = describeKnownPlaces(repos, config, { x: 0, z: 0 }, now);
    expect(fromPoint).toMatchObject({
      ok: true,
      value: { dimension: 'overworld', from: { x: 0, z: 0 }, chunksSeen: 1 },
    });
    // A live observation was stored: places are measured from where the player last was.
    repos.snapshots.insert(null, {
      ...makeState(),
      source: 'gtnh1710',
      player: { ...makeState().player, position: known({ x: 30, y: 64, z: 3 }) },
    });
    const fromPlayer = describeKnownPlaces(repos, config, null, now);
    if (!fromPlayer.ok) throw new Error(fromPlayer.error);
    expect(fromPlayer.value['from']).toEqual({ x: 30, z: 3 });
    expect(fromPlayer.value['places']).toEqual([
      expect.objectContaining({ resource: 'clay', distance: 15, direction: 'east', count: 4 }),
      expect.objectContaining({ resource: 'water', distance: 11, direction: 'east', count: 40 }),
    ]);
  });
});
