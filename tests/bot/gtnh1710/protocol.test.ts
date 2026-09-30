import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FmlClientHandshake, MultipartAssembler } from '../../../src/bot/gtnh1710/fml-handshake.ts';
import { decodePlay, outbound, PLAYER_EYE_HEIGHT } from '../../../src/bot/gtnh1710/packets.ts';
import {
  nameItemStack,
  parseModIdData,
  type Registry,
} from '../../../src/bot/gtnh1710/registry.ts';
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
  encodeVarShort,
  FrameDecoder,
  ProtocolError,
  Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import { dimensionName, WorldModel } from '../../../src/bot/gtnh1710/world-model.ts';

describe('wire codec', () => {
  it.each([0, 1, 127, 128, 255, 25565, 2 ** 21, 2 ** 31 - 1, -1])('VarInt round-trips %i', (n) => {
    expect(new Reader(encodeVarInt(n)).varInt()).toBe(n);
  });

  it.each([0, 1, 32767, 32768, 485837, 0x7fffff])('Forge varshort round-trips %i', (n) => {
    const encoded = encodeVarShort(n);
    expect(encoded.length).toBe(n > 0x7fff ? 3 : 2);
    expect(new Reader(encoded).varShort()).toBe(n);
  });

  it('reassembles frames split at every byte and several frames per chunk', () => {
    const frames = Buffer.concat([
      encodeFrame(0x00, encodeString('first')),
      encodeFrame(0x3f, Buffer.alloc(40_000, 7)),
      encodeFrame(0x02, encodeString('third')),
    ]);
    const decoder = new FrameDecoder();
    const out = [];
    for (let i = 0; i < frames.length; i++) out.push(...decoder.push(frames.subarray(i, i + 1)));
    expect(out.map((f) => f.packetId)).toEqual([0x00, 0x3f, 0x02]);
    expect(out[0]?.body.string()).toBe('first');
    expect(out[1]?.body.remaining).toBe(40_000);
    expect(new FrameDecoder().push(frames).map((f) => f.packetId)).toEqual([0x00, 0x3f, 0x02]);
  });

  it('rejects oversized frames and reads past the end', () => {
    expect(() => new FrameDecoder(100).push(encodeFrame(0x00, Buffer.alloc(200)))).toThrow(
      ProtocolError,
    );
    expect(() => new Reader(Buffer.from([1, 2])).i32()).toThrow(ProtocolError);
    expect(() => new Reader(encodeVarInt(50)).string()).toThrow(ProtocolError);
  });
});

describe('outbound packets', () => {
  it('only writes to the REGISTER and FML|HS plugin channels', () => {
    expect(() => outbound.pluginMessage('MC|BSign', Buffer.alloc(1))).toThrow(/refusing/);
    expect(() => outbound.pluginMessage('GregTech', Buffer.alloc(1))).toThrow(/refusing/);
    expect(outbound.pluginMessage('FML|HS', Buffer.from([1, 2])).kind).toBe('plugin-message');
  });

  it('echoes the server position exactly (feet = eyes - 1.62, stance = eyes)', () => {
    const packet = outbound.confirmServerPosition(
      { x: 10.25, eyeY: 71.62000000476837, z: -3, yaw: 90, pitch: 5 },
      true,
    );
    const r = new FrameDecoder().push(packet.frame)[0]?.body;
    expect(r).toBeDefined();
    if (r === undefined) return;
    expect([r.f64(), r.f64(), r.f64(), r.f64(), r.f32(), r.f32(), r.bool()]).toEqual([
      10.25,
      71.62000000476837 - PLAYER_EYE_HEIGHT,
      71.62000000476837,
      -3,
      90,
      5,
      true,
    ]);
  });
});

