import { connect } from 'node:net';
import { assertPrivateDestination } from '../../../config/network.ts';
import { errorMessage } from '../../../util/json.ts';
import { BQ_CHANNEL, BqAssembler, decodeBqMessage } from '../better-questing.ts';
import { FmlClientHandshake, MultipartAssembler } from '../fml-handshake.ts';
import { decodeGregTechMessage, GT_CHANNEL } from '../gregtech.ts';
import type { ConnectionInfo, Gtnh1710ClientOptions } from '../gtnh-client.ts';
import {
  decodeFmlRuntimeMessage,
  decodeLogin,
  decodePlay,
  outbound,
  PLAYER_EYE_HEIGHT,
  type PlayPacket,
  type ServerPosition,
} from '../packets.ts';
import { parseIdentity, statusPing, type ServerIdentity } from '../status-ping.ts';
import { FrameDecoder, ProtocolError, type Frame } from '../wire.ts';
import type { WorldModel } from '../world-model.ts';
import type { ClientCore } from './core.ts';
import { delay, ON_GROUND } from './shared.ts';

/** How long after a death the client asks to respawn (the death screen's button delay). */
const RESPAWN_DELAY_MS = 1_000;

/**
 * Connecting, and the protocol from then on: the status ping that identifies the server before
 * anything else is sent, the login and the FML handshake, every frame folded into the world
 * model (packets.ts decodes it), the plugin channels (FML, GregTech, Better Questing), the
 * answers the protocol needs (keep-alive, position confirmations), and the respawn after a
 * death.
 */
export class Connection {
  readonly #core: ClientCore;
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world: WorldModel;
  readonly #multipart = new MultipartAssembler();
  /** Better Questing's sliced messages from the server, reassembled. */
  readonly #questBookSlices = new BqAssembler();
  #handshake: FmlClientHandshake | null = null;
  #identity: ServerIdentity | null = null;
  #connectedAt: Date | null = null;
  /** The player died and a respawn was asked for (until the server sends health again). */
  #respawnAsked = false;

  constructor(core: ClientCore) {
    this.#core = core;
    this.#opts = core.opts;
    this.#world = core.world;
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
      outboundCounts: Object.fromEntries(this.#core.outboundCounts),
      confirmedServerPositions: this.#core.confirmedPositions,
      connectedAt: this.#connectedAt?.toISOString() ?? null,
      closedReason: this.#core.closedReason,
      recentChat: this.#world.recentChat,
    };
  }

