import { ProtocolError } from './wire.ts';

/**
 * Minimal reader for Minecraft's NBT format as used by 1.7.10 (tags 1-11; no long arrays).
 * Values map to plain JS: numbers, bigint (TAG_Long), strings, Buffer (byte arrays),
 * Int32Array, arrays (lists) and objects (compounds).
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
  // Java "modified UTF-8"; identical to UTF-8 for the ASCII/BMP text used in ids and names.
  const s = c.buf.toString('utf8', c.offset, c.offset + len);
  c.offset += len;
  return s;
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
