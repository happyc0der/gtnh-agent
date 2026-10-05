import { describe, expect, it } from 'vitest';
import { BLOCK_CODE } from '../../../src/bot/gtnh1710/block-hazards.ts';
import { overlappedCells } from '../../../src/bot/gtnh1710/pathing/physics.ts';
import type { Fence, WalkWorld } from '../../../src/bot/gtnh1710/walking.ts';
import { WEB_STEP, webExit, websAt } from '../../../src/bot/gtnh1710/web.ts';

const ID = { air: 0, stone: 1, grass: 2, web: 30, lava: 11 } as const;
const NAMES = new Map<number, string>([
  [ID.stone, 'minecraft:stone'],
  [ID.grass, 'minecraft:grass'],
  [ID.web, 'minecraft:web'],
  [ID.lava, 'minecraft:lava'],
]);
const k = (x: number, y: number, z: number): string => `${x},${y},${z}`;
/** Flat grass at y 92 (feet at 93), stone below, air above; `over` sets single blocks. */
function land(over: Record<string, number> = {}): WalkWorld {
  return {
    blockAt: (x, y, z) => over[k(x, y, z)] ?? (y === 92 ? ID.grass : y < 92 ? ID.stone : ID.air),
    blockName: (id) => NAMES.get(id),
    hazardCode: (id) => (id === ID.lava ? BLOCK_CODE.lava : BLOCK_CODE.safe),
  };
}
const FENCE: Fence = { min: { x: -40, y: 80, z: -10 }, max: { x: -10, y: 100, z: 30 } };
/** Where the agent stood in the web, seen live 2026-10-05. */
const FEET = { x: -27.5, y: 93, z: 10.55 };

describe('getting out of a cobweb (web.ts)', () => {
  it('is nothing to do out of a web', () => {
    expect(websAt(land(), FEET)).toEqual([]);
    expect(webExit(land(), FENCE, FEET)).toBeNull();
  });

  it('steps level onto the nearest side, at most WEB_STEP a tick, ending on its centre', () => {
    // Seen live: the web at the feet, a retreat home stopped there; every walk was refused.
    const world = land({ [k(-28, 93, 10)]: ID.web });
    const exit = webExit(world, FENCE, FEET);
    if (exit === null || !exit.ok) throw new Error(JSON.stringify(exit));
    expect(exit.webs).toEqual([{ x: -28, y: 93, z: 10 }]);
    // z 10.55 is nearer the +z side (0.95) than the -z one (1.05).
    expect(exit.to).toEqual({ x: -27.5, y: 93, z: 11.5 });
    let at = FEET;
    for (const s of exit.steps) {
      expect(Math.hypot(s.pos.x - at.x, s.pos.z - at.z)).toBeLessThanOrEqual(WEB_STEP + 1e-9);
      expect(s.pos.y).toBe(93);
      expect(s.onGround).toBe(true);
      at = s.pos;
    }
    expect(at).toEqual(exit.to);
    // Out of the web at the end: the body overlaps no web cell.
    const [x0, x1, , , z0, z1] = overlappedCells(at.x, at.y, at.z);
    expect([x0, x1, z0, z1]).toEqual([-28, -28, 11, 11]);
  });

  it('never steps into another web, a wall or beside a hazard: another side, then a corner', () => {
    const webs = { [k(-28, 93, 10)]: ID.web, [k(-28, 94, 10)]: ID.web };
    const world = land({
      ...webs,
      [k(-28, 93, 11)]: ID.web, // +z: another web
      [k(-28, 94, 9)]: ID.stone, // -z: a wall at head height
      [k(-26, 92, 10)]: ID.lava, // +x: lava next to (-27, 93, 10)
    });
    const exit = webExit(world, FENCE, FEET);
    if (exit === null || !exit.ok) throw new Error(JSON.stringify(exit));
    expect(exit.webs).toHaveLength(2); // feet and head in the web
    expect(exit.to).toEqual({ x: -28.5, y: 93, z: 10.5 }); // -x, the side left
    // No side to stand on (holes all round, open above): the nearest corner, over their edges.
    const holes = land({
      ...webs,
      [k(-29, 92, 10)]: ID.air,
      [k(-27, 92, 10)]: ID.air,
      [k(-28, 92, 11)]: ID.air,
      [k(-28, 92, 9)]: ID.air,
    });
    const corner = webExit(holes, FENCE, FEET);
    if (corner === null || !corner.ok) throw new Error(JSON.stringify(corner));
    expect(corner.to).toEqual({ x: -26.5, y: 93, z: 11.5 });
    // Walled on every side: a corner's way passes the walls' edges, so there is none.
    const boxed = land({
      ...webs,
      [k(-29, 93, 10)]: ID.stone,
      [k(-27, 93, 10)]: ID.stone,
      [k(-28, 93, 11)]: ID.stone,
      [k(-28, 93, 9)]: ID.stone,
    });
    const none = webExit(boxed, FENCE, { x: -27.5, y: 93, z: 10.5 });
    expect(none?.ok).toBe(false);
    expect(none?.ok === false && none.reason).toMatch(/^no cell beside it to step onto: /);
  });

  it('leaves a web holding the player in the air to gravity', () => {
    const world = land({ [k(-28, 95, 10)]: ID.web });
    const exit = webExit(world, FENCE, { x: -27.5, y: 95.3, z: 10.5 });
    expect(exit).toEqual({
      ok: false,
      reason: 'the feet are not on a block top',
      webs: [{ x: -28, y: 95, z: 10 }],
    });
  });
});
