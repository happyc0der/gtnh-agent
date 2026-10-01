/**
 * A night shelter, the way a first-night player makes one: a 1 x 1 box around where the
 * player stands, four walls at feet level and four at head level, and a roof above the
 * head. Pure: what the box needs, given what is solid around the player and what it carries.
 *
 * A block is placed by clicking a face of a block next to its cell, and the roof cell
 * touches no wall (the head walls are diagonally below it). So, as a player does, a support
 * block goes on top of one head wall first, and the roof is placed against its side (seen
 * live on 2026-10-01: without it the roof cell was never placeable).
 *
 * Walls are blocks a bare hand can dig again (sand, dirt, logs...), so the agent can dig its
 * way out in the morning (head level first, so nothing falls). The roof is never sand or
 * gravel: they would fall onto the player (and placing refuses them there).
 */

export interface SolidLookup {
  /** True for a block a mob cannot pass, false for open, undefined when not loaded. */
  solidAt(x: number, y: number, z: number): boolean | undefined;
}

export interface ShelterCell {
  position: { x: number; y: number; z: number };
  role: 'feet wall' | 'head wall' | 'roof support' | 'roof';
}

/** Wall blocks a bare hand digs again, in order of preference (sand first: plentiful). */
export const SHELTER_WALL_ITEMS = [
  'minecraft:sand',
  'minecraft:dirt',
  'minecraft:log',
  'minecraft:log2',
  'minecraft:gravel',
] as const;

/** Roof blocks: anything placeable that does not fall. */
export const SHELTER_ROOF_ITEMS = [
  'minecraft:cobblestone',
  'minecraft:dirt',
  'minecraft:sandstone',
  'minecraft:planks',
  'minecraft:log',
  'minecraft:log2',
] as const;

const FALLING: ReadonlySet<string> = new Set(['minecraft:sand', 'minecraft:gravel']);

/**
 * The cells of the box around feet block (fx, fy, fz), in building order: four feet walls,
 * four head walls, the roof support (on top of the east head wall), then the roof.
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
    { position: { x: fx + 1, y: fy + 2, z: fz }, role: 'roof support' as const },
    { position: { x: fx, y: fy + 2, z: fz }, role: 'roof' as const },
  ];
}

/** The four cells beside the roof: one of them must be solid for the roof to be placed. */
function besideRoof(roof: { x: number; y: number; z: number }): Array<[number, number, number]> {
  return [
    [roof.x + 1, roof.y, roof.z],
    [roof.x - 1, roof.y, roof.z],
    [roof.x, roof.y, roof.z + 1],
    [roof.x, roof.y, roof.z - 1],
  ];
}

export interface ShelterStatus {
  /** Every cell of the box is solid: mobs cannot reach the player. */
  sheltered: boolean;
  /** Cells still open, in building order, each with the block to put there. */
  todo: Array<ShelterCell & { item: string }>;
  /** Blocks the remaining cells need, by item. */
  needs: Record<string, number>;
  /** Why the box cannot be built from what is carried (or the area is unknown), else null. */
  problem: string | null;
}

/**
 * What the box around `feet` still needs. Walls take the first wall item carried in enough
 * quantity (mixing kinds when one is short); the roof takes a non-falling block. A falling
 * wall block needs a solid cell below it (the ground, or the wall below it).
 */
export function shelterStatus(
  world: SolidLookup,
  feet: { x: number; y: number; z: number },
  inventory: Readonly<Record<string, number>>,
): ShelterStatus {
  const cells = shelterCells(feet);
  const solid = (c: ShelterCell): boolean | undefined =>
    world.solidAt(c.position.x, c.position.y, c.position.z);
  if (cells.some((c) => solid(c) === undefined)) {
    return {
      sheltered: false,
      todo: [],
      needs: {},
      problem: 'the blocks around the player are not loaded',
    };
  }
  // The box: walls and roof. The support only matters while the roof is still open and
  // nothing beside the roof cell is solid already.
  const box = cells.filter((c) => c.role !== 'roof support');
  if (box.every((c) => solid(c) === true)) {
    return { sheltered: true, todo: [], needs: {}, problem: null };
  }
  const roof = cells.find((c) => c.role === 'roof');
  const supported =
    roof === undefined ||
    solid(roof) === true ||
    besideRoof(roof.position).some(([x, y, z]) => world.solidAt(x, y, z) === true);
  const open = cells.filter((c) => solid(c) !== true && (c.role !== 'roof support' || !supported));

  const left = new Map(Object.entries(inventory));
  const take = (choices: readonly string[]): string | null => {
    for (const item of choices) {
      const n = left.get(item) ?? 0;
      if (n > 0) {
        left.set(item, n - 1);
        return item;
      }
    }
    return null;
  };
  const todo: ShelterStatus['todo'] = [];
  const needs: Record<string, number> = {};
  // Cells that will be solid once the earlier ones are built (falling blocks need support).
  const willBeSolid = new Set<string>();
  const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
  for (const cell of open) {
    const p = cell.position;
    const below =
      world.solidAt(p.x, p.y - 1, p.z) === true || willBeSolid.has(key({ ...p, y: p.y - 1 }));
    const walls = SHELTER_WALL_ITEMS.filter((i) => below || !FALLING.has(i));
    // The support sits outside the box: any wall block that stays put, or any roof block.
    const choices =
      cell.role === 'roof'
        ? SHELTER_ROOF_ITEMS
        : cell.role === 'roof support'
          ? [...walls, ...SHELTER_ROOF_ITEMS.filter((i) => !walls.some((w) => w === i))]
          : walls;
    const item = take(choices);
    if (item === null) {
      return {
        sheltered: false,
        todo,
        needs,
        problem:
          cell.role === 'roof'
            ? 'no block for the roof (cobblestone, dirt, sandstone, planks or logs)'
            : 'not enough wall blocks (sand, dirt, logs or gravel)',
      };
    }
    todo.push({ ...cell, item });
    needs[item] = (needs[item] ?? 0) + 1;
    willBeSolid.add(key(p));
  }
  return { sheltered: false, todo, needs, problem: null };
}

/** The shelter as route steps for the planner. */
export function describeShelter(status: ShelterStatus): string[] {
  return status.todo.map(
    (c, i) =>
      `${i + 1}. place ${c.item} at (${c.position.x}, ${c.position.y}, ${c.position.z}) (${c.role})`,
  );
}
