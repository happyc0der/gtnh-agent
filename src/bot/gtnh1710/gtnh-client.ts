import { connect, type Socket } from 'node:net';
import type { MinecraftConfig } from '../../config/env.ts';
import { assertPrivateDestination } from '../../config/network.ts';
import type { GameState } from '../../domain/game-state.ts';
import { assertValidatedAction, type ValidatedAction } from '../../domain/validated-action.ts';
import type { Clock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from '../minecraft-client.ts';
import { FmlClientHandshake, MultipartAssembler } from './fml-handshake.ts';
import {
  decodeLogin,
  decodePlay,
  outbound,
  type OutboundKind,
  type OutboundPacket,
  type PlayDecodeOptions,
  type PlayPacket,
  type ServerPosition,
  VANILLA_DECODING,
} from './packets.ts';
import { parseIdentity, statusPing, type ServerIdentity } from './status-ping.ts';
import { FrameDecoder, ProtocolError, type Frame } from './wire.ts';
import { WorldModel } from './world-model.ts';

/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** The server sends at least a time update every second; within this window the state is current. */
const FRESHNESS_WINDOW_MS = 3_000;
/**
 * Reported with presence packets. The client never moves, so this only matters for fall
 * handling (no vertical movement means no fall damage either way).
 */
const ON_GROUND = true;

export interface Gtnh1710ClientOptions {
  config: MinecraftConfig;
  clock: Clock;
  log?: (line: string) => void;
  /** DNS resolver override (tests). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Delay between retries while Forge reports "Server is still starting!". */
  retryDelayMs?: number;
}

export interface ConnectionInfo {
  identity: { motd: string; version: string | null; mods: number } | null;
  handshakeStep: string | null;
  registry: { items: number; blocks: number } | null;
  outboundCounts: Record<string, number>;
  confirmedServerPositions: number;
  connectedAt: string | null;
  closedReason: string | null;
  recentChat: readonly string[];
}

type Phase = 'idle' | 'connecting' | 'login' | 'play' | 'closed';

/**
 * READ-ONLY client for a private GTNH (Minecraft 1.7.10 + Forge) server.
 *
 * Guarantees, enforced here and in packets.ts:
 *  - never connects unless live connections are enabled, an identity marker is set, the
 *    host is private, and the server's status ping shows that marker, Forge and GregTech;
 *  - can only send: handshake, status request, login start, keep-alive, FML handshake /
 *    channel registration, idle ticks, and confirmations of server-assigned positions;
 *  - perform() only supports OBSERVE_STATE, WAIT and PAUSE_AND_ASK_USER; every
 *    world-changing action returns NOT_IMPLEMENTED without sending anything.
 */
export class Gtnh1710Client implements MinecraftClient {
  readonly kind = 'gtnh1710';
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world = new WorldModel();
  readonly #multipart = new MultipartAssembler();
  readonly #outboundCounts = new Map<OutboundKind, number>();
  #socket: Socket | null = null;
  #phase: Phase = 'idle';
  #handshake: FmlClientHandshake | null = null;
  #identity: ServerIdentity | null = null;
  #decoding: PlayDecodeOptions = VANILLA_DECODING;
  #idleTimer: NodeJS.Timeout | null = null;
  #closedReason: string | null = null;
  #connectedAt: Date | null = null;
  #confirmedPositions = 0;
  #listeners: Array<() => void> = [];

  constructor(opts: Gtnh1710ClientOptions) {
    this.#opts = opts;
  }

  /** Read access for diagnostics and tests. */
  get world(): WorldModel {
    return this.#world;
  }

  info(): ConnectionInfo {
    return {
      identity: this.#identity && {
        motd: this.#identity.motd,
        version: this.#identity.versionName,
        mods: this.#identity.mods.length,
      },
      handshakeStep: this.#handshake?.step ?? null,
      registry: this.#world.registry && {
        items: this.#world.registry.items.size,
        blocks: this.#world.registry.blocks.size,
      },
      outboundCounts: Object.fromEntries(this.#outboundCounts),
      confirmedServerPositions: this.#confirmedPositions,
      connectedAt: this.#connectedAt?.toISOString() ?? null,
      closedReason: this.#closedReason,
      recentChat: this.#world.recentChat,
    };
  }

  async connect(): Promise<void> {
    if (this.#phase !== 'idle') throw new Error('Gtnh1710Client can only connect once');
    const cfg = this.#opts.config;
    if (!cfg.enableLiveConnection) {
      throw new Error(
        'Live connection is disabled (set MC_ENABLE_LIVE_CONNECTION=true for a private test server).',
      );
    }
    if (cfg.serverIdentityMarker === null) {
      throw new Error(
        'No server identity marker configured (MC_SERVER_MARKER); refusing to join an unidentified server.',
      );
    }
    await assertPrivateDestination(cfg.host, cfg.allowedHostnames, this.#opts.resolveHost);

    const deadline = Date.now() + cfg.connectTimeoutMs;
    this.#identity = await this.#identify(cfg.serverIdentityMarker, deadline);
    // Wire-format quirks are chosen from the server's own mod list, never guessed.
    this.#decoding = {
      itemStackSizeVarInt: this.#identity.mods.some((m) => m.modid === 'modularui'),
    };
    this.#log(
      `item stack format: ${this.#decoding.itemStackSizeVarInt ? 'ModularUI (VarInt stack size)' : 'vanilla'}`,
    );
    await this.#join(deadline);
    await this.#waitFor(
      () => this.#world.hasHealth && this.#world.hasInventory,
      cfg.initialStateGraceMs,
    );
  }

  disconnect(): Promise<void> {
    this.#close('disconnected by the agent', true);
    return Promise.resolve();
  }

  observe(): Promise<GameState> {
    if (this.#phase !== 'play') {
      return Promise.reject(
        new Error(
          this.#closedReason === null ? 'not connected' : `connection lost: ${this.#closedReason}`,
        ),
      );
    }
    const now = this.#opts.clock.now();
    const last = this.#world.lastPacketAt;
    // While packets keep arriving the model is current; if the server goes quiet the
    // timestamp stops advancing, so the safety policy's staleness check fires.
    const asOf = last !== null && now.getTime() - last.getTime() > FRESHNESS_WINDOW_MS ? last : now;
    return Promise.resolve(this.#world.toGameState(asOf));
  }

  perform(validated: ValidatedAction): Promise<ClientActionResult> {
    assertValidatedAction(validated);
    if (this.#phase !== 'play') return Promise.resolve(failed('not connected', 'ERROR'));
    const action = validated.action;
    switch (action.type) {
      case 'OBSERVE_STATE':
        return Promise.resolve(ok('observation is taken by the executor after every action'));
      case 'WAIT':
        return new Promise((resolve) =>
          setTimeout(
            () => resolve(ok(`waited ${action.args.durationMs} ms`)),
            action.args.durationMs,
          ),
        );
      case 'PAUSE_AND_ASK_USER':
        // Recorded by the agent; deliberately not sent as in-game chat.
        return Promise.resolve(ok('pause recorded (not sent in-game)', { acknowledged: true }));
      case 'MOVE_TO':
      case 'RETURN_TO_SAFE_LOCATION':
      case 'EAT_FOOD':
      case 'OPEN_CONTAINER':
      case 'DEPOSIT_ITEM':
      case 'WITHDRAW_ITEM':
      case 'INSPECT_MACHINE':
      case 'REFUEL_KNOWN_GENERATOR':
        return Promise.resolve(
          failed(
            `${action.type} is not available: the GTNH client is read-only`,
            'NOT_IMPLEMENTED',
          ),
        );
    }
  }

  // -------------------------------------------------------------------------

  async #identify(marker: string, deadline: number): Promise<ServerIdentity> {
    const { host, port } = this.#opts.config;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for the server to accept connections');
      const result = await statusPing(host, port, Math.min(remaining, 10_000));
      if (result.kind === 'status') {
        const identity = parseIdentity(result.json);
        if (!identity.motd.includes(marker)) {
          throw new Error(
            `Refusing to join: server MOTD ${JSON.stringify(identity.motd)} does not contain "${marker}"`,
          );
        }
        if (identity.modinfoType !== 'FML')
          throw new Error('Refusing to join: not a Forge (FML) server');
        if (!identity.mods.some((m) => m.modid === 'gregtech')) {
          throw new Error('Refusing to join: server does not report GregTech');
        }
        if (identity.versionName !== '1.7.10') {
          throw new Error(
            `Refusing to join: server version is ${identity.versionName ?? 'unknown'}, expected 1.7.10`,
          );
        }
        this.#log(`identified server: ${identity.motd} (${identity.mods.length} mods)`);
        return identity;
      }
      if (result.kind === 'disconnect' && /still starting/i.test(result.text)) {
        this.#log('server is still starting; retrying');
        await delay(Math.min(this.#opts.retryDelayMs ?? 2_000, Math.max(0, deadline - Date.now())));
        continue;
      }
      throw new Error(
        `Status ping failed: ${result.kind === 'error' ? result.error : result.text}`,
      );
    }
  }

  #join(deadline: number): Promise<void> {
    const { host, port, username } = this.#opts.config;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.#close(error.message);
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(`Timed out joining (handshake step: ${this.#handshake?.step ?? 'login'})`),
          ),
        Math.max(0, deadline - Date.now()),
      );
      const unsubscribe = this.#subscribe(() => {
        if (
          settled ||
          !this.#world.joined ||
          !this.#world.hasPosition ||
          this.#handshake?.done !== true
        )
          return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        this.#connectedAt = this.#opts.clock.now();
        this.#log('joined the world');
        resolve();
      });

      const decoder = new FrameDecoder();
      const socket = connect(port, host);
      this.#socket = socket;
      this.#phase = 'connecting';
      socket.setNoDelay(true);
      socket.on('connect', () => {
        this.#phase = 'login';
        this.#send(outbound.handshake(host, port, 2));
        this.#send(outbound.loginStart(username));
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) {
            this.#handleFrame(frame);
            if (this.#phase === 'closed') return;
          }
        } catch (error) {
          const message = errorMessage(error);
          if (settled) this.#close(message);
          else fail(error instanceof Error ? error : new Error(message));
        }
      });
      socket.on('error', (error) => {
        if (settled) this.#close(`socket error: ${error.message}`);
        else fail(error);
      });
      socket.on('close', () => {
        if (settled) this.#close('connection closed by the server');
        else fail(new Error(this.#closedReason ?? 'connection closed while joining'));
      });
    });
  }

  #handleFrame(frame: Frame): void {
    const at = this.#opts.clock.now();
    if (this.#phase === 'login') {
      const packet = decodeLogin(frame.packetId, frame.body);
      switch (packet.type) {
        case 'login-disconnect':
          throw new Error(`Kicked during login: ${chatText(packet.reason)}`);
        case 'encryption-request':
          throw new Error(
            'Server is in online mode; the agent only joins offline-mode private test servers',
          );
        case 'login-success':
          if (this.#identity === null) throw new Error('internal: identity missing at login');
          this.#phase = 'play';
          this.#handshake = new FmlClientHandshake(this.#identity.mods);
          this.#log(`logged in as ${packet.username}`);
          return;
        case 'unhandled':
          return;
      }
    }

    const bodyStart = frame.body.offset;
    let packet: PlayPacket;
    try {
      packet = decodePlay(frame.packetId, frame.body, this.#decoding);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // Frames are length-delimited, so skipping one never desynchronizes the stream.
      // The world model marks whatever that packet would have updated as unknown.
      const bytes = frame.body.buf.subarray(bodyStart);
      this.#log(
        `could not decode packet 0x${frame.packetId.toString(16).padStart(2, '0')} ` +
          `(${bytes.length} bytes): ${error.message}; first bytes ${bytes.subarray(0, 256).toString('hex')}`,
      );
      this.#world.markUndecodable(frame.packetId, error.message, at);
      this.#emit();
      return;
    }
    this.#world.apply(packet, at);
    switch (packet.type) {
      case 'keep-alive':
        this.#send(outbound.keepAlive(packet.id));
        break;
      case 'plugin-message':
        this.#onPluginMessage(packet.channel, packet.data);
        break;
      case 'server-position':
        this.#onServerPosition(packet);
        break;
      case 'disconnect':
        throw new Error(`Kicked: ${chatText(packet.reason)}`);
      case 'join-game':
      case 'chat':
      case 'spawn-position':
      case 'update-health':
      case 'respawn':
      case 'held-item':
      case 'set-slot':
      case 'window-items':
      case 'unhandled':
        break; // observation only: already folded into the world model above
    }
    this.#emit();
  }

  #onPluginMessage(channel: string, data: Buffer): void {
    if (channel === 'FML|MP') {
      const assembled = this.#multipart.push(data);
      if (assembled !== null) this.#onPluginMessage(assembled.channel, assembled.data);
      return;
    }
    if (channel !== 'FML|HS' || this.#handshake === null) return;
    const out = this.#handshake.onServerMessage(data);
    this.#log(`FML: ${out.note}`);
    for (const message of out.send)
      this.#send(outbound.pluginMessage(message.channel, message.data));
    if (this.#handshake.registry !== null && this.#world.registry === null) {
      this.#world.setRegistry(this.#handshake.registry);
    }
  }

  /** Acknowledge the server's placement (exact echo) and start idle ticks, if presence is enabled. */
  #onServerPosition(position: ServerPosition): void {
    if (!this.#opts.config.presenceTicks) return;
    this.#send(outbound.confirmServerPosition(position, ON_GROUND));
    this.#confirmedPositions += 1;
    if (this.#idleTimer === null) {
      this.#idleTimer = setInterval(() => this.#send(outbound.playerIdle(ON_GROUND)), IDLE_TICK_MS);
    }
  }

  #send(packet: OutboundPacket): void {
    const socket = this.#socket;
    if (socket === null || socket.destroyed || this.#phase === 'closed') return;
    socket.write(packet.frame);
    this.#outboundCounts.set(packet.kind, (this.#outboundCounts.get(packet.kind) ?? 0) + 1);
  }

  /**
   * Stop all traffic. A graceful close (our own disconnect) sends a normal TCP FIN and
   * keeps draining incoming data until the server closes, so the server logs a clean
   * "Disconnected" instead of "Connection reset"; it is forced after one second.
   */
  #close(reason: string, graceful = false): void {
    if (this.#phase === 'closed') return;
    this.#phase = 'closed';
    this.#closedReason = reason;
    if (this.#idleTimer !== null) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
    const socket = this.#socket;
    if (socket !== null && !socket.destroyed) {
      if (graceful) {
        socket.removeAllListeners('data');
        socket.on('data', () => undefined); // drain, ignore
        socket.end();
        const force = setTimeout(() => socket.destroy(), 1_000);
        force.unref();
        socket.once('close', () => clearTimeout(force));
      } else {
        socket.destroy();
      }
    }
    this.#log(`closed: ${reason}`);
    this.#emit();
  }

  #subscribe(listener: () => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Resolves when `condition` holds, the connection closes, or `timeoutMs` passes. */
  #waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const unsubscribe = this.#subscribe(() => {
        if (condition() || this.#phase === 'closed') finish();
      });
      if (condition()) finish();
    });
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plain text of a chat-component JSON string (best effort, for error messages). */
function chatText(json: string): string {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'string') return parsed;
    const c = parsed as { text?: unknown; translate?: unknown; extra?: unknown[] };
    const extra = Array.isArray(c.extra)
      ? c.extra.map((e) => chatText(JSON.stringify(e))).join('')
      : '';
    const base =
      typeof c.text === 'string' ? c.text : typeof c.translate === 'string' ? c.translate : '';
    return `${base}${extra}` || json;
  } catch {
    return json;
  }
}
