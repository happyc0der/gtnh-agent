import { gunzipSync } from 'node:zlib';
import { BQ_CHANNEL, encodeBqOutbound, type BqOutbound } from './better-questing.ts';
import type { ColumnHeader } from './chunk-data.ts';
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
  Reader,
} from './wire.ts';

/** Minecraft 1.7.6-1.7.10 protocol number. */
export const PROTOCOL_1710 = 5;

/** 1.7.10 sends the player's eye height in S08; feet = eyes - this. */
export const PLAYER_EYE_HEIGHT = 1.6200000047683716;

// ---------------------------------------------------------------------------
// Outbound: the ONLY packets this client can ever send. Anything that could change
// the world (placing, chat/commands, using items, attacking, dropping items) is
// intentionally absent. The exceptions are walking ('player-move', only for steps
// walking.ts has checked), vanilla chests and crafting ('activate-block', 'select-slot',
// 'click-window', 'confirm-transaction', 'close-window', only as container.ts and
// crafting.ts plan them) and digging one block ('dig-block' with status
// start/cancel/finish only, for targets digging.ts has checked); see Gtnh1710Client.
// 'player-look' and 'swing-arm' only change what other players see: where the head
// points, and the arm swinging while digging.
// 'quest-book' is Better Questing's own channel (BQ_NET_CHAN), and only its four typed
// client messages (better-questing.ts BqOutbound): the answer to the server's main_sync,
// quest_action claim/detect, task_checkbox and choice_reward.
// ---------------------------------------------------------------------------

export type OutboundKind =
  | 'handshake'
  | 'status-request'
  | 'login-start'
  | 'keep-alive'
  | 'plugin-message'
  | 'player-idle'
  | 'confirm-server-position'
  | 'player-move'
  | 'activate-block'
  | 'select-slot'
  | 'click-window'
  | 'confirm-transaction'
  | 'close-window'
  | 'dig-block'
  | 'player-look'
  | 'swing-arm'
  | 'quest-book';

/**
 * C07 Player Digging statuses the client may send. 1.7.10 also uses this packet for 3 (drop
 * the held stack), 4 (drop one item) and 5 (release a used item, e.g. shoot a bow); those
 * are deliberately not representable here.
 */
