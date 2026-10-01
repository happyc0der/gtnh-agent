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
 * Metadata is kept next to the ids (the walker tells plant variants apart by it): vanilla's
 * is a nibble per block (NibbleArray: the low nibble for an even index), NEID's a u16 per
 * block (MixinExtendedBlockStorage.getBlockMeta writes its short[] through a ByteBuffer, and
 * reads it back as meta & 0xFFFF: unsigned).
 *
 * Light is kept too (whether a spider may target the player depends on it): block light and
 * sky light, a nibble per block, indexed like the metadata, in both layouts. Verified in the
 * 1.7.10 jar with Forge's patches: S21PacketChunkData.func_149269_a copies each sent
 * section's getBlocklightArray, then (only where the world has a sky) its getSkylightArray,
 * and NEID's mixin replaces only the id and metadata copies. It sends a section only when it
 * holds a block that is not air (`!groundUp || !isEmpty()`): a section not sent holds only
 * air, and its light is not sent at all. ArchaicFix's Phosphor (on the test server) runs the
 * queued light updates before building the packet, so the light is the server's own.
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

/**
 * Block metadata of one section, indexed like its ids: one byte per block while every value
 * fits (always for vanilla's 4-bit metadata), two when NEID sends a larger one.
 */
export type SectionMeta = Uint8Array | Uint16Array;
/** Metadata of one column's 16 sections; null = all 0 (every all-air section, and many more). */
export type ColumnMeta = Array<SectionMeta | null>;

/**
 * One section's light array as the protocol sends it: 2048 bytes, a nibble per block indexed
 * like its ids (the low nibble for an even index); or, when every block has the same value
 * (most sections: no block light at all, full sky light above the ground, none deep below
 * it), that one value.
 */
export type PackedNibbles = Uint8Array | number;

/** One sent section's light: block light, and sky light (null: the world has no sky). */
export interface SectionLight {
  block: PackedNibbles;
  sky: PackedNibbles | null;
}

/** The light one column's chunk data carried. */
export interface ColumnLight {
  /** It carried sky light (a world with a sky, like the overworld). */
  sky: boolean;
  /** Per section; null where no section was sent (it holds only air, and no light came). */
  sections: Array<SectionLight | null>;
}

/** A block's index in its section. `& 15` is correct for negative coordinates too. */
const cellIndex = (x: number, y: number, z: number): number =>
  ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);

/** The nibble of block `i` in a packed light array. */
const nibbleAt = (packed: PackedNibbles, i: number): number =>
  typeof packed === 'number' ? packed : ((packed[i >> 1] as number) >> ((i & 1) << 2)) & 15;

/** The 2048-byte nibble array at `base`: one value when every block has it, else a copy. */
function packNibbles(data: Buffer, base: number): PackedNibbles {
  const first = data[base] as number;
  if ((first & 15) === first >> 4) {
    let i = 1;
    while (i < 2048 && data[base + i] === first) i += 1;
    if (i === 2048) return first & 15;
  }
  // A copy: a view would keep the whole inflated packet alive.
  return Uint8Array.from(data.subarray(base, base + 2048));
}

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

/** A section's metadata from vanilla's nibble array at `base` (null when all 0). */
function nibbleMeta(data: Buffer, base: number): SectionMeta | null {
  let meta: Uint8Array | null = null;
  for (let i = 0; i < 4096; i++) {
    const b = data[base + (i >> 1)] as number;
    const v = (i & 1) === 0 ? b & 15 : b >> 4;
    if (v === 0) continue;
    meta ??= new Uint8Array(4096);
    meta[i] = v;
  }
  return meta;
}

/** A section's metadata from NEID's big-endian u16 array at `base` (null when all 0). */
function wideMeta(data: Buffer, base: number): SectionMeta | null {
  let any = 0;
  for (let i = 0; i < 4096; i++) any |= data.readUInt16BE(base + i * 2);
  if (any === 0) return null;
  const meta = any > 255 ? new Uint16Array(4096) : new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) meta[i] = data.readUInt16BE(base + i * 2);
  return meta;
}

