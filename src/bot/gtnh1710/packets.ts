import { gunzipSync } from 'node:zlib';
import {
  bool,
  encodeFrame,
  encodeString,
  encodeVarInt,
  f32,
  f64,
  i32,
  ProtocolError,
  u16,
  type Reader,
} from './wire.ts';

/** Minecraft 1.7.6-1.7.10 protocol number. */
export const PROTOCOL_1710 = 5;

/** 1.7.10 sends the player's eye height in S08; feet = eyes - this. */
export const PLAYER_EYE_HEIGHT = 1.6200000047683716;

// ---------------------------------------------------------------------------
// Outbound: the ONLY packets this client can ever send. Anything that could change
// the world (digging, placing, clicking windows, chat/commands, using items,
// attacking, moving to a new position) is intentionally absent.
// ---------------------------------------------------------------------------

export type OutboundKind =
  | 'handshake'
  | 'status-request'
  | 'login-start'
  | 'keep-alive'
  | 'plugin-message'
  | 'player-idle'
  | 'confirm-server-position';

export interface OutboundPacket {
  kind: OutboundKind;
  frame: Buffer;
}

/** Plugin channels the client may write to: channel registration and the FML handshake. */
export const OUTBOUND_PLUGIN_CHANNELS: ReadonlySet<string> = new Set(['REGISTER', 'FML|HS']);

export const outbound = {
  /** Handshake with the FML marker, so the server treats us as a Forge client. */
  handshake(host: string, port: number, nextState: 1 | 2): OutboundPacket {
    const hostField = nextState === 2 ? `${host}\0FML\0` : host;
    return {
      kind: 'handshake',
      frame: encodeFrame(
        0x00,
        Buffer.concat([
          encodeVarInt(PROTOCOL_1710),
          encodeString(hostField),
          u16(port),
          encodeVarInt(nextState),
        ]),
      ),
    };
  },

  statusRequest(): OutboundPacket {
    return { kind: 'status-request', frame: encodeFrame(0x00, Buffer.alloc(0)) };
  },

  loginStart(username: string): OutboundPacket {
    return { kind: 'login-start', frame: encodeFrame(0x00, encodeString(username)) };
  },

  keepAlive(id: number): OutboundPacket {
    return { kind: 'keep-alive', frame: encodeFrame(0x00, i32(id)) };
  },

  pluginMessage(channel: string, data: Buffer): OutboundPacket {
    if (!OUTBOUND_PLUGIN_CHANNELS.has(channel)) {
      throw new ProtocolError(`refusing to send on plugin channel ${channel}`);
    }
    if (data.length > 32767) throw new ProtocolError('client plugin message too large');
    return {
      kind: 'plugin-message',
      frame: encodeFrame(0x17, Buffer.concat([encodeString(channel), u16(data.length), data])),
    };
  },

  /** C03 Player: "still here, not moving". Lets the server tick the player (health/food updates). */
  playerIdle(onGround: boolean): OutboundPacket {
    return { kind: 'player-idle', frame: encodeFrame(0x03, bool(onGround)) };
  },

  /**
   * C06 Player Position And Look, used ONLY to acknowledge a position the server just
   * set (S08). The caller passes the server's packet, never a computed position.
   */
  confirmServerPosition(server: ServerPosition, onGround: boolean): OutboundPacket {
    const feetY = server.eyeY - PLAYER_EYE_HEIGHT;
    return {
      kind: 'confirm-server-position',
      frame: encodeFrame(
        0x06,
        Buffer.concat([
          f64(server.x),
          f64(feetY),
          f64(server.eyeY),
          f64(server.z),
          f32(server.yaw),
          f32(server.pitch),
          bool(onGround),
        ]),
      ),
    };
  },
};

// ---------------------------------------------------------------------------
// Inbound: decoders for the packets the client uses. Everything else is skipped
// (frames are length-delimited, so unknown packets never desynchronize the stream).
// ---------------------------------------------------------------------------

export interface ServerPosition {
  x: number;
  eyeY: number;
  z: number;
  yaw: number;
  pitch: number;
}

export interface ItemStackData {
  id: number;
  count: number;
  damage: number;
  hasNbt: boolean;
}

export type LoginPacket =
  | { type: 'login-disconnect'; reason: string }
  | { type: 'encryption-request' }
  | { type: 'login-success'; uuid: string; username: string }
  | { type: 'unhandled'; id: number };

