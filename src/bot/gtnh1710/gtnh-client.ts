import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import type { MinecraftConfig } from '../../config/env.ts';
import { assertPrivateDestination } from '../../config/network.ts';
import type { GameState } from '../../domain/game-state.ts';
import type { Position } from '../../domain/common.ts';
import { assertValidatedAction, type ValidatedAction } from '../../domain/validated-action.ts';
import type { Clock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from '../minecraft-client.ts';
import { FmlClientHandshake, MultipartAssembler } from './fml-handshake.ts';
import {
  decodeFmlRuntimeMessage,
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
import {
  planWalk,
  renderWalkMap,
  segmentProblem,
  stepsAlong,
  yawTowards,
  type Fence,
  type Vec3,
  type WalkPlan,
} from './walking.ts';
import { FrameDecoder, ProtocolError, type Frame } from './wire.ts';
import { WorldModel } from './world-model.ts';

/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** Walking sends one position per tick. */
const WALK_TICK_MS = 50;
/** After the last step, ticks to wait for a server correction before calling a walk done. */
const SETTLE_TICKS = 5;
/** The server sends at least a time update every second; within this window the state is current. */
const FRESHNESS_WINDOW_MS = 3_000;
/**
 * Reported with every presence and walking packet. The walker only ever stands or walks on
 * a full block (never jumps or falls), so the player is always on the ground.
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
  /**
   * Diagnostic tap: sees every incoming frame (read-only copy) before it is decoded.
   * Used by research scripts; must never be used to send anything.
   */
  onFrame?: (phase: 'login' | 'play', packetId: number, body: Buffer) => void;
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
 * Client for a private GTNH (Minecraft 1.7.10 + Forge) server: read-only, except that it
 * can WALK when movement is explicitly enabled with a fence.
 *
 * Guarantees, enforced here and in packets.ts:
 *  - never connects unless live connections are enabled, an identity marker is set, the
 *    host is private, and the server's status ping shows that marker, Forge and GregTech;
 *  - can only send: handshake, status request, login start, keep-alive, FML handshake /
 *    channel registration, idle ticks, confirmations of server-assigned positions, and
 *    walking steps;
 *  - perform() supports OBSERVE_STATE, WAIT and PAUSE_AND_ASK_USER, plus MOVE_TO and
 *    RETURN_TO_SAFE_LOCATION as walks when movement is enabled (NOT_IMPLEMENTED
 *    otherwise); every other world-changing action returns NOT_IMPLEMENTED without
 *    sending anything;
 *  - a walk stays on one level inside the fence, and every step is re-checked just before
 *    it is sent; it stops on a server correction, a health drop, a nearby threat (MOVE_TO),
 *    a blocked or dangerous way ahead, the stop file, halt(), or a lost connection.
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
  #walking = false;
  #haltReason: string | null = null;

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
      neid: this.#identity.mods.some((m) => m.modid === 'neid'),
    };
    this.#world.setChunkFormat({ neid: this.#decoding.neid });
    this.#world.setServerMods(this.#identity.mods);
    this.#log(`block format: ${this.#decoding.neid ? 'NotEnoughIDs (16-bit ids)' : 'vanilla'}`);
    this.#log(
      `item stack format: ${this.#decoding.itemStackSizeVarInt ? 'ModularUI (VarInt stack size)' : 'vanilla'}`,
    );
    await this.#join(deadline);
    // Wait (bounded) until health, inventory and a complete entity picture have arrived.
    await this.#waitFor(
      () =>
        this.#world.hasHealth &&
        this.#world.hasInventory &&
        this.#world.entitiesReady(this.#opts.clock.now()),
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
        return this.#walkTo(action.args.target, { stopForThreats: true });
      case 'RETURN_TO_SAFE_LOCATION':
        // A retreat is how the agent gets away from a threat, so threats do not stop it.
        return this.#walkTo(validated.resolvedTarget, { stopForThreats: false });
      case 'EAT_FOOD':
      case 'OPEN_CONTAINER':
      case 'DEPOSIT_ITEM':
      case 'WITHDRAW_ITEM':
      case 'INSPECT_MACHINE':
      case 'REFUEL_KNOWN_GENERATOR':
        return Promise.resolve(
          failed(
            `${action.type} is not available: the GTNH client can only observe and walk`,
            'NOT_IMPLEMENTED',
          ),
        );
    }
  }

  /** Stops a walk in progress at its next step and refuses new walks (e.g. on Ctrl+C). */
  halt(reason: string): void {
    this.#haltReason = reason;
  }

  /**
   * Plans a walk without moving (for previews and dry runs), with a text map of the fence.
   * Works whether or not movement is enabled; null when no fence is configured.
   */
  previewWalk(target: Position | null): { plan: WalkPlan | null; map: string[] } | null {
    const m = this.#opts.config.movement;
    if (m.fence === null) return null;
    const fence = fenceOf(m.fence);
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return { plan: { ok: false, reason: 'block data or position unknown' }, map: [] };
    }
    const plan = target === null ? null : planWalk(world, fence, from, target, m.maxPathLength);
    const entities = this.#world.nearbyEntities(64).map((e) => ({
      id: e.entityId,
      threat: e.category === 'hostile' || e.category === 'unclassified',
    }));
    const positions = new Map(this.#world.trackedEntities().map((e) => [e.entityId, e]));
    const map = renderWalkMap(world, fence, {
      player: from,
      target,
      path: plan?.ok === true ? plan.waypoints : [],
      entities: entities.flatMap((e) => {
        const p = positions.get(e.id);
        return p === undefined ? [] : [{ x: p.x, z: p.z, threat: e.threat }];
      }),
    });
    return { plan, map };
  }

  /** Why walking cannot start or continue now, or null. */
  #movementBlocker(): string | null {
    const m = this.#opts.config.movement;
    if (!m.enabled) return 'movement is disabled (MC_ENABLE_MOVEMENT)';
    if (m.fence === null) return 'no movement fence is configured (MC_MOVEMENT_FENCE_MIN/MAX)';
    if (!this.#opts.config.presenceTicks) return 'walking needs presence ticks (MC_PRESENCE_TICKS)';
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(m.stopFile))) return `the stop file ${m.stopFile} exists`;
    return null;
  }

  async #walkTo(
    target: Readonly<Position> | null,
    options: { stopForThreats: boolean },
  ): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const blocker = this.#movementBlocker();
    if (blocker !== null || m.fence === null) {
      return failed(`not walking: ${blocker}`, m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED');
    }
    if (target === null) return failed('not walking: no resolved target', 'ERROR');
    if (this.#walking) return failed('not walking: a walk is already in progress', 'REFUSED');
    const fence = fenceOf(m.fence);
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return failed('not walking: block data or position unknown', 'REFUSED');
    }
    const plan = planWalk(world, fence, from, target, m.maxPathLength);
    if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');

    const steps = stepsAlong(plan.waypoints);
    this.#log(
      `walking ${plan.length.toFixed(2)} blocks in ${steps.length} steps (${plan.waypoints.length - 1} stretch(es))`,
    );
    const placementsAtStart = this.#confirmedPositions;
    const healthAtStart = this.#world.health;
    let at: Vec3 = from;
    let taken = 0;
    const stopped = (reason: string): ClientActionResult => {
      const where = this.#world.ownPosition ?? at;
      this.#log(`walk stopped after ${taken}/${steps.length} steps: ${reason}`);
      return failed(`walk stopped after ${taken} of ${steps.length} steps: ${reason}`, 'FAILED', {
        stepsTaken: taken,
        stepsPlanned: steps.length,
        x: where.x,
        y: where.y,
        z: where.z,
      });
    };

    this.#walking = true;
    this.#stopIdle();
    try {
      for (const next of steps) {
        const reason = this.#stepProblem(world, fence, at, next, {
          placementsAtStart,
          healthAtStart,
          stopForThreats: options.stopForThreats,
        });
        if (reason !== null) return stopped(reason);
        this.#send(
          outbound.playerMove(
            { x: next.x, feetY: next.y, z: next.z, yaw: yawTowards(at, next), pitch: 0 },
            ON_GROUND,
          ),
        );
        this.#world.setOwnPosition(next);
        at = next;
        taken += 1;
        await delay(WALK_TICK_MS);
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      for (let i = 0; i < SETTLE_TICKS; i++) {
        if (this.#phase !== 'play') return stopped('the connection closed');
        if (this.#confirmedPositions !== placementsAtStart) {
          return stopped('the server corrected the final position');
        }
        this.#send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      if (this.#phase !== 'play') return stopped('the connection closed');
      if (this.#confirmedPositions !== placementsAtStart) {
        return stopped('the server corrected the final position');
      }
      return ok(`walked ${plan.length.toFixed(2)} blocks in ${steps.length} steps`, {
        steps: steps.length,
        distance: Number(plan.length.toFixed(3)),
        x: at.x,
        y: at.y,
        z: at.z,
      });
    } finally {
      this.#walking = false;
      if (this.#phase === 'play') this.#startIdle();
    }
  }

  /** Why the next step must not be taken, or null. Checked immediately before every step. */
  #stepProblem(
    world: NonNullable<ReturnType<WorldModel['walkWorld']>>,
    fence: Fence,
    from: Vec3,
    to: Vec3,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
  ): string | null {
    if (this.#phase !== 'play') return 'the connection closed';
    const blocker = this.#movementBlocker();
    if (blocker !== null) return blocker;
    if (this.#confirmedPositions !== guard.placementsAtStart) {
      return 'the server corrected the position';
    }
    const health = this.#world.health;
    if (guard.healthAtStart !== null && health !== null && health < guard.healthAtStart) {
      return `health dropped from ${guard.healthAtStart} to ${health}`;
    }
    if (guard.stopForThreats) {
      if (!this.#world.entitiesReady(this.#opts.clock.now())) {
        return 'the entities around the player are not fully known';
      }
      const radius = this.#opts.config.movement.threatRadius;
      const threat = this.#world
        .nearbyEntities(radius)
        .find((e) => e.category === 'hostile' || e.category === 'unclassified');
      if (threat !== undefined) {
        return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
      }
    }
    const problem = segmentProblem(world, fence, from, to);
    return problem === null ? null : `the way ahead is not clear: ${problem}`;
  }

  #startIdle(): void {
    if (this.#idleTimer !== null || this.#walking) return;
    this.#idleTimer = setInterval(() => this.#send(outbound.playerIdle(ON_GROUND)), IDLE_TICK_MS);
  }

  #stopIdle(): void {
    if (this.#idleTimer !== null) clearInterval(this.#idleTimer);
    this.#idleTimer = null;
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
    if (this.#opts.onFrame !== undefined && (this.#phase === 'login' || this.#phase === 'play')) {
      this.#opts.onFrame(
        this.#phase,
        frame.packetId,
        Buffer.from(frame.body.buf.subarray(frame.body.offset)),
      );
    }
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
      case 'spawn-player':
      case 'spawn-object':
      case 'spawn-mob':
      case 'destroy-entities':
      case 'entity-move':
      case 'entity-teleport':
      case 'chunk-data':
      case 'chunk-bulk':
      case 'block-change':
      case 'multi-block-change':
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
    if (channel === 'FML') {
      // Forge runtime messages: this is how GTNH's modded mobs are spawned and moved.
      try {
        this.#world.applyFml(decodeFmlRuntimeMessage(data), this.#opts.clock.now());
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#log(`could not decode FML message: ${error.message}`);
        this.#world.markEntityProblem(`undecodable FML entity message: ${error.message}`);
      }
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

  /**
   * Acknowledge the server's placement (exact echo) and start idle ticks, if presence is
   * enabled. A placement during a walk stops the walk (its step check sees the count change).
   */
  #onServerPosition(position: ServerPosition): void {
    if (!this.#opts.config.presenceTicks) return;
    this.#send(outbound.confirmServerPosition(position, ON_GROUND));
    this.#confirmedPositions += 1;
    this.#startIdle();
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
    this.#stopIdle();
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
      let done = false;
      const check = (): void => {
        if (!done && (condition() || this.#phase === 'closed')) finish();
      };
      const finish = (): void => {
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      // Re-check on every packet, and on a timer: some conditions (e.g. "entities have
      // settled") become true through elapsed time rather than a new packet.
      const poll = setInterval(check, 50);
      const unsubscribe = this.#subscribe(check);
      check();
    });
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fenceOf(f: { min: Position; max: Position }): Fence {
  return { min: { ...f.min }, max: { ...f.max } };
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
