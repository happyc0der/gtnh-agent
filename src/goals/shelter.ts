import type { PlaceableItem } from '../domain/blocks.ts';
import type { ShelterStep } from '../domain/night-shelter.ts';

/**
 * The night shelter, as play sees it, and the raised box, its second choice.
 *
 * The first choice is the night pit (src/domain/night-shelter.ts; planned with the live
 * client's own rules in src/bot/gtnh1710/night-pit.ts): three digs straight down and a roof
 * in the ground layer, against the natural ground beside it. Where the ground does not allow
 * a pit, the raised box: a 1 x 1 box around where the player stands, four walls at feet
 * level, four at head level, and a roof above the head. Pure: what the box needs, given what
 * is solid around the player and what it carries.
 *
 * A block is placed by clicking a face of a block next to its cell that looks at the eyes.
 * The box's roof cell touches no wall (the head walls are diagonally below it), and from
 * inside the box the walls' top faces are above the eyes (feet + 1.62 < feet + 2), so no
 * block can be put beside the roof cell either (seen live on 2026-10-01: a roof support on a
 * wall was never placeable). The box therefore works only where something solid already
 * touches the roof cell from the side or above (a cliff, a tree trunk): there the roof is
 * placed against it. On open ground the box cannot be roofed, and play digs the pit instead.
 *
 * Walls are blocks a bare hand digs again (sand, dirt, logs...), so the agent can dig its way
 * out in the morning. The roof is never sand or gravel: they would fall onto the player (and
 * placing refuses them there).
 */

export interface SolidLookup {
  /** True for a block a mob cannot pass, false for open, undefined when not loaded. */
  solidAt(x: number, y: number, z: number): boolean | undefined;
}

export interface ShelterCell {
  position: { x: number; y: number; z: number };
  role: 'feet wall' | 'head wall' | 'roof';
}

/** Wall blocks a bare hand digs again, in order of preference (sand first: plentiful). */
export const SHELTER_WALL_ITEMS: readonly PlaceableItem[] = [
  'minecraft:sand',
  'minecraft:dirt',
  'minecraft:log',
  'minecraft:log2',
  'minecraft:gravel',
];

/** Roof blocks: anything placeable that does not fall. */
export const SHELTER_ROOF_ITEMS: readonly PlaceableItem[] = [
  'minecraft:cobblestone',
  'minecraft:dirt',
  'minecraft:sandstone',
  'minecraft:planks',
  'minecraft:log',
  'minecraft:log2',
];

const FALLING: ReadonlySet<string> = new Set(['minecraft:sand', 'minecraft:gravel']);

/**
 * What play needs to know about the night shelter: whether the player is enclosed, what code
 * still does to finish it (its steps, which run as known safe steps: each an ordinary action
 * the executor validates), and in the morning whether the player is walled in and the way
 * out.
 */
export interface ShelterStatus {
  /** The kind of shelter: a pit dug into the ground (first choice), or the raised box. */
  kind: 'pit' | 'box';
  /** Walls all around and a roof: mobs cannot reach the player. */
  sheltered: boolean;
  /** What code still does to finish it, in order. */
  steps: ShelterStep[];
  /** Blocks the remaining steps place, by item. */
  needs: Record<string, number>;
  /** Why no shelter can be made here (or the area is unknown), else null. */
  problem: string | null;
  /**
   * All eight walls are solid (roofed or not), or, in the morning, the player is still down in
   * its night pit's column: it cannot walk out without digging.
   */
  walled: boolean;
  /** When walled: the way out, in order (digs, then the walk out). Empty otherwise. */
  exit: ShelterStep[];
  /**
   * In the morning: the hostiles near that stop it from leaving (the safety rules' words),
   * else null or absent.
   */
  hostiles?: string | null;
  /** In the morning: the player is sealed in (GameState player.sealed), hurt lately or not. */
  sealed?: boolean;
}

/** Why the shelter shelters no more (ShelterStatus problem): hurt inside it a moment ago. */
export const HURT_IN_SHELTER = 'something hurt the player inside its shelter a moment ago';
/** The same, when that hurt was starving (food 0). */
export const STARVING_IN_SHELTER = 'the player is starving inside its shelter';

/**
 * The cells of the box around feet block (fx, fy, fz), in building order: four feet walls,
 * four head walls, then the roof.
 */
export function shelterCells(feet: { x: number; y: number; z: number }): ShelterCell[] {
  const fx = Math.floor(feet.x);
  const fy = Math.floor(feet.y + 1e-6);
  const fz = Math.floor(feet.z);
  const sides: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  return [
    ...sides.map(([dx, dz]) => ({
      position: { x: fx + dx, y: fy, z: fz + dz },
      role: 'feet wall' as const,
    })),
    ...sides.map(([dx, dz]) => ({
      position: { x: fx + dx, y: fy + 1, z: fz + dz },
      role: 'head wall' as const,
    })),
    { position: { x: fx, y: fy + 2, z: fz }, role: 'roof' as const },
  ];
}