  async connect(): Promise<void> {
    if (this.#core.phase !== 'idle') throw new Error('Gtnh1710Client can only connect once');
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
    this.#core.decoding = {
      itemStackSizeVarInt: this.#identity.mods.some((m) => m.modid === 'modularui'),
      neid: this.#identity.mods.some((m) => m.modid === 'neid'),
    };
    this.#world.setChunkFormat({ neid: this.#core.decoding.neid });
    this.#world.setServerMods(this.#identity.mods);
    this.#world.setQuestScope(this.#opts.questScope ?? []);
    this.#world.setContainers(
      Object.entries(cfg.containers.chests).map(([id, c]) => ({
        id,
        name: c.name,
        position: { ...c.position },
      })),
    );
    this.#world.setCraftingTables(
      Object.entries(cfg.crafting.tables).map(([id, t]) => ({
        id,
        name: t.name,
        position: { ...t.position },
      })),
    );
    this.#world.setObservePatterns(cfg.interact.observeOnly);
    this.#core.log(
      `block format: ${this.#core.decoding.neid ? 'NotEnoughIDs (16-bit ids)' : 'vanilla'}`,
    );
    this.#core.log(
      `item stack format: ${this.#core.decoding.itemStackSizeVarInt ? 'ModularUI (VarInt stack size)' : 'vanilla'}`,
    );
    await this.#join(deadline);
    // Wait (bounded) until health, inventory, a complete entity picture and the chunks the
    // hazard scan needs have arrived: a first observation without them is unreliable, and the
    // safety policy pauses on it (seen live right after a login).
    await this.#core.waitFor(
      () =>
        this.#world.hasHealth &&
        this.#world.hasInventory &&
        this.#world.entitiesReady(this.#opts.clock.now()) &&
        this.#world.surroundingsKnown,
      cfg.initialStateGraceMs,
    );
  }

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
        this.#core.log(`identified server: ${identity.motd} (${identity.mods.length} mods)`);
        return identity;
      }
      if (result.kind === 'disconnect' && /still starting/i.test(result.text)) {
        this.#core.log('server is still starting; retrying');
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
        this.#core.close(error.message);
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fail(
            new Error(`Timed out joining (handshake step: ${this.#handshake?.step ?? 'login'})`),
          ),
        Math.max(0, deadline - Date.now()),
      );
      const unsubscribe = this.#core.subscribe(() => {
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
        this.#core.log('joined the world');
        resolve();
      });

      const decoder = new FrameDecoder();
      const socket = connect(port, host);
      this.#core.socket = socket;
      this.#core.phase = 'connecting';
      socket.setNoDelay(true);
      socket.on('connect', () => {
        this.#core.phase = 'login';
        this.#core.send(outbound.handshake(host, port, 2));
        this.#core.send(outbound.loginStart(username));
      });
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const frame of decoder.push(chunk)) {
            this.#handleFrame(frame);
            if (this.#core.phase === 'closed') return;
          }
        } catch (error) {
          const message = errorMessage(error);
          if (settled) this.#core.close(message);
          else fail(error instanceof Error ? error : new Error(message));
        }
      });
      socket.on('error', (error) => {
        if (settled) this.#core.close(`socket error: ${error.message}`);
        else fail(error);
      });
      socket.on('close', () => {
        if (settled) this.#core.close('connection closed by the server');
        else fail(new Error(this.#core.closedReason ?? 'connection closed while joining'));
      });
    });
  }

  #handleFrame(frame: Frame): void {
    const at = this.#opts.clock.now();
    if (
      this.#opts.onFrame !== undefined &&
      (this.#core.phase === 'login' || this.#core.phase === 'play')
    ) {
      this.#opts.onFrame(
        this.#core.phase,
        frame.packetId,
        Buffer.from(frame.body.buf.subarray(frame.body.offset)),
      );
    }
    if (this.#core.phase === 'login') {
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
          this.#core.phase = 'play';
          this.#handshake = new FmlClientHandshake(this.#identity.mods);
          // Better Questing keys this player's progress by this UUID (GameProfile id).
          this.#world.questBook.setPlayer(packet.uuid);
          this.#core.log(`logged in as ${packet.username}`);
          return;
        case 'unhandled':
          return;
      }
    }

    const bodyStart = frame.body.offset;
    let packet: PlayPacket;
    try {
      packet = decodePlay(frame.packetId, frame.body, this.#core.decoding);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      // Frames are length-delimited, so skipping one never desynchronizes the stream.
      // The world model marks whatever that packet would have updated as unknown.
      const bytes = frame.body.buf.subarray(bodyStart);
      this.#core.log(
        `could not decode packet 0x${frame.packetId.toString(16).padStart(2, '0')} ` +
          `(${bytes.length} bytes): ${error.message}; first bytes ${bytes.subarray(0, 256).toString('hex')}`,
      );
      this.#world.markUndecodable(frame.packetId, error.message, at);
      this.#core.emit();
      return;
    }
    if (packet.type === 'server-position') this.#noteCorrection(packet);
    this.#world.apply(packet, at);
    switch (packet.type) {
      case 'keep-alive':
        this.#core.send(outbound.keepAlive(packet.id));
        break;
      case 'plugin-message':
        this.#onPluginMessage(packet.channel, packet.data);
        break;
      case 'server-position':
        this.#onServerPosition(packet);
        break;
      case 'disconnect':
        throw new Error(`Kicked: ${chatText(packet.reason)}`);
      case 'confirm-transaction':
        // Verdicts for the window clicks go to: the open window, or window 0 when none is.
        if (packet.windowId === (this.#world.openWindow?.windowId ?? 0)) {
          this.#core.clickVerdicts.set(packet.actionNumber, packet.accepted);
        }
        break;
      case 'update-health':
        if (packet.health <= 0) this.#onDeath();
        else this.#respawnAsked = false;
        break;
      case 'chat':
        // An owner's command (MC_OWNERS) is kept for the play loop, and a stop stops the
        // action in progress at once (chat-actions.ts); the world model keeps the raw line.
        this.#core.chat.onChat(packet.json, at);
        break;
      case 'open-window':
      case 'close-window':
      case 'window-property':
      case 'join-game':
      case 'spawn-position':
      case 'time-update':
      case 'change-game-state':
      case 'respawn':
      case 'held-item':
      case 'player-abilities':
      case 'set-slot':
      case 'window-items':
      case 'spawn-player':
      case 'spawn-object':
      case 'spawn-mob':
      case 'entity-status':
      case 'entity-metadata':
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
    this.#core.emit();
  }

  #onPluginMessage(channel: string, data: Buffer): void {
    if (channel === 'FML|MP') {
      const assembled = this.#multipart.push(data);
      if (assembled !== null) this.#onPluginMessage(assembled.channel, assembled.data);
      return;
    }
    if (channel === GT_CHANNEL) {
      // GregTech's own channel: machine placements and state changes (read-only).
      try {
        this.#world.applyGregTech(decodeGregTechMessage(data));
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#core.log(`could not decode GregTech message: ${error.message}`);
        this.#world.markMachineProblem(`undecodable GregTech message: ${error.message}`);
      }
      return;
    }
    if (channel === BQ_CHANNEL) {
      this.#onQuestBookMessage(data);
      return;
    }
    if (channel === 'FML') {
      // Forge runtime messages: this is how GTNH's modded mobs are spawned and moved.
      try {
        this.#world.applyFml(
          decodeFmlRuntimeMessage(data, this.#core.decoding),
          this.#opts.clock.now(),
        );
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#core.log(`could not decode FML message: ${error.message}`);
        this.#world.markEntityProblem(`undecodable FML entity message: ${error.message}`);
      }
      return;
    }
    if (channel !== 'FML|HS' || this.#handshake === null) return;
    const out = this.#handshake.onServerMessage(data);
    this.#core.log(`FML: ${out.note}`);
    for (const message of out.send)
      this.#core.send(outbound.pluginMessage(message.channel, message.data));
    if (this.#handshake.registry !== null && this.#world.registry === null) {
      this.#world.setRegistry(this.#handshake.registry);
    }
  }

  /**
   * Better Questing (BQ_NET_CHAN): reassemble the server's sliced message, fold it into the
   * quest book, and answer main_sync {respond} exactly as the stock client does (an empty
   * main_sync), which is what makes the server send the quest database. A message that
   * cannot be decoded makes the quest book unknown for this connection.
   */
  #onQuestBookMessage(data: Buffer): void {
    try {
      const payload = this.#questBookSlices.push(data);
      if (payload === null) return;
      const message = decodeBqMessage(payload);
      this.#world.applyQuestBook(message, this.#opts.clock.now());
      if (message.type === 'main-sync' && message.respond) {
        for (const p of outbound.questBook({ kind: 'main-sync-reply' })) this.#core.send(p);
        this.#core.log('quest book: answered main_sync; waiting for the quest database');
      }
      if (message.type === 'quest-sync' && !message.merge) {
        this.#core.log(`quest book: ${message.entries.length} quests from the server`);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#core.log(`could not decode a Better Questing message: ${error.message}`);
      this.#world.markQuestBookProblem(`undecodable Better Questing message: ${error.message}`);
    }
  }

  /**
   * A server position packet (S08) moves the player: at login, on a teleport, or to correct a
   * move the server did not accept. Where it put the player, against where the client had it,
   * goes into the reason a walk or a dig stops (seen live: a retreat stopped with only "the
   * server corrected the position", and nothing said where).
   */
  #noteCorrection(to: ServerPosition): void {
    const was = this.#world.ownPosition;
    if (was === null) {
      this.#core.lastCorrection = null;
      return;
    }
    const feetY = to.eyeY - PLAYER_EYE_HEIGHT;
    const at = (x: number, y: number, z: number) =>
      `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
    const moved = Math.hypot(to.x - was.x, feetY - was.y, to.z - was.z);
    this.#core.lastCorrection =
      `to ${at(to.x, feetY, to.z)}, ${moved.toFixed(2)} blocks from where the client had it ` +
      at(was.x, was.y, was.z);
    this.#core.log(`the server moved the player ${this.#core.lastCorrection}`);
  }

  /**
   * The player died (its health came as 0). A dead player stays dead until its client asks
   * to respawn, as a player clicks Respawn on the death screen; whoever logs in next finds it
   * dead. So the client asks, once, a second later (the death screen's own delay), and says so
   * loudly: a death is never routine. Its items lie where it died; it respawns at the spawn
   * point, with the health and food the server gives a respawned player.
   */
  #onDeath(): void {
    if (this.#respawnAsked) return;
    this.#respawnAsked = true;
    const at = this.#world.ownPosition;
    this.#core.log(
      `THE PLAYER DIED${at === null ? '' : ` at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`}` +
        ` (food ${this.#world.food ?? 'unknown'}): asking the server to respawn it`,
    );
    const timer = setTimeout(() => {
      if (this.#core.phase === 'play') this.#core.send(outbound.respawn());
    }, RESPAWN_DELAY_MS);
    timer.unref();
  }

  /**
   * Acknowledge the server's placement (exact echo) and start idle ticks, if presence is
   * enabled. A placement during a walk stops the walk (its step check sees the count change).
   */
  #onServerPosition(position: ServerPosition): void {
    if (!this.#opts.config.presenceTicks) return;
    this.#core.send(outbound.confirmServerPosition(position, ON_GROUND));
    this.#core.confirmedPositions += 1;
    this.#core.movement.startIdle();
  }
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
