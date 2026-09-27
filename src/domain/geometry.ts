import type { Position } from './common.ts';

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
