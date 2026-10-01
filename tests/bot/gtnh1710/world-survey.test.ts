import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { biomeName } from '../../../src/bot/gtnh1710/biomes.ts';
import {
  ChunkStore,
  decodeChunkBulk,
  decodeChunkColumnWithBiomes,
  type ColumnSections,
} from '../../../src/bot/gtnh1710/chunk-data.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import {
  buildSurveyTables,
  clearLine,
  describeSightings,
  dominantBiome,
  FAR_SIGHT_RANGE,
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
import { surveyTerrain } from './survey-terrain.ts';

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

/**
 * The grass world held out to `radius` chunks around chunk (0, 0) (as far as far sight looks),
 * written straight into a store: encoding hundreds of chunks as packets would take seconds.
 * `extra` decides a block first (undefined: grass at y=63 over stone).
 */
function farStore(
  extra: (x: number, y: number, z: number) => number | undefined,
  radius = Math.ceil(FAR_SIGHT_RANGE / 16),
): ChunkStore {
  const store = new ChunkStore();
  for (let cx = -radius; cx <= radius; cx++) {
    for (let cz = -radius; cz <= radius; cz++) {
      const sections: ColumnSections = new Array<Uint16Array | null>(16).fill(null);
      for (let i = 0; i < 256; i++) {
        const x = cx * 16 + (i & 15);
        const z = cz * 16 + (i >> 4);
        for (let y = 0; y < 96; y++) {
          const id =
            extra(x, y, z) ??
            (y === 0 ? BLOCK.bedrock : y < GROUND ? BLOCK.stone : y === GROUND ? BLOCK.grass : 0);
          if (id === 0) continue;
          const s = (sections[y >> 4] ??= new Uint16Array(4096));
          s[((y & 15) << 8) | i] = id;
        }
      }
      store.setColumn(cx, cz, sections, 0, new Uint8Array(256).fill(211));
    }
  }
  return store;
}

/** A pond (water at the ground's level) 62-71 blocks east of EYE, in chunk (4, 0). */
const pond = (x: number, y: number, z: number): number | undefined =>
  x >= 70 && x <= 79 && z >= 0 && z <= 15 && y === GROUND ? BLOCK.water : undefined;