export type PlayPacket =
  | { type: 'keep-alive'; id: number }
  | {
      type: 'join-game';
      entityId: number;
      gamemode: number;
      dimension: number;
      difficulty: number;
      maxPlayers: number;
      levelType: string;
    }
  | { type: 'chat'; json: string }
  | { type: 'spawn-position'; x: number; y: number; z: number }
  | { type: 'update-health'; health: number; food: number; saturation: number }
  | { type: 'respawn'; dimension: number; difficulty: number; gamemode: number; levelType: string }
  | ({ type: 'server-position'; onGround: boolean } & ServerPosition)
  | { type: 'held-item'; slot: number }
  | { type: 'set-slot'; windowId: number; slot: number; item: ItemStackData | null }
  | { type: 'window-items'; windowId: number; items: Array<ItemStackData | null> }
  | { type: 'plugin-message'; channel: string; data: Buffer }
  | { type: 'disconnect'; reason: string }
  | { type: 'unhandled'; id: number };

export function decodeLogin(packetId: number, r: Reader): LoginPacket {
  switch (packetId) {
    case 0x00:
      return { type: 'login-disconnect', reason: r.string() };
    case 0x01:
      return { type: 'encryption-request' };
    case 0x02:
      return { type: 'login-success', uuid: r.string(), username: r.string() };
    default:
      return { type: 'unhandled', id: packetId };
  }
}

export interface PlayDecodeOptions {
  /**
   * GTNH's ModularUI (modid `modularui`) patches PacketBuffer so every NON-empty item
   * stack is followed by its full stack size as a VarInt (vanilla's byte caps at 127).
   * Verified by disassembling modularui-1.2.20's PacketBufferMixin and by live packets.
   */
  itemStackSizeVarInt: boolean;
}

export const VANILLA_DECODING: PlayDecodeOptions = { itemStackSizeVarInt: false };

/**
 * 1.7.10 item stack: short id (-1 = empty), byte count, short damage, short NBT length
 * (+ gzip NBT), and with ModularUI a trailing VarInt holding the real stack size.
 */
export function readItemStack(
  r: Reader,
  options: PlayDecodeOptions = VANILLA_DECODING,
): ItemStackData | null {
  const id = r.i16();
  if (id === -1) return null;
  let count = r.i8();
  const damage = r.i16();
  const nbtLength = r.i16();
  if (nbtLength > 0) gunzipSync(r.bytes(nbtLength)); // validated, contents not used yet
  if (options.itemStackSizeVarInt) count = r.varInt();
  return { id, count, damage, hasNbt: nbtLength > 0 };
}

export function decodePlay(
  packetId: number,
  r: Reader,
  options: PlayDecodeOptions = VANILLA_DECODING,
): PlayPacket {
  switch (packetId) {
    case 0x00:
      return { type: 'keep-alive', id: r.i32() };
    case 0x01:
      return {
        type: 'join-game',
        entityId: r.i32(),
        gamemode: r.u8(),
        dimension: r.i8(),
        difficulty: r.u8(),
        maxPlayers: r.u8(),
        levelType: r.string(),
      };
    case 0x02:
      return { type: 'chat', json: r.string() };
    case 0x05:
      return { type: 'spawn-position', x: r.i32(), y: r.i32(), z: r.i32() };
    case 0x06:
      return { type: 'update-health', health: r.f32(), food: r.i16(), saturation: r.f32() };
    case 0x07:
      return {
        type: 'respawn',
        dimension: r.i32(),
        difficulty: r.u8(),
        gamemode: r.u8(),
        levelType: r.string(),
      };
    case 0x08:
      return {
        type: 'server-position',
        x: r.f64(),
        eyeY: r.f64(),
        z: r.f64(),
        yaw: r.f32(),
        pitch: r.f32(),
        onGround: r.bool(),
      };
    case 0x09:
      return { type: 'held-item', slot: r.i8() };
    case 0x2f:
      return { type: 'set-slot', windowId: r.i8(), slot: r.i16(), item: readItemStack(r, options) };
    case 0x30: {
      const windowId = r.u8();
      const count = r.i16();
      const items: Array<ItemStackData | null> = [];
      for (let i = 0; i < count; i++) items.push(readItemStack(r, options));
      return { type: 'window-items', windowId, items };
    }
    case 0x3f: {
      // Forge 1.7.10 widens the payload length to a "varshort" (vanilla: short).
      const channel = r.string();
      const length = r.varShort();
      return { type: 'plugin-message', channel, data: Buffer.from(r.bytes(length)) };
    }
    case 0x40:
      return { type: 'disconnect', reason: r.string() };
    default:
      return { type: 'unhandled', id: packetId };
  }
}
