import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FmlClientHandshake, MultipartAssembler } from '../../../src/bot/gtnh1710/fml-handshake.ts';
import {
  classifyModded,
  classifyVanillaMob,
  MODDED_ENTITY_TABLE,
} from '../../../src/bot/gtnh1710/entity-types.ts';
import {
  decodeFmlRuntimeMessage,
  decodePlay,
  outbound,
  PLAYER_EYE_HEIGHT,
} from '../../../src/bot/gtnh1710/packets.ts';
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
  i32,
  ProtocolError,
  Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import { dimensionName, WorldModel } from '../../../src/bot/gtnh1710/world-model.ts';
import { chunkBulkFrame, flatWorld, neidColumn } from './chunk-fixtures.ts';

/** Decode one frame the way the client does on a GTNH (ModularUI + NEID) server. */
function decodeFrame(frame: Buffer) {
  const f = new FrameDecoder().push(frame)[0];
  if (f === undefined) throw new Error('no frame');
  return decodePlay(f.packetId, f.body, { itemStackSizeVarInt: true, neid: true });
}

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

  it('clicks in window 0 (the 2x2 grid) but never closes it (that drops the grid)', () => {
    const click = outbound.clickWindow(0, 1, 1, 7, null, true);
    const r = new FrameDecoder().push(click.frame)[0]?.body;
    expect([r?.i8(), r?.i16(), r?.i8(), r?.i16(), r?.i8(), r?.i16()]).toEqual([0, 1, 1, 7, 0, -1]);
    expect(() => outbound.closeWindow(0)).toThrow(/refusing to close window 0/);
    expect(outbound.closeWindow(3).kind).toBe('close-window');
    expect(() => outbound.clickWindow(-1, 0, 0, 1, null, true)).toThrow(/bad window id/);
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
    expect(decodePlay(0x30, new Reader(body), { itemStackSizeVarInt: true, neid: false })).toEqual({
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

describe('entity packets', () => {
  const fixed = (x: number, y: number, z: number) =>
    Buffer.concat([i32(Math.floor(x * 32)), i32(Math.floor(y * 32)), i32(Math.floor(z * 32))]);

  it('decodes vanilla spawn mob, destroy, relative move and teleport', () => {
    const spawn = Buffer.concat([
      encodeVarInt(300),
      Buffer.from([54]),
      fixed(10.5, 64, -3.25),
      Buffer.alloc(9),
    ]);
    expect(decodePlay(0x0f, new Reader(spawn))).toEqual({
      type: 'spawn-mob',
      entityId: 300,
      mobType: 54,
      x: 10.5,
      y: 64,
      z: -3.25,
    });
    const destroy = Buffer.concat([Buffer.from([2]), i32(300), i32(301)]);
    expect(decodePlay(0x13, new Reader(destroy))).toEqual({
      type: 'destroy-entities',
      entityIds: [300, 301],
    });
    const move = Buffer.concat([i32(300), Buffer.from([32, 0xf0, 0])]); // +1, -0.5, 0 blocks
    expect(decodePlay(0x15, new Reader(move))).toEqual({
      type: 'entity-move',
      entityId: 300,
      dx: 1,
      dy: -0.5,
      dz: 0,
    });
    const lookMove = Buffer.concat([move, Buffer.from([10, 20])]);
    expect(decodePlay(0x17, new Reader(lookMove))).toMatchObject({ type: 'entity-move', dx: 1 });
    const teleport = Buffer.concat([i32(300), fixed(1, 2, 3), Buffer.from([0, 0])]);
    expect(decodePlay(0x18, new Reader(teleport))).toEqual({
      type: 'entity-teleport',
      entityId: 300,
      x: 1,
      y: 2,
      z: 3,
    });
  });

  it('decodes Forge FML entity spawn and adjust messages, ignoring trailing spawn data', () => {
    const spawn = Buffer.concat([
      Buffer.from([2]),
      i32(77),
      encodeString('SpecialMobs'),
      i32(21),
      fixed(-40, 70, 12.5),
      Buffer.from([1, 2, 3, 0x66, 0x7f]), // rotation + DataWatcher, not needed
    ]);
    expect(decodeFmlRuntimeMessage(spawn)).toEqual({
      type: 'fml-entity-spawn',
      entityId: 77,
      modId: 'SpecialMobs',
      typeId: 21,
      x: -40,
      y: 70,
      z: 12.5,
    });
    const adjust = Buffer.concat([Buffer.from([3]), i32(77), fixed(1, 2, 3)]);
    expect(decodeFmlRuntimeMessage(adjust)).toEqual({
      type: 'fml-entity-adjust',
      entityId: 77,
      x: 1,
      y: 2,
      z: 3,
    });
    expect(decodeFmlRuntimeMessage(Buffer.from([1, 9, 9]))).toEqual({
      type: 'fml-other',
      discriminator: 1,
    });
    expect(() => decodeFmlRuntimeMessage(Buffer.from([2, 0, 0]))).toThrow(ProtocolError);
  });

  it('identified modded types apply only to the mod version they were verified with', () => {
    expect(classifyModded('etfuturum', 3, '2.6.2.25-GTNH')).toEqual({
      name: 'etfuturum.rabbit',
      category: 'passive',
    });
    expect(classifyModded('etfuturum', 3, '2.7.0')).toEqual({
      name: 'etfuturum#3',
      category: 'unclassified',
    });
    expect(classifyModded('SpecialMobs', 18, '9.9.9')).toEqual({
      name: 'SpecialMobs.DarkCreeper',
      category: 'hostile', // the whole mod is hostile, whatever the version
    });
  });

  it('every passive identification meets the evidence rule (>= 10 votes, all agreeing)', () => {
    const keys = MODDED_ENTITY_TABLE.map((e) => `${e.modId}#${e.typeId}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of MODDED_ENTITY_TABLE.filter((x) => x.category === 'passive')) {
      expect(e.votes, e.name).toBeGreaterThanOrEqual(10);
      expect(e.votes, e.name).toBe(e.total);
    }
  });

  it('classifies fail-closed: unknown vanilla ids and unlisted mods are unclassified', () => {
    expect(classifyVanillaMob(54).category).toBe('hostile');
    expect(classifyVanillaMob(92).category).toBe('passive');
    expect(classifyVanillaMob(200)).toEqual({ name: 'mob#200', category: 'unclassified' });
    expect(classifyModded('SpecialMobs', 999, '3.6.3').category).toBe('hostile');
    expect(classifyModded('etfuturum', 3, undefined)).toEqual({
      name: 'etfuturum#3',
      category: 'unclassified',
    });
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

  it('lays out a crafting table window (S2D type 1 announces 9 slots; the window has 10 + 36)', () => {
    const w = new WorldModel();
    w.setRegistry(registry);
    w.apply({ type: 'window-items', windowId: 0, items: empty(46) }, at);
    w.expectContainer('table.test');
    w.apply(
      { type: 'open-window', windowId: 4, inventoryType: 1, title: 'Crafting', slotCount: 9 },
      at,
    );
    const items: Array<{ id: number; count: number; damage: number; hasNbt: boolean } | null> =
      empty(46);
    items[0] = { id: 297, count: 2, damage: 0, hasNbt: false }; // the crafting result
    items[10] = { id: 297, count: 5, damage: 0, hasNbt: false }; // player main inventory
    w.apply({ type: 'window-items', windowId: 4, items }, at);
    const open = w.openWindow;
    expect([open?.containerSlots, open?.slotsKnown, open?.containerId]).toEqual([
      10,
      true,
      'table.test',
    ]);
    // The result slot is not inventory; the player's part is.
    expect(w.toGameState(at).inventory).toMatchObject({
      known: true,
      value: { items: { 'minecraft:bread': 5 } },
    });
    // Window 0 takes clicks only while no other window is open.
    expect(w.inventoryClickWindow).toBeNull();
    w.closeWindowLocally();
    expect(w.inventoryClickWindow?.slots[9]).toEqual(items[10]);
  });

  it('tracks window-0 syncs and the cursor for crafting in the 2x2 grid', () => {
    const w = new WorldModel();
    w.setRegistry(registry);
    w.setCraftingTables([{ id: 'table.a', name: 'A table', position: { x: 1, y: 64, z: 2 } }]);
    w.apply({ type: 'window-items', windowId: 0, items: empty(46) }, at);
    w.apply(
      {
        type: 'set-slot',
        windowId: -1,
        slot: -1,
        item: { id: 297, count: 1, damage: 0, hasNbt: false },
      },
      at,
    );
    expect([w.inventorySyncs, w.cursorSyncs]).toEqual([1, 1]);
    const view = w.inventoryClickWindow;
    expect(view?.cursor).toEqual({ id: 297, count: 1, damage: 0, hasNbt: false });
    expect(view?.containerSlots).toBe(9);
    if (view === null || view === undefined) return;
    const slots = [...view.slots];
    slots[1] = view.cursor;
    // While the click was on its way, the server updated another slot: that update is kept.
    const bread = { id: 297, count: 3, damage: 0, hasNbt: false };
    w.apply({ type: 'set-slot', windowId: 0, slot: 20, item: bread }, at);
    w.applyAcceptedClick(0, view, { ...view, slots, cursor: null });
    expect(w.inventoryWindow?.[1]).toEqual({ id: 297, count: 1, damage: 0, hasNbt: false });
    expect(w.inventoryWindow?.[20]).toEqual(bread);
    expect(w.inventoryClickWindow?.cursor).toBeNull();
    w.apply({ type: 'set-slot', windowId: 0, slot: 20, item: null }, at);
    // Grid items are not inventory.
    expect(w.toGameState(at).inventory).toMatchObject({ known: true, value: { items: {} } });
    expect(w.toGameState(at).craftingTables).toEqual([
      { id: 'table.a', name: 'A table', position: { known: true, value: { x: 1, y: 64, z: 2 } } },
    ]);
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

  it('tracks entities, ignores its own entity id and clears everything on respawn', () => {
    const w = new WorldModel();
    w.apply(
      {
        type: 'join-game',
        entityId: 7,
        gamemode: 0,
        dimension: 0,
        difficulty: 3,
        maxPlayers: 4,
        levelType: 'RWG',
      },
      at,
    );
    w.apply(
      {
        type: 'server-position',
        x: 0,
        eyeY: 64 + PLAYER_EYE_HEIGHT,
        z: 0,
        yaw: 0,
        pitch: 0,
        onGround: false,
      },
      at,
    );
    w.apply({ type: 'spawn-mob', entityId: 7, mobType: 54, x: 1, y: 64, z: 0 }, at); // our own id: ignored
    w.apply({ type: 'spawn-mob', entityId: 8, mobType: 54, x: 3, y: 64, z: 4 }, at);
    w.applyFml(
      { type: 'fml-entity-spawn', entityId: 9, modId: 'etfuturum', typeId: 3, x: 0, y: 64, z: 2 },
      at,
    );
    w.applyFml({ type: 'fml-entity-adjust', entityId: 9, x: 0, y: 64, z: 1 }, at);
    // Not trusted until the chunks covering the scan radius have arrived and settled.
    expect(w.toGameState(at).nearbyThreats).toMatchObject({
      known: false,
      reason: /waiting for 9 nearby chunk/,
    });
    const world = flatWorld();
    const bulk = decodeFrame(
      chunkBulkFrame([-1, 0, 1].flatMap((cx) => [-1, 0, 1].map((cz) => neidColumn(cx, cz, world)))),
    );
    w.apply(bulk, at);
    expect(w.toGameState(at).nearbyThreats).toMatchObject({ known: false, reason: /settling/ });
    const later = new Date(at.getTime() + 300);
    let s = w.toGameState(later);
    expect(s.nearbyThreats).toEqual({
      known: true,
      value: {
        scanRadius: 16,
        hostileCount: 1,
        nearestHostileDistance: 5,
        unclassifiedCount: 1,
        nearestUnclassifiedDistance: 1,
      },
    });
    w.apply({ type: 'respawn', dimension: -1, difficulty: 3, gamemode: 0, levelType: 'RWG' }, at);
    w.apply(
      {
        type: 'server-position',
        x: 0,
        eyeY: 64 + PLAYER_EYE_HEIGHT,
        z: 0,
        yaw: 0,
        pitch: 0,
        onGround: false,
      },
      at,
    );
    expect(w.trackedEntityCount).toBe(0);
    expect(w.loadedChunkCount).toBe(0); // the new dimension's chunks have not arrived yet
    expect(w.toGameState(later).nearbyThreats.known).toBe(false);
    w.apply(bulk, at);
    s = w.toGameState(later);
    expect(s.nearbyThreats).toMatchObject({
      known: true,
      value: { hostileCount: 0, unclassifiedCount: 0 },
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
