import { BLOCK_CODE, buildBlockCodeTable } from '../../../../src/bot/gtnh1710/block-hazards.ts';
import type { Fence, Vec3, WalkWorld } from '../../../../src/bot/gtnh1710/walking.ts';
import { DIG_TEST_BLOCK_REGISTRY } from './chunk-fixtures.ts';
import { surveyTerrain, type TerrainColumn } from './survey-terrain.ts';

/**
 * Synthetic worlds for the pathfinder's tests (tests/bot/gtnh1710/pathing/): ground from a
 * height map (grass on top, dirt and stone below, air above), single blocks or boxes set on
 * top of it, columns left unloaded. Block ids are vanilla 1.7.10's, named as the real
 * registry names them.
 */

export const B = {
  air: 0,
  stone: 1,
  grass: 2,
  dirt: 3,
  cobblestone: 4,
  planks: 5,
  flowingWater: 8,
  water: 9,
  lava: 11,
  sand: 12,
  gravel: 13,
  log: 17,
  leaves: 18,
  glass: 20,
  tallgrass: 31,
  deadbush: 32,
  yellowFlower: 37,
  fire: 51,
  chest: 54,
  woodenDoor: 64,
  ladder: 65,
  ironDoor: 71,
  cactus: 81,
  fence: 85,
  vine: 106,
  fenceGate: 107,
  foliage: 1102,
} as const;

const NAMES = new Map<number, string>([
  [B.air, 'minecraft:air'],
  [B.stone, 'minecraft:stone'],
  [B.grass, 'minecraft:grass'],
  [B.dirt, 'minecraft:dirt'],
  [B.cobblestone, 'minecraft:cobblestone'],
  [B.planks, 'minecraft:planks'],
  [B.flowingWater, 'minecraft:flowing_water'],
  [B.water, 'minecraft:water'],
  [B.lava, 'minecraft:lava'],
  [B.sand, 'minecraft:sand'],
  [B.gravel, 'minecraft:gravel'],
  [B.log, 'minecraft:log'],
  [B.leaves, 'minecraft:leaves'],
  [B.glass, 'minecraft:glass'],
  [B.tallgrass, 'minecraft:tallgrass'],
  [B.deadbush, 'minecraft:deadbush'],
  [B.yellowFlower, 'minecraft:yellow_flower'],
  [B.fire, 'minecraft:fire'],
  [B.chest, 'minecraft:chest'],
  [B.woodenDoor, 'minecraft:wooden_door'],
  [B.ladder, 'minecraft:ladder'],
  [B.ironDoor, 'minecraft:iron_door'],
  [B.cactus, 'minecraft:cactus'],
  [B.fence, 'minecraft:fence'],
  [B.vine, 'minecraft:vine'],
  [B.fenceGate, 'minecraft:fence_gate'],
  [B.foliage, 'BiomesOPlenty:foliage'],
]);

const HAZARDS = new Map<number, number>([
  [B.lava, BLOCK_CODE.lava],
  [B.fire, BLOCK_CODE.fire],
  [B.cactus, BLOCK_CODE.damaging_block],
]);

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

export class TestWorld implements WalkWorld {
  readonly #ground: (x: number, z: number) => number;
  readonly #blocks = new Map<string, number>();
  readonly #metas = new Map<string, number>();
  readonly #unloaded: Array<(x: number, z: number) => boolean> = [];
  /** blockAt calls, for the performance tests. */
  reads = 0;

  /** Ground whose top block (grass) is at `ground(x, z)`; feet stand one higher. */
  constructor(ground: (x: number, z: number) => number = () => 63) {
    this.#ground = ground;
  }

  set(x: number, y: number, z: number, id: number, meta = 0): this {
    this.#blocks.set(key(x, y, z), id);
    if (meta !== 0) this.#metas.set(key(x, y, z), meta);
    else this.#metas.delete(key(x, y, z));
    return this;
  }

  /** Every block of the box (inclusive) set to `id`. */
  fill(a: Vec3, b: Vec3, id: number, meta = 0): this {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) {
      for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
        for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) this.set(x, y, z, id, meta);
      }
    }
    return this;
  }

  /** Columns where `where` holds read as not loaded. */
  unload(where: (x: number, z: number) => boolean): this {
    this.#unloaded.push(where);
    return this;
  }

  ground(x: number, z: number): number {
    return this.#ground(x, z);
  }

  blockAt(x: number, y: number, z: number): number | undefined {
    this.reads++;
    if (this.#unloaded.some((u) => u(x, z))) return undefined;
    const set = this.#blocks.get(key(x, y, z));
    if (set !== undefined) return set;
    const top = this.#ground(x, z);
    if (y > top) return B.air;
    if (y === top) return B.grass;
    return y >= top - 2 ? B.dirt : B.stone;
  }

  metaAt(x: number, y: number, z: number): number | undefined {
    if (this.#unloaded.some((u) => u(x, z))) return undefined;
    return this.#metas.get(key(x, y, z)) ?? 0;
  }

  blockName(id: number): string | undefined {
    return NAMES.get(id);
  }

  hazardCode(id: number): number {
    return HAZARDS.get(id) ?? (NAMES.has(id) ? BLOCK_CODE.safe : BLOCK_CODE.unknown);
  }
}

/**
 * The bench terrain of survey-terrain.ts (17 x 17 chunks: hills, a forest, a desert, a river,
 * a lake) as the client's WalkWorld would read it: block ids through the chunk store, names
 * from the test registry, hazard codes as the client builds them.
 */
export function benchWalkWorld(): {
  world: WalkWorld;
  column: (x: number, z: number) => TerrainColumn;
} {
  const { store, column } = surveyTerrain();
  const names = new Map(DIG_TEST_BLOCK_REGISTRY);
  const codes = buildBlockCodeTable({
    blocks: names,
    items: new Map(),
    blockSubstitutions: [],
    itemSubstitutions: [],
  });
  return {
    world: {
      blockAt: (x, y, z) => store.blockAt(x, y, z),
      metaAt: (x, y, z) => store.metaAt(x, y, z),
      blockName: (id) => (id === 0 ? 'minecraft:air' : names.get(id)),
      hazardCode: (id) => codes[id] ?? BLOCK_CODE.unknown,
    },
    column,
  };
}

/**
 * A 10-block cliff (ground 63 for x <= 0, feet 64) over a pool one deep (floor 53, water 54) at
 * x 1..3, and a bank one higher (ground 54, feet 55) from x = 4.
 */
export function poolWorld(): TestWorld {
  return new TestWorld((x) => (x <= 0 ? 63 : x <= 3 ? 53 : 54)).fill(
    { x: 1, y: 54, z: -3 },
    { x: 3, y: 54, z: 3 },
    B.water,
  );
}

/** A search area: x and z from -r to r around (cx, cz), feet levels y0..y1. */
export function area(r: number, y0: number, y1: number, cx = 0, cz = 0): Fence {
  return { min: { x: cx - r, y: y0, z: cz - r }, max: { x: cx + r, y: y1, z: cz + r } };
}

export const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
/** The centre of feet block (x, y, z). */
export const centre = (x: number, y: number, z: number): Vec3 => ({ x: x + 0.5, y, z: z + 0.5 });
