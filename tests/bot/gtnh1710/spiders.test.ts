import { describe, expect, it } from 'vitest';
import {
  decodePlay,
  PLAYER_EYE_HEIGHT,
  type PlayPacket,
} from '../../../src/bot/gtnh1710/packets.ts';
import type { Registry } from '../../../src/bot/gtnh1710/registry.ts';
import { FrameDecoder } from '../../../src/bot/gtnh1710/wire.ts';
import { WorldModel } from '../../../src/bot/gtnh1710/world-model.ts';
import type { GameState } from '../../../src/domain/game-state.ts';
import { assessDangers, assessStateReliability } from '../../../src/safety/safety-policy.ts';
import { safetyCtx } from '../../fixtures/index.ts';
import {
  BLOCK,
  chunkBulkFrame,
  DIG_TEST_BLOCK_REGISTRY,
  flatWorld,
  neidColumn,
  openSkyLight,
  type BlockFn,
  type LightFn,
} from './chunk-fixtures.ts';

const GTNH = { itemStackSizeVarInt: true, neid: true };
const T = new Date('2026-10-01T12:00:00.000Z');
const after = (ms: number): Date => new Date(T.getTime() + ms);
const NOON = 6000;
const MIDNIGHT = 18000;
const SPIDER = 52;
const CAVE_SPIDER = 59;

const registry: Registry = {
  items: new Map(),
  blocks: new Map(DIG_TEST_BLOCK_REGISTRY),
  blockSubstitutions: [],
  itemSubstitutions: [],
};

/** A world model for a GTNH server: the registry, and NotEnoughIDs' chunk layout. */
function model(): WorldModel {
  const w = new WorldModel();
  w.setRegistry(registry);
  w.setChunkFormat({ neid: true });
  return w;
}

/**
 * A joined world (the overworld by default) at `dayTicks` (noon), the player standing at
 * (0.5, 106, 0.5) on the flat test world's grass floor, the chunks around it arrived with
 * their light (open sky by default), health, food and an empty inventory known.
 */
