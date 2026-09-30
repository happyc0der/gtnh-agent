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
  { modid: 'dreamcraft', version: '2.7.268' },
  { modid: 'modularui', version: '1.2.20' },
];

const plugin = (channel: string, data: Buffer): Buffer =>
  encodeFrame(0x3f, Buffer.concat([encodeString(channel), encodeVarShort(data.length), data]));

function slot(item: FakeItem | undefined, modularUi: boolean): Buffer {
  if (item === undefined) return Buffer.from([0xff, 0xff]); // short -1 = empty
  const b = Buffer.alloc(7);
  b.writeInt16BE(item.id, 0);
  b.writeInt8(Math.min(item.count, 127), 2); // vanilla byte (truncated for big stacks)
  b.writeInt16BE(item.damage, 3);
  b.writeInt16BE(-1, 5); // no NBT
  // GTNH ModularUI: full stack size as a VarInt after every non-empty stack.
  return modularUi ? Buffer.concat([b, encodeVarInt(item.count)]) : b;
}

export class FakeGtnhServer {
  readonly received: ReceivedPacket[] = [];
  readonly confirmedPositions: ConfirmedPosition[] = [];
  readonly keepAliveEchoes: number[] = [];
  idleTicks = 0;
  statusPings = 0;
  logins = 0;
  handshakeHosts: string[] = [];
  readonly #opts: Required<Omit<FakeServerOptions, 'kickOnLogin'>> & { kickOnLogin: string | null };
  readonly #server: Server;
  readonly #sockets = new Set<Socket>();
  readonly #timers = new Set<NodeJS.Timeout>();

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
      blocks: options.blocks ?? [[1, 'minecraft:stone']],
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
    };
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
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  /** Drop every client connection (simulates a server crash / network loss). */
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
    socket.on('close', () => this.#sockets.delete(socket));
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
            break;
          case 0x17: {
            const channel = r.string();
            const data = r.bytes(r.i16());
            if (channel === 'FML|HS') this.#onHandshake(data, send);
            break;
          }
          default:
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
    const bySlot = new Map(o.inventory.map((i) => [i.slot, i]));
    const modularUi = o.mods.some((m) => m.modid === 'modularui');
    const slots = Array.from({ length: o.windowSlots }, (_, s) => slot(bySlot.get(s), modularUi));
    const count = Buffer.alloc(2);
    count.writeInt16BE(o.windowSlots);
    const window = Buffer.concat([Buffer.from([0]), count, ...slots]);
    send(encodeFrame(0x30, o.corruptInventory ? window.subarray(0, window.length - 3) : window));
    // An unknown packet id the client must skip without desynchronizing.
    send(encodeFrame(0x35, Buffer.from('opaque tile entity data')));
    const timer = setInterval(
      () => send(encodeFrame(0x00, i32(Math.floor(Math.random() * 1e6)))),
      o.keepAliveEveryMs,
    );
    this.#timers.add(timer);
  }
}
