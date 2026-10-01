import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { biomeName } from '../../../src/bot/gtnh1710/biomes.ts';
import {
  ChunkStore,
  decodeChunkBulk,
  decodeChunkColumnWithBiomes,
} from '../../../src/bot/gtnh1710/chunk-data.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import {
  buildSurveyTables,
  clearLine,
  describeSightings,
  dominantBiome,
  namesAnOre,
  SIGHT,
  sightOf,
  SURVEY_RANGE,
  surveyChunk,
  surveyKindOf,
  SurveyTracker,
  type TrackedWorld,
} from '../../../src/bot/gtnh1710/world-survey.ts';
import { worldTime } from '../../../src/domain/game-state.ts';
import { BLOCK, DIG_TEST_BLOCK_REGISTRY, neidColumn, type BlockFn } from './chunk-fixtures.ts';

const ORE = 2711; // gregtech:gt.blockores in the test world
const registry: Registry = {
  blocks: new Map([...DIG_TEST_BLOCK_REGISTRY, [ORE, 'gregtech:gt.blockores']]),
  items: new Map(),
  blockSubstitutions: [],
  itemSubstitutions: [],
};
const tables = buildSurveyTables(registry);

/** A world store holding the chunks within `radius` of chunk (0, 0), with biomes. */
function storeOf(block: BlockFn, biome: (x: number, z: number) => number, radius = 2): ChunkStore {
  const store = new ChunkStore();
  const columns = [];
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      columns.push(neidColumn(cx, cz, block, true, true, biome));
    }
  }
  const decoded = decodeChunkBulk(
    columns.map((c) => c.header),
    true,
    deflateSync(Buffer.concat(columns.map((c) => c.data))),
    { neid: true },
  );
  for (const c of decoded) {
    store.setColumn(c.header.chunkX, c.header.chunkZ, c.sections, 0, c.biomes);
  }
  return store;
}

function worldOf(store: ChunkStore, dayTicks = 6000): TrackedWorld {
  return {
    registry,
    dimension: 'overworld',
    worldTimeAt: () => worldTime(dayTicks, true),
    chunkColumn: (cx, cz) => store.column(cx, cz),
    blockAt: (x, y, z) => store.blockAt(x, y, z),
  };
}

const GROUND = 63;
const EYE = { x: 8.5, y: GROUND + 1 + 1.62, z: 8.5 };
/** Grass ground at y=63 over stone, with single blocks overridden. */
function ground(overrides: Record<string, number>): BlockFn {
  return (x, y, z) => {
    const o = overrides[`${x},${y},${z}`];
    if (o !== undefined) return o;
    if (y === 0) return BLOCK.bedrock;
    if (y < GROUND) return BLOCK.stone;
    return y === GROUND ? BLOCK.grass : BLOCK.air;
  };
}