export const DIG_STATUS = { start: 0, cancel: 1, finish: 2 } as const;
export type DigStatus = (typeof DIG_STATUS)[keyof typeof DIG_STATUS];

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
   * C06 Player Position And Look for one walking step (feet position; the head is at
   * feet + eye height, which is what 1.7.10 expects as "stance").
   */
  playerMove(
    step: { x: number; feetY: number; z: number; yaw: number; pitch: number },
    onGround: boolean,
  ): OutboundPacket {
    const values = [step.x, step.feetY, step.z, step.yaw, step.pitch];
    if (!values.every(Number.isFinite)) throw new ProtocolError('refusing a non-finite position');
    // 1.7.10 kicks for "Illegal position" beyond 3.2e7 and "Illegal stance" outside 0.1-1.65.
    if (Math.abs(step.x) >= 3.2e7 || Math.abs(step.z) >= 3.2e7) {
      throw new ProtocolError('refusing an out-of-world position');
    }
    return {
      kind: 'player-move',
      frame: encodeFrame(
        0x06,
        Buffer.concat([
          f64(step.x),
          f64(step.feetY),
          f64(step.feetY + PLAYER_EYE_HEIGHT),
          f64(step.z),
          f32(step.yaw),
          f32(step.pitch),
          bool(onGround),
        ]),
      ),
    };
  },

  /**
   * C08 Player Block Placement used ONLY to right-click (activate) a block with an EMPTY
   * hand: the client selects an empty hotbar slot first, so nothing can be placed or used.
   */
  activateBlock(x: number, y: number, z: number, face: number): OutboundPacket {
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new ProtocolError('bad face');
    if (!Number.isInteger(y) || y < 0 || y > 255) throw new ProtocolError('bad y');
    return {
      kind: 'activate-block',
      frame: encodeFrame(
        0x08,
        Buffer.concat([
          i32(x),
          Buffer.from([y]),
          i32(z),
          Buffer.from([face]),
          i16(-1), // held item: empty hand
          Buffer.from([8, 8, 8]), // cursor at the face centre (sixteenths)
        ]),
      ),
    };
  },

  /** C09 Held Item Change: select hotbar slot 0-8. */
  selectHotbarSlot(slot: number): OutboundPacket {
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new ProtocolError('bad hotbar slot');
    return { kind: 'select-slot', frame: encodeFrame(0x09, i16(slot)) };
  },

  /**
   * C0E Click Window, normal click (mode 0) only. `claimed` is the slot's stack before the
   * click, which the server compares with its own (see container.ts). Window 0 is the
   * player's own inventory container (its 2x2 crafting grid, see crafting.ts).
   */
  clickWindow(
    windowId: number,
    slot: number,
    button: 0 | 1,
    actionNumber: number,
    claimed: ItemStackData | null,
    modularUi: boolean,
  ): OutboundPacket {
    if (!Number.isInteger(windowId) || windowId < 0 || windowId > 127) {
      throw new ProtocolError('bad window id');
    }
    if (!Number.isInteger(slot) || slot < 0 || slot > 32767) throw new ProtocolError('bad slot');
    if (actionNumber < 1 || actionNumber > 32767) throw new ProtocolError('bad action number');
    return {
      kind: 'click-window',
      frame: encodeFrame(
        0x0e,
        Buffer.concat([
          Buffer.from([windowId]),
          i16(slot),
          Buffer.from([button]),
          i16(actionNumber),
          Buffer.from([0]), // mode 0: normal click
          writeItemStack(claimed, modularUi),
        ]),
      ),
    };
  },

  /** C0F Confirm Transaction: acknowledge a click the server rejected (it then re-syncs). */
  confirmTransaction(windowId: number, actionNumber: number): OutboundPacket {
    return {
      kind: 'confirm-transaction',
      frame: encodeFrame(
        0x0f,
        Buffer.concat([Buffer.from([windowId]), i16(actionNumber), bool(true)]),
      ),
    };
  },

  /**
   * C0D Close Window. The caller must make sure nothing is on the cursor, or in a crafting
   * grid: the server DROPS both into the world. Never for window 0: 1.7.10 closes whatever
   * window is open whatever id the packet names, and closing the player's own inventory
   * container drops its 2x2 crafting grid (verified in the server jar).
   */
  closeWindow(windowId: number): OutboundPacket {
    if (windowId === 0) {
      throw new ProtocolError('refusing to close window 0 (it would drop the 2x2 crafting grid)');
    }
    if (!Number.isInteger(windowId) || windowId < 1 || windowId > 127) {
      throw new ProtocolError('bad window id');
    }
    return { kind: 'close-window', frame: encodeFrame(0x0d, Buffer.from([windowId])) };
  },

  /**
   * C07 Player Digging (u8 status, i32 x, u8 y, i32 z, u8 face; verified against the
   * 1.7.10 server's packet class): start (0), cancel (1) or finish (2) digging ONE block.
   * Any other status (they drop items) is refused, whatever the caller passes.
   */
  digBlock(status: DigStatus, x: number, y: number, z: number, face: number): OutboundPacket {
    if (
      status !== DIG_STATUS.start &&
      status !== DIG_STATUS.cancel &&
      status !== DIG_STATUS.finish
    ) {
      throw new ProtocolError(`refusing digging status ${String(status)}`);
    }
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(z) ||
      Math.abs(x) > 30_000_000 ||
      Math.abs(z) > 30_000_000
    ) {
      throw new ProtocolError('bad block x/z');
    }
    if (!Number.isInteger(y) || y < 0 || y > 255) throw new ProtocolError('bad y');
    if (!Number.isInteger(face) || face < 0 || face > 5) throw new ProtocolError('bad face');
    return {
      kind: 'dig-block',
      frame: encodeFrame(
        0x07,
        Buffer.concat([
          Buffer.from([status]),
          i32(x),
          Buffer.from([y]),
          i32(z),
          Buffer.from([face]),
        ]),
      ),
    };
  },

  /** C05 Player Look (f32 yaw, f32 pitch, bool on ground): turn the head, without moving. */
  playerLook(yaw: number, pitch: number, onGround: boolean): OutboundPacket {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch) || Math.abs(pitch) > 90) {
      throw new ProtocolError('refusing a bad look direction');
    }
    return {
      kind: 'player-look',
      frame: encodeFrame(0x05, Buffer.concat([f32(yaw), f32(pitch), bool(onGround)])),
    };
  },

  /** C0A Animation (i32 own entity id, i8 1 = swing the arm), as a client does while digging. */
  swingArm(entityId: number): OutboundPacket {
    if (!Number.isInteger(entityId)) throw new ProtocolError('bad entity id');
    return {
      kind: 'swing-arm',
      frame: encodeFrame(0x0a, Buffer.concat([i32(entityId), Buffer.from([1])])),
    };
  },

  /**
   * C17 plugin messages on Better Questing's channel for ONE typed quest-book message (one
   * frame per 20,480-byte slice; the agent's messages are a single slice). Nothing else can
   * be written to BQ_NET_CHAN: the payload is built from the typed message, never raw NBT.
   */
  questBook(message: BqOutbound): OutboundPacket[] {
    return encodeBqOutbound(message).map((data) => {
      if (data.length > 32767) throw new ProtocolError('client plugin message too large');
      return {
        kind: 'quest-book',
        frame: encodeFrame(0x17, Buffer.concat([encodeString(BQ_CHANNEL), u16(data.length), data])),
      };
    });
  },

  /**
   * C06 Player Position And Look, used to acknowledge a position the server just set
   * (S08). The caller passes the server's packet, never a computed position.
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
  /**
   * S03 Time Update: the world's age and its day time in ticks. A 1.7.10 server sends the
   * day time negated (and -1 for 0) while the doDaylightCycle game rule is off.
   */
  | { type: 'time-update'; worldAge: number; dayTicks: number; daylightCycle: boolean }
  | { type: 'respawn'; dimension: number; difficulty: number; gamemode: number; levelType: string }
  | ({ type: 'server-position'; onGround: boolean } & ServerPosition)
  | { type: 'held-item'; slot: number }
  | { type: 'set-slot'; windowId: number; slot: number; item: ItemStackData | null }
  | {
      type: 'open-window';
      windowId: number;
      inventoryType: number;
      title: string;
      slotCount: number;
    }
  | { type: 'close-window'; windowId: number }
  | { type: 'confirm-transaction'; windowId: number; actionNumber: number; accepted: boolean }
  | { type: 'window-items'; windowId: number; items: Array<ItemStackData | null> }
  | { type: 'plugin-message'; channel: string; data: Buffer }
  | { type: 'disconnect'; reason: string }
  | ({ type: 'spawn-player'; entityId: number; name: string } & EntityPosition)
  | ({ type: 'spawn-object'; entityId: number; objectType: number } & EntityPosition)
  | ({ type: 'spawn-mob'; entityId: number; mobType: number } & EntityPosition)
  | { type: 'destroy-entities'; entityIds: number[] }
  | { type: 'entity-move'; entityId: number; dx: number; dy: number; dz: number }
  | ({ type: 'entity-teleport'; entityId: number } & EntityPosition)
  | {
      type: 'chunk-data';
      header: ColumnHeader;
      groundUp: boolean;
      /** "Ground-up continuous" with no sections is how 1.7.10 unloads a column. */
      unload: boolean;
      compressed: Buffer;
    }
  | { type: 'chunk-bulk'; columns: ColumnHeader[]; skyLight: boolean; compressed: Buffer }
  | { type: 'block-change'; x: number; y: number; z: number; blockId: number }
  | {
      type: 'multi-block-change';
      chunkX: number;
      chunkZ: number;
      records: Array<{ x: number; y: number; z: number; blockId: number }>;
    }
  | { type: 'unhandled'; id: number };

