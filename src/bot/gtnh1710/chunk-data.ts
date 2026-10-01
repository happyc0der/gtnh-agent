import { inflateSync } from 'node:zlib';
import { ProtocolError } from './wire.ts';

/**
 * Chunk block data for Minecraft 1.7.10, with and without NotEnoughIDs (NEID).
 *
 * Inflated column layout (sections in bit order of the primary mask, each array for all
 * sections before the next array):
 *   vanilla: block id LSB 4096 B | metadata 2048 | block light 2048 | [sky light 2048]
 *            | [add (id MSB nibbles) 2048 per add-mask section] | [biomes 256 if ground-up]
 *   NEID:    block id 8192 B (big-endian u16) | metadata 8192 (u16) | block light 2048
 *            | [sky light 2048] | (no add arrays) | [biomes 256 if ground-up]
 * NEID layout verified from notenoughIDs-2.1.10 (Constants.BYTES_PER_EBS = 20480,
 * ByteBuffer default big-endian) and against 252 live columns (every byte accounted for).
 */

export interface ChunkFormat {
  neid: boolean;
}

export interface ColumnHeader {
  chunkX: number;
  chunkZ: number;
  primaryBitMask: number;
  addBitMask: number;
}

/** Block ids of one column: 16 sections of 4096 (index y<<8 | z<<4 | x); null = all air. */
export type ColumnSections = Array<Uint16Array | null>;

export function popcount16(mask: number): number {
  let n = 0;
  for (let i = 0; i < 16; i++) n += (mask >> i) & 1;
  return n;
}

export function columnDataLength(
  h: ColumnHeader,
  skyLight: boolean,
  groundUp: boolean,
  format: ChunkFormat,
): number {
  const n = popcount16(h.primaryBitMask);
  const perSection = format.neid ? 8192 + 8192 + 2048 : 4096 + 2048 + 2048;
  return (
    n * perSection +
    (skyLight ? n * 2048 : 0) +
    popcount16(h.addBitMask) * 2048 +
    (groundUp ? 256 : 0)
  );
}

function decodeColumn(
  data: Buffer,
  offset: number,
  h: ColumnHeader,
  skyLight: boolean,
  format: ChunkFormat,
): ColumnSections {
  const sections: ColumnSections = new Array<Uint16Array | null>(16).fill(null);
  const n = popcount16(h.primaryBitMask);
  // Vanilla only: where the add (MSB) arrays start.
  const addBase = offset + n * (4096 + 2048 + 2048) + (skyLight ? n * 2048 : 0);
  let s = 0;
  let a = 0;
  for (let sec = 0; sec < 16; sec++) {
    if (((h.primaryBitMask >> sec) & 1) === 0) continue;
    const ids = new Uint16Array(4096);
    if (format.neid) {
      const base = offset + s * 8192;
      for (let i = 0; i < 4096; i++) ids[i] = data.readUInt16BE(base + i * 2);
    } else {
      const base = offset + s * 4096;
      for (let i = 0; i < 4096; i++) ids[i] = data[base + i] as number;
      if (((h.addBitMask >> sec) & 1) !== 0) {
        const add = addBase + a * 2048;
        for (let i = 0; i < 4096; i++) {
          const b = data[add + (i >> 1)] as number;
          ids[i] = (ids[i] as number) | (((i & 1) === 0 ? b & 15 : b >> 4) << 8);
        }
        a += 1;
      }
    }
    sections[sec] = ids;
    s += 1;
  }
  return sections;
}

/** Bytes of a ground-up column's biome array: one biome id per column, index z << 4 | x. */
export const BIOME_BYTES = 256;

export interface DecodedColumn {
  header: ColumnHeader;
  sections: ColumnSections;
  /** The column's biome ids (ground-up data ends with them); null when not sent. */
  biomes: Uint8Array | null;
}

/** The biome array at the end of a ground-up column's data (a copy). */
function biomesAt(data: Buffer, end: number): Uint8Array {
  return Uint8Array.from(data.subarray(end - BIOME_BYTES, end));
}

/** Map Chunk Bulk (0x26): every column is ground-up and shares one zlib stream. */
export function decodeChunkBulk(
  columns: readonly ColumnHeader[],
  skyLight: boolean,
  compressed: Buffer,
  format: ChunkFormat,
): DecodedColumn[] {
  const data = inflateChunkData(compressed);
  const out: DecodedColumn[] = [];
  let offset = 0;
  for (const h of columns) {
    if (format.neid && h.addBitMask !== 0) {
      throw new ProtocolError(`NEID column ${h.chunkX},${h.chunkZ} unexpectedly has an add mask`);
    }
    const length = columnDataLength(h, skyLight, true, format);
    if (offset + length > data.length)
      throw new ProtocolError('chunk bulk data shorter than its headers');
    out.push({
      header: h,
      sections: decodeColumn(data, offset, h, skyLight, format),
      biomes: biomesAt(data, offset + length),
    });
    offset += length;
  }
  if (offset !== data.length) {
    throw new ProtocolError(`chunk bulk data length ${data.length} != expected ${offset}`);
  }
  return out;
}