describe('what a survey counts', () => {
  it('names kinds, ores and what a line of sight passes through', () => {
    expect(surveyKindOf('minecraft:log2')).toBe('log');
    expect(surveyKindOf('minecraft:flowing_water')).toBe('water');
    expect(surveyKindOf('minecraft:cobblestone')).toBe('stone');
    expect(surveyKindOf('minecraft:grass')).toBe('dirt'); // grass drops dirt when dug
    expect(surveyKindOf('minecraft:sandstone')).toBeNull();
    for (const ore of [
      'minecraft:iron_ore',
      'minecraft:lit_redstone_ore',
      'gregtech:gt.blockores',
      'bartworks:bw.blockores.01',
      'BiomesOPlenty:gemOre',
      'IC2:blockOreCopper',
    ]) {
      expect(namesAnOre(ore), ore).toBe(true);
    }
    for (const not of ['Forestry:core', 'TConstruct:ore.berries.one', 'minecraft:stone']) {
      expect(namesAnOre(not), not).toBe(false);
    }
    expect(sightOf('minecraft:air')).toBe(SIGHT.clear);
    expect(sightOf('minecraft:water')).toBe(SIGHT.clear);
    expect(sightOf('BiomesOPlenty:foliage')).toBe(SIGHT.clear);
    expect(sightOf('minecraft:leaves')).toBe(SIGHT.foliage);
    expect(sightOf('BiomesOPlenty:leaves1')).toBe(SIGHT.foliage);
    expect(sightOf('minecraft:sand')).toBe(SIGHT.blocked);
    expect(sightOf('gregtech:gt.blockmachines')).toBe(SIGHT.blocked);
  });

  it('a line of sight passes air and a little foliage, never a solid or unloaded block', () => {
    const cells = new Map<string, number>([
      ['3,0,0', SIGHT.blocked],
      ['0,0,3', SIGHT.foliage],
      ['0,0,4', SIGHT.foliage],
      ['0,0,5', SIGHT.foliage],
    ]);
    const sight = (x: number, y: number, z: number): number =>
      cells.get(`${x},${y},${z}`) ?? SIGHT.clear;
    const o = { x: 0.5, y: 0.5, z: 0.5 };
    expect(clearLine(o, { x: 2.5, y: 0.5, z: 0.5 }, sight)).toBe(true);
    expect(clearLine(o, { x: 5.5, y: 0.5, z: 0.5 }, sight)).toBe(false);
    expect(clearLine(o, { x: 0.5, y: 0.5, z: 4.5 }, sight)).toBe(true); // one leaf cell crossed
    expect(clearLine(o, { x: 0.5, y: 0.5, z: 6.5 }, sight)).toBe(false); // three
    expect(clearLine(o, { x: 0.5, y: 0.5, z: 6.5 }, sight, 3)).toBe(true);
    // Diagonal through a corner gap, and the end cell itself never blocks.
    expect(clearLine(o, { x: 3.5, y: 0.5, z: 0.5 }, sight)).toBe(true);
    expect(clearLine(o, { x: 9.5, y: 3.5, z: -2.5 }, () => SIGHT.blocked)).toBe(false);
  });

  it('counts only what a player could see: exposed, in view, near the surface, in range', () => {
    const blocks: Record<string, number> = {
      // Seen: sand on the ground, a log, ore in a bank, water's surface.
      '10,63,8': BLOCK.sand,
      '11,63,8': BLOCK.sand,
      '6,64,6': BLOCK.log,
      '6,65,6': BLOCK.log,
      '12,64,12': ORE,
      '4,63,12': BLOCK.water,
      '4,62,12': BLOCK.water,
      // Not seen: buried sand, clay under the water, gravel behind a wall, and ores in caves:
      // one below the surface band, one in it but with only rock between it and the eyes.
      '9,62,8': BLOCK.sand,
      '4,61,12': BLOCK.clay,
      '8,63,1': BLOCK.gravel,
      '14,30,14': ORE,
      '14,31,14': BLOCK.air,
      '13,45,13': ORE,
      '13,46,13': BLOCK.air,
    };
    for (let x = 5; x <= 11; x++) {
      for (let y = 64; y <= 67; y++) blocks[`${x},${y},3`] = BLOCK.stone; // the wall
    }
    const store = storeOf(ground(blocks), () => 230);
    const s = surveyChunk(worldOf(store), tables, 0, 0, EYE);
    expect(s).not.toBeNull();
    if (s === null) return;
    expect(s.counts.sand).toBe(2);
    expect(s.counts.log).toBe(2);
    expect(s.counts.ore).toBe(1);
    expect(s.counts.water).toBe(1); // only its surface
    expect(s.counts.clay).toBeUndefined();
    expect(s.counts.gravel).toBeUndefined();
    expect(s.counts.stone).toBeGreaterThan(0); // the wall's faces toward the player
    expect(s.examples.ore).toEqual([{ x: 12, y: 64, z: 12 }]);
    expect(s.examples.sand).toEqual([
      { x: 10, y: 63, z: 8 },
      { x: 11, y: 63, z: 8 },
    ]);
    expect(s.biome).toEqual({ id: 230, name: 'Hot Desert', share: 1 });
    // With x-ray, the cave ores would count: both are exposed to cave air.
    const xray = surveyChunk(worldOf(store), tables, 0, 0, { x: 13.5, y: 46.5, z: 13.5 });
    expect(xray?.counts.ore).toBe(1); // standing in the cave, the near one is seen
  });

  it('sees nothing beyond its range, and nothing of unloaded chunks', () => {
    const store = storeOf(ground({}), () => 2, 1);
    const w = worldOf(store);
    const far = { x: 8.5, y: EYE.y, z: 8.5 + 16 + SURVEY_RANGE + 1 };
    expect(surveyChunk(w, tables, 0, 0, far)).toBeNull();
    expect(surveyChunk(w, tables, 5, 5, EYE)).toBeNull();
  });

  it('names the most common biome, ignoring unset columns', () => {
    const b = new Uint8Array(256).fill(229);
    b.fill(43, 0, 100);
    b.fill(255, 100, 120);
    expect(dominantBiome(b)).toEqual({ id: 229, name: 'Hot Forest', share: 0.53 });
    expect(dominantBiome(new Uint8Array(256).fill(255))).toBeNull();
    expect(dominantBiome(null)).toBeNull();
    expect(biomeName(43)).toBe('Bamboo Forest');
    expect(biomeName(250)).toBe('biome #250');
  });

  it('decodes the biome array of single columns as well as bulks', () => {
    const c = neidColumn(2, -3, ground({}), true, true, (x, z) => (x === 32 && z === -48 ? 7 : 4));
    const decoded = decodeChunkColumnWithBiomes(c.header, true, deflateSync(c.data), {
      neid: true,
    });
    expect(decoded.biomes?.[0]).toBe(7); // column (32, -48): x & 15 = 0, z & 15 = 0
    expect(decoded.biomes?.[1]).toBe(4);
    expect(decoded.biomes).toHaveLength(256);
    const partial = neidColumn(2, -3, ground({}), true, false);
    expect(
      decodeChunkColumnWithBiomes(partial.header, false, deflateSync(partial.data), { neid: true })
        .biomes,
    ).toBeNull();
  });
});

