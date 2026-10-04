import type { MinecraftConfig } from '../../config/env.ts';
import type { Position } from '../../domain/common.ts';
import type { GameState } from '../../domain/game-state.ts';
import { assertValidatedAction, type ValidatedAction } from '../../domain/validated-action.ts';
import type { SeenChunk } from '../../domain/world-memory.ts';
import type { Clock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from '../minecraft-client.ts';
import type { OwnerMessage } from './client/chat-actions.ts';
import { ClientCore } from './client/core.ts';
import type { PointBox } from './play-area.ts';
import type { Fence, WalkPlan } from './walking.ts';
import type { WorldModel } from './world-model.ts';

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
  /**
   * The exploration boundary (the config's safety.boundary): with movement mode 'follow' the
   * play area never leaves it. Without it, 'follow' refuses all movement.
   */
  explorationBoundary?: PointBox | null;
  /**
   * The quests GameState.questBook reports (the agent's Age 0 closure, in order). Quest-book
   * actions are possible only for these. None when absent.
   */
  questScope?: readonly string[];
  /** Overrides how long a quest-book click waits for the server's verdict (tests). */
  questBookTimeoutMs?: number;
}

/** How long disconnect() waits for the last replies to an owner (one chat line a second). */
const REPLY_FLUSH_MS = 4_000;

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

/**
 * Client for a private GTNH (Minecraft 1.7.10 + Forge) server: read-only, except that it
 * can WALK (and EXPLORE) inside a fence or a moving play area, use configured vanilla
 * CHESTS, CRAFT, DIG and PLACE allowlisted blocks, use BLOCK WINDOWS (furnaces and other
 * blocks with an interaction profile) and FIGHT one checked entity, each only when explicitly
 * enabled.
 *
 * Guarantees, enforced here (with the modules in client/) and in packets.ts:
 *  - never connects unless live connections are enabled, an identity marker is set, the
 *    host is private, and the server's status ping shows that marker, Forge and GregTech;
 *  - can only send: handshake, status request, login start, keep-alive, FML handshake /
 *    channel registration, idle ticks, confirmations of server-assigned positions, walking
 *    steps, the window packets chests and crafting need (empty-hand block activation,
 *    hotbar selection, predictable clicks, confirmations, closing a window), digging
 *    start/cancel/finish, a block placement with the held block item, attacks on one checked
 *    entity (C02, attack only), the cosmetic head look and arm swing, and Better Questing's
 *    four typed quest-book messages (the main_sync answer that reading the quest book needs,
 *    and submit, checkbox, choice and claim when the quest book is enabled), and one chat
 *    packet: a whisper (`/tell`) to one of the bot's owners (MC_OWNERS), plain text, at most
 *    one line a second;
 *  - reads chat only for its owners' commands (client/chat-actions.ts): a whisper to the bot,
 *    or public chat starting with ! or # or the bot's name; a stop stops the action in
 *    progress at once (interrupt());
 *  - perform() supports OBSERVE_STATE, WAIT and PAUSE_AND_ASK_USER, plus MOVE_TO and
 *    RETURN_TO_SAFE_LOCATION as walks when movement is enabled, EXPLORE (walks in hops) when
 *    the play area follows the player (movement mode 'follow'), OPEN_CONTAINER /
 *    DEPOSIT_ITEM / WITHDRAW_ITEM when containers are enabled, CRAFT_ITEM when crafting is
 *    enabled, DIG_BLOCK when digging is enabled (and DIG_DOWN, the night pit's dig under the
 *    feet, when walking is enabled too), PLACE_BLOCK when placing is enabled,
 *    INTERACT_BLOCK / SMELT / TAKE_OUTPUT when interacting is enabled and ATTACK_ENTITY when
 *    combat is enabled (NOT_IMPLEMENTED otherwise); every other world-changing action returns
 *    NOT_IMPLEMENTED without sending anything;
 *  - a walk stays inside the fence (one level, or terrain when the fence has a height
 *    range; in mode 'follow' the play area around the player, inside the exploration
 *    boundary: client/core.ts fence()), and every step is re-checked just before it is sent;
 *    it stops on a server correction, a health drop, a nearby threat (MOVE_TO, EXPLORE), a
 *    blocked or dangerous way ahead, the stop file, halt(), or a lost connection;
 *  - a MOVE_TO over terrain may break a few leaves in its way when digging is enabled, each
 *    one as DIG_BLOCK digs (checkWalkBreak re-checked before and during the dig, success only
 *    on the server's change to air); a break refused or not confirmed stops the walk;
 *  - window work never leaves items on the cursor or in a crafting grid when it can help it
 *    (the server drops both when a window closes or the player leaves);
 *  - a dig breaks one allowlisted block that digging.ts has checked, and re-checks it every
 *    tick; it holds an allowlisted tool made for that block (src/domain/tools.ts: never a
 *    protected one, one with NBT data, or one that one more use would break) or an empty
 *    hand; a dig down (the night pit only) digs the block under the feet by checkDigDown's
 *    rules and then drops the player exactly one block, with vanilla gravity;
 *  - a placement puts one allowlisted block into a cell placing.ts has checked, clicking
 *    only a plain full block, never a chest, machine or modded block;
 *  - a fight strikes one entity src/domain/combat.ts allows, with an allowlisted weapon or an
 *    empty hand, never moving, and re-checks the target and the moment every tick;
 *  - walking, window work, digging, placing and fighting never run at the same time.
 *
 * This class is the facade: the work is done by the modules in client/ (see #core).
 */