describe('what a survey counts', () => {
  it('names kinds, ores and what a line of sight passes through', () => {
    expect(surveyKindOf('minecraft:log2')).toBe('log');
    expect(surveyKindOf('minecraft:flowing_water')).toBe('water');
    expect(surveyKindOf('minecraft:cobblestone')).toBe('stone');
    expect(surveyKindOf('minecraft:grass')).toBe('dirt'); // grass drops dirt when dug
    expect(surveyKindOf('minecraft:sandstone')).toBeNull();
    // HarvestCraft's gardens that give food, for food trips; never the cotton-only one.
    expect(surveyKindOf('harvestcraft:berrygarden')).toBe('garden');
    expect(surveyKindOf('harvestcraft:tropicalgarden')).toBe('garden');
    expect(surveyKindOf('harvestcraft:textilegarden')).toBeNull();
    expect(sightOf('harvestcraft:berrygarden')).toBe(SIGHT.clear); // a plant: seen through
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
    expect(s.near).toBe(true);
    // Within SURVEY_RANGE far sight changes nothing: the near rules alone decide.
    expect(surveyChunk(worldOf(store), tables, 0, 0, EYE, false)).toEqual(s);
    // With x-ray, the cave ores would count: both are exposed to cave air.
    const xray = surveyChunk(worldOf(store), tables, 0, 0, { x: 13.5, y: 46.5, z: 13.5 });
    expect(xray?.counts.ore).toBe(1); // standing in the cave, the near one is seen
  });

  it('sees a trunk through the leaves around it, and only a little way into a canopy', () => {
    // Seen live: in bushy trees only the canopy's logs were ever seen, too high to dig.
    const blocks: Record<string, number> = { '6,64,6': BLOCK.log, '6,65,6': BLOCK.log };
    for (const [x, z] of [
      [5, 6],
      [7, 6],
      [6, 5],
      [6, 7],
    ] as const) {
      blocks[`${x},64,${z}`] = BLOCK.leaves;
      blocks[`${x},65,${z}`] = BLOCK.leaves;
    }
    blocks['6,66,6'] = BLOCK.leaves;
    const s = surveyChunk(worldOf(storeOf(ground(blocks), () => 230)), tables, 0, 0, EYE);
    expect(s?.counts.log).toBe(2);
  });

  it('sees nothing beyond its range, and nothing of unloaded chunks', () => {
    const store = storeOf(ground({}), () => 2, 1);
    const w = worldOf(store);
    const far = { x: 8.5, y: EYE.y, z: 8.5 + 16 + SURVEY_RANGE + 1 };
    expect(surveyChunk(w, tables, 0, 0, far, false)).toBeNull();
    // Far sight finds nothing in plain grass to make out: no sighting either.
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

describe('far sight', () => {
  it('sees water far across open ground, where the near look does not reach', () => {
    const w = worldOf(farStore(pond));
    const s = surveyChunk(w, tables, 4, 0, EYE);
    expect(s).toMatchObject({ chunkX: 4, chunkZ: 0, near: false, biome: { name: 'River Oasis' } });
    expect(s?.counts).toEqual({ water: 160 }); // every column of it: its top faces are in view
    expect(s?.examples.water).toEqual([
      { x: 70, y: GROUND, z: 0 },
      { x: 71, y: GROUND, z: 0 },
      { x: 72, y: GROUND, z: 0 },
    ]);
    expect(surveyChunk(w, tables, 4, 0, EYE, false)).toBeNull();
  });

  it('does not see it behind a hill, through a wood, under a canopy, or past unloaded chunks', () => {
    const behind = (wall: number) => (x: number, y: number, z: number) =>
      x >= 40 && x <= 44 && y > GROUND && y <= GROUND + 7 ? wall : pond(x, y, z);
    expect(surveyChunk(worldOf(farStore(behind(BLOCK.stone))), tables, 4, 0, EYE)).toBeNull();
    // Five leaves deep: more than a line of sight crosses (MAX_FOLIAGE_CELLS).
    expect(surveyChunk(worldOf(farStore(behind(BLOCK.leaves))), tables, 4, 0, EYE)).toBeNull();
    // A canopy over it: its top blocks are leaves, nothing to make out from afar.
    const shaded = (x: number, y: number, z: number) =>
      x >= 69 && x <= 80 && y === GROUND + 4 ? BLOCK.leaves : pond(x, y, z);
    expect(surveyChunk(worldOf(farStore(shaded)), tables, 4, 0, EYE)).toBeNull();
    // A chunk not (yet) loaded on the way blocks every line through it.
    const store = farStore(pond);
    store.unload(2, 0);
    store.unload(2, 1);
    store.unload(2, -1);
    expect(surveyChunk(worldOf(store), tables, 4, 0, EYE)).toBeNull();
  });

  it('sees the face a player sees: tops from above, open sides turned toward it from below', () => {
    // A gravel ledge two blocks wide, its top above the eyes: from the ground only its near
    // side shows; from up high both tops do.
    const ledge = (x: number, y: number) =>
      x >= 70 && x <= 71 && y > GROUND && y <= GROUND + 3
        ? y === GROUND + 3
          ? BLOCK.gravel
          : BLOCK.stone
        : undefined;
    const w = worldOf(farStore(ledge));
    const low = surveyChunk(w, tables, 4, 0, EYE);
    expect(low?.counts.gravel).toBe(16);
    expect(low?.examples.gravel?.every((p) => p.x === 70)).toBe(true);
    const high = surveyChunk(w, tables, 4, 0, { ...EYE, y: GROUND + 12 });
    expect(high?.counts.gravel).toBe(32);
    // Water shows only by its top: a pond above the eyes is out of view.
    const tarn = (x: number, y: number) =>
      x >= 70 && x <= 79 && y > GROUND && y <= GROUND + 3
        ? y === GROUND + 3 && x > 70 && x < 79
          ? BLOCK.water
          : BLOCK.stone
        : undefined;
    expect(surveyChunk(worldOf(farStore(tarn)), tables, 4, 0, EYE)?.counts.water).toBeUndefined();
  });

  it('looks at sand and stone on every second column each way, and at every gravel top', () => {
    const tops = (x: number, y: number, z: number) =>
      y === GROUND && x >= 64 && x < 80 ? (z < 16 ? BLOCK.sand : BLOCK.gravel) : undefined;
    const w = worldOf(farStore(tops));
    const sand = surveyChunk(w, tables, 4, 0, EYE);
    expect(sand?.counts.sand).toBe(64); // a lower bound: a quarter of the 256 in view
    expect(sand?.examples.sand?.every((p) => p.x % 2 === 0 && p.z % 2 === 0)).toBe(true);
    expect(surveyChunk(w, tables, 4, 1, EYE)?.counts.gravel).toBe(256);
  });
});

describe('the survey tracker', () => {
  it('looks far on entering a chunk and when asked; again in the same chunk, near only', () => {
    const w = worldOf(farStore(pond));
    const tracker = new SurveyTracker();
    const feet = { x: 8.5, y: GROUND + 1, z: 8.5 };
    const t0 = new Date('2026-09-30T12:00:00Z');
    const first = tracker.update(w, feet, t0);
    // The near look covers every chunk within SURVEY_RANGE: the 5 x 5 square, and (3, 0) and
    // (0, 3), 39.5 blocks away. Far sight adds the pond's chunk; plain grass beyond the near
    // look is not recorded.
    const near = first.filter((c) => c.near);
    expect(near).toHaveLength(27);
    expect(near.some((c) => c.chunkX === 3 && c.chunkZ === 0)).toBe(true);
    expect(first.filter((c) => !c.near)).toEqual([
      expect.objectContaining({ chunkX: 4, chunkZ: 0, counts: { water: 160 } }),
    ]);
    const again = tracker.update(w, feet, new Date(t0.getTime() + 31_000));
    expect(again).toHaveLength(27);
    expect(again.every((c) => c.near)).toBe(true);
    const asked = tracker.update(w, feet, new Date(t0.getTime() + 32_000), true);
    expect(asked.some((c) => !c.near)).toBe(true);
    const drained = tracker.drain();
    expect(drained.find((c) => c.chunkX === 4)?.near).toBe(false);
    expect(describeSightings(drained)).toMatch(
      /^28 chunk\(s\), 1 only from afar \(River Oasis 28\); dirt \d+, water 160$/,
    );
  });

  it('surveys realistic terrain, far sight and all, in well under 20 ms (loose bound)', () => {
    const { store, column } = surveyTerrain();
    const w = worldOf(store);
    const c = column(8, 8);
    const feet = { x: 8.5, y: c.ground + 1, z: 8.5 };
    const t0 = new Date('2026-09-30T12:00:00Z');
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const tracker = new SurveyTracker();
      const start = performance.now();
      tracker.update(w, feet, t0, true);
      times.push(performance.now() - start);
    }
    // About 9 ms at this spot (scripts/survey-bench.ts). The bound catches a return to a map
    // lookup per cell (the near look alone took 50-80 ms so), not a busy test machine.
    expect(times.sort((a, b) => a - b)[3]).toBeLessThan(60);
  });

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
