/**
 * A night shelter, the way a first-night player makes one: a 1 x 1 box around where the
 * player stands, four walls at feet level and four at head level, and a roof above the
 * head. Pure: what the box needs, given what is solid around the player and what it carries.
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
  role: 'feet wall' | 'head wall' | 'roof';
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

/** The nine cells of the box around feet block (fx, fy, fz), in building order. */
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
  const open = cells.filter(
    (c) => world.solidAt(c.position.x, c.position.y, c.position.z) !== true,
  );
  if (cells.some((c) => world.solidAt(c.position.x, c.position.y, c.position.z) === undefined)) {
    return {
      sheltered: false,
      todo: [],
      needs: {},
      problem: 'the blocks around the player are not loaded',
    };
  }
  if (open.length === 0) return { sheltered: true, todo: [], needs: {}, problem: null };

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
    const choices =
      cell.role === 'roof'
        ? SHELTER_ROOF_ITEMS
        : SHELTER_WALL_ITEMS.filter((i) => below || !FALLING.has(i));
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