/** Entity position in blocks (the protocol sends 1/32-block fixed point). */
export interface EntityPosition {
  x: number;
  y: number;
  z: number;
}

function fixedPointPosition(r: Reader): EntityPosition {
  return { x: r.i32() / 32, y: r.i32() / 32, z: r.i32() / 32 };
}

/** Forge "FML" channel runtime messages the agent uses (FMLRuntimeCodec discriminators). */
export type FmlRuntimeMessage =
  | ({ type: 'fml-entity-spawn'; entityId: number; modId: string; typeId: number } & EntityPosition)
  | ({ type: 'fml-entity-adjust'; entityId: number } & EntityPosition)
  | { type: 'fml-other'; discriminator: number };

/**
 * Decodes the start of a Forge 1.7.10 "FML" channel message. Only the leading fields are
 * read (the spawn message continues with rotation, DataWatcher and spawn data, which the
 * agent does not need). Layout verified against live GTNH traffic on 2026-09-30.
 *   2 EntitySpawnMessage:  int entityId, string modId, int modEntityTypeId, int x/y/z (1/32)
 *   3 EntityAdjustMessage: int entityId, int x/y/z (1/32)
 */
export function decodeFmlRuntimeMessage(data: Buffer): FmlRuntimeMessage {
  const r = new Reader(data);
  const discriminator = r.u8();
  switch (discriminator) {
    case 2: {
      const entityId = r.i32();
      const modId = r.string(256);
      const typeId = r.i32();
      return { type: 'fml-entity-spawn', entityId, modId, typeId, ...fixedPointPosition(r) };
    }
    case 3:
      return { type: 'fml-entity-adjust', entityId: r.i32(), ...fixedPointPosition(r) };
    default:
      return { type: 'fml-other', discriminator };
  }
}

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
  /**
   * NotEnoughIDs (modid `neid`) widens block ids and metadata to 16 bits: chunk sections
   * carry u16 ids and metadata, Block Change metadata is a short, and Multi Block Change
   * records are 6 bytes. Verified from notenoughIDs-2.1.10's mixins and live packets.
   */
  neid: boolean;
}

