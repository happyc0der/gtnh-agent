import { createServer, type Server, type Socket } from 'node:net';
import {
  encodeFrame,
  encodeString,
  encodeVarInt,
  encodeVarShort,
  f32,
  f64,
  FrameDecoder,
  i32,
  Reader,
} from '../../../src/bot/gtnh1710/wire.ts';
import { encodeStack, FakeChestSim, type FakeChest, type FakeRecipe } from './fake-chests.ts';
import { FakeDigSim, type FakeDigOptions } from './fake-digging.ts';
import { FakePlaceSim, type FakeBody, type FakePlaceOptions } from './fake-placing.ts';
import {
  blockChangeFrame,
  chunkBulkFrame,
  flatWorld,
  multiBlockChangeFrame,
  neidColumn,
  TEST_BLOCK_REGISTRY,
} from './chunk-fixtures.ts';

/**
 * A scripted stand-in for a GTNH 1.7.10 Forge server, following the sequence observed
 * against the real test server on 2026-09-30:
 *   status ping (optionally "still starting" first) -> login -> REGISTER + FML ServerHello
 *   -> mod lists -> ModIdData (large, Forge varshort length) + acks -> Join Game, spawn,
 *   position, held slot, inventory -> health only once the client ticks the player.
 * It records every packet the client sends so tests can assert the client stayed read-only.
 */

export interface FakeItem {
  slot: number;
  id: number;
  count: number;
  damage: number;
  /** A stack with (trivial) NBT data. */
  nbt?: boolean | undefined;
}

export interface FakeServerOptions {
  motd?: string;
  versionName?: string;
  modinfoType?: string;
  mods?: Array<{ modid: string; version: string }>;
  stillStartingPings?: number;
  onlineMode?: boolean;
  kickOnLogin?: string;
  items?: Array<[number, string]>;
  blocks?: Array<[number, string]>;
  /** Extra registry entries so ModIdData exceeds 32767 bytes (exercises Forge's varshort). */
  registryFiller?: number;
  spawn?: { x: number; eyeY: number; z: number; yaw: number; pitch: number };
  inventory?: FakeItem[];
  windowSlots?: number;
  health?: { health: number; food: number; saturation: number };
  keepAliveEveryMs?: number;
  /** Send a truncated inventory packet (the client must degrade, not disconnect). */
  corruptInventory?: boolean;
  /** Entities present when the client joins. */
  entities?: FakeEntity[];
  /** Blocks that differ from the flat test world ("x,y,z" -> id). */
  blockOverrides?: ReadonlyMap<string, number>;
  /** Columns ("x,z") with no blocks at all (holes to the void). */
  voidColumns?: ReadonlySet<string>;
  /** Send chunk bulks whose data does not inflate. */
  corruptChunks?: boolean;
  /** Stream the chunk columns around spawn after joining, as the real server does (default true). */
  sendChunks?: boolean;
  /** Vanilla chests (their blocks must also be in blockOverrides). */
  chests?: FakeChest[];
  /** Crafting tables (their blocks must also be in blockOverrides). */
  tables?: Array<{ x: number; y: number; z: number }>;
  /** The server's crafting recipes (for the 2x2 grid and crafting tables). */
  recipes?: FakeRecipe[];
  /** 1-based click numbers the server rejects (as if the client's claim did not match). */
  rejectClicks?: number[];
  /** How the server treats digging (C07); vanilla by default. */
  dig?: FakeDigOptions;
  /** How the server treats block placement (C08 with a held block); vanilla by default. */
  place?: FakePlaceOptions;
}

export interface ReceivedPacket {
  state: 'handshaking' | 'status' | 'login' | 'play';
  id: number;
  body: Buffer;
}

