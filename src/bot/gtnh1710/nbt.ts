import { ProtocolError } from './wire.ts';

/**
 * Minimal reader and writer for Minecraft's NBT format as used by 1.7.10 (tags 1-11; no long
 * arrays). The reader maps values to plain JS: numbers, bigint (TAG_Long), strings, Buffer
 * (byte arrays), Int32Array, arrays (lists) and objects (compounds). The writer takes
 * explicitly typed tags (NbtTag). Strings are Java's modified UTF-8 in both directions.
 */
export type NbtValue = number | bigint | string | Buffer | Int32Array | NbtValue[] | NbtCompound;
export interface NbtCompound {
  [name: string]: NbtValue;
}

const MAX_DEPTH = 512;

class Cursor {
  readonly buf: Buffer;
  offset = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  need(n: number): void {
    if (n < 0 || this.offset + n > this.buf.length) throw new ProtocolError('NBT: read past end');
  }
  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.offset++);
  }
}

function readString(c: Cursor): string {
  c.need(2);
  const len = c.buf.readUInt16BE(c.offset);
  c.offset += 2;
  c.need(len);
  const s = decodeModifiedUtf8(c.buf.subarray(c.offset, c.offset + len));
  c.offset += len;
  return s;
}

/**
 * Java's "modified UTF-8" (DataInput.readUTF), which NBT strings use: like UTF-8, except
 * that U+0000 is two bytes (C0 80) and characters outside the BMP are two 3-byte surrogates.
 * Malformed input throws, as Java's readUTF does.
 */
export function decodeModifiedUtf8(b: Buffer): string {
  const units: number[] = [];
  for (let i = 0; i < b.length;) {
    const x = b[i] as number;
    if (x < 0x80) {
      units.push(x);
      i += 1;
    } else if ((x & 0xe0) === 0xc0) {
      const y = b[i + 1];
      if (y === undefined || (y & 0xc0) !== 0x80) throw new ProtocolError('NBT: bad string');
      units.push(((x & 0x1f) << 6) | (y & 0x3f));
      i += 2;
    } else if ((x & 0xf0) === 0xe0) {
      const y = b[i + 1];
      const z = b[i + 2];
      if (y === undefined || z === undefined || (y & 0xc0) !== 0x80 || (z & 0xc0) !== 0x80) {
        throw new ProtocolError('NBT: bad string');
      }
      units.push(((x & 0x0f) << 12) | ((y & 0x3f) << 6) | (z & 0x3f));
      i += 3;
    } else {
      throw new ProtocolError('NBT: bad string');
    }
  }
  let s = '';
  for (let i = 0; i < units.length; i += 4096) {
    s += String.fromCharCode(...units.slice(i, i + 4096));
  }
  return s;
}

/** Java's DataOutput.writeUTF bytes for `s` (without the length prefix). */
export function encodeModifiedUtf8(s: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x01 && c <= 0x7f) out.push(c);
    else if (c <= 0x7ff) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Buffer.from(out);
}

function readPayload(c: Cursor, type: number, depth: number): NbtValue {
  if (depth > MAX_DEPTH) throw new ProtocolError('NBT: nested too deeply');
  const b = c.buf;
  switch (type) {
    case 1:
      c.need(1);
      return b.readInt8(c.offset++);
    case 2:
      c.need(2);
      c.offset += 2;
      return b.readInt16BE(c.offset - 2);
    case 3:
      c.need(4);
      c.offset += 4;
      return b.readInt32BE(c.offset - 4);
    case 4:
      c.need(8);
      c.offset += 8;
      return b.readBigInt64BE(c.offset - 8);
    case 5:
      c.need(4);
      c.offset += 4;
      return b.readFloatBE(c.offset - 4);
    case 6:
      c.need(8);
      c.offset += 8;
      return b.readDoubleBE(c.offset - 8);
    case 7: {
      c.need(4);
      const len = b.readInt32BE(c.offset);
      c.offset += 4;
      c.need(len);
      c.offset += len;
      return Buffer.from(b.subarray(c.offset - len, c.offset));
    }
    case 8:
      return readString(c);
    case 9: {
      const itemType = c.u8();
      c.need(4);
      const len = b.readInt32BE(c.offset);
      c.offset += 4;
      if (len < 0) throw new ProtocolError('NBT: negative list length');
      const items: NbtValue[] = [];
      for (let i = 0; i < len; i++) items.push(readPayload(c, itemType, depth + 1));
      return items;
    }
    case 10: {
      const out: NbtCompound = {};
      for (;;) {
        const tag = c.u8();
        if (tag === 0) return out;
        const name = readString(c);
        out[name] = readPayload(c, tag, depth + 1);
      }
    }
    case 11: {
      c.need(4);
      const len = b.readInt32BE(c.offset);
      c.offset += 4;
      c.need(len * 4);
      const arr = new Int32Array(len);
      for (let i = 0; i < len; i++) arr[i] = b.readInt32BE(c.offset + i * 4);
      c.offset += len * 4;
      return arr;
    }
    default:
      throw new ProtocolError(`NBT: unknown tag type ${type}`);
  }
}

/** Reads an uncompressed NBT document (root must be a named compound). */
export function readNbt(buf: Buffer): { name: string; value: NbtCompound } {
  const c = new Cursor(buf);
  if (c.u8() !== 10) throw new ProtocolError('NBT: root is not a compound');
  const name = readString(c);
  return { name, value: readPayload(c, 10, 0) as NbtCompound };
}