function joined(
  opts: { dayTicks?: number; world?: BlockFn; light?: LightFn; dimension?: number } = {},
): WorldModel {
  const w = model();
  const world = opts.world ?? flatWorld();
  const packets: PlayPacket[] = [
    {
      type: 'join-game',
      entityId: 7,
      gamemode: 0,
      dimension: opts.dimension ?? 0,
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
    // The (re)join's time update; without rain no weather follows it.
    { type: 'time-update', worldAge: 0, dayTicks: opts.dayTicks ?? NOON, daylightCycle: true },
    { type: 'window-items', windowId: 0, items: Array.from({ length: 46 }, () => null) },
    { type: 'update-health', health: 20, food: 20, saturation: 5 },
  ];
  for (const p of packets) w.apply(p, T);
  const light = opts.light ?? openSkyLight(world);
  const columns = [-2, -1, 0, 1, 2].flatMap((cx) =>
    [-2, -1, 0, 1, 2].map((cz) =>
      neidColumn(cx, cz, world, true, true, undefined, undefined, light),
    ),
  );
  const frame = new FrameDecoder().push(chunkBulkFrame(columns))[0];
  if (frame === undefined) throw new Error('no frame');
  w.apply(decodePlay(frame.packetId, frame.body, GTNH), T);
  return w;
}

const spawn = (entityId: number, x: number, z: number, mobType = SPIDER, y = 106): PlayPacket => ({
  type: 'spawn-mob',
  entityId,
  mobType,
  x,
  y,
  z,
  metadata: [{ index: 6, value: 16 }],
});

/** Whether the world model counts entity `id` (within 32 blocks) as a calm spider at `now`. */
const calm = (w: WorldModel, id = 20, now = after(1000)): boolean | undefined =>
  w.nearbyEntities(32, now).find((e) => e.entityId === id)?.calm;

function observe(w: WorldModel, now = after(1000)): GameState {
  return w.toGameState(now);
}

const inconsistencies = (s: GameState, now = after(1000)): string[] =>
  assessStateReliability(s, safetyCtx(undefined, now))
    .filter((v) => v.code === 'STATE_INCONSISTENT')
    .map((v) => v.message);

describe('spiders in the light (EntitySpider.findPlayerToAttack)', () => {
  it('a spider on open ground at noon is calm: listed, but no threat and no danger', () => {
    const w = joined();
    w.apply(spawn(20, 8.5, 0.5), T);
    const s = observe(w);
    expect(s.nearbyThreats).toMatchObject({
      known: true,
      value: { hostileCount: 0, nearestHostileDistance: null },
    });
    if (!s.nearbyEntities.known) throw new Error(s.nearbyEntities.reason);
    expect(s.nearbyEntities.value.entities).toEqual([
      expect.objectContaining({ id: 20, type: 'minecraft:Spider', distance: 8, calm: true }),
    ]);
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(15);
    expect(inconsistencies(s)).toEqual([]);
    expect(assessDangers(s, safetyCtx(undefined, after(1000)))).toEqual([]);
  });

  it('at midnight the same spider is a threat (sky light 15 - 11 = 4)', () => {
    const w = joined({ dayTicks: MIDNIGHT });
    w.apply(spawn(20, 8.5, 0.5), T);
    const s = observe(w);
    expect(calm(w)).toBe(false);
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(4);
    expect(s.nearbyThreats).toMatchObject({
      value: { hostileCount: 1, nearestHostileDistance: 8 },
    });
    expect(inconsistencies(s)).toEqual([]);
    expect(assessDangers(s, safetyCtx(undefined, after(1000))).map((v) => v.code)).toEqual([
      'HOSTILES_NEARBY',
    ]);
  });

  it('light 11 is dark, 12 is light (under a roof, by block light alone)', () => {
    const roofed = (level: number): WorldModel => {
      const roof = new Map<string, number>();
      for (let x = 4; x <= 12; x++)
        for (let z = -4; z <= 5; z++) roof.set(`${x},109,${z}`, BLOCK.stone);
      const world = flatWorld(roof);
      const sky = openSkyLight(world);
      const under = (x: number, y: number, z: number): boolean =>
        x >= 4 && x <= 12 && z >= -4 && z <= 5 && y >= 106 && y <= 108;
      const w = joined({
        world,
        light: (x, y, z) => ({ ...sky(x, y, z), block: under(x, y, z) ? level : 0 }),
      });
      w.apply(spawn(20, 8.5, 0.5), T);
      return w;
    };
    const dim = roofed(11);
    expect(dim.lightLevelAt(8, 106, 0, after(1000))).toBe(11);
    expect(calm(dim)).toBe(false);
    const lit = roofed(12);
    expect(lit.lightLevelAt(8, 106, 0, after(1000))).toBe(12);
    expect(calm(lit)).toBe(true);
  });

  it('at dusk the open sky gives 12 until tick 12540 and 11 from 12541 (with 2 s to spare)', () => {
    const early = joined({ dayTicks: 12_450 });
    early.apply(spawn(20, 8.5, 0.5), T);
    expect(calm(early)).toBe(true);
    const late = joined({ dayTicks: 12_600 });
    late.apply(spawn(20, 8.5, 0.5), T);
    expect(calm(late)).toBe(false);
    // Under 2 s before the change, the clock's margin already counts it as dark.
    const edge = joined({ dayTicks: 12_490 });
    edge.apply(spawn(20, 8.5, 0.5), T);
    expect(calm(edge)).toBe(false);
  });

  it('no spider is calm for 15 s after the player was hurt (the bite may have been its)', () => {
    const w = joined();
    w.apply(spawn(20, 8.5, 0.5), T);
    expect(calm(w)).toBe(true);
    const bitten = after(500);
    w.apply({ type: 'update-health', health: 17, food: 20, saturation: 5 }, bitten);
    const s = observe(w);
    expect(calm(w)).toBe(false);
    expect(s.player.lastHurtAt).toBe(bitten.toISOString());
    expect(s.nearbyThreats).toMatchObject({ value: { hostileCount: 1 } });
    expect(inconsistencies(s)).toEqual([]);
    // 15.5 s after the bite (packets keep arriving), it is calm again: it was never hit itself.
    w.apply({ type: 'keep-alive', id: 1 }, after(16_000));
    expect(calm(w, 20, after(16_000))).toBe(true);
  });

  it('a spider within its leap (6 blocks) counts as a threat whatever the light', () => {
    const w = joined();
    w.apply(spawn(20, 5.5, 0.5), T); // 5 blocks
    w.apply(spawn(21, 0.5, 7), T); // 6.5 blocks
    const s = observe(w);
    expect([calm(w, 20), calm(w, 21)]).toEqual([false, true]);
    expect(s.nearbyThreats).toMatchObject({
      value: { hostileCount: 1, nearestHostileDistance: 5 },
    });
    expect(inconsistencies(s)).toEqual([]);
  });

  it('a spider seen in the dark within its reach stays a threat in the light; one seen far does not', () => {
    const w = joined({ dayTicks: MIDNIGHT });
    w.apply(spawn(20, 8.5, 0.5), T); // 8 blocks, in the dark: may pick the player
    w.apply(spawn(21, 0.5, 20.5), T); // 20 blocks: beyond EntitySpider's 16 (and the margin)
    w.apply({ type: 'time-update', worldAge: 0, dayTicks: NOON, daylightCycle: true }, after(500));
    w.apply({ type: 'entity-teleport', entityId: 21, x: 0.5, y: 106, z: 9.5 }, after(600));
    expect(calm(w, 20)).toBe(false);
    expect(calm(w, 21)).toBe(true);
    expect(w.trackedEntities().find((e) => e.entityId === 20)?.mayTarget).toMatch(
      /seen in light 4, 8\.0 blocks from the player/,
    );
    // Walking up to a spider in the dark counts the same.
    const v = joined({ dayTicks: MIDNIGHT });
    v.apply(spawn(30, 0.5, 20.5), T);
    v.setOwnPosition({ x: 0.5, y: 106, z: 8.5 });
    v.apply({ type: 'time-update', worldAge: 0, dayTicks: NOON, daylightCycle: true }, after(500));
    v.setOwnPosition({ x: 0.5, y: 106, z: 0.5 });
    expect(calm(v, 30)).toBe(false);
  });

  it('a spider seen hurt is never calm again (a blow makes the attacker its target)', () => {
    const w = joined();
    w.apply(spawn(20, 8.5, 0.5), T);
    w.apply({ type: 'entity-status', entityId: 20, status: 2 }, after(500));
    w.apply({ type: 'keep-alive', id: 1 }, after(60_000));
    expect(calm(w, 20, after(60_000))).toBe(false);
    expect(w.combatEntity(20, after(60_000))).toMatchObject({ calm: false, hurtCount: 1 });
  });

  it('cave spiders too (their light at 0.33 of their 0.5 height); Special Mobs spiders never', () => {
    const w = joined();
    w.setServerMods([{ modid: 'SpecialMobs', version: '3.6.3' }]);
    w.apply(spawn(20, 8.5, 0.5, CAVE_SPIDER), T);
    w.applyFml(
      {
        type: 'fml-entity-spawn',
        entityId: 21,
        modId: 'SpecialMobs',
        typeId: 78,
        x: 0.5,
        y: 106,
        z: 9.5,
      },
      T,
    );
    const s = observe(w);
    if (!s.nearbyEntities.known) throw new Error(s.nearbyEntities.reason);
    expect(s.nearbyEntities.value.entities.map((e) => [e.type, e.calm])).toEqual([
      ['minecraft:CaveSpider', true],
      ['SpecialMobs.SpecialSpider', false],
    ]);
    expect(s.nearbyThreats).toMatchObject({
      value: { hostileCount: 1, nearestHostileDistance: 9 },
    });
  });

  it('rain keeps the open sky at 12 by day; a thunderstorm darkens it to 10', () => {
    const w = joined();
    w.apply(spawn(20, 8.5, 0.5), T);
    // It starts raining (WorldServer.updateWeather: 1, then both strengths, raw). Between the
    // rain and the thunder update the thunder is not known: not calm for that moment, but
    // nothing that was not seen marks the spider.
    w.apply({ type: 'change-game-state', reason: 1, value: 0 }, after(100));
    w.apply({ type: 'change-game-state', reason: 7, value: 1 }, after(100));
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(10);
    expect(calm(w)).toBe(false);
    w.apply({ type: 'change-game-state', reason: 8, value: 0 }, after(100));
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(12);
    expect(calm(w)).toBe(true);
    w.apply({ type: 'change-game-state', reason: 8, value: 1 }, after(200));
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(10);
    expect(calm(w)).toBe(false);
    // In the dark within its reach: after the storm it may still be after the player.
    w.apply({ type: 'change-game-state', reason: 8, value: 0 }, after(300));
    expect(w.lightLevelAt(8, 106, 0, after(1000))).toBe(12);
    expect(calm(w)).toBe(false);
  });

  it('the (re)join weather: the thunder it sends is weighted by the rain', () => {
    const w = model();
    const world = flatWorld();
    const joinPackets: PlayPacket[] = [
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
      { type: 'time-update', worldAge: 0, dayTicks: NOON, daylightCycle: true },
      // updateTimeAndWeatherForPlayer while it rains at half strength in a full storm:
      { type: 'change-game-state', reason: 1, value: 0 },
      { type: 'change-game-state', reason: 7, value: 0.5 },
      { type: 'change-game-state', reason: 8, value: 0.5 }, // thunder 1 x rain 0.5
    ];
    for (const p of joinPackets) w.apply(p, T);
    const columns = [-1, 0, 1].flatMap((cx) =>
      [-1, 0, 1].map((cz) =>
        neidColumn(cx, cz, world, true, true, undefined, undefined, openSkyLight(world)),
      ),
    );
    const frame = new FrameDecoder().push(chunkBulkFrame(columns))[0];
    if (frame === undefined) throw new Error('no frame');
    w.apply(decodePlay(frame.packetId, frame.body, GTNH), T);
    // The rain gets stronger; the storm (steady) is not sent again.
    w.apply({ type: 'change-game-state', reason: 7, value: 1 }, after(100));
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBe(10);
  });

  it('weather not known: before the join time update nothing is lit; rain with thunder not known is a storm', () => {
    const w = model();
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
      T,
    );
    w.apply(
      {
        type: 'server-position',
        x: 0.5,
        eyeY: 106 + PLAYER_EYE_HEIGHT,
        z: 0.5,
        yaw: 0,
        pitch: 0,
        onGround: true,
      },
      T,
    );
    const world = flatWorld();
    const columns = [-1, 0, 1].flatMap((cx) =>
      [-1, 0, 1].map((cz) =>
        neidColumn(cx, cz, world, true, true, undefined, undefined, openSkyLight(world)),
      ),
    );
    const frame = new FrameDecoder().push(chunkBulkFrame(columns))[0];
    if (frame === undefined) throw new Error('no frame');
    w.apply(decodePlay(frame.packetId, frame.body, GTNH), T);
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBeUndefined();
    w.apply({ type: 'time-update', worldAge: 0, dayTicks: NOON, daylightCycle: true }, after(100));
    w.apply({ type: 'keep-alive', id: 1 }, after(100));
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBe(15);
    // Rain that began fading in before the join (under 0.2: no weather at the join): the
    // thunder was never sent, so a storm is assumed.
    w.apply({ type: 'change-game-state', reason: 7, value: 1 }, after(200));
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBe(10);
    w.apply({ type: 'change-game-state', reason: 8, value: 0 }, after(300));
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBe(12);
    // A weather update that did not decode: not known for the rest of the connection.
    w.markUndecodable(0x2b, 'test', after(400));
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBeUndefined();
  });

  it('outside the overworld no spider is calm (its brightness table is the one verified)', () => {
    const w = joined({ dimension: -1 });
    w.apply(spawn(20, 8.5, 0.5), T);
    expect(calm(w)).toBe(false);
  });

  it('a section not sent (only air) is lit by the sky where nothing is above; not known under an overhang', () => {
    // A stone ledge at y 111 (the spider stands on it at 112: section 7, all air, not sent).
    const blocks = new Map<string, number>();
    for (let x = 7; x <= 10; x++)
      for (let z = -1; z <= 2; z++) blocks.set(`${x},111,${z}`, BLOCK.stone);
    const open = joined({ world: flatWorld(blocks) });
    open.apply(spawn(20, 8.5, 0.5, SPIDER, 112), T);
    expect(open.lightLevelAt(8, 112, 0, after(1000))).toBe(15);
    expect(calm(open)).toBe(true);
    // A block far above the spider (section 8): its light is not known.
    const overhang = joined({ world: flatWorld(new Map([...blocks, ['8,130,0', BLOCK.stone]])) });
    overhang.apply(spawn(20, 8.5, 0.5, SPIDER, 112), T);
    expect(overhang.lightLevelAt(8, 112, 0, after(1000))).toBeUndefined();
    expect(calm(overhang)).toBe(false);
  });

  it('a block that may take its neighbours brightness (a plant) reads the darker of the two', () => {
    const world = flatWorld(new Map([['3,106,3', BLOCK.tallgrass]]));
    const sky = openSkyLight(world);
    // The plant's own cell 15, the cells above and beside it 11 (contrived, to tell them apart).
    const around = new Set(['3,107,3', '4,106,3', '2,106,3', '3,106,4', '3,106,2']);
    const w = joined({
      world,
      light: (x, y, z) => {
        if (around.has(`${x},${y},${z}`)) return { block: 11, sky: 0 };
        return x === 3 && y === 106 && z === 3 ? { block: 0, sky: 15 } : sky(x, y, z);
      },
    });
    expect(w.lightLevelAt(3, 106, 3, after(1000))).toBe(11);
    expect(w.lightLevelAt(4, 106, 3, after(1000))).toBe(11); // air: its own light
    expect(w.lightLevelAt(6, 106, 6, after(1000))).toBe(15);
  });
});
