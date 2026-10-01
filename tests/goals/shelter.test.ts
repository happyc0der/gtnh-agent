import { describe, expect, it } from 'vitest';
import {
  describeShelter,
  shelterCells,
  shelterStatus,
  type SolidLookup,
} from '../../src/goals/shelter.ts';

/** Flat ground: solid at y <= 63, open above, plus extra solid cells. */
function ground(extra: string[] = []): SolidLookup {
  const solid = new Set(extra);
  return { solidAt: (x, y, z) => y <= 63 || solid.has(`${x},${y},${z}`) };
}
const FEET = { x: 0.5, y: 64, z: 0.5 };

describe('the night shelter', () => {
  it('is a 1 x 1 box: four walls at feet level, four at head level, a roof support, then the roof', () => {
    const cells = shelterCells(FEET);
    expect(cells.map((c) => c.role)).toEqual([
      ...Array<string>(4).fill('feet wall'),
      ...Array<string>(4).fill('head wall'),
      'roof support',
      'roof',
    ]);
    // The roof touches no wall, so it is placed against the support on top of a head wall.
    expect(cells.at(-2)?.position).toEqual({ x: 1, y: 66, z: 0 });
    expect(cells.at(-1)?.position).toEqual({ x: 0, y: 66, z: 0 });
  });

  it('needs no support when a block beside the roof is solid already', () => {
    const walls = shelterCells(FEET)
      .filter((c) => c.role === 'feet wall' || c.role === 'head wall')
      .map((c) => `${c.position.x},${c.position.y},${c.position.z}`);
    const open = shelterStatus(ground(walls), FEET, { 'minecraft:cobblestone': 2 });
    expect(open.todo.map((c) => c.role)).toEqual(['roof support', 'roof']);
    const cliff = shelterStatus(ground([...walls, '-1,66,0']), FEET, {
      'minecraft:cobblestone': 1,
    });
    expect(cliff.todo.map((c) => c.role)).toEqual(['roof']);
  });

  it('builds walls from sand (it can dig out again) and the roof from a block that does not fall', () => {
    const s = shelterStatus(ground(), FEET, { 'minecraft:sand': 55, 'minecraft:cobblestone': 10 });
    expect(s).toMatchObject({ sheltered: false, problem: null });
    expect(s.needs).toEqual({ 'minecraft:sand': 9, 'minecraft:cobblestone': 1 });
    expect(s.todo.at(-1)).toMatchObject({ role: 'roof', item: 'minecraft:cobblestone' });
    expect(describeShelter(s)[0]).toBe('1. place minecraft:sand at (1, 64, 0) (feet wall)');
  });

  it('needs a roof block that does not fall, and enough wall blocks', () => {
    expect(shelterStatus(ground(), FEET, { 'minecraft:sand': 64 }).problem).toMatch(
      /no block for the roof/,
    );
    expect(
      shelterStatus(ground(), FEET, { 'minecraft:sand': 3, 'minecraft:cobblestone': 1 }).problem,
    ).toMatch(/not enough wall blocks/);
  });

  it('uses what is already solid, and knows when the player is enclosed', () => {
    const wall = ['1,64,0', '1,65,0', '-1,64,0', '-1,65,0'];
    const part = shelterStatus(ground(wall), FEET, {
      'minecraft:dirt': 4,
      'minecraft:cobblestone': 2,
    });
    expect(part.problem).toBeNull();
    expect(part.todo.map((c) => c.role)).toEqual([
      ...Array<string>(2).fill('feet wall'),
      ...Array<string>(2).fill('head wall'),
      'roof support',
      'roof',
    ]);
    const all = shelterCells(FEET).map((c) => `${c.position.x},${c.position.y},${c.position.z}`);
    expect(shelterStatus(ground(all), FEET, {}).sheltered).toBe(true);
  });

  it('refuses when the blocks around are not loaded', () => {
    const unknown: SolidLookup = { solidAt: () => undefined };
    expect(shelterStatus(unknown, FEET, { 'minecraft:sand': 8 }).problem).toMatch(/not loaded/);
  });
});