function decodeColumn(
  data: Buffer,
  offset: number,
  h: ColumnHeader,
  skyLight: boolean,
  format: ChunkFormat,
): { sections: ColumnSections; meta: ColumnMeta; light: ColumnLight } {
  const sections: ColumnSections = new Array<Uint16Array | null>(16).fill(null);
  const meta: ColumnMeta = new Array<SectionMeta | null>(16).fill(null);
  const light: ColumnLight = {
    sky: skyLight,
    sections: new Array<SectionLight | null>(16).fill(null),
  };
  const n = popcount16(h.primaryBitMask);
  // Each array holds every sent section before the next array starts.
  const metaBase = offset + n * (format.neid ? 8192 : 4096);
  // Block light, then sky light: 2048 bytes per sent section in both layouts.
  const blockLightBase = metaBase + n * (format.neid ? 8192 : 2048);
  const skyLightBase = blockLightBase + n * 2048;
  // Vanilla only: where the add (MSB) arrays start.
  const addBase = offset + n * (4096 + 2048 + 2048) + (skyLight ? n * 2048 : 0);
  let s = 0;
  let a = 0;
  for (let sec = 0; sec < 16; sec++) {
    if (((h.primaryBitMask >> sec) & 1) === 0) continue;
    light.sections[sec] = {
      block: packNibbles(data, blockLightBase + s * 2048),
      sky: skyLight ? packNibbles(data, skyLightBase + s * 2048) : null,
    };
    const ids = new Uint16Array(4096);
    if (format.neid) {
      const base = offset + s * 8192;
      for (let i = 0; i < 4096; i++) ids[i] = data.readUInt16BE(base + i * 2);
      meta[sec] = wideMeta(data, metaBase + s * 8192);
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
      meta[sec] = nibbleMeta(data, metaBase + s * 2048);
    }
    sections[sec] = ids;
    s += 1;
  }
  return { sections, meta, light };
}

/** Bytes of a ground-up column's biome array: one biome id per column, index z << 4 | x. */
export const BIOME_BYTES = 256;

export interface DecodedColumn {
  header: ColumnHeader;
  sections: ColumnSections;
  /** The block metadata of the sent sections, next to their ids. */
  meta: ColumnMeta;
  /** The block light and sky light of the sent sections. */
  light: ColumnLight;
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
      ...decodeColumn(data, offset, h, skyLight, format),
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

/**
 * Chunk Data (0x21) with the block metadata, and the biome array a ground-up column ends with
 * (null otherwise).
 */
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
        ...decodeColumn(data, 0, header, skyLight, format),
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
  /** Block metadata next to the ids; null when the column came without it (not known). */
  meta: ColumnMeta | null;
  /**
   * The light the last chunk data carried; null when the column came without it (not known).
   * Block changes carry no light, so it stays as that data had it (see setBlock).
   */
  light: ColumnLight | null;
  receivedAt: number;
  /** Why the block data is unusable (the column still counts as "arrived" for entities). */
  bad: string | null;
  /** Biome ids from the last ground-up data (null: none received). */
  biomes: Uint8Array | null;
}

/** `meta` with cell `i` set to `v`: allocated at the first value that is not 0, widened past 255. */
function withMeta(meta: SectionMeta | null, i: number, v: number): SectionMeta | null {
  let m = meta;
  if (m === null) {
    if (v === 0) return null;
    m = v > 255 ? new Uint16Array(4096) : new Uint8Array(4096);
  } else if (v > 255 && m instanceof Uint8Array) {
    m = Uint16Array.from(m);
  }
  m[i] = v;
  return m;
}

/** A loaded, usable column, read-only (world surveys). */
export interface ColumnView {
  readonly sections: ColumnSections;
  readonly biomes: Uint8Array | null;
  readonly receivedAt: number;
}

const key = (cx: number, cz: number): string => `${cx},${cz}`;

/** Loaded chunk columns: their block ids, metadata and light. */
export class ChunkStore {
  readonly #columns = new Map<string, StoredColumn>();

  get size(): number {
    return this.#columns.size;
  }

  clear(): void {
    this.#columns.clear();
  }

  /**
   * A whole column; without `meta` its metadata is not known (metaAt answers undefined), and
   * without `light` its light (lightAt and lightValue answer undefined).
   */
  setColumn(
    cx: number,
    cz: number,
    sections: ColumnSections,
    at: number,
    biomes: Uint8Array | null = null,
    meta: ColumnMeta | null = null,
    light: ColumnLight | null = null,
  ): void {
    this.#columns.set(key(cx, cz), { sections, meta, light, receivedAt: at, bad: null, biomes });
  }

  /**
   * A non-ground-up update replaces only the sections in its mask (ids, metadata and light).
   * One without metadata or light leaves the column's metadata or light not known.
   */
  updateSections(
    cx: number,
    cz: number,
    sections: ColumnSections,
    primaryBitMask: number,
    at: number,
    meta: ColumnMeta | null = null,
    light: ColumnLight | null = null,
  ): void {
    const existing = this.#columns.get(key(cx, cz));
    if (existing === undefined || existing.bad !== null) return; // nothing trustworthy to patch
    if (meta === null) existing.meta = null;
    if (light === null || existing.light?.sky !== light.sky) existing.light = null;
    for (let sec = 0; sec < 16; sec++) {
      if (((primaryBitMask >> sec) & 1) === 0) continue;
      existing.sections[sec] = sections[sec] ?? null;
      if (existing.meta !== null && meta !== null) existing.meta[sec] = meta[sec] ?? null;
      if (existing.light !== null && light !== null) {
        existing.light.sections[sec] = light.sections[sec] ?? null;
      }
    }
    existing.receivedAt = at;
  }