export class Gtnh1710Client implements MinecraftClient {
  readonly kind = 'gtnh1710';
  /**
   * What all parts of the client share (client/core.ts), and through it the parts, one module
   * each in client/: connection.ts (connecting and the protocol), observation.ts (observe()),
   * inventory-actions.ts (chests, windows and clicks), craft-actions.ts, interact-actions.ts
   * (block windows, SMELT, TAKE_OUTPUT), dig-actions.ts, drop-actions.ts (picking up what a
   * dig or a kill dropped), place-actions.ts, combat-actions.ts, quest-book-actions.ts,
   * player-actions.ts (WAIT, EAT_FOOD), movement-actions.ts (walking, idle ticks, gravity) and
   * travel-actions.ts (EXPLORE, retreats).
   */
  readonly #core: ClientCore;

  constructor(opts: Gtnh1710ClientOptions) {
    this.#core = new ClientCore(opts);
  }

  /** Read access for diagnostics and tests. */
  get world(): WorldModel {
    return this.#core.world;
  }

  info(): ConnectionInfo {
    return this.#core.connection.info();
  }

  connect(): Promise<void> {
    return this.#core.connection.connect();
  }

  async disconnect(): Promise<void> {
    // The last replies to an owner (a command's "Done: ...") go out first, at the chat rate.
    await this.#core.chat.flush(REPLY_FLUSH_MS);
    // The server drops a crafting grid's contents and the cursor when the player leaves.
    try {
      await this.#core.crafting.returnCraftingLeftovers();
    } catch (error) {
      this.#core.log(`could not return leftovers before disconnecting: ${errorMessage(error)}`);
    }
    this.#core.close('disconnected by the agent', true);
  }

  observe(): Promise<GameState> {
    return this.#core.observation.observe();
  }

  /** What the player has seen since the last call, per chunk (for world memory). */
  takeSeenChunks(): SeenChunk[] {
    return this.#core.observation.takeSeenChunks();
  }

  /**
   * The fence walks, digs and placements use right now (client/core.ts fence()), read-only,
   * for code that plans with the client's own rules (the night shelter); null when there is
   * none.
   */
  currentFence(): Fence | null {
    return this.#core.fence().fence;
  }