/**
 * Chunk Data (0x21) for one column. The packet does not say whether sky light is
 * included (it depends on the dimension), so the length decides; anything else is an error.
 */
export function decodeChunkColumn(
  header: ColumnHeader,
  groundUp: boolean,
  compressed: Buffer,
  format: ChunkFormat,
): ColumnSections {
  return decodeChunkColumnWithBiomes(header, groundUp, compressed, format).sections;
}

/** Chunk Data (0x21) with the biome array a ground-up column ends with (null otherwise). */
export function decodeChunkColumnWithBiomes(
  header: ColumnHeader,
  groundUp: boolean,
  compressed: Buffer,
  format: ChunkFormat,
): DecodedColumn {
  if (format.neid && header.addBitMask !== 0) {
    throw new ProtocolError(
      `NEID column ${header.chunkX},${header.chunkZ} unexpectedly has an add mask`,
    );
  }
  const data = inflateChunkData(compressed);
  for (const skyLight of [true, false]) {
    if (data.length === columnDataLength(header, skyLight, groundUp, format)) {
      return {
        header,
        sections: decodeColumn(data, 0, header, skyLight, format),
        biomes: groundUp ? biomesAt(data, data.length) : null,
      };
    }
  }
  throw new ProtocolError(`chunk data length ${data.length} matches no known layout`);
}

function inflateChunkData(compressed: Buffer): Buffer {
  try {
    return inflateSync(compressed);
  } catch (error) {
    throw new ProtocolError(
      `chunk data does not inflate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface StoredColumn {
  sections: ColumnSections;
  receivedAt: number;
  /** Why the block data is unusable (the column still counts as "arrived" for entities). */
  bad: string | null;
  /** Biome ids from the last ground-up data (null: none received). */
  biomes: Uint8Array | null;
}

/** A loaded, usable column, read-only (world surveys). */
export interface ColumnView {
  readonly sections: ColumnSections;
  readonly biomes: Uint8Array | null;
  readonly receivedAt: number;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;

/** Loaded chunk columns and their block ids. */
export class ChunkStore {
  readonly #columns = new Map<string, StoredColumn>();

  get size(): number {
    return this.#columns.size;
  }

  clear(): void {
    this.#columns.clear();
  }

  setColumn(
    cx: number,
    cz: number,
    sections: ColumnSections,
    at: number,
    biomes: Uint8Array | null = null,
  ): void {
    this.#columns.set(key(cx, cz), { sections, receivedAt: at, bad: null, biomes });
  }

  /** A non-ground-up update replaces only the sections in its mask. */
  updateSections(
    cx: number,
    cz: number,
    sections: ColumnSections,
    primaryBitMask: number,
    at: number,
  ): void {
    const existing = this.#columns.get(key(cx, cz));
    if (existing === undefined || existing.bad !== null) return; // nothing trustworthy to patch
    for (let sec = 0; sec < 16; sec++) {
      if (((primaryBitMask >> sec) & 1) !== 0) existing.sections[sec] = sections[sec] ?? null;
    }
    existing.receivedAt = at;
  }

  markBad(cx: number, cz: number, reason: string, at: number): void {
    this.#columns.set(key(cx, cz), {
      sections: new Array<Uint16Array | null>(16).fill(null),
      receivedAt: at,
      bad: reason,
      biomes: null,
    });
  }

  unload(cx: number, cz: number): void {
    this.#columns.delete(key(cx, cz));
  }

  /** When the column arrived (decodable or not), or undefined if not loaded. */
  receivedAt(cx: number, cz: number): number | undefined {
    return this.#columns.get(key(cx, cz))?.receivedAt;
  }

  /** Why the column's block data cannot be used, null if usable, undefined if not loaded. */
  problem(cx: number, cz: number): string | null | undefined {
    const c = this.#columns.get(key(cx, cz));
    return c === undefined ? undefined : c.bad;
  }

  /** Block id at a world position; undefined if that column is not loaded or unusable. */
  blockAt(x: number, y: number, z: number): number | undefined {
    if (y < 0 || y > 255) return 0;
    const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (c === undefined || c.bad !== null) return undefined;
    const section = c.sections[y >> 4];
    if (section === null || section === undefined) return 0;
    // `& 15` is correct for negative block coordinates too (two's complement).
    return section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)];
  }

  /** Column sections for scans (undefined if not loaded or unusable). */
  columnSections(cx: number, cz: number): ColumnSections | undefined {
    const c = this.#columns.get(key(cx, cz));
    return c === undefined || c.bad !== null ? undefined : c.sections;
  }

  /** The column with its biomes and arrival time (undefined if not loaded or unusable). */
  column(cx: number, cz: number): ColumnView | undefined {
    const c = this.#columns.get(key(cx, cz));
    return c === undefined || c.bad !== null
      ? undefined
      : { sections: c.sections, biomes: c.biomes, receivedAt: c.receivedAt };
  }

  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y > 255) return;
    const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (c === undefined || c.bad !== null) return;
    let section = c.sections[y >> 4];
    if (section === null || section === undefined) {
      if (id === 0) return;
      section = new Uint16Array(4096);
      c.sections[y >> 4] = section;
    }
    section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
  }
}