/** The four cells beside the roof and the one above it: what the roof is placed against. */
function aroundRoof(roof: { x: number; y: number; z: number }): Array<[number, number, number]> {
  return [
    [roof.x + 1, roof.y, roof.z],
    [roof.x - 1, roof.y, roof.z],
    [roof.x, roof.y, roof.z + 1],
    [roof.x, roof.y, roof.z - 1],
    [roof.x, roof.y + 1, roof.z],
  ];
}

const at = (p: { x: number; y: number; z: number }): string => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * What the box around `feet` still needs (kind 'box'). Walls take the first wall item carried
 * in enough quantity (mixing kinds when one is short); the roof takes a non-falling block,
 * placed against something already solid beside or above its cell. A falling wall block
 * needs a solid cell below it (the ground, or the wall below it). The way out is not planned
 * here: the live adapter plans it with the client's own rules (night-pit.ts).
 */
export function shelterStatus(
  world: SolidLookup,
  feet: { x: number; y: number; z: number },
  inventory: Readonly<Record<string, number>>,
): ShelterStatus {
  const cells = shelterCells(feet);
  const solid = (c: ShelterCell): boolean | undefined =>
    world.solidAt(c.position.x, c.position.y, c.position.z);
  const base = { kind: 'box' as const, exit: [] as ShelterStep[] };
  if (cells.some((c) => solid(c) === undefined)) {
    return {
      ...base,
      sheltered: false,
      steps: [],
      needs: {},
      problem: 'the blocks around the player are not loaded',
      walled: false,
    };
  }
  const walled = cells
    .filter((c) => c.role === 'feet wall' || c.role === 'head wall')
    .every((c) => solid(c) === true);
  if (cells.every((c) => solid(c) === true)) {
    return { ...base, sheltered: true, steps: [], needs: {}, problem: null, walled };
  }
  const roof = cells.find((c) => c.role === 'roof') as ShelterCell;
  const roofed =
    solid(roof) === true ||
    aroundRoof(roof.position).some(([x, y, z]) => world.solidAt(x, y, z) === true);
  if (!roofed) {
    return {
      ...base,
      sheltered: false,
      steps: [],
      needs: {},
      problem:
        `nothing beside or above the box's roof cell ${at(roof.position)} to place the roof ` +
        'against (open ground): a box cannot be roofed from inside it',
      walled,
    };
  }

  const left = new Map(Object.entries(inventory));
  const take = (choices: readonly PlaceableItem[]): PlaceableItem | null => {
    for (const item of choices) {
      const n = left.get(item) ?? 0;
      if (n > 0) {
        left.set(item, n - 1);
        return item;
      }
    }
    return null;
  };
  const steps: ShelterStep[] = [];
  const needs: Record<string, number> = {};
  // Cells that will be solid once the earlier ones are built (falling blocks need support).
  const willBeSolid = new Set<string>();
  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
  for (const cell of cells.filter((c) => solid(c) !== true)) {
    const p = cell.position;
    const below =
      world.solidAt(p.x, p.y - 1, p.z) === true || willBeSolid.has(key({ ...p, y: p.y - 1 }));
    // A wall block is placed against a solid face beside, below or above its cell (the
    // player's own cell is open): with none, the box cannot be built (seen live 2026-10-04: the
    // player on its own pillar in a tree, three nights' sessions refused NOT_PLACEABLE).
    const faces: Array<[number, number, number]> = [
      [p.x + 1, p.y, p.z],
      [p.x - 1, p.y, p.z],
      [p.x, p.y, p.z + 1],
      [p.x, p.y, p.z - 1],
      [p.x, p.y - 1, p.z],
      [p.x, p.y + 1, p.z],
    ];
    const against = faces.some(
      ([x, y, z]) => world.solidAt(x, y, z) === true || willBeSolid.has(key({ x, y, z })),
    );
    if (cell.role !== 'roof' && !against) {
      return {
        ...base,
        sheltered: false,
        steps: [],
        needs: {},
        problem: `nothing solid beside, below or above the box's wall cell ${at(p)} to place it against`,
        walled,
      };
    }
    const choices =
      cell.role === 'roof'
        ? SHELTER_ROOF_ITEMS
        : SHELTER_WALL_ITEMS.filter((i) => below || !FALLING.has(i));
    const item = take(choices);
    if (item === null) {
      return {
        ...base,
        sheltered: false,
        steps,
        needs,
        problem:
          cell.role === 'roof'
            ? 'no block for the roof (cobblestone, dirt, sandstone, planks or logs)'
            : 'not enough wall blocks (sand, dirt, logs or gravel)',
        walled,
      };
    }
    steps.push({
      spec: { type: 'PLACE_BLOCK', args: { position: { ...p }, item } },
      text: `place ${item} at ${at(p)} (${cell.role})`,
    });
    needs[item] = (needs[item] ?? 0) + 1;
    willBeSolid.add(key(p));
  }
  return { ...base, sheltered: false, steps, needs, problem: null, walled };
}

/** The shelter's remaining steps as route lines for the planner (and the journal). */
export function describeShelter(status: ShelterStatus): string[] {
  return status.steps.map((s, i) => `${i + 1}. ${s.text}`);
}

/** The way out of a walled shelter, as route lines (empty when not walled). */
export function describeShelterExit(status: ShelterStatus): string[] {
  return status.exit.map((s, i) => `${i + 1}. ${s.text}`);
}
