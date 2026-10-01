import { describe, expect, it } from 'vitest';
import {
  decodeModifiedUtf8,
  encodeModifiedUtf8,
  isCompound,
  nbtTag,
  readNbt,
  writeNbt,
} from '../../../src/bot/gtnh1710/nbt.ts';
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

  it("reads strings as Java's modified UTF-8 (NUL as C0 80, astral characters as surrogates)", () => {
    // "a", NUL, "é", U+1F600 as the two surrogates D83D DE00, three bytes each.
    const java = Buffer.from([0x61, 0xc0, 0x80, 0xc3, 0xa9, 0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
    expect(decodeModifiedUtf8(java)).toBe('a\u0000é😀');
    expect(encodeModifiedUtf8('a\u0000é😀')).toEqual(java);
    expect(() => decodeModifiedUtf8(Buffer.from([0xc3]))).toThrow(ProtocolError);
    expect(() => decodeModifiedUtf8(Buffer.from([0xff]))).toThrow(ProtocolError);
  });
});

describe('NBT writer', () => {
  it('writes the exact bytes of a named root compound, as CompressedStreamTools does', () => {
    const bytes = writeNbt({ ID: nbtTag.string('x'), n: nbtTag.int(5) });
    expect(bytes).toEqual(
      Buffer.concat([
        Buffer.from([10, 0, 0]), // TAG_Compound, name ""
        Buffer.from([8, 0, 2]),
        Buffer.from('ID'),
        Buffer.from([0, 1]),
        Buffer.from('x'),
        Buffer.from([3, 0, 1]),
        Buffer.from('n'),
        Buffer.from([0, 0, 0, 5]),
        Buffer.from([0]), // TAG_End
      ]),
    );
  });

  it('writes every tag type so the reader gets the same values back', () => {
    const doc = writeNbt({
      b: nbtTag.byte(-3),
      flag: nbtTag.bool(true),
      s: nbtTag.short(-300),
      i: nbtTag.int(70_000),
      l: nbtTag.long(-4782315901562449638n),
      f: nbtTag.float(1.5),
      d: nbtTag.double(-2.25),
      bytes: nbtTag.byteArray(Buffer.from([1, 2, 3])),
      text: nbtTag.string('§6§lSomething From Nothing'),
      list: nbtTag.list('compound', [nbtTag.compound({ x: nbtTag.int(1) })]),
      strings: nbtTag.list('string', [nbtTag.string('a'), nbtTag.string('b')]),
      empty: nbtTag.list('compound', []),
      ints: nbtTag.intArray([2, -1]),
    });
    const { name, value } = readNbt(doc);
    expect(name).toBe('');
    expect(value).toMatchObject({
      b: -3,
      flag: 1,
      s: -300,
      i: 70_000,
      l: -4782315901562449638n,
      f: 1.5,
      d: -2.25,
      text: '§6§lSomething From Nothing',
      list: [{ x: 1 }],
      strings: ['a', 'b'],
      empty: [],
    });
    expect(value['bytes']).toEqual(Buffer.from([1, 2, 3]));
    expect(Array.from(value['ints'] as Int32Array)).toEqual([2, -1]);
  });

  it('refuses values that do not fit their tag', () => {
    expect(() => writeNbt({ b: nbtTag.byte(128) })).toThrow(ProtocolError);
    expect(() => writeNbt({ s: nbtTag.short(40_000) })).toThrow(ProtocolError);
    expect(() => writeNbt({ i: nbtTag.int(1.5) })).toThrow(ProtocolError);
    expect(() => writeNbt({ l: nbtTag.long(1n << 63n) })).toThrow(ProtocolError);
    expect(() => writeNbt({ x: nbtTag.list('int', [nbtTag.string('no')]) })).toThrow(
      /string in a list of int/,
    );
  });
});