  perform(validated: ValidatedAction): Promise<ClientActionResult> {
    assertValidatedAction(validated);
    if (this.#core.phase !== 'play') return Promise.resolve(failed('not connected', 'ERROR'));
    const action = validated.action;
    switch (action.type) {
      case 'OBSERVE_STATE':
        return Promise.resolve(ok('observation is taken by the executor after every action'));
      case 'WAIT':
        return this.#core.player.wait(action.args.durationMs);
      case 'PAUSE_AND_ASK_USER':
        // Recorded by the agent; deliberately not sent as in-game chat.
        return Promise.resolve(ok('pause recorded (not sent in-game)', { acknowledged: true }));
      case 'MOVE_TO':
        // Over terrain it walks on the pathfinder, breaking what is in its way as the walk
        // policy allows (client/path-actions.ts).
        return this.#core.movement.walkTo(action.args.target, {
          stopForThreats: true,
          work: true,
          protectedItems: new Set(validated.protectedItems),
        });
      case 'EXPLORE':
        return this.#core.travel.explore(action.args);
      case 'RETURN_TO_SAFE_LOCATION':
        // A retreat is how the agent gets away from a threat, so threats do not stop it.
        return this.#core.travel.retreat(validated.resolvedTarget);
      case 'OPEN_CONTAINER':
        return this.#core.inventory.containerAction(action.args.containerId, null);
      case 'DEPOSIT_ITEM':
        return this.#core.inventory.containerAction(action.args.containerId, {
          direction: 'to_container',
          item: action.args.item,
          quantity: action.args.quantity,
        });
      case 'WITHDRAW_ITEM':
        return this.#core.inventory.containerAction(action.args.containerId, {
          direction: 'to_player',
          item: action.args.item,
          quantity: action.args.quantity,
        });
      case 'CRAFT_ITEM':
        return this.#core.crafting.craft(action.args);
      case 'DIG_BLOCK':
        return this.#core.dig.dig(action.args.position, new Set(validated.protectedItems));
      case 'DIG_DOWN':
        return this.#core.dig.digDown(action.args.position, new Set(validated.protectedItems));
      case 'PLACE_BLOCK':
        return this.#core.place.place(action.args);
      case 'INTERACT_BLOCK':
        return this.#core.interact.interact(action.args.position);
      case 'SMELT':
        return this.#core.interact.smelt(action.args);
      case 'TAKE_OUTPUT':
        return this.#core.interact.takeOutput(action.args);
      case 'ATTACK_ENTITY':
        return this.#core.combat.attack(action.args.entityId);
      case 'SUBMIT_QUEST':
        return this.#core.questBook.questBookAction({
          kind: 'submit',
          questId: action.args.questId,
        });
      case 'CHECK_QUEST_BOX':
        return this.#core.questBook.questBookAction({
          kind: 'check',
          questId: action.args.questId,
          taskIndex: action.args.taskIndex,
        });
      case 'CLAIM_QUEST_REWARD':
        return this.#core.questBook.questBookAction({
          kind: 'claim',
          questId: action.args.questId,
          choice: action.args.choice,
        });
      case 'EAT_FOOD':
        return this.#core.player.eat(action.args.item);
      case 'INSPECT_MACHINE':
      case 'REFUEL_KNOWN_GENERATOR':
        return Promise.resolve(
          failed(
            `${action.type} is not available: the GTNH client can observe, walk, use chests, craft, dig, place, use block windows, fight and eat`,
            'NOT_IMPLEMENTED',
          ),
        );
    }
  }

  /** Stops a walk in progress at its next step and refuses new walks (e.g. on Ctrl+C). */
  halt(reason: string): void {
    this.#core.haltReason = reason;
  }

  /**
   * Stops the action in progress (a walk, an EXPLORE hop, a dig, a fight...) at its next step
   * or tick, and refuses new ones, until clearInterrupt(): an owner's stop. Unlike halt(), it
   * does not last; the play loop clears it once the session it stopped is over.
   */
  interrupt(reason: string): void {
    this.#core.interrupt(reason);
  }

  clearInterrupt(): void {
    this.#core.clearInterrupt();
  }

  /** The owners' commands heard in chat since the last call (MC_OWNERS), oldest first. */
  takeOwnerMessages(): OwnerMessage[] {
    return this.#core.chat.take();
  }

  /** Whether owners' commands are waiting to be taken. */
  ownerMessagesWaiting(): boolean {
    return this.#core.chat.waiting > 0;
  }

  /**
   * Whispers to one of the bot's owners: the only chat the client sends (`/tell <owner>`),
   * plain text cut into at most three lines, at most one line a second. Null when it is on
   * its way, else why not.
   */
  whisper(owner: string, text: string): string | null {
    return this.#core.chat.whisper(owner, text);
  }

  /**
   * Where a player the server shows the bot is (its feet, as last sent), by its exact name;
   * null when it is not in view (the server sends a player's entity within its tracking
   * range only).
   */
  playerPosition(name: string): Position | null {
    const player = this.#core.world
      .trackedEntities()
      .find(
        (e) =>
          e.kind === 'player' && e.classification.name === `player:${name}` && e.diedAt == null,
      );
    return player === undefined ? null : { x: player.x, y: player.y, z: player.z };
  }

  /**
   * Plans a walk without moving (for previews and dry runs), with a text map of the fence.
   * Works whether or not movement is enabled; null when no fence is configured. With
   * `work` it plans as MOVE_TO does (breaking on its way as the walk policy allows).
   */
  previewWalk(
    target: Position | null,
    work = false,
  ): { plan: WalkPlan | null; map: string[] } | null {
    return this.#core.movement.previewWalk(target, work);
  }
}