  markBad(cx: number, cz: number, reason: string, at: number): void {
    this.#columns.set(key(cx, cz), {
      sections: new Array<Uint16Array | null>(16).fill(null),
      meta: null,
      light: null,
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
    return section[cellIndex(x, y, z)];
  }

  /**
   * Block metadata at a world position (0 above and below the world, which is air); undefined
   * if that column is not loaded or unusable, or came without its metadata.
   */
  metaAt(x: number, y: number, z: number): number | undefined {
    if (y < 0 || y > 255) return 0;
    const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (c === undefined || c.bad !== null || c.meta === null) return undefined;
    const meta = c.meta[y >> 4];
    if (meta === null || meta === undefined) return 0;
    return meta[cellIndex(x, y, z)];
  }

  /**
   * The light the chunk data carried for a block: its block light, and its sky light (null in
   * a world without a sky). Null for a block in a section the server did not send (only air
   * there, and no light came for it); undefined when not known (not loaded or unusable, the
   * column came without light, or the section was made by a block change since).
   */
  lightAt(
    x: number,
    y: number,
    z: number,
  ): { block: number; sky: number | null } | null | undefined {
    if (y < 0 || y > 255) return undefined;
    const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (c === undefined || c.bad !== null || c.light === null) return undefined;
    const light = c.light.sections[y >> 4];
    if (light === null || light === undefined) {
      return c.sections[y >> 4] == null ? null : undefined;
    }
    const i = cellIndex(x, y, z);
    return {
      block: nibbleAt(light.block, i),
      sky: light.sky === null ? null : nibbleAt(light.sky, i),
    };
  }

  /**
   * Chunk.getBlockLightValue for a block (y 0-255): the brighter of its sky light less
   * `subtracted` (the time of day's darkness) and its block light; a world without a sky
   * has no sky light. Undefined when not known.
   *
   * A section the server did not send holds only air, and no light came for it. The server
   * reads full sky light there (less `subtracted`) when the section does not exist, and an
   * empty one it keeps holds full sky light in every column with nothing above it (vanilla's
   * generateSkylightMap, and Phosphor's initSkylightForSection: 15 where the column's height
   * is at or below the section); block light only adds. So it is 15 less `subtracted` where
   * nothing but air is above the block in its column, and not known otherwise.
   */
  lightValue(x: number, y: number, z: number, subtracted: number): number | undefined {
    const light = this.lightAt(x, y, z);
    if (light === undefined) return undefined;
    if (light === null) {
      const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
      if (c === undefined || c.light === null) return undefined;
      if (!c.light.sky) return 0; // no sky: the block light (not sent) is at least 0
      return this.#clearAbove(c, x, y, z) ? Math.max(0, 15 - subtracted) : undefined;
    }
    return Math.max((light.sky ?? 0) - subtracted, light.block);
  }

  /** Whether every block above (x, y, z) in its column is air. */
  #clearAbove(c: StoredColumn, x: number, y: number, z: number): boolean {
    for (let yy = y + 1; yy <= 255; yy++) {
      const section = c.sections[yy >> 4];
      if (section === null || section === undefined) {
        yy |= 15; // the rest of this section is air
        continue;
      }
      if (section[cellIndex(x, yy, z)] !== 0) return false;
    }
    return true;
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

  /**
   * A block change (Block Change, Multi Block Change): its id and metadata. These packets
   * carry no light, so the light stays as the column's last chunk data had it: around a block
   * that changed since (one the agent dug or placed, leaves that decayed, a tree that grew)
   * it may be stale until the server sends the column again. In practice a change the player
   * made near a spider is the only staleness that matters. (The time of day's darkness is
   * not stored light: lightValue subtracts it, from the clock.) A section a change creates
   * has no light known at all.
   */
  setBlock(x: number, y: number, z: number, id: number, meta: number): void {
    if (y < 0 || y > 255) return;
    const c = this.#columns.get(key(Math.floor(x / 16), Math.floor(z / 16)));
    if (c === undefined || c.bad !== null) return;
    const sec = y >> 4;
    const i = cellIndex(x, y, z);
    let section = c.sections[sec];
    if (section === null || section === undefined) {
      if (id === 0) return; // still all air (whose metadata is 0)
      section = new Uint16Array(4096);
      c.sections[sec] = section;
    }
    section[i] = id;
    if (c.meta !== null) c.meta[sec] = withMeta(c.meta[sec] ?? null, i, meta);
  }
}
