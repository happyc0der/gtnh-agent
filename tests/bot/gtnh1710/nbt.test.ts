import { describe, expect, it } from 'vitest';
import { isCompound, readNbt } from '../../../src/bot/gtnh1710/nbt.ts';
import { ProtocolError } from '../../../src/bot/gtnh1710/wire.ts';

// Tiny NBT writer for tests.
const str = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};
const named = (type: number, name: string, payload: Buffer): Buffer =>
  Buffer.concat([Buffer.from([type]), str(name), payload]);
const i16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
};
const i32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const f64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b;
};

describe('NBT reader', () => {
  it('reads every 1.7.10 tag type, like a saved chunk with one entity', () => {
    const long = Buffer.alloc(8);
    long.writeBigInt64BE(-5n);
    const float = Buffer.alloc(4);
    float.writeFloatBE(1.5);
    const entity = Buffer.concat([
      named(8, 'id', str('etfuturum.rabbit')),
      named(9, 'Pos', Buffer.concat([Buffer.from([6]), i32(3), f64(-4.5), f64(106), f64(-7.25)])),
      named(1, 'OnGround', Buffer.from([1])),
      named(2, 'Air', i16(300)),
      named(4, 'UUIDMost', long),
      named(5, 'FallDistance', float),
      named(7, 'Bytes', Buffer.concat([i32(2), Buffer.from([9, 8])])),
      named(11, 'Ints', Buffer.concat([i32(2), i32(7), i32(-1)])),
      Buffer.from([0]),
    ]);
    const level = Buffer.concat([
      named(3, 'xPos', i32(-1)),
      named(9, 'Entities', Buffer.concat([Buffer.from([10]), i32(1), entity])),
      Buffer.from([0]),
    ]);
    const doc = named(10, '', Buffer.concat([named(10, 'Level', level), Buffer.from([0])]));
    const { name, value } = readNbt(doc);
    expect(name).toBe('');
    const lvl = value['Level'];
    if (!isCompound(lvl)) throw new Error('Level missing');
    expect(lvl['xPos']).toBe(-1);
    const entities = lvl['Entities'];
    expect(Array.isArray(entities) && entities.length).toBe(1);
    const e = (entities as unknown[])[0];
    if (!isCompound(e as never)) throw new Error('entity missing');
    expect(e).toMatchObject({
      id: 'etfuturum.rabbit',
      Pos: [-4.5, 106, -7.25],
      OnGround: 1,
      Air: 300,
      UUIDMost: -5n,
      FallDistance: 1.5,
    });
    expect((e as { Bytes: Buffer }).Bytes).toEqual(Buffer.from([9, 8]));
    expect(Array.from((e as { Ints: Int32Array }).Ints)).toEqual([7, -1]);
  });

  it('refuses malformed documents', () => {
    expect(() => readNbt(Buffer.from([8, 0, 0]))).toThrow(/root is not a compound/);
    expect(() => readNbt(named(10, 'x', Buffer.from([99, 0, 0])))).toThrow(/unknown tag type 99/);
    expect(() => readNbt(named(10, 'x', named(3, 'n', Buffer.from([0, 1]))))).toThrow(
      ProtocolError,
    );
  });
});