describe('inbound packets', () => {
  it('decodes window items, including a stack with gzip NBT', () => {
    const nbt = gzipSync(Buffer.from([10, 0, 0, 0])); // empty compound
    const stack = Buffer.alloc(7);
    stack.writeInt16BE(7495, 0);
    stack.writeInt8(3, 2);
    stack.writeInt16BE(2032, 3);
    stack.writeInt16BE(nbt.length, 5);
    const body = Buffer.concat([Buffer.from([0, 0, 2]), Buffer.from([0xff, 0xff]), stack, nbt]);
    expect(decodePlay(0x30, new Reader(body))).toEqual({
      type: 'window-items',
      windowId: 0,
      items: [null, { id: 7495, count: 3, damage: 2032, hasNbt: true }],
    });
  });

  it('reads GTNH ModularUI stack sizes (VarInt after each non-empty stack)', () => {
    const stack = Buffer.alloc(7);
    stack.writeInt16BE(263, 0);
    stack.writeInt8(127, 2); // vanilla byte, capped
    stack.writeInt16BE(0, 3);
    stack.writeInt16BE(-1, 5);
    const body = Buffer.concat([
      Buffer.from([0, 0, 2]),
      stack,
      encodeVarInt(1000),
      Buffer.from([0xff, 0xff]),
    ]);
    expect(decodePlay(0x30, new Reader(body), { itemStackSizeVarInt: true })).toEqual({
      type: 'window-items',
      windowId: 0,
      items: [{ id: 263, count: 1000, damage: 0, hasNbt: false }, null],
    });
    // Decoding the same bytes as vanilla must fail loudly rather than misread.
    expect(() => decodePlay(0x30, new Reader(body))).toThrow(ProtocolError);
  });

  it('reads Forge plugin messages longer than 32767 bytes', () => {
    const data = Buffer.alloc(40_000, 1);
    const body = Buffer.concat([encodeString('FML|HS'), encodeVarShort(data.length), data]);
    const packet = decodePlay(0x3f, new Reader(body));
    expect(packet).toMatchObject({ type: 'plugin-message', channel: 'FML|HS' });
    expect(packet.type === 'plugin-message' && packet.data.length).toBe(40_000);
  });
});

function modIdData(entries: Array<[string, number]>): Buffer {
  return Buffer.concat([
    Buffer.from([3]),
    encodeVarInt(entries.length),
    ...entries.flatMap(([n, id]) => [encodeString(n), encodeVarInt(id)]),
    encodeVarInt(0),
    encodeVarInt(0),
  ]);
}

describe('FML client handshake', () => {
  const mods = [
    { modid: 'Forge', version: '10.13.4.1614' },
    { modid: 'gregtech', version: 'MC1710' },
  ];

  it('walks the full sequence and captures the registry', () => {
    const hs = new FmlClientHandshake(mods);
    const hello = hs.onServerMessage(Buffer.from([0, 2, 0, 0, 0, 0]));
    expect(hello.send.map((s) => [s.channel, s.data[0]])).toEqual([
      ['REGISTER', 'F'.charCodeAt(0)],
      ['FML|HS', 1],
      ['FML|HS', 2],
    ]);
    const clientMods = new Reader(hello.send[2]?.data ?? Buffer.alloc(0), 1);
    expect(clientMods.varInt()).toBe(2);
    expect([clientMods.string(), clientMods.string()]).toEqual(['Forge', '10.13.4.1614']);

    expect(
      hs.onServerMessage(Buffer.concat([Buffer.from([2]), encodeVarInt(2)])).send[0]?.data,
    ).toEqual(Buffer.from([0xff, 2]));
    const reg = hs.onServerMessage(
      modIdData([
        ['\u0001minecraft:stone', 1],
        ['\u0002minecraft:bread', 297],
      ]),
    );
    expect(reg.send[0]?.data).toEqual(Buffer.from([0xff, 3]));
    expect(hs.onServerMessage(Buffer.from([0xff, 2])).send[0]?.data).toEqual(
      Buffer.from([0xff, 4]),
    );
    expect(hs.onServerMessage(Buffer.from([0xff, 3])).send[0]?.data).toEqual(
      Buffer.from([0xff, 5]),
    );
    expect(hs.done).toBe(true);
    expect(hs.registry?.items.get(297)).toBe('minecraft:bread');
    expect(hs.registry?.blocks.get(1)).toBe('minecraft:stone');
  });

  it('rejects messages out of sequence', () => {
    const hs = new FmlClientHandshake(mods);
    expect(() => hs.onServerMessage(modIdData([]))).toThrow(/unexpected FML\|HS/);
  });

  it('reassembles FML|MP multipart payloads', () => {
    const m = new MultipartAssembler();
    const preamble = Buffer.concat([
      encodeString('FML|HS'),
      Buffer.from([2]),
      Buffer.from([0, 0, 0, 5]),
    ]);
    expect(m.push(preamble)).toBeNull();
    expect(m.push(Buffer.from([0, 1, 2, 3]))).toBeNull();
    expect(m.push(Buffer.from([1, 4, 5, 0, 0]))).toEqual({
      channel: 'FML|HS',
      data: Buffer.from([1, 2, 3, 4, 5]),
    });
  });
});