describe('the survey tracker', () => {
  it('surveys on entering a chunk, every 30 s, or when asked; never in the dark', () => {
    const store = storeOf(ground({ '10,63,8': BLOCK.sand }), () => 230);
    const tracker = new SurveyTracker();
    const feet = { x: 8.5, y: 64, z: 8.5 };
    const t0 = new Date('2026-09-30T12:00:00Z');
    const first = tracker.update(worldOf(store), feet, t0);
    expect(first.length).toBeGreaterThanOrEqual(9);
    expect(first[0]).toMatchObject({ dimension: 'overworld', seenAt: t0.toISOString() });
    expect(
      tracker.update(worldOf(store), { ...feet, x: 9.5 }, new Date(t0.getTime() + 1000)),
    ).toEqual([]);
    expect(
      tracker.update(worldOf(store), feet, new Date(t0.getTime() + 1000), true).length,
    ).toBeGreaterThan(0);
    expect(
      tracker.update(worldOf(store), feet, new Date(t0.getTime() + 31_000)).length,
    ).toBeGreaterThan(0);
    expect(tracker.update(worldOf(store), { ...feet, x: 20.5 }, t0).length).toBeGreaterThan(0);
    // Evening and night: nothing is seen.
    const dark = new SurveyTracker();
    expect(dark.update(worldOf(store, 13_500), feet, t0, true)).toEqual([]);
    expect(dark.update(worldOf(store, 18_000), feet, t0, true)).toEqual([]);
    // Drained once, merged per chunk.
    const drained = tracker.drain();
    const keys = drained.map((c) => `${c.chunkX},${c.chunkZ}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(drained.find((c) => c.chunkX === 0 && c.chunkZ === 0)?.counts.sand).toBe(1);
    expect(tracker.drain()).toEqual([]);
    expect(describeSightings(drained)).toMatch(
      /^\d+ chunk\(s\) \(Hot Desert \d+\); dirt \d+, sand 1/,
    );
    expect(describeSightings([])).toMatch(/^nothing/);
  });

  it('keeps at most the newest sightings when nobody takes them', () => {
    const store = storeOf(ground({}), () => 230);
    const tracker = new SurveyTracker(12);
    const t0 = new Date('2026-09-30T12:00:00Z');
    tracker.update(worldOf(store), { x: 8.5, y: 64, z: 8.5 }, t0); // chunks -2..2 around (0, 0)
    tracker.update(worldOf(store), { x: 24.5, y: 64, z: 8.5 }, t0); // around (1, 0)
    const kept = tracker.drain();
    expect(kept).toHaveLength(12);
    // The chunks of the newer survey are kept, oldest dropped first.
    expect(kept.every((c) => c.chunkX >= -1)).toBe(true);
  });
});
