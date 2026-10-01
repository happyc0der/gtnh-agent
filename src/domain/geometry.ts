import type { BlockPosition, Position } from './common.ts';

export function distance(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export interface Box {
  min: Position;
  max: Position;
}

export function isInsideBox(p: Position, box: Box): boolean {
  return (
    p.x >= box.min.x &&
    p.x <= box.max.x &&
    p.y >= box.min.y &&
    p.y <= box.max.y &&
    p.z >= box.min.z &&
    p.z <= box.max.z
  );
}

export function formatPosition(p: Position): string {
  return `(${p.x}, ${p.y}, ${p.z})`;
}

/** The player's body is 0.6 x 1.8 x 0.6 blocks around its feet position; eyes at 1.62. */
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_OFFSET = 1.62;
const EPS = 1e-6;

export function blockCentre(b: BlockPosition): Position {
  return { x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 };
}

/** Distance from the player's eyes (feet + 1.62) to the centre of a block. */
export function eyeDistanceToBlock(feet: Position, b: BlockPosition): number {
  return distance({ x: feet.x, y: feet.y + PLAYER_EYE_OFFSET, z: feet.z }, blockCentre(b));
}

/** The whole block lies inside the box (a box of points, so the block's far corner too). */
export function isBlockInsideBox(b: BlockPosition, box: Box): boolean {
  return isInsideBox(b, box) && isInsideBox({ x: b.x + 1, y: b.y + 1, z: b.z + 1 }, box);
}

/** Block columns (x, z) the player's body overlaps at `feet`. Touching a face is not overlapping. */
export function bodyColumns(feet: Position): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  const x0 = Math.floor(feet.x - PLAYER_HALF_WIDTH + EPS);
  const x1 = Math.ceil(feet.x + PLAYER_HALF_WIDTH - EPS) - 1;
  const z0 = Math.floor(feet.z - PLAYER_HALF_WIDTH + EPS);
  const z1 = Math.ceil(feet.z + PLAYER_HALF_WIDTH - EPS) - 1;
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) out.push({ x, z });
  return out;
}

/** Highest block level the player's body reaches into (its head block). */
export function headBlockY(feet: Position): number {
  return Math.floor(feet.y + PLAYER_HEIGHT - EPS);
}