describe('registry naming', () => {
  const registry: Registry = parseModIdData(
    modIdData([
      ['\u0002minecraft:bread', 297],
      ['\u0002gregtech:gt.metaitem.01', 7495],
      ['\u0002bad#mod:thing', 9999],
      ['\u0001Natura:N Crops', 3001],
    ]),
  );

  it('names stacks, adding @damage for sub-types', () => {
    expect(nameItemStack(registry, 297, 0)).toEqual({ ok: true, name: 'minecraft:bread' });
    expect(nameItemStack(registry, 7495, 2032)).toEqual({
      ok: true,
      name: 'gregtech:gt.metaitem.01@2032',
    });
    expect(nameItemStack(registry, 3001, 0)).toEqual({ ok: true, name: 'Natura:N Crops' });
  });

  it('fails instead of guessing', () => {
    expect(nameItemStack(null, 297, 0).ok).toBe(false);
    expect(nameItemStack(registry, 12345, 0)).toMatchObject({
      ok: false,
      reason: /not in the registry/,
    });
    expect(nameItemStack(registry, 297, -1)).toMatchObject({
      ok: false,
      reason: /negative damage/,
    });
    expect(nameItemStack(registry, 9999, 0)).toMatchObject({
      ok: false,
      reason: /not a valid item name/,
    });
  });
});

describe('world model', () => {
  const at = new Date('2026-09-30T18:00:00.000Z');
  const registry = parseModIdData(
    modIdData([
      ['\u0002minecraft:bread', 297],
      ['\u0002minecraft:iron_sword', 267],
    ]),
  );
  const empty = (n: number) => Array.from({ length: n }, () => null);

  it('reports everything unknown before joining', () => {
    const s = new WorldModel().toGameState(at);
    expect([
      s.player.position.known,
      s.player.health.known,
      s.inventory.known,
      s.nearbyThreats.known,
    ]).toEqual([false, false, false, false]);
  });

  it('maps dimensions', () => {
    expect([0, -1, 1, 7, -28].map(dimensionName)).toEqual([
      'overworld',
      'the_nether',
      'the_end',
      'dim_7',
      'dim_-28',
    ]);
  });

  it('counts only main inventory slots 9-44 and tracks the held item', () => {
    const w = new WorldModel();
    w.setRegistry(registry);
    const items: Array<{ id: number; count: number; damage: number; hasNbt: boolean } | null> =
      empty(46);
    items[5] = { id: 267, count: 1, damage: 0, hasNbt: false }; // armor slot (not counted)
    items[9] = { id: 297, count: 5, damage: 0, hasNbt: false };
    items[44] = { id: 297, count: 2, damage: 0, hasNbt: false }; // last hotbar slot
    items[45] = { id: 297, count: 9, damage: 0, hasNbt: false }; // Backhand off-hand (not counted)
    w.apply({ type: 'window-items', windowId: 0, items }, at);
    let s = w.toGameState(at);
    expect(s.inventory).toEqual({
      known: true,
      value: { items: { 'minecraft:bread': 7 }, usedSlots: 2, capacitySlots: 36 },
    });
    expect(s.player.armor.known).toBe(false); // wearing something: durability not known
    expect(s.player.heldTool).toEqual({ known: true, value: null });

    w.apply(
      {
        type: 'set-slot',
        windowId: 0,
        slot: 36,
        item: { id: 267, count: 1, damage: 12, hasNbt: false },
      },
      at,
    );
    s = w.toGameState(at);
    expect(s.player.heldTool.known).toBe(false);
    expect(s.inventory.known && s.inventory.value.items['minecraft:iron_sword@12']).toBe(1);
  });

  it('marks the whole inventory unknown if any stack cannot be named', () => {
    const w = new WorldModel();
    w.setRegistry(registry);
    const items: Array<{ id: number; count: number; damage: number; hasNbt: boolean } | null> =
      empty(45);
    items[9] = { id: 31337, count: 1, damage: 0, hasNbt: false };
    w.apply({ type: 'window-items', windowId: 0, items }, at);
    expect(w.toGameState(at).inventory).toMatchObject({
      known: false,
      reason: /not in the registry/,
    });
  });

  it('forgets the position on respawn until the server sends a new one', () => {
    const w = new WorldModel();
    w.apply(
      { type: 'server-position', x: 1, eyeY: 65.62, z: 2, yaw: 0, pitch: 0, onGround: false },
      at,
    );
    expect(w.toGameState(at).player.position.known).toBe(true);
    w.apply({ type: 'respawn', dimension: -1, difficulty: 3, gamemode: 0, levelType: 'RWG' }, at);
    const s = w.toGameState(at);
    expect(s.player.position.known).toBe(false);
    expect(s.player.dimension).toEqual({ known: true, value: 'the_nether' });
  });
});
