/**
 * Byte-level codec for the Minecraft 1.7.x protocol (protocol 5, used by 1.7.6-1.7.10).
 * 1.7 has no packet compression, and offline-mode servers use no encryption, so every
 * packet is simply: VarInt length | VarInt packet id | body.
 */

/** Largest frame accepted. GTNH's FML registry packet is ~0.5 MB; chunk bulk packets are smaller. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError';
}

export function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return Buffer.from(bytes);
}

export function encodeString(s: string): Buffer {
  const utf8 = Buffer.from(s, 'utf8');
  return Buffer.concat([encodeVarInt(utf8.length), utf8]);
}

/** Forge 1.7.10 "varshort": 15 bits, plus one extra byte (bits 15-22) if the top bit is set. */
export function encodeVarShort(value: number): Buffer {
  if (value < 0 || value > 0x7fffff) throw new ProtocolError(`varshort out of range: ${value}`);
  const low = value & 0x7fff;
  const high = (value & 0x7f8000) >> 15;
  const b = Buffer.alloc(high !== 0 ? 3 : 2);
  b.writeUInt16BE(high !== 0 ? low | 0x8000 : low, 0);
  if (high !== 0) b.writeUInt8(high, 2);
  return b;
}

export function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

export function i32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

export function f32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(n);
  return b;
}

export function f64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
}

export function bool(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}

export function encodeFrame(packetId: number, body: Buffer): Buffer {
  const payload = Buffer.concat([encodeVarInt(packetId), body]);
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

/** Bounds-checked cursor over a buffer. Every read throws ProtocolError past the end. */
export class Reader {
  readonly buf: Buffer;
  offset: number;

  constructor(buf: Buffer, offset = 0) {
    this.buf = buf;
    this.offset = offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  #need(n: number): void {
    if (n < 0 || this.offset + n > this.buf.length) {
      throw new ProtocolError(
        `read of ${n} bytes past end (offset ${this.offset}, length ${this.buf.length})`,
      );
    }
  }

  varInt(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      this.#need(1);
      const b = this.buf[this.offset++] as number;
      value |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return value | 0;
      shift += 7;
      if (shift > 28) throw new ProtocolError('VarInt too long');
    }
  }

  varShort(): number {
    let low = this.u16();
    let high = 0;
    if ((low & 0x8000) !== 0) {
      low &= 0x7fff;
      high = this.u8();
    }
    return ((high & 0xff) << 15) | low;
  }

  string(maxBytes = 32767 * 4): string {
    const len = this.varInt();
    if (len < 0 || len > maxBytes) throw new ProtocolError(`string length ${len} out of range`);
    this.#need(len);
    const s = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  bytes(n: number): Buffer {
    this.#need(n);
    const b = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }

  u8(): number {
    this.#need(1);
    return this.buf.readUInt8(this.offset++);
  }

  i8(): number {
    this.#need(1);
    return this.buf.readInt8(this.offset++);
  }

  u16(): number {
    this.#need(2);
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  i16(): number {
    this.#need(2);
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  i32(): number {
    this.#need(4);
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.#need(8);
    const v = this.buf.readBigInt64BE(this.offset);
    this.offset += 8;
    return v;
  }

  f32(): number {
    this.#need(4);
    const v = this.buf.readFloatBE(this.offset);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.#need(8);
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }
}

export interface Frame {
  packetId: number;
  body: Reader;
}

/**
 * Reassembles length-prefixed frames from arbitrary TCP chunks. Frames split across
 * chunks, several frames per chunk, and partial length prefixes are all handled.
 */
export class FrameDecoder {
  #pending: Buffer = Buffer.alloc(0);
  readonly #maxFrameBytes: number;

  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): Frame[] {
    this.#pending = this.#pending.length === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const header = this.#readLength();
      if (header === null) break;
      const [length, headerBytes] = header;
      if (length < 1 || length > this.#maxFrameBytes) {
        throw new ProtocolError(`frame length ${length} out of range`);
      }
      if (this.#pending.length < headerBytes + length) break;
      const payload = this.#pending.subarray(headerBytes, headerBytes + length);
      this.#pending = this.#pending.subarray(headerBytes + length);
      const reader = new Reader(Buffer.from(payload));
      frames.push({ packetId: reader.varInt(), body: reader });
    }
    return frames;
  }

  /** [frame length, bytes used by the length prefix], or null if the prefix is incomplete. */
  #readLength(): [number, number] | null {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (i >= this.#pending.length) return null;
      const b = this.#pending[i] as number;
      value |= (b & 0x7f) << (7 * i);
      if ((b & 0x80) === 0) return [value, i + 1];
    }
    throw new ProtocolError('frame length VarInt too long');
  }
}
