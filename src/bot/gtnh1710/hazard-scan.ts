import type { Hazard } from '../../domain/game-state.ts';
import { BLOCK_CODE, kindOfCode } from './block-hazards.ts';
import type { ChunkStore } from './chunk-data.ts';

/** Blocks around the player searched for hazards (sphere) and void (horizontal circle). */
export const HAZARD_SCAN_RADIUS = 32;
/** Longest hazard list reported; beyond it the declared coverage shrinks (never truncates silently). */
export const MAX_REPORTED_HAZARDS = 256;

export type HazardScan =
  | { ok: true; scanRadius: number; hazards: Array<Hazard & { distance: number }> }
  | { ok: false; reason: string };

/**
 * Finds damaging blocks within a sphere and bottomless (void) columns within a circle
 * around the player's feet. Fail closed: any column in range that has not arrived, could
 * not be decoded, or holds a block id the registry does not name makes the scan unknown.
 *
 * Only EXPOSED hazard blocks are reported (at least one face not touching another hazard
 * block): the nearest hazard to any outside point is always an exposed one, so the list
 * stays short near lava lakes without weakening clearance checks.
 */
export function scanHazards(
  store: ChunkStore,
  codes: Uint8Array,
  feet: { x: number; y: number; z: number },
  radius = HAZARD_SCAN_RADIUS,
): HazardScan {
  const r2 = radius * radius;
  const minX = Math.floor(feet.x - radius);
  const maxX = Math.floor(feet.x + radius);
  const minZ = Math.floor(feet.z - radius);
  const maxZ = Math.floor(feet.z + radius);
  const minY = Math.max(0, Math.floor(feet.y - radius));
  const maxY = Math.min(255, Math.floor(feet.y + radius));
  const feetBlockY = Math.max(0, Math.min(255, Math.floor(feet.y)));

  // Every column overlapping the scan must be loaded and decodable.
  let missing = 0;
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++) {
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const problem = store.problem(cx, cz);
      if (problem === undefined) missing += 1;
      else if (problem !== null)
        return { ok: false, reason: `chunk ${cx},${cz} block data unusable: ${problem}` };
    }
  }
  if (missing > 0)
    return { ok: false, reason: `waiting for ${missing} nearby chunk(s) of block data` };

  const codeAt = (x: number, y: number, z: number): number => {
    const id = store.blockAt(x, y, z);
    return id === undefined ? BLOCK_CODE.unknown : (codes[id] as number);
  };
  const isHazard = (code: number): boolean =>
    code !== BLOCK_CODE.safe && code !== BLOCK_CODE.unknown;

  const hazards: Array<Hazard & { distance: number }> = [];
  const voidColumns = new Set<string>();

  for (let x = minX; x <= maxX; x++) {
    const dx = x + 0.5 - feet.x;
    for (let z = minZ; z <= maxZ; z++) {
      const dz = z + 0.5 - feet.z;
      const h2 = dx * dx + dz * dz;
      if (h2 > r2) continue;
      const sections = store.columnSections(Math.floor(x / 16), Math.floor(z / 16));
      if (sections === undefined)
        return { ok: false, reason: 'chunk block data changed during the scan' };

      // Damaging blocks in the sphere.
      for (let y = minY; y <= maxY; y++) {
        const dy = y + 0.5 - feet.y;
        if (h2 + dy * dy > r2) continue;
        const section = sections[y >> 4];
        if (section === null || section === undefined) {
          y = y | 15; // skip the rest of this empty (all-air) section
          continue;
        }
        const id = section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] as number;
        const code = codes[id] as number;
        if (code === BLOCK_CODE.safe) continue;
        if (code === BLOCK_CODE.unknown) {
          return { ok: false, reason: `block id ${id} at ${x},${y},${z} is not in the registry` };
        }
        const exposed =
          !isHazard(codeAt(x + 1, y, z)) ||
          !isHazard(codeAt(x - 1, y, z)) ||
          !isHazard(codeAt(x, y + 1, z)) ||
          !isHazard(codeAt(x, y - 1, z)) ||
          !isHazard(codeAt(x, y, z + 1)) ||
          !isHazard(codeAt(x, y, z - 1));
        const kind = kindOfCode(code);
        if (exposed && kind !== null) {
          hazards.push({
            kind,
            position: { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
            distance: Math.sqrt(h2 + dy * dy),
          });
        }
      }

      // Void: nothing at all from y=0 up to the player's feet in this column.
      // Only this column's own blocks count (index y<<8 | z<<4 | x within the section).
      const column = ((z & 15) << 4) | (x & 15);
      let solidBelow = false;
      for (let sec = 0; sec <= feetBlockY >> 4 && !solidBelow; sec++) {
        const section = sections[sec];
        if (section === null || section === undefined) continue;
        const top = sec === feetBlockY >> 4 ? feetBlockY & 15 : 15;
        for (let yy = 0; yy <= top; yy++) {
          if (section[(yy << 8) | column] !== 0) {
            solidBelow = true;
            break;
          }
        }
      }
      if (!solidBelow) voidColumns.add(`${x},${z}`);
    }
  }

  // Report void columns on the edge of a void area (nearest points to anything outside it).
  for (const col of voidColumns) {
    const [x, z] = col.split(',').map(Number) as [number, number];
    const edge =
      !voidColumns.has(`${x + 1},${z}`) ||
      !voidColumns.has(`${x - 1},${z}`) ||
      !voidColumns.has(`${x},${z + 1}`) ||
      !voidColumns.has(`${x},${z - 1}`);
    if (!edge) continue;
    const dx = x + 0.5 - feet.x;
    const dz = z + 0.5 - feet.z;
    hazards.push({
      kind: 'void',
      position: { x: x + 0.5, y: feetBlockY, z: z + 0.5 },
      distance: Math.sqrt(dx * dx + dz * dz),
    });
  }

  hazards.sort((a, b) => a.distance - b.distance);
  if (hazards.length <= MAX_REPORTED_HAZARDS) return { ok: true, scanRadius: radius, hazards };
  // Too many to list: report the nearest ones and shrink the declared coverage to what the
  // list completely describes, so the safety policy never trusts an incomplete list.
  const kept = hazards.slice(0, MAX_REPORTED_HAZARDS);
  const coverage = Math.floor((hazards[MAX_REPORTED_HAZARDS]?.distance ?? radius) * 100) / 100;
  return { ok: true, scanRadius: Math.max(0, coverage), hazards: kept };
}