export const VANILLA_DECODING: PlayDecodeOptions = { itemStackSizeVarInt: false, neid: false };

/**
 * 1.7.10 item stack: short id (-1 = empty), byte count, short damage, short NBT length
 * (+ gzip NBT), and with ModularUI a trailing VarInt holding the real stack size.
 */
/**
 * An item stack as 1.7.10 writes it (plus GTNH ModularUI's VarInt stack size). Only
 * NBT-free stacks are ever sent.
 */
export function writeItemStack(stack: ItemStackData | null, modularUi: boolean): Buffer {
  if (stack === null) return i16(-1);
  if (stack.hasNbt) throw new ProtocolError('refusing to send an item stack with NBT data');
  const b = Buffer.alloc(7);
  b.writeInt16BE(stack.id, 0);
  b.writeInt8(((stack.count & 0xff) << 24) >> 24, 2); // vanilla byte (truncated above 127)
  b.writeInt16BE(stack.damage, 3);
  b.writeInt16BE(-1, 5); // no NBT
  return modularUi ? Buffer.concat([b, encodeVarInt(stack.count)]) : b;
}

function i16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}

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
    case 0x03: {
      const worldAge = Number(r.i64());
      const dayTime = Number(r.i64());
      return {
        type: 'time-update',
        worldAge,
        dayTicks: Math.abs(dayTime),
        daylightCycle: dayTime >= 0,
      };
    }
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
    case 0x2d: {
      const windowId = r.u8();
      const inventoryType = r.u8();
      const title = r.string();
      const slotCount = r.u8();
      r.bool(); // use the title as given
      if (inventoryType === 11) r.i32(); // horse inventories carry the horse's entity id
      return { type: 'open-window', windowId, inventoryType, title, slotCount };
    }
    case 0x2e:
      return { type: 'close-window', windowId: r.u8() };
    case 0x32:
      return {
        type: 'confirm-transaction',
        windowId: r.u8(),
        actionNumber: r.i16(),
        accepted: r.bool(),
      };
    case 0x40:
      return { type: 'disconnect', reason: r.string() };
    case 0x0c: {
      const entityId = r.varInt();
      r.string(); // uuid
      const name = r.string();
      const properties = r.varInt();
      for (let i = 0; i < properties; i++) {
        r.string(); // name
        r.string(); // value
        r.string(); // signature
      }
      return { type: 'spawn-player', entityId, name, ...fixedPointPosition(r) };
    }
    case 0x0e: {
      const entityId = r.varInt();
      const objectType = r.i8();
      return { type: 'spawn-object', entityId, objectType, ...fixedPointPosition(r) };
    }
    case 0x0f: {
      const entityId = r.varInt();
      const mobType = r.u8();
      return { type: 'spawn-mob', entityId, mobType, ...fixedPointPosition(r) };
    }
    case 0x13: {
      const count = r.u8();
      const entityIds: number[] = [];
      for (let i = 0; i < count; i++) entityIds.push(r.i32());
      return { type: 'destroy-entities', entityIds };
    }
    case 0x15:
    case 0x17: // relative move (+ look, which is ignored)
      return {
        type: 'entity-move',
        entityId: r.i32(),
        dx: r.i8() / 32,
        dy: r.i8() / 32,
        dz: r.i8() / 32,
      };
    case 0x18:
      return { type: 'entity-teleport', entityId: r.i32(), ...fixedPointPosition(r) };
    case 0x21: {
      const chunkX = r.i32();
      const chunkZ = r.i32();
      const groundUp = r.bool();
      const primaryBitMask = r.u16();
      const addBitMask = r.u16();
      const compressed = Buffer.from(r.bytes(r.i32()));
      return {
        type: 'chunk-data',
        header: { chunkX, chunkZ, primaryBitMask, addBitMask },
        groundUp,
        unload: groundUp && primaryBitMask === 0,
        compressed,
      };
    }
    case 0x26: {
      // Map Chunk Bulk: column count, one compressed stream, then per-column headers.
      // NotEnoughIDs does not change this header (verified live: 0 bytes left over).
      const columnCount = r.i16();
      const dataLength = r.i32();
      const skyLight = r.bool();
      const compressed = Buffer.from(r.bytes(dataLength));
      const columns: ColumnHeader[] = [];
      for (let i = 0; i < columnCount; i++) {
        columns.push({
          chunkX: r.i32(),
          chunkZ: r.i32(),
          primaryBitMask: r.u16(),
          addBitMask: r.u16(),
        });
      }
      return { type: 'chunk-bulk', columns, skyLight, compressed };
    }
    case 0x23: {
      const x = r.i32();
      const y = r.u8();
      const z = r.i32();
      const blockId = r.varInt();
      if (options.neid)
        r.i16(); // metadata (short with NEID)
      else r.u8(); // metadata (byte in vanilla)
      return { type: 'block-change', x, y, z, blockId };
    }
    case 0x22: {
      const chunkX = r.i32();
      const chunkZ = r.i32();
      const count = r.u16();
      const dataSize = r.i32();
      const recordSize = options.neid ? 6 : 4;
      if (dataSize !== count * recordSize) {
        throw new ProtocolError(
          `multi block change: ${dataSize} bytes for ${count} records of ${recordSize}`,
        );
      }
      const records: Array<{ x: number; y: number; z: number; blockId: number }> = [];
      for (let i = 0; i < count; i++) {
        const pos = r.u16(); // x<<12 | z<<8 | y
        let blockId: number;
        if (options.neid) {
          blockId = r.u16();
          r.u16(); // metadata
        } else {
          blockId = r.u16() >> 4; // id<<4 | meta
        }
        records.push({
          x: chunkX * 16 + (pos >> 12),
          y: pos & 0xff,
          z: chunkZ * 16 + ((pos >> 8) & 15),
          blockId,
        });
      }
      return { type: 'multi-block-change', chunkX, chunkZ, records };
    }
    default:
      return { type: 'unhandled', id: packetId };
  }
}
