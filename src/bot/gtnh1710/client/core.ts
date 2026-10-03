import type { Socket } from 'node:net';
import type { Gtnh1710ClientOptions } from '../gtnh-client.ts';
import {
  VANILLA_DECODING,
  type OutboundKind,
  type OutboundPacket,
  type PlayDecodeOptions,
} from '../packets.ts';
import { playArea, type PlayArea } from '../play-area.ts';
import { WorldModel } from '../world-model.ts';
import { ChatActions } from './chat-actions.ts';
import { CombatActions } from './combat-actions.ts';
import { Connection } from './connection.ts';
import { CraftActions } from './craft-actions.ts';
import { DigActions } from './dig-actions.ts';
import { InteractActions } from './interact-actions.ts';
import { InventoryActions } from './inventory-actions.ts';
import { MovementActions } from './movement-actions.ts';
import { Observation } from './observation.ts';
import { PlaceActions } from './place-actions.ts';
import { PlayerActions } from './player-actions.ts';
import { QuestBookActions } from './quest-book-actions.ts';
import { TravelActions } from './travel-actions.ts';

type Phase = 'idle' | 'connecting' | 'login' | 'play' | 'closed';

/**
 * What all parts of one Gtnh1710Client share: the options, the world model, the connection's
 * state and plumbing (send, close, waitFor, log), the fence of the moment, the flags that keep
 * walking, window work, digging, placing and fighting apart, and the feature modules, so that
 * each can use the others (a dig walks to its drop with movement.walkTo, a walk breaks leaves
 * with dig.digChecked, and whatever holds an item arranges the hotbar with inventory clicks).
 */
export class ClientCore {
  readonly opts: Gtnh1710ClientOptions;
  readonly world = new WorldModel();

  // The connection (connection.ts opens it and handles what arrives).
  readonly outboundCounts = new Map<OutboundKind, number>();
  socket: Socket | null = null;
  phase: Phase = 'idle';
  decoding: PlayDecodeOptions = VANILLA_DECODING;
  closedReason: string | null = null;
  confirmedPositions = 0;
  /**
   * Where the last server position packet put the player, in words (connection.ts
   * #noteCorrection).
   */
  lastCorrection: string | null = null;
  #listeners: Array<() => void> = [];
  /** Server verdicts on our clicks (S32), by action number. */
  readonly clickVerdicts = new Map<number, boolean>();
  lastYaw = 0;
  /** halt()'s reason (Ctrl+C): for the rest of the connection. */
  #halt: string | null = null;
  /** interrupt()'s reason (an owner's stop): until clearInterrupt(). */
  #interrupt: string | null = null;

  /**
   * Why every action must stop at its next step or tick, and none may start: halt()'s reason
   * (Ctrl+C: for good) or an interrupt's (an owner's stop: until the play loop has taken the
   * stop, clearInterrupt()). Every walk (and so every EXPLORE hop and retreat), dig, placement,
   * fight, window and quest-book click checks it before it starts and while it runs, so an
   * interrupt stops the action in progress at its next tick, and the one a cycle in flight
   * was about to start, without halt()'s lasting latch.
   */
  get haltReason(): string | null {
    return this.#halt ?? this.#interrupt;
  }

  set haltReason(reason: string | null) {
    this.#halt = reason;
  }

  /** Stops the action in progress (see haltReason) until clearInterrupt(). */
  interrupt(reason: string): void {
    if (this.#interrupt !== null) return;
    this.#interrupt = reason;
    this.log(`interrupted: ${reason}`);
    this.emit();
  }

  clearInterrupt(): void {
    this.#interrupt = null;
  }

  // What is running now: each action checks these before it starts.
  walking = false;
  /** A chest or crafting operation is running (they, and walking, exclude each other). */
  usingContainer = false;
  digging = false;
  /** An ATTACK_ENTITY burst is running (it excludes walking, window work, digging and placing). */
  fighting = false;
  placing = false;
  /** An EAT_FOOD is running: the hand holds the food until the server finishes eating it. */
  eating = false;
  /** An EXPLORE is running (its hops are walks; no second EXPLORE starts meanwhile). */
  exploring = false;
  /** A quest-book click is waiting for the server's verdict. */
  questBookBusy = false;

  // The feature modules: each holds this core, through which they use one another.
  readonly connection: Connection;
  /** Owner commands heard in chat, and whispered replies (chat-actions.ts). */
  readonly chat: ChatActions;
  readonly observation: Observation;
  readonly inventory: InventoryActions;
  readonly crafting: CraftActions;
  readonly interact: InteractActions;
  readonly dig: DigActions;
  readonly place: PlaceActions;
  readonly combat: CombatActions;
  readonly questBook: QuestBookActions;
  readonly player: PlayerActions;
  readonly movement: MovementActions;
  readonly travel: TravelActions;

  constructor(opts: Gtnh1710ClientOptions) {
    this.opts = opts;
    this.connection = new Connection(this);
    this.chat = new ChatActions(this);
    this.observation = new Observation(this);
    this.inventory = new InventoryActions(this);
    this.crafting = new CraftActions(this);
    this.interact = new InteractActions(this);
    this.dig = new DigActions(this);
    this.place = new PlaceActions(this);
    this.combat = new CombatActions(this);
    this.questBook = new QuestBookActions(this);
    this.player = new PlayerActions(this);
    this.movement = new MovementActions(this);
    this.travel = new TravelActions(this);
  }

  /**
   * The fence every walk, dig, placement and stand-spot check uses NOW: the configured fence
   * (movement mode 'fixed'), or the play area around the player clipped to the exploration
   * boundary (mode 'follow'). Each action takes it once when it starts (play-area.ts).
   */
  fence(): PlayArea {
    return playArea(
      this.opts.config.movement,
      this.opts.explorationBoundary ?? null,
      this.world.ownPosition,
    );
  }

  /**
   * The food bar is empty: the server takes health every few seconds (on Hard, with
   * HungerOverhaul's damageOnStarve, until the player dies), so a drop in health is hunger,
   * and a walk or a dig that stopped for each would never reach food (seen live: the food
   * trip's walks stopped after 34 and 104 steps, "health dropped"). Threats still stop them
   * (stopForThreats, the dig's own entity check), as do the agent loop's dangers.
   */
  starving(): boolean {
    return this.world.food === 0;
  }

  /**
   * The stop reason for a server correction, with where it put the player (connection.ts
   * #noteCorrection).
   */
  corrected(): string {
    return this.lastCorrection === null
      ? 'the server corrected the position'
      : `the server corrected the position ${this.lastCorrection}`;
  }

  send(packet: OutboundPacket): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed || this.phase === 'closed') return;
    socket.write(packet.frame);
    this.outboundCounts.set(packet.kind, (this.outboundCounts.get(packet.kind) ?? 0) + 1);
  }

  /**
   * Stop all traffic. A graceful close (our own disconnect) sends a normal TCP FIN and
   * keeps draining incoming data until the server closes, so the server logs a clean
   * "Disconnected" instead of "Connection reset"; it is forced after one second.
   */
  close(reason: string, graceful = false): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed';
    this.closedReason = reason;
    this.movement.stopIdle();
    this.chat.stop();
    const socket = this.socket;
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
    this.log(`closed: ${reason}`);
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  /** Resolves when `condition` holds, the connection closes, or `timeoutMs` passes. */
  waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const check = (): void => {
        if (!done && (condition() || this.phase === 'closed')) finish();
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
      const unsubscribe = this.subscribe(check);
      check();
    });
  }

  log(line: string): void {
    this.opts.log?.(line);
  }
}