export interface ConfirmedPosition {
  x: number;
  feetY: number;
  headY: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export const DEFAULT_MODS = [
  { modid: 'mcp', version: '9.05' },
  { modid: 'FML', version: '7.10.99.99' },
  { modid: 'Forge', version: '10.13.4.1614' },
  { modid: 'gregtech', version: 'MC1710' },
  { modid: 'gregtech_nh', version: '5.09.51.482' },
  { modid: 'dreamcraft', version: '2.7.268' },
  { modid: 'modularui', version: '1.2.20' },
  { modid: 'neid', version: '2.1.10' },
];

const plugin = (channel: string, data: Buffer): Buffer =>
  encodeFrame(0x3f, Buffer.concat([encodeString(channel), encodeVarShort(data.length), data]));

/** GregTech TILE_ENTITY (type 0): a machine (or pipe) and its common data byte. */
export function gtTileEntityMessage(
  x: number,
  y: number,
  z: number,
  metaTileId: number,
  common: number,
): Buffer {
  const b = Buffer.alloc(1 + 4 + 2 + 4 + 2 + 6 * 4 + 4);
  b.writeUInt8(0, 0);
  b.writeInt32BE(x, 1);
  b.writeInt16BE(y, 5);
  b.writeInt32BE(z, 7);
  b.writeInt16BE(metaTileId, 11);
  b.writeUInt8(common, 37); // after six zero cover ids
  return b;
}

/** GregTech BLOCK_EVENT (type 2), coordinates packed like GTNHLib's CoordinatePacker. */
export function gtBlockEventsMessage(
  dimension: number,
  events: Array<{ x: number; y: number; z: number; eventId: number; value: number }>,
): Buffer {
  const b = Buffer.alloc(1 + 4 + 4 + events.length * 10);
  b.writeUInt8(2, 0);
  b.writeInt32BE(dimension, 1);
  b.writeInt32BE(events.length, 5);
  events.forEach((e, i) => {
    const packed =
      ((BigInt(e.x) & 0x3ffffffn) << 38n) |
      (BigInt(e.y) & 0xfffn) |
      ((BigInt(e.z) & 0x3ffffffn) << 12n);
    b.writeBigInt64BE(BigInt.asIntN(64, packed), 9 + i * 8);
  });
  events.forEach((e, i) => {
    b.writeInt16BE(
      ((((e.eventId & 0xff) << 8) | (e.value & 0xff)) << 16) >> 16,
      9 + events.length * 8 + i * 2,
    );
  });
  return b;
}

/** Entities the fake server can announce, in the wire formats observed on the real server. */
export type FakeEntity =
  | { kind: 'mob'; entityId: number; mobType: number; x: number; y: number; z: number }
  | { kind: 'object'; entityId: number; objectType: number; x: number; y: number; z: number }
  | { kind: 'player'; entityId: number; name: string; x: number; y: number; z: number }
  | {
      kind: 'modded';
      entityId: number;
      modId: string;
      typeId: number;
      x: number;
      y: number;
      z: number;
    };

const fixed = (x: number, y: number, z: number): Buffer =>
  Buffer.concat([i32(Math.floor(x * 32)), i32(Math.floor(y * 32)), i32(Math.floor(z * 32))]);

/** Vanilla object types that stop a block being placed into them (preventEntitySpawning). */
const SOLID_OBJECTS: ReadonlySet<number> = new Set([1, 10, 50, 51, 70]);

/**
 * An entity's box as World.canPlaceEntityOnSide sees it: living entities (players, mobs,
 * modded mobs) as 0.6 x 1.8 (the fake does not model sizes), boats, minecarts, primed TNT,
 * ender crystals and falling blocks as one block; dropped items and other objects not at all.
 */
function bodyOf(e: FakeEntity): FakeBody[] {
  if (e.kind === 'object') {
    return SOLID_OBJECTS.has(e.objectType) ? [{ x: e.x, y: e.y, z: e.z, width: 1, height: 1 }] : [];
  }
  return [{ x: e.x, y: e.y, z: e.z, width: 0.6, height: 1.8 }];
}

/** Encodes an entity spawn exactly as a 1.7.10 Forge server would. */
export function spawnFrame(e: FakeEntity): Buffer {
  switch (e.kind) {
    case 'mob':
      return encodeFrame(
        0x0f,
        Buffer.concat([
          encodeVarInt(e.entityId),
          Buffer.from([e.mobType]),
          fixed(e.x, e.y, e.z),
          Buffer.from([0, 0, 0]), // yaw, pitch, head pitch
          Buffer.alloc(6), // velocity
          Buffer.from([0x7f]), // empty metadata
        ]),
      );
    case 'object':
      return encodeFrame(
        0x0e,
        Buffer.concat([
          encodeVarInt(e.entityId),
          Buffer.from([e.objectType]),
          fixed(e.x, e.y, e.z),
          Buffer.from([0, 0]),
          i32(0), // object data (0: no velocity follows)
        ]),
      );
    case 'player':
      return encodeFrame(
        0x0c,
        Buffer.concat([
          encodeVarInt(e.entityId),
          encodeString('61cb1b75-ae88-3692-8d0c-e959380993c6'),
          encodeString(e.name),
          encodeVarInt(1), // one property, as online-mode skins would add
          encodeString('textures'),
          encodeString('eyJ0ZXh0dXJlcyI6e319'),
          encodeString(''),
          fixed(e.x, e.y, e.z),
          Buffer.from([0, 0, 0, 0]), // yaw, pitch, current item
          Buffer.from([0x7f]),
        ]),
      );
    case 'modded':
      return plugin(
        'FML',
        Buffer.concat([
          Buffer.from([2]),
          i32(e.entityId),
          encodeString(e.modId),
          i32(e.typeId),
          fixed(e.x, e.y, e.z),
          Buffer.from([0, 0, 0]), // yaw, pitch, head yaw
          Buffer.from([0x66, 0, 0, 0, 0, 0x7f]), // some DataWatcher bytes the client must not need
          i32(0), // no thrower
        ]),
      );
  }
}

export class FakeGtnhServer {
  readonly received: ReceivedPacket[] = [];
  /** Every C06 the client sent: echoes of server placements and walking steps. */
  readonly confirmedPositions: ConfirmedPosition[] = [];
  /** Every placement (S08) the server sent: the join spawn and placePlayer() calls. */
  readonly placements: Array<{ x: number; eyeY: number; z: number }> = [];
  /** Chests and the player's inventory: one world, kept across connections like a real server. */
  readonly chestSim: FakeChestSim;
  /** Digging (C07): what the client sent, what broke, what was picked up. */
  readonly digSim: FakeDigSim;
  /** Placing (C08 with a held block): what the client clicked, what was placed. */
  readonly placeSim: FakePlaceSim;
  readonly keepAliveEchoes: number[] = [];
  idleTicks = 0;
  statusPings = 0;
  logins = 0;
  handshakeHosts: string[] = [];
  readonly #opts: Required<Omit<FakeServerOptions, 'kickOnLogin'>> & { kickOnLogin: string | null };
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #playSockets = new Set<Socket>();
  /** The world's blocks that differ from the flat world ("x,y,z" -> id); changes as blocks break. */
  readonly #blocks: Map<string, number>;

