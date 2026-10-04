import { describe, expect, it } from 'vitest';
import {
  decodeFmlRuntimeMessage,
  decodePlay,
  outbound,
  PLAYER_EYE_HEIGHT,
  readEntityMetadata,
  type PlayPacket,
} from '../../../src/bot/gtnh1710/packets.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import {
  encodeString,
  encodeVarInt,
  FrameDecoder,
  i32,
  ProtocolError,
  Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import { WorldModel } from '../../../src/bot/gtnh1710/world-model.ts';
import { GameStateSchema } from '../../../src/domain/game-state.ts';
import {
  chunkBulkFrame,
  flatWorld,
  neidColumn,
  TEST_BLOCK_REGISTRY,
} from './fixtures/chunk-fixtures.ts';
import { encodeMetadata } from './fixtures/fake-combat.ts';

const GTNH = { itemStackSizeVarInt: true, neid: true };
const at = new Date('2026-09-30T12:00:00.000Z');
const later = new Date(at.getTime() + 1_000);
const fixed = (x: number, y: number, z: number) =>
  Buffer.concat([i32(Math.floor(x * 32)), i32(Math.floor(y * 32)), i32(Math.floor(z * 32))]);

describe('C02 Use Entity', () => {
  it('attacks: i32 entity id, then action 1 (ATTACK); INTERACT cannot be expressed', () => {
    const p = outbound.attackEntity(300);
    expect(p.kind).toBe('attack-entity');
    const f = new FrameDecoder().push(p.frame)[0];
    expect(f?.packetId).toBe(0x02);
    const r = f?.body ?? new Reader(Buffer.alloc(0));
    expect([r.i32(), r.u8(), r.remaining]).toEqual([300, 1, 0]);
    expect(() => outbound.attackEntity(1.5)).toThrow(ProtocolError);
    expect(() => outbound.attackEntity(2 ** 31)).toThrow(ProtocolError);
  });
});

describe('entity metadata (DataWatcher)', () => {
  it('reads every 1.7.10 value type, item stacks in the ModularUI format', () => {
    const stack = Buffer.concat([
      Buffer.from([0x01, 0x28, 3, 0, 0, 0xff, 0xff]), // id 296, 3 items, damage 0, no NBT
      encodeVarInt(3), // ModularUI's stack size
    ]);
    const body = Buffer.concat([
      Buffer.from([(0 << 5) | 0, 0x02]), // byte
      Buffer.from([(1 << 5) | 1, 0x01, 0x2c]), // short 300
      Buffer.from([(2 << 5) | 12]),
      i32(-24000), // int
      encodeMetadata([{ index: 6, type: 'float', value: 7.5 }]).subarray(0, 5), // float
      Buffer.from([(4 << 5) | 10]),
      encodeString('Bessie'),
      Buffer.from([(5 << 5) | 13]),
      stack,
      Buffer.from([(6 << 5) | 14]),
      i32(1),
      i32(2),
      i32(3),
      Buffer.from([0x7f]),
    ]);
    expect(readEntityMetadata(new Reader(body), GTNH)).toEqual([
      { index: 0, value: 2 },
      { index: 1, value: 300 },
      { index: 12, value: -24000 },
      { index: 6, value: 7.5 },
      { index: 10, value: 'Bessie' },
      // An item stack is kept apart from the values (a dropped item's says what it is).
      { index: 13, value: null, stack: { id: 296, count: 3, damage: 0, hasNbt: false } },
      { index: 14, value: null },
    ]);
  });

  it('throws on a type 1.7.10 does not have, or a list without its end', () => {
    expect(() => readEntityMetadata(new Reader(Buffer.from([0xe0, 0, 0x7f])))).toThrow(
      /unknown entity metadata type 7/,
    );
    expect(() => readEntityMetadata(new Reader(Buffer.from([0x00, 1])))).toThrow(ProtocolError);
  });

  it('decodes S19 status and S1C metadata; undecodable entries keep the entity id', () => {
    expect(decodePlay(0x1a, new Reader(Buffer.concat([i32(300), Buffer.from([3])])))).toEqual({
      type: 'entity-status',
      entityId: 300,
      status: 3,
    });
    const health = encodeMetadata([{ index: 6, type: 'float', value: 12 }]);
    expect(decodePlay(0x1c, new Reader(Buffer.concat([i32(300), health])))).toEqual({
      type: 'entity-metadata',
      entityId: 300,
      metadata: [{ index: 6, value: 12 }],
    });
    expect(decodePlay(0x1c, new Reader(Buffer.concat([i32(300), Buffer.from([0x66, 1])])))).toEqual(
      { type: 'entity-metadata', entityId: 300, metadata: null },
    );
  });

  it('reads the full watcher of a vanilla and a Forge spawn (and skips one that does not decode)', () => {
    const meta = encodeMetadata([
      { index: 6, type: 'float', value: 10 },
      { index: 10, type: 'string', value: '' },
      { index: 12, type: 'int', value: 0 },
    ]);
    const spawn = Buffer.concat([
      encodeVarInt(301),
      Buffer.from([92]),
      fixed(1, 64, 2),
      Buffer.alloc(9),
      meta,
    ]);
    expect(decodePlay(0x0f, new Reader(spawn), GTNH)).toEqual({
      type: 'spawn-mob',
      entityId: 301,
      mobType: 92,
      x: 1,
      y: 64,
      z: 2,
      metadata: [
        { index: 6, value: 10 },
        { index: 10, value: '' },
        { index: 12, value: 0 },
      ],
    });
    const fml = Buffer.concat([
      Buffer.from([2]),
      i32(77),
      encodeString('SpecialMobs'),
      i32(19),
      fixed(-40, 70, 12.5),
      Buffer.from([1, 2, 3]),
      encodeMetadata([{ index: 6, type: 'float', value: 20 }]),
      i32(0),
    ]);
    expect(decodeFmlRuntimeMessage(fml, GTNH)).toMatchObject({
      type: 'fml-entity-spawn',
      entityId: 77,
      typeId: 19,
      metadata: [{ index: 6, value: 20 }],
    });
    // A bad watcher: the spawn itself still counts, without metadata.
    const bad = Buffer.concat([spawn.subarray(0, spawn.length - meta.length), Buffer.from([0xe5])]);
    const decoded = decodePlay(0x0f, new Reader(bad), GTNH);
    expect(decoded).toMatchObject({ type: 'spawn-mob', entityId: 301 });
    expect('metadata' in decoded).toBe(false);
  });
});

