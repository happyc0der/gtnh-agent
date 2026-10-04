import { describe, expect, it } from 'vitest';
import { hiddenFrom, lineBlocked } from '../../../src/bot/gtnh1710/sight.ts';
import { B, TestWorld } from './fixtures/path-worlds.ts';

// Ground: grass at y 63 (feet stand at 64), dirt down to 61, stone below.
const PLAYER = { x: 0.5, y: 64, z: 0.5 };

/** A 3 x 3 x 3 cave whose floor is at feet level `y`, centred on (x, z). */
const cave = (w: TestWorld, x: number, y: number, z: number): TestWorld =>
  w.fill({ x: x - 1, y, z: z - 1 }, { x: x + 1, y: y + 2, z: z + 1 }, B.air);

describe('lines of sight', () => {
  it('a line through a full block is blocked; one beside it, or through air, is not', () => {
    const w = new TestWorld().set(3, 65, 0, B.stone);
    expect(lineBlocked(w, { x: 0.5, y: 65.5, z: 0.5 }, { x: 6.5, y: 65.5, z: 0.5 })).toBe(true);
    expect(lineBlocked(w, { x: 0.5, y: 65.5, z: 1.5 }, { x: 6.5, y: 65.5, z: 1.5 })).toBe(false);
    // Diagonally through the corner cells round it.
    expect(lineBlocked(w, { x: 0.5, y: 66.5, z: 0.5 }, { x: 6.5, y: 64.5, z: 6.5 })).toBe(false);
  });

  it('a line only grazing a block (a hair inside its faces) is not blocked by it', () => {
    const w = new TestWorld().set(3, 65, 0, B.stone);
    // 0.05 inside the block's top face: the mob's real line may pass just above it.
    expect(lineBlocked(w, { x: 0.5, y: 65.95, z: 0.5 }, { x: 6.5, y: 65.95, z: 0.5 })).toBe(false);
    expect(lineBlocked(w, { x: 0.5, y: 65.8, z: 0.5 }, { x: 6.5, y: 65.8, z: 0.5 })).toBe(true);
    // The seam between two blocks of a wall is no gap: a line along it is blocked.
    const wall = new TestWorld().set(3, 65, 0, B.stone).set(3, 66, 0, B.stone);
    expect(lineBlocked(wall, { x: 0.5, y: 66, z: 0.5 }, { x: 6.5, y: 66, z: 0.5 })).toBe(true);
  });

  it('a mob on open ground sees the player', () => {
    const w = new TestWorld();
    expect(hiddenFrom(w, { x: 12.5, y: 64, z: 3.5 }, PLAYER)).toBe(false);
  });

  it('a mob in a cave below cannot see the player on the surface: rock on every line', () => {
    // Seen live 2026-10-04: a giant skeleton 7 blocks under the night pit, 10.4 blocks off.
    const w = cave(new TestWorld(), 7, 57, 0);
    expect(hiddenFrom(w, { x: 7.5, y: 57, z: 0.5 }, PLAYER)).toBe(true);
    // A shaft from the cave up to the surface by the player: it sees up it.
    const open = cave(new TestWorld(), 7, 57, 0).fill(
      { x: 1, y: 57, z: 0 },
      { x: 6, y: 63, z: 0 },
      B.air,
    );
    expect(hiddenFrom(open, { x: 7.5, y: 57, z: 0.5 }, PLAYER)).toBe(false);
  });

  it("sealed in a pit, the player is seen by a mob in view of the pit's top: it comes out there", () => {
    // An independent review (2026-10-04): every mob outside a sealed pit counted as hidden, so
    // the morning exit would have dug out under a skeleton in plain view.
    const w = new TestWorld().set(0, 63, 0, B.dirt).set(0, 62, 0, B.air).set(0, 61, 0, B.air);
    const pit = { x: 0.5, y: 61, z: 0.5 };
    expect(hiddenFrom(w, { x: 12.5, y: 64, z: 0.5 }, pit)).toBe(false);
    // In a cave under the pit, it still cannot see the player, nor the pit's top.
    expect(hiddenFrom(cave(w, 7, 52, 0), { x: 7.5, y: 52, z: 0.5 }, pit)).toBe(true);
  });

  it('fails toward seen: blocks not loaded, or not known to be full cubes, let a line through', () => {
    // Every column of rock between them not loaded.
    const unloaded = cave(new TestWorld(), 7, 57, 0).unload((x) => x >= 1 && x <= 5);
    expect(hiddenFrom(unloaded, { x: 7.5, y: 57, z: 0.5 }, PLAYER)).toBe(false);
    // A wall of leaves between the player and a mob on the surface.
    const leaves = new TestWorld().fill({ x: 4, y: 64, z: -6 }, { x: 4, y: 70, z: 6 }, B.leaves);
    expect(hiddenFrom(leaves, { x: 8.5, y: 64, z: 0.5 }, PLAYER)).toBe(false);
    // A stone wall: hidden.
    const wall = new TestWorld().fill({ x: 4, y: 64, z: -6 }, { x: 4, y: 70, z: 6 }, B.stone);
    expect(hiddenFrom(wall, { x: 8.5, y: 64, z: 0.5 }, PLAYER)).toBe(true);
  });

  it('a wall the mob can see over (a tall mob, its head above it) does not hide the player', () => {
    // Two blocks high: a giant's head (up to 2.8 above its feet) sees over it.
    const wall = new TestWorld().fill({ x: 4, y: 64, z: -6 }, { x: 4, y: 65, z: 6 }, B.stone);
    expect(hiddenFrom(wall, { x: 8.5, y: 64, z: 0.5 }, PLAYER)).toBe(false);
  });
});