  constructor(options: FakeServerOptions = {}) {
    this.#opts = {
      motd: options.motd ?? 'gtnh-agent-test (localhost only)',
      versionName: options.versionName ?? '1.7.10',
      modinfoType: options.modinfoType ?? 'FML',
      mods: options.mods ?? DEFAULT_MODS,
      stillStartingPings: options.stillStartingPings ?? 0,
      onlineMode: options.onlineMode ?? false,
      kickOnLogin: options.kickOnLogin ?? null,
      items: options.items ?? [
        [297, 'minecraft:bread'],
        [263, 'minecraft:coal'],
        [7495, 'gregtech:gt.metaitem.01'],
        [9001, 'BuildCraft|Core:engineBlock'],
        [9002, 'Natura:N Crops'],
      ],
      blocks: options.blocks ?? TEST_BLOCK_REGISTRY,
      registryFiller: options.registryFiller ?? 2000,
      spawn: options.spawn ?? { x: -4.5, eyeY: 107.62000000476837, z: -7.5, yaw: 0, pitch: 0 },
      inventory: options.inventory ?? [
        { slot: 9, id: 297, count: 6, damage: 0 },
        { slot: 10, id: 263, count: 16, damage: 0 },
        { slot: 11, id: 7495, count: 3, damage: 2032 },
        { slot: 12, id: 9001, count: 1, damage: 0 },
        { slot: 13, id: 9002, count: 2, damage: 0 },
        { slot: 20, id: 297, count: 4, damage: 0 },
      ],
      windowSlots: options.windowSlots ?? 46,
      health: options.health ?? { health: 20, food: 18, saturation: 5 },
      keepAliveEveryMs: options.keepAliveEveryMs ?? 100,
      corruptInventory: options.corruptInventory ?? false,
      entities: options.entities ?? [],
      sendChunks: options.sendChunks ?? true,
      blockOverrides: options.blockOverrides ?? new Map(),
      voidColumns: options.voidColumns ?? new Set(),
      corruptChunks: options.corruptChunks ?? false,
      chests: options.chests ?? [],
      tables: options.tables ?? [],
      recipes: options.recipes ?? [],
      rejectClicks: options.rejectClicks ?? [],
      dig: options.dig ?? {},
      place: options.place ?? {},
    };
    this.chestSim = new FakeChestSim({
      chests: this.#opts.chests,
      tables: this.#opts.tables,
      recipes: this.#opts.recipes,
      playerInventory: this.#opts.inventory,
      modularUi: this.#opts.mods.some((m) => m.modid === 'modularui'),
      rejectClicks: new Set(this.#opts.rejectClicks),
      send: () => undefined,
    });
    this.#blocks = new Map(this.#opts.blockOverrides);
    const world = flatWorld(this.#blocks, this.#opts.voidColumns);
    const blockNames = new Map(this.#opts.blocks);
    this.digSim = new FakeDigSim(
      {
        blockAt: world,
        setBlock: (x, y, z, id) => this.#blocks.set(`${x},${y},${z}`, id),
        blockName: (id) => (id === 0 ? 'minecraft:air' : blockNames.get(id)),
        // 1.7.10 block items share their block's id.
        itemId: (name) =>
          this.#opts.items.find(([, n]) => n === name)?.[0] ??
          this.#opts.blocks.find(([, n]) => n === name)?.[0],
        itemName: (id) =>
          this.#opts.items.find(([i]) => i === id)?.[1] ??
          this.#opts.blocks.find(([i]) => i === id)?.[1],
        playerFeet: () => {
          const p = this.confirmedPositions.at(-1);
          return p === undefined ? null : { x: p.x, y: p.feetY, z: p.z };
        },
      },
      this.chestSim,
      this.#opts.dig,
    );
    this.placeSim = new FakePlaceSim(
      {
        blockAt: world,
        setBlock: (x, y, z, id) => this.#blocks.set(`${x},${y},${z}`, id),
        blockName: (id) => (id === 0 ? 'minecraft:air' : blockNames.get(id)),
        playerFeet: () => {
          const p = this.confirmedPositions.at(-1);
          return p === undefined ? null : { x: p.x, y: p.feetY, z: p.z };
        },
        entities: () => this.#opts.entities.flatMap(bodyOf),
      },
      this.chestSim,
      this.#opts.place,
    );
    this.#server = createServer((socket) => this.#onConnection(socket));
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        const address = this.#server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  }

  close(): Promise<void> {
    for (const t of this.#timers) clearInterval(t);
    this.digSim.stop();
    this.placeSim.stop();
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /** Drop every client connection (simulates a server crash / network loss). */
  /** Send a frame to every client in the play state (entity updates during a test). */
  broadcast(frame: Buffer): void {
    for (const s of this.#playSockets) if (!s.destroyed) s.write(frame);
  }

  moveEntity(entityId: number, dx: number, dy: number, dz: number): void {
    const b = Buffer.alloc(3);
    b.writeInt8(Math.round(dx * 32), 0);
    b.writeInt8(Math.round(dy * 32), 1);
    b.writeInt8(Math.round(dz * 32), 2);
    this.broadcast(encodeFrame(0x15, Buffer.concat([i32(entityId), b])));
  }

  teleportEntity(entityId: number, x: number, y: number, z: number): void {
    this.broadcast(
      encodeFrame(0x18, Buffer.concat([i32(entityId), fixed(x, y, z), Buffer.from([0, 0])])),
    );
  }

  /** A message on GregTech's own plugin channel. */
  sendGregTech(data: Buffer): void {
    this.broadcast(plugin('GregTech', data));
  }

  /** S08: the server places the player, as after a teleport or a move it rejected. */
  placePlayer(x: number, eyeY: number, z: number): void {
    this.placements.push({ x, eyeY, z });
    this.broadcast(
      encodeFrame(
        0x08,
        Buffer.concat([f64(x), f64(eyeY), f64(z), f32(0), f32(0), Buffer.from([0])]),
      ),
    );
  }

  /** C06 packets that are walking steps (not exact echoes of a placement). */
  walkSteps(): ConfirmedPosition[] {
    return this.confirmedPositions.filter(
      (p) => !this.placements.some((s) => s.x === p.x && s.z === p.z && s.eyeY === p.headY),
    );
  }

  /** A single block change (NEID format), e.g. lava appearing next to the player. */
  setBlock(x: number, y: number, z: number, id: number): void {
    this.#blocks.set(`${x},${y},${z}`, id);
    this.broadcast(blockChangeFrame(x, y, z, id));
  }

  /** A block change the client is never told about (as if the update had been lost). */
  setBlockSilently(x: number, y: number, z: number, id: number): void {
    this.#blocks.set(`${x},${y},${z}`, id);
  }

  setBlocks(
    chunkX: number,
    chunkZ: number,
    records: Array<{ x: number; y: number; z: number; id: number }>,
  ): void {
    for (const r of records) this.#blocks.set(`${r.x},${r.y},${r.z}`, r.id);
    this.broadcast(multiBlockChangeFrame(chunkX, chunkZ, records));
  }

  /** 1.7.10 chunk unload: Chunk Data, ground-up continuous, no sections, empty data. */
  unloadChunk(chunkX: number, chunkZ: number): void {
    this.broadcast(
      encodeFrame(
        0x21,
        Buffer.concat([i32(chunkX), i32(chunkZ), Buffer.from([1, 0, 0, 0, 0]), i32(0)]),
      ),
    );
  }

  destroyEntities(ids: number[]): void {
    this.broadcast(
      encodeFrame(0x13, Buffer.concat([Buffer.from([ids.length]), ...ids.map((id) => i32(id))])),
    );
  }

  dropAll(): void {
    for (const s of this.#sockets) s.destroy();
  }

  /** Packet ids the client sent while in the play state. */
  playPacketIds(): number[] {
    return this.received.filter((p) => p.state === 'play').map((p) => p.id);
  }

  /** Plugin channels the client wrote to. */
  pluginChannels(): string[] {
    return this.received
      .filter((p) => p.state === 'play' && p.id === 0x17)
      .map((p) => new Reader(p.body).string());
  }

  #onConnection(socket: Socket): void {
    this.#sockets.add(socket);
    let sim: FakeChestSim | null = null;
    socket.on('close', () => {
      this.#sockets.delete(socket);
      this.#playSockets.delete(socket);
      sim?.onDisconnect();
    });
    socket.on('error', () => undefined);
    let state: ReceivedPacket['state'] = 'handshaking';
    let healthSent = false;
    const decoder = new FrameDecoder();
    const send = (frame: Buffer): void => {
      if (!socket.destroyed) socket.write(frame);
    };

    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        const r = frame.body;
        this.received.push({
          state,
          id: frame.packetId,
          body: Buffer.from(r.buf.subarray(r.offset)),
        });

        if (state === 'handshaking') {
          r.varInt(); // protocol
          this.handshakeHosts.push(r.string());
          r.u16();
          state = r.varInt() === 1 ? 'status' : 'login';
          continue;
        }

        if (state === 'status') {
          this.statusPings += 1;
          const response =
            this.statusPings <= this.#opts.stillStartingPings
              ? 'Server is still starting! Please wait before reconnecting.'
              : {
                  description: this.#opts.motd,
                  players: { max: 4, online: 0 },
                  version: { name: this.#opts.versionName, protocol: 5 },
                  modinfo: { type: this.#opts.modinfoType, modList: this.#opts.mods },
                };
          send(encodeFrame(0x00, encodeString(JSON.stringify(response))));
          socket.end();
          continue;
        }

        if (state === 'login') {
          const name = r.string();
          this.logins += 1;
          if (this.#opts.kickOnLogin !== null) {
            send(encodeFrame(0x00, encodeString(JSON.stringify({ text: this.#opts.kickOnLogin }))));
            socket.end();
            continue;
          }
          if (this.#opts.onlineMode) {
            send(encodeFrame(0x01, Buffer.concat([encodeString(''), Buffer.from([0, 0, 0, 0])])));
            continue;
          }
          send(
            encodeFrame(
              0x02,
              Buffer.concat([
                encodeString('3dfc863b-6ad1-3d61-b872-36bf96373604'),
                encodeString(name),
              ]),
            ),
          );
          state = 'play';
          this.#playSockets.add(socket);
          sim = this.chestSim;
          sim.setSender(send);
          sim.onJoin();
          this.digSim.setSenders(send, (f) => this.broadcast(f));
          this.placeSim.setSenders(send, (f) => this.broadcast(f));
          send(
            plugin(
              'REGISTER',
              Buffer.from(['FML|HS', 'FML', 'FML|MP', 'FORGE', 'GregTech'].join('\0')),
            ),
          );
          send(plugin('FML|HS', Buffer.concat([Buffer.from([0, 2]), i32(0)])));
          continue;
        }

        // play
        switch (frame.packetId) {
          case 0x00:
            this.keepAliveEchoes.push(r.i32());
            break;
          case 0x03:
            this.idleTicks += 1;
            this.digSim.onPlayerTick();
            if (!healthSent && this.confirmedPositions.length > 0) {
              healthSent = true;
              const h = this.#opts.health;
              send(
                encodeFrame(
                  0x06,
                  Buffer.concat([f32(h.health), Buffer.from([0, h.food]), f32(h.saturation)]),
                ),
              );
            }
            break;
          case 0x06:
            this.confirmedPositions.push({
              x: r.f64(),
              feetY: r.f64(),
              headY: r.f64(),
              z: r.f64(),
              yaw: r.f32(),
              pitch: r.f32(),
              onGround: r.bool(),
            });
            this.digSim.onPlayerTick();
            break;
          case 0x17: {
            const channel = r.string();
            const data = r.bytes(r.i16());
            if (channel === 'FML|HS') this.#onHandshake(data, send);
            break;
          }
          case 0x07:
            this.digSim.handle(r);
            break;
          case 0x08:
            // Activation first (a chest or table opens), else the held block is placed.
            this.placeSim.handle(
              r,
              this.#opts.mods.some((m) => m.modid === 'modularui'),
            );
            break;
          default:
            sim?.handle(frame.packetId, r);
            break;
        }
      }
    });
  }

  #onHandshake(data: Buffer, send: (frame: Buffer) => void): void {
    const discriminator = data.readInt8(0);
    if (discriminator === 2) {
      const mods = this.#opts.mods;
      send(
        plugin(
          'FML|HS',
          Buffer.concat([
            Buffer.from([2]),
            encodeVarInt(mods.length),
            ...mods.flatMap((m) => [encodeString(m.modid), encodeString(m.version)]),
          ]),
        ),
      );
      return;
    }
    if (discriminator !== -1) return;
    const phase = data.readInt8(1);
    if (phase === 2) {
      const entries: Array<[string, number]> = [
        ...this.#opts.blocks.map(([id, name]): [string, number] => [`\u0001${name}`, id]),
        ...this.#opts.items.map(([id, name]): [string, number] => [`\u0002${name}`, id]),
        ...Array.from({ length: this.#opts.registryFiller }, (_, i): [string, number] => [
          `\u0002filler:item_number_${i}`,
          20_000 + i,
        ]),
      ];
      const body = Buffer.concat([
        Buffer.from([3]),
        encodeVarInt(entries.length),
        ...entries.flatMap(([name, id]) => [encodeString(name), encodeVarInt(id)]),
        encodeVarInt(0),
        encodeVarInt(0),
      ]);
      send(plugin('FML|HS', body));
      send(plugin('FML|HS', Buffer.from([0xff, 2])));
    } else if (phase === 3) {
      send(plugin('FML|HS', Buffer.from([0xff, 3])));
    } else if (phase === 4) {
      this.#sendJoin(send);
    }
  }

  #sendJoin(send: (frame: Buffer) => void): void {
    const o = this.#opts;
    send(
      encodeFrame(
        0x01,
        Buffer.concat([i32(1197138), Buffer.from([0, 0, 3, 4]), encodeString('RWG')]),
      ),
    );
    send(encodeFrame(0x05, Buffer.concat([i32(0), i32(64), i32(0)])));
    this.placements.push({ x: o.spawn.x, eyeY: o.spawn.eyeY, z: o.spawn.z });
    send(
      encodeFrame(
        0x08,
        Buffer.concat([
          f64(o.spawn.x),
          f64(o.spawn.eyeY),
          f64(o.spawn.z),
          f32(o.spawn.yaw),
          f32(o.spawn.pitch),
          Buffer.from([0]),
        ]),
      ),
    );
    send(encodeFrame(0x09, Buffer.from([0])));
    const player = this.chestSim.playerSlots();
    const modularUi = o.mods.some((m) => m.modid === 'modularui');
    const slots = Array.from({ length: o.windowSlots }, (_, s) =>
      encodeStack(player[s] ?? null, modularUi),
    );
    const count = Buffer.alloc(2);
    count.writeInt16BE(o.windowSlots);
    const window = Buffer.concat([Buffer.from([0]), count, ...slots]);
    send(encodeFrame(0x30, o.corruptInventory ? window.subarray(0, window.length - 3) : window));
    // addCraftingToCrafters follows the window with the cursor (empty at login).
    send(encodeFrame(0x2f, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff])));
    // An unknown packet id the client must skip without desynchronizing.
    send(encodeFrame(0x35, Buffer.from('opaque tile entity data')));
    if (o.sendChunks) {
      // Nearest-first, 5 columns per Map Chunk Bulk, like the real server, with real
      // NotEnoughIDs-format block data for a flat world (plus test overrides).
      const cx0 = Math.floor(o.spawn.x / 16);
      const cz0 = Math.floor(o.spawn.z / 16);
      const columns: Array<[number, number]> = [];
      for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++) columns.push([cx0 + dx, cz0 + dz]);
      columns.sort(
        (a, b) => Math.hypot(a[0] - cx0, a[1] - cz0) - Math.hypot(b[0] - cx0, b[1] - cz0),
      );
      for (let i = 0; i < columns.length; i += 5) {
        const batch = columns.slice(i, i + 5);
        const world = flatWorld(this.#blocks, o.voidColumns);
        send(
          chunkBulkFrame(
            batch.map(([cx, cz]) => neidColumn(cx, cz, world)),
            true,
            o.corruptChunks,
          ),
        );
      }
    }
    for (const entity of o.entities) send(spawnFrame(entity));
    const timer = setInterval(
      () => send(encodeFrame(0x00, i32(Math.floor(Math.random() * 1e6)))),
      o.keepAliveEveryMs,
    );
    this.#timers.add(timer);
  }
}
