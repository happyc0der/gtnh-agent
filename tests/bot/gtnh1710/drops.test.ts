import { describe, expect, it } from 'vitest';
import {
  decodePlay,
  PLAYER_EYE_HEIGHT,
  type PlayPacket,
} from '../../../src/bot/gtnh1710/packets.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import { FrameDecoder } from '../../../src/bot/gtnh1710/wire.ts';
import {
  ITEM_SETTLE_MS,
  ITEM_STILL_MS,
  WorldModel,
  type ItemEntity,
} from '../../../src/bot/gtnh1710/world-model.ts';
import {
  BLOCK,
  chunkBulkFrame,
  DIG_TEST_BLOCK_REGISTRY,
  flatWorld,
  neidColumn,
} from './fixtures/chunk-fixtures.ts';

const GTNH = { itemStackSizeVarInt: true, neid: true };
const T0 = new Date('2026-10-01T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

describe('world model: dropped items (EntityItems)', () => {
  const registry: Registry = {
    items: new Map([[363, 'minecraft:beef']]),
    blocks: new Map(DIG_TEST_BLOCK_REGISTRY),
    blockSubstitutions: [],
    itemSubstitutions: [],
  };
  // The flat test world: grass at y=105, so an item lying on it is at y = 106.125 (the centre
  // of its 0.25-high box); a log stands at (2, 106, 0).
  const LYING_Y = 106.125;

  function joined(): WorldModel {
    const w = new WorldModel();
    w.setRegistry(registry);
    w.setChunkFormat({ neid: true }); // the test server's (NotEnoughIDs), as neidColumn writes it
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
        eyeY: 106 + PLAYER_EYE_HEIGHT,
        z: 0.5,
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
    ];
    for (const p of packets) w.apply(p, T0);
    const world = flatWorld(new Map([['2,106,0', BLOCK.log]]));
    const f = new FrameDecoder().push(
      chunkBulkFrame([-1, 0, 1].flatMap((cx) => [-1, 0, 1].map((cz) => neidColumn(cx, cz, world)))),
    )[0];
    if (f === undefined) throw new Error('no frame');
    w.apply(decodePlay(f.packetId, f.body, GTNH), T0);
    return w;
  }
  /** S0E for a dropped item (type 2), then its S1C: its whole DataWatcher with the stack. */
  function drop(w: WorldModel, id: number, x: number, y: number, z: number, when = T0): void {
    w.apply({ type: 'spawn-object', entityId: id, objectType: 2, x, y, z }, when);
  }
  function stack(w: WorldModel, id: number, itemId: number, count: number, damage = 0): void {
    w.apply(
      {
        type: 'entity-metadata',
        entityId: id,
        metadata: [
          { index: 0, value: 0 },
          { index: 1, value: 300 },
          { index: 10, value: null, stack: { id: itemId, count, damage, hasNbt: false } },
        ],
      },
      T0,
    );
  }
  const near = (w: WorldModel, now: Date): ItemEntity[] => {
    const k = w.itemEntitiesNear({ x: 0.5, y: 106, z: 0.5 }, 16, now);
    if (!k.known) throw new Error(k.reason);
    return k.value;
  };

  it('tracks what each is (its stack in the DataWatcher), named as the inventory names it', () => {
    const w = joined();
    drop(w, 50, 1.5, 106.5, 0.5);
    // Before its metadata arrives, it is an item, but which is not known.
    expect(near(w, T0)).toEqual([
      expect.objectContaining({ entityId: 50, item: null, count: null, settled: false }),
    ]);
    stack(w, 50, BLOCK.log, 1, 2); // a birch log: a block item, by its block's id
    drop(w, 51, 0.5, 106.5, 3.5);
    stack(w, 51, 363, 3);
    expect(near(w, T0).map((i) => [i.entityId, i.item, i.count])).toEqual([
      [50, 'minecraft:log@2', 1],
      [51, 'minecraft:beef', 3],
    ]);
    // Never listed among the creatures; a merge grows its stack; a lost update forgets it.
    expect(w.combatEntity(50)).toBeNull();
    stack(w, 51, 363, 5);
    expect(near(w, T0).find((i) => i.entityId === 51)?.count).toBe(5);
    w.apply({ type: 'entity-metadata', entityId: 51, metadata: null }, T0);
    expect(near(w, T0).find((i) => i.entityId === 51)).toMatchObject({ item: null, count: null });
    w.markUndecodable(0x1c, 'truncated', T0);
    expect(near(w, T0).find((i) => i.entityId === 50)).toMatchObject({ item: null });
  });

  it('follows where it moves; picked up (destroyed), it is gone', () => {
    const w = joined();
    drop(w, 50, 1.5, 106.5, 0.5);
    w.apply({ type: 'entity-move', entityId: 50, dx: 0.25, dy: -0.375, dz: 0 }, at(1_000));
    expect(w.itemEntity(50, { x: 0.5, y: 106, z: 0.5 }, at(1_000))).toMatchObject({
      position: { x: 1.75, y: LYING_Y, z: 0.5 },
      spawn: { x: 1.5, y: 106.5, z: 0.5 },
      spawnedAt: T0,
      distance: expect.closeTo(Math.hypot(1.25, 0.125), 9) as unknown,
    });
    w.apply({ type: 'entity-teleport', entityId: 50, x: -2.5, y: LYING_Y, z: 0.5 }, at(2_000));
    expect(w.itemEntity(50, { x: 0.5, y: 106, z: 0.5 }, at(2_000))?.position.x).toBe(-2.5);
    w.apply({ type: 'destroy-entities', entityIds: [50] }, at(2_100));
    expect(w.itemEntity(50, { x: 0.5, y: 106, z: 0.5 }, at(2_100))).toBeNull();
    expect(near(w, at(2_100))).toEqual([]);
  });

  it('settles once it lies on a block and has not moved for 25 ticks (positions come every 20)', () => {
    const w = joined();
    // It appears in mid-air, in the middle of a dug cell: not lying on anything.
    drop(w, 50, 1.5, 106.5, 0.5);
    const settled = (ms: number): boolean =>
      w.itemEntity(50, { x: 0, y: 0, z: 0 }, at(ms))?.settled ?? false;
    expect(settled(ITEM_SETTLE_MS + 100)).toBe(false);
    // The tracker's update 20 ticks later shows it lying on the grass.
    w.apply({ type: 'entity-move', entityId: 50, dx: 0, dy: -0.375, dz: 0 }, at(1_000));
    expect(settled(1_000 + ITEM_SETTLE_MS - 50)).toBe(false);
    expect(settled(1_000 + ITEM_SETTLE_MS)).toBe(true);
    // A move of nothing (the tracker's every 60 ticks) is no move.
    w.apply({ type: 'entity-move', entityId: 50, dx: 0, dy: 0, dz: 0 }, at(3_000));
    expect(settled(3_000)).toBe(true);
    // Moving again (pushed off), it must lie still again first.
    w.apply({ type: 'entity-move', entityId: 50, dx: 0.5, dy: 0, dz: 0 }, at(4_000));
    expect(settled(4_100)).toBe(false);
    expect(settled(4_000 + ITEM_SETTLE_MS)).toBe(true);
  });

  it('lying on the edge of a block counts; over air it does not, until it has been still long', () => {
    const w = joined();
    // On top of the log at (2, 106, 0), at its east edge: half its box over the log.
    drop(w, 50, 3.05, 107.125, 0.5);
    expect(w.itemEntity(50, { x: 0, y: 0, z: 0 }, at(ITEM_SETTLE_MS))?.settled).toBe(true);
    // In mid-air, where a drop appears: not on a block, so it counts as settled only once it
    // has not moved for ITEM_STILL_MS (past the tracker's forced update every 60 ticks).
    drop(w, 51, 0.5, 106.5, 2.5);
    expect(w.itemEntity(51, { x: 0, y: 0, z: 0 }, at(ITEM_STILL_MS - 50))?.settled).toBe(false);
    expect(w.itemEntity(51, { x: 0, y: 0, z: 0 }, at(ITEM_STILL_MS))?.settled).toBe(true);
  });

  it('is unknown while an entity update was lost (an item may be missing or misplaced)', () => {
    const w = joined();
    drop(w, 50, 1.5, LYING_Y, 0.5);
    w.markUndecodable(0x15, 'truncated', T0);
    expect(w.itemEntitiesNear({ x: 0, y: 106, z: 0 }, 16, T0)).toMatchObject({
      known: false,
      reason: /undecodable entity packet 0x15/,
    });
  });
});