describe('world model: what combat sees', () => {
  const registry: Registry = {
    items: new Map([
      [258, 'minecraft:iron_axe'],
      [267, 'minecraft:iron_sword'],
      [297, 'minecraft:bread'],
    ]),
    blocks: new Map(TEST_BLOCK_REGISTRY),
    blockSubstitutions: [],
    itemSubstitutions: [],
  };

  /** A joined world at (0, 64, 0) with its chunks settled. */
  function joined(): WorldModel {
    const w = new WorldModel();
    w.setRegistry(registry);
    const packets: PlayPacket[] = [
      {
        type: 'join-game',
        entityId: 7,
        gamemode: 0,
        dimension: 0,
        difficulty: 3,
        maxPlayers: 4,
        levelType: 'RWG',
      },
      {
        type: 'server-position',
        x: 0.5,
        eyeY: 64 + PLAYER_EYE_HEIGHT,
        z: 0.5,
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
    ];
    for (const p of packets) w.apply(p, at);
    const f = new FrameDecoder().push(
      chunkBulkFrame(
        [-1, 0, 1].flatMap((cx) => [-1, 0, 1].map((cz) => neidColumn(cx, cz, flatWorld()))),
      ),
    )[0];
    if (f === undefined) throw new Error('no frame');
    w.apply(decodePlay(f.packetId, f.body, GTNH), at);
    return w;
  }
  const entities = (w: WorldModel, now = later) => {
    const s = w.toGameState(now);
    if (!s.nearbyEntities.known) throw new Error(s.nearbyEntities.reason);
    return s.nearbyEntities.value;
  };

  it('lists creatures with health, owner and age, and agrees with the threat counts', () => {
    const w = joined();
    w.apply(
      {
        type: 'spawn-mob',
        entityId: 8,
        mobType: 54,
        x: 3.5,
        y: 64,
        z: 0.5,
        metadata: [{ index: 6, value: 20 }],
      },
      at,
    );
    w.apply(
      {
        type: 'spawn-mob',
        entityId: 9,
        mobType: 92,
        x: 0.5,
        y: 64,
        z: 4.5,
        metadata: [
          { index: 6, value: 10 },
          { index: 10, value: '' },
          { index: 12, value: 0 },
        ],
      },
      at,
    );
    w.apply({ type: 'spawn-object', entityId: 10, objectType: 2, x: 1, y: 64, z: 1 }, at); // an item
    w.apply({ type: 'spawn-player', entityId: 11, name: 'DankAxon', x: 5, y: 64, z: 5 }, at);
    const value = entities(w);
    expect(value.entities.map((e) => [e.id, e.type, e.category, e.kind, e.health])).toEqual([
      [8, 'minecraft:Zombie', 'hostile', 'mob', 20],
      [9, 'minecraft:Cow', 'passive', 'mob', 10],
      [11, 'player', 'player', 'player', null],
    ]);
    expect(value.entities[1]).toMatchObject({ owned: false, baby: false, distance: 4 });
    // Player names never reach the state; dropped items are not listed.
    expect(JSON.stringify(value)).not.toContain('DankAxon');
    // The state as a whole passes its schema and its own consistency rules.
    expect(GameStateSchema.safeParse(w.toGameState(later)).success).toBe(true);
    expect(w.toGameState(later).nearbyThreats).toMatchObject({
      known: true,
      value: { hostileCount: 1 },
    });
  });

  it('follows health, hurt and death; a dying mob no longer counts as a threat', () => {
    const w = joined();
    w.apply(
      {
        type: 'spawn-mob',
        entityId: 8,
        mobType: 54,
        x: 2.5,
        y: 64,
        z: 0.5,
        metadata: [{ index: 6, value: 20 }],
      },
      at,
    );
    const hit = new Date(at.getTime() + 500);
    w.apply({ type: 'entity-status', entityId: 8, status: 2 }, hit);
    w.apply({ type: 'entity-metadata', entityId: 8, metadata: [{ index: 6, value: 14 }] }, hit);
    expect(entities(w).entities[0]).toMatchObject({
      id: 8,
      health: 14,
      lastHurtAt: hit.toISOString(),
    });
    expect(w.combatEntity(8)).toMatchObject({ hurtCount: 1, dead: false });

    const death = new Date(at.getTime() + 900);
    w.apply({ type: 'entity-status', entityId: 8, status: 2 }, death);
    w.apply({ type: 'entity-status', entityId: 8, status: 3 }, death);
    expect(w.hasDied(8)).toBe(true);
    const after = entities(w);
    expect(after.entities).toEqual([]);
    expect(after.recentDeaths).toEqual([
      { id: 8, type: 'minecraft:Zombie', at: death.toISOString() },
    ]);
    expect(w.toGameState(later).nearbyThreats).toMatchObject({ value: { hostileCount: 0 } });
    // Removed 20 ticks later: the death stays on record.
    w.apply({ type: 'destroy-entities', entityIds: [8] }, later);
    expect(entities(w).recentDeaths).toHaveLength(1);
  });

  it('a lost metadata update makes the values it may have changed unknown', () => {
    const w = joined();
    w.apply(
      {
        type: 'spawn-mob',
        entityId: 9,
        mobType: 92,
        x: 0.5,
        y: 64,
        z: 2.5,
        metadata: [
          { index: 6, value: 10 },
          { index: 10, value: '' },
          { index: 12, value: 0 },
        ],
      },
      at,
    );
    w.apply({ type: 'entity-metadata', entityId: 9, metadata: null }, at);
    expect(entities(w).entities[0]).toMatchObject({ health: null, owned: null, baby: null });
    // Later changes are known again.
    w.apply({ type: 'entity-metadata', entityId: 9, metadata: [{ index: 6, value: 8 }] }, at);
    expect(entities(w).entities[0]).toMatchObject({ health: 8, owned: null });
    // An undecodable S1C (which entity is not known): every entity's values go.
    w.markUndecodable(0x1c, 'truncated', at);
    expect(entities(w).entities[0]).toMatchObject({ health: null });
  });

  it('reports the weapon: the best allowlisted axe in the hotbar, else a bare hand', () => {
    const w = joined();
    const items: Array<{ id: number; count: number; damage: number; hasNbt: boolean } | null> =
      Array.from({ length: 45 }, () => null);
    items[36] = { id: 297, count: 2, damage: 0, hasNbt: false };
    items[38] = { id: 267, count: 1, damage: 0, hasNbt: false }; // a sword: useless here
    w.apply({ type: 'window-items', windowId: 0, items }, at);
    expect(w.toGameState(later).player.weapon).toEqual({
      known: true,
      value: { item: null, damage: 1 },
    });
    items[40] = { id: 258, count: 1, damage: 17, hasNbt: false }; // a worn iron axe
    w.apply({ type: 'window-items', windowId: 0, items: [...items] }, at);
    expect(w.toGameState(later).player.weapon).toEqual({
      known: true,
      value: { item: 'minecraft:iron_axe', damage: 6 },
    });
    // No weapon and no empty hotbar slot: the agent cannot strike at all.
    const full = items.map((s, i) =>
      i >= 36 ? { id: 297, count: 1, damage: 0, hasNbt: false } : s,
    );
    w.apply({ type: 'window-items', windowId: 0, items: full }, at);
    expect(w.toGameState(later).player.weapon).toMatchObject({
      known: false,
      reason: /cannot strike/,
    });
  });
});
