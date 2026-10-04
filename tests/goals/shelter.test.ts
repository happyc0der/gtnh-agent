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
/** A tree trunk east of the roof cell: something to place the roof against. */
const TRUNK = '1,66,0';
const roles = (s: ReturnType<typeof shelterStatus>): string[] =>
  s.steps.map((x) => x.text.replace(/^.*\((.*)\)$/, '$1'));

describe('the raised box (the night shelter where a pit cannot be dug)', () => {
  it('is a 1 x 1 box: four walls at feet level, four at head level, then the roof', () => {
    const cells = shelterCells(FEET);
    expect(cells.map((c) => c.role)).toEqual([
      ...Array<string>(4).fill('feet wall'),
      ...Array<string>(4).fill('head wall'),
      'roof',
    ]);
    expect(cells.at(-1)?.position).toEqual({ x: 0, y: 66, z: 0 });
  });

  it('cannot be roofed on open ground: nothing touches the roof cell (seen live 2026-10-01)', () => {
    const s = shelterStatus(ground(), FEET, { 'minecraft:sand': 20, 'minecraft:cobblestone': 2 });
    expect(s).toMatchObject({ kind: 'box', sheltered: false, steps: [] });
    expect(s.problem).toMatch(/nothing beside or above the box's roof cell \(0, 66, 0\)/);
  });

  it('is roofed against a block already beside or above the roof cell (a trunk, a cliff, a canopy)', () => {
    const s = shelterStatus(ground([TRUNK]), FEET, {
      'minecraft:sand': 55,
      'minecraft:cobblestone': 10,
    });
    expect(s).toMatchObject({ kind: 'box', sheltered: false, problem: null, exit: [] });
    expect(s.needs).toEqual({ 'minecraft:sand': 8, 'minecraft:cobblestone': 1 });
    expect(roles(s)).toEqual([
      ...Array<string>(4).fill('feet wall'),
      ...Array<string>(4).fill('head wall'),
      'roof',
    ]);
    // Each step is an action the executor validates.
    expect(s.steps[0]?.spec).toEqual({
      type: 'PLACE_BLOCK',
      args: { position: { x: 1, y: 64, z: 0 }, item: 'minecraft:sand' },
    });
    expect(s.steps.at(-1)?.spec).toEqual({
      type: 'PLACE_BLOCK',
      args: { position: { x: 0, y: 66, z: 0 }, item: 'minecraft:cobblestone' },
    });
    expect(describeShelter(s)[0]).toBe('1. place minecraft:sand at (1, 64, 0) (feet wall)');
    // Leaves above count too (placed against their bottom face).
    expect(shelterStatus(ground(['0,67,0']), FEET, s.needs).problem).toBeNull();
  });

  it('cannot be walled up in the air: a wall cell with nothing beside, below or above it', () => {
    // Seen live: the player on its own pillar in a tree; every wall placement was refused.
    const pillar: SolidLookup = {
      solidAt: (x, y, z) => (x === 0 && z === 0 && y <= 81) || (x === 1 && y === 84 && z === 0),
    };
    const s = shelterStatus(pillar, { x: 0.5, y: 82, z: 0.5 }, { 'minecraft:dirt': 20 });
    expect(s).toMatchObject({ kind: 'box', sheltered: false, steps: [] });
    expect(s.problem).toMatch(/^nothing solid beside, below or above the box's wall cell/);
  });

  it('needs a roof block that does not fall, and enough wall blocks', () => {
    expect(shelterStatus(ground([TRUNK]), FEET, { 'minecraft:sand': 64 }).problem).toMatch(
      /no block for the roof/,
    );
    expect(
      shelterStatus(ground([TRUNK]), FEET, { 'minecraft:sand': 3, 'minecraft:cobblestone': 1 })
        .problem,
    ).toMatch(/not enough wall blocks/);
  });

  it('uses what is already solid, and knows when the player is walled in and enclosed', () => {
    const wall = ['1,64,0', '1,65,0', '-1,64,0', '-1,65,0'];
    const part = shelterStatus(ground([...wall, TRUNK]), FEET, {
      'minecraft:dirt': 4,
      'minecraft:cobblestone': 1,
    });
    expect(part.problem).toBeNull();
    expect(roles(part)).toEqual(['feet wall', 'feet wall', 'head wall', 'head wall', 'roof']);
    const walls = shelterCells(FEET)
      .filter((c) => c.role !== 'roof')
      .map((c) => `${c.position.x},${c.position.y},${c.position.z}`);
    expect(shelterStatus(ground([...walls, TRUNK]), FEET, {}).walled).toBe(true);
    const all = shelterCells(FEET).map((c) => `${c.position.x},${c.position.y},${c.position.z}`);
    expect(shelterStatus(ground(all), FEET, {})).toMatchObject({ sheltered: true, walled: true });
  });

  it('refuses when the blocks around are not loaded', () => {
    const unknown: SolidLookup = { solidAt: () => undefined };
    expect(shelterStatus(unknown, FEET, { 'minecraft:sand': 8 }).problem).toMatch(/not loaded/);
  });
});