export function isCompound(v: NbtValue | undefined): v is NbtCompound {
  return (
    v !== undefined &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    !Buffer.isBuffer(v) &&
    !(v instanceof Int32Array)
  );
}

// ---------------------------------------------------------------------------
// Writer. Values carry their tag type explicitly (a JS number could be any of five tags).
// ---------------------------------------------------------------------------

export type NbtTag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'byteArray'; value: Buffer }
  | { type: 'string'; value: string }
  | { type: 'list'; itemType: NbtTagType; value: NbtTag[] }
  | { type: 'compound'; value: NbtTagCompound }
  | { type: 'intArray'; value: readonly number[] };
export type NbtTagType = NbtTag['type'];
export interface NbtTagCompound {
  [name: string]: NbtTag;
}

const TAG_IDS: Readonly<Record<NbtTagType, number>> = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
};

/** Typed tag constructors for writeNbt. */
export const nbtTag = {
  byte: (value: number): NbtTag => ({ type: 'byte', value }),
  bool: (value: boolean): NbtTag => ({ type: 'byte', value: value ? 1 : 0 }),
  short: (value: number): NbtTag => ({ type: 'short', value }),
  int: (value: number): NbtTag => ({ type: 'int', value }),
  long: (value: bigint): NbtTag => ({ type: 'long', value }),
  float: (value: number): NbtTag => ({ type: 'float', value }),
  double: (value: number): NbtTag => ({ type: 'double', value }),
  byteArray: (value: Buffer): NbtTag => ({ type: 'byteArray', value }),
  string: (value: string): NbtTag => ({ type: 'string', value }),
  list: (itemType: NbtTagType, value: NbtTag[]): NbtTag => ({ type: 'list', itemType, value }),
  compound: (value: NbtTagCompound): NbtTag => ({ type: 'compound', value }),
  intArray: (value: readonly number[]): NbtTag => ({ type: 'intArray', value }),
};

function intIn(n: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ProtocolError(`NBT: ${what} ${n} out of range`);
  }
  return n;
}

function writeString(out: Buffer[], s: string): void {
  const bytes = encodeModifiedUtf8(s);
  if (bytes.length > 0xffff) throw new ProtocolError('NBT: string too long');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(bytes.length);
  out.push(len, bytes);
}

function writePayload(out: Buffer[], t: NbtTag, depth: number): void {
  if (depth > MAX_DEPTH) throw new ProtocolError('NBT: nested too deeply');
  switch (t.type) {
    case 'byte': {
      const b = Buffer.alloc(1);
      b.writeInt8(intIn(t.value, -128, 127, 'byte'));
      out.push(b);
      return;
    }
    case 'short': {
      const b = Buffer.alloc(2);
      b.writeInt16BE(intIn(t.value, -32768, 32767, 'short'));
      out.push(b);
      return;
    }
    case 'int': {
      const b = Buffer.alloc(4);
      b.writeInt32BE(intIn(t.value, -2147483648, 2147483647, 'int'));
      out.push(b);
      return;
    }
    case 'long': {
      if (BigInt.asIntN(64, t.value) !== t.value) throw new ProtocolError('NBT: long out of range');
      const b = Buffer.alloc(8);
      b.writeBigInt64BE(t.value);
      out.push(b);
      return;
    }
    case 'float': {
      const b = Buffer.alloc(4);
      b.writeFloatBE(t.value);
      out.push(b);
      return;
    }
    case 'double': {
      const b = Buffer.alloc(8);
      b.writeDoubleBE(t.value);
      out.push(b);
      return;
    }
    case 'byteArray': {
      const len = Buffer.alloc(4);
      len.writeInt32BE(t.value.length);
      out.push(len, Buffer.from(t.value));
      return;
    }
    case 'string':
      writeString(out, t.value);
      return;
    case 'list': {
      const head = Buffer.alloc(5);
      head.writeUInt8(TAG_IDS[t.itemType], 0);
      head.writeInt32BE(t.value.length, 1);
      out.push(head);
      for (const item of t.value) {
        if (item.type !== t.itemType) {
          throw new ProtocolError(`NBT: ${item.type} in a list of ${t.itemType}`);
        }
        writePayload(out, item, depth + 1);
      }
      return;
    }
    case 'compound':
      for (const [name, child] of Object.entries(t.value)) {
        out.push(Buffer.from([TAG_IDS[child.type]]));
        writeString(out, name);
        writePayload(out, child, depth + 1);
      }
      out.push(Buffer.from([0]));
      return;
    case 'intArray': {
      const b = Buffer.alloc(4 + t.value.length * 4);
      b.writeInt32BE(t.value.length, 0);
      t.value.forEach((v, i) =>
        b.writeInt32BE(intIn(v, -2147483648, 2147483647, 'int'), 4 + i * 4),
      );
      out.push(b);
      return;
    }
  }
}

/**
 * Writes an uncompressed NBT document: a named root compound, as Java's
 * CompressedStreamTools writes it (inside the gzip). Minecraft's root name is "".
 */
export function writeNbt(root: NbtTagCompound, name = ''): Buffer {
  const out: Buffer[] = [Buffer.from([TAG_IDS.compound])];
  writeString(out, name);
  writePayload(out, nbtTag.compound(root), 0);
  return Buffer.concat(out);
}
