import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import type { MinecraftConfig } from '../../config/env.ts';
import { assertPrivateDestination } from '../../config/network.ts';
import type { GameState } from '../../domain/game-state.ts';
import type { BlockPosition, Position } from '../../domain/common.ts';
import {
  needsCraftingTable,
  RECIPES,
  type CraftingRecipe,
  type RecipeId,
} from '../../domain/recipes.ts';
import { assertValidatedAction, type ValidatedAction } from '../../domain/validated-action.ts';
import type { ExploreToward } from '../../domain/actions.ts';
import { mergeSeen, type SeenChunk } from '../../domain/world-memory.ts';
import type { Clock } from '../../util/clock.ts';
import { errorMessage } from '../../util/json.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from '../minecraft-client.ts';
import {
  applyClick,
  containerRange,
  planEmptyCursor,
  planTransfer,
  playerRange,
  type Click,
  type Stack,
  type TransferDirection,
  type WindowSnapshot,
} from './container.ts';
import {
  applyTakeResult,
  gridEmpty,
  INVENTORY_GRID,
  placeRecipe,
  planClearGrid,
  planFill,
  planStoreCursor,
  planSyncClick,
  sameStack,
  simulateCrafts,
  stackBounds,
  TABLE_GRID,
  windowDifferences,
  type CraftingLayout,
  type PlacedRecipe,
} from './crafting.ts';
import { checkDig, digWaitTicks, eyesOf, standSpotFor, TICK_MS, type DigArea } from './digging.ts';
import { ARRIVED, chooseHop, exploreGoal } from './explore.ts';
import { FmlClientHandshake, MultipartAssembler } from './fml-handshake.ts';
import { decodeGregTechMessage, GT_CHANNEL } from './gregtech.ts';
import {
  decodeFmlRuntimeMessage,
  decodeLogin,
  decodePlay,
  DIG_STATUS,
  outbound,
  PLAYER_EYE_HEIGHT,
  type OutboundKind,
  type OutboundPacket,
  type PlayDecodeOptions,
  type PlayPacket,
  type ServerPosition,
  VANILLA_DECODING,
} from './packets.ts';
import { fenceHolds, playArea, type PlayArea, type PointBox } from './play-area.ts';
import { nameItemStack, resolveItemName } from './registry.ts';
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
import {
  bodyProblem,
  planTerrainWalk,
  standProblem,
  terrainSteps,
  type TerrainStep,
} from './terrain.ts';
import { FrameDecoder, ProtocolError, type Frame } from './wire.ts';
import { WORKBENCH_WINDOW_TYPE, WorldModel, type BlockWatch } from './world-model.ts';
import { describeSightings, SurveyTracker } from './world-survey.ts';

/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** Walking sends one position per tick. */
const WALK_TICK_MS = 50;
/** After the last step, ticks to wait for a server correction before calling a walk done. */
const SETTLE_TICKS = 5;
/** How long to wait for a chest or crafting table window, and for the server's verdict on one click. */
const WINDOW_OPEN_TIMEOUT_MS = 3_000;
const CLICK_TIMEOUT_MS = 3_000;
/** Server reach is 8 blocks to the block centre; the client stays well inside it. */
const MAX_BLOCK_DISTANCE = 6;
const VANILLA_CHEST = 'minecraft:chest';
const VANILLA_CRAFTING_TABLE = 'minecraft:crafting_table';
/** 1.7.10 window types: 0 = chest (27 or 54 slots); 1 = crafting table (world-model.ts). */
const CHEST_WINDOW_TYPE = 0;
/** How often a crafting grid is emptied again (with fresh server state) before giving up. */
const CLEAR_GRID_ATTEMPTS = 3;

type ClickOutcome = 'accepted' | 'rejected' | 'unanswered' | 'unpredictable';
/** The server sends at least a time update every second; within this window the state is current. */
const FRESHNESS_WINDOW_MS = 3_000;
/** After the finish: how long to wait for the server's verdict on the block. */
const DIG_OUTCOME_TIMEOUT_MS = 2_000;
/**
 * After the block turned to air: a quiet period with no further update for it. Forge sends
 * "air" to the digging player BEFORE it asks mods whether the break may happen, and re-sends
 * the block if one cancels it, so the first "air" alone is not proof.
 */
const DIG_SETTLE_MS = 5 * TICK_MS;
/** How long the drop may take to reach the inventory: a 10-tick pickup delay, plus falling. */
const DROP_WAIT_MS = 2_000;

/** "2 x minecraft:sand, 1 x minecraft:flint" (at most 200 characters). */
function describeGain(gained: ReadonlyArray<[string, number]>): string {
  return gained
    .map(([item, n]) => `${n} x ${item}`)
    .join(', ')
    .slice(0, 200);
}

/** Yaw and pitch (degrees, Minecraft's convention) from the eyes to a block's centre. */
function lookAt(eyes: Vec3, block: BlockPosition): { yaw: number; pitch: number } {
  const dx = block.x + 0.5 - eyes.x;
  const dy = block.y + 0.5 - eyes.y;
  const dz = block.z + 0.5 - eyes.z;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}
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
  /**
   * The exploration boundary (the config's safety.boundary): with movement mode 'follow' the
   * play area never leaves it. Without it, 'follow' refuses all movement.
   */
  explorationBoundary?: PointBox | null;
}

/** EXPLORE's own limits, on top of maxDistance: hops, time, and the wait for chunks per hop. */
const MAX_EXPLORE_HOPS = 12;
const MAX_EXPLORE_MS = 180_000;
const EXPLORE_ENTITIES_WAIT_MS = 5_000;
/** A hop shorter than this is not worth walking (blocks). */
const MIN_HOP_LENGTH = 2;
/**
 * A far retreat in mode 'follow' (the safety policy bounds its straight-line distance with
 * maxRetreatDistance): blocks walked, hops and time at most, and how close the hops bring it
 * before the last walk onto the safe location.
 */
const MAX_RETREAT_WALK = 768;
const MAX_RETREAT_HOPS = 48;
const MAX_RETREAT_MS = 360_000;
const RETREAT_ARRIVE = 6;

/** Where a walk in hops got to, and why it stopped (`safe`: nothing went wrong). */
interface Trip {
  walked: number;
  hops: number;
  stop: { why: string; safe: boolean };
  seen: Map<string, SeenChunk>;
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
 * can WALK inside a fence, use configured vanilla CHESTS, CRAFT and DIG allowlisted blocks
 * inside the fence, each only when explicitly enabled.
 *
 * Guarantees, enforced here and in packets.ts:
 *  - never connects unless live connections are enabled, an identity marker is set, the
 *    host is private, and the server's status ping shows that marker, Forge and GregTech;
 *  - can only send: handshake, status request, login start, keep-alive, FML handshake /
 *    channel registration, idle ticks, confirmations of server-assigned positions, walking
 *    steps, the window packets chests and crafting need (empty-hand block activation,
 *    hotbar selection, predictable clicks, confirmations, closing a window), digging
 *    start/cancel/finish, and the cosmetic head look and arm swing;
 *  - perform() supports OBSERVE_STATE, WAIT and PAUSE_AND_ASK_USER, plus MOVE_TO and
 *    RETURN_TO_SAFE_LOCATION as walks when movement is enabled, EXPLORE (walks in hops) when
 *    the play area follows the player (movement mode 'follow'), OPEN_CONTAINER /
 *    DEPOSIT_ITEM / WITHDRAW_ITEM when containers are enabled, CRAFT_ITEM when crafting is
 *    enabled and DIG_BLOCK when digging is enabled (NOT_IMPLEMENTED otherwise); every other
 *    world-changing action returns NOT_IMPLEMENTED without sending anything;
 *  - a walk stays inside the fence (one level, or terrain when the fence has a height
 *    range; in mode 'follow' the play area around the player, inside the exploration
 *    boundary: #fence()), and every step is re-checked just before it is sent; it stops on
 *    a server correction, a health drop, a nearby threat (MOVE_TO, EXPLORE), a blocked or
 *    dangerous way ahead, the stop file, halt(), or a lost connection;
 *  - window work never leaves items on the cursor or in a crafting grid when it can help it
 *    (the server drops both when a window closes or the player leaves);
 *  - a dig uses an empty hand on one allowlisted block that digging.ts has checked, and
 *    re-checks it every tick; walking, window work and digging never run at the same time.
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
  #lastYaw = 0;
  #haltReason: string | null = null;
  /** Server verdicts on our clicks (S32), by action number. */
  readonly #clickVerdicts = new Map<number, boolean>();
  #nextActionNumber = 1;
  /** A chest or crafting operation is running (they, and walking, exclude each other). */
  #usingContainer = false;
  #digging = false;
  /** Sync clicks sent while crafting (diagnostics). */
  #craftSyncs = 0;
  /** An EXPLORE is running (its hops are walks; no second EXPLORE starts meanwhile). */
  #exploring = false;
  /** What the player has seen around it, for world memory (world-survey.ts). */
  readonly #surveys = new SurveyTracker();

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

  async disconnect(): Promise<void> {
    // The server drops a crafting grid's contents and the cursor when the player leaves.
    try {
      await this.#returnCraftingLeftovers();
    } catch (error) {
      this.#log(`could not return leftovers before disconnecting: ${errorMessage(error)}`);
    }
    this.#close('disconnected by the agent', true);
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
    this.#survey(false);
    return Promise.resolve(this.#withStandSpots(this.#world.toGameState(asOf)));
  }

  /**
   * Surveys what the player sees around it, when due (world-survey.ts: on entering another
   * chunk, every 30 s, or `force`). A survey problem is logged, never thrown: observing and
   * walking go on without it.
   */
  #survey(force: boolean): SeenChunk[] {
    const feet = this.#world.ownPosition;
    if (feet === null) return [];
    try {
      return this.#surveys.update(this.#world, feet, this.#opts.clock.now(), force);
    } catch (error) {
      this.#log(`world survey failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /** What the player has seen since the last call, per chunk (for world memory). */
  takeSeenChunks(): SeenChunk[] {
    return this.#surveys.drain();
  }

  /**
   * The fence every walk, dig and stand-spot check uses NOW: the configured fence (movement
   * mode 'fixed'), or the play area around the player clipped to the exploration boundary
   * (mode 'follow'). Each walk or dig takes it once when it starts (play-area.ts).
   */
  #fence(): PlayArea {
    return playArea(
      this.#opts.config.movement,
      this.#opts.explorationBoundary ?? null,
      this.#world.ownPosition,
    );
  }

  /**
   * Adds, for the nearest listed diggable blocks, where the player can stand to dig each
   * (digging.ts standSpotFor), so a planner can walk there and dig. Digging disabled or no
   * fence: the blocks are left as they are.
   */
  #withStandSpots(state: GameState): GameState {
    const cfg = this.#opts.config;
    const fence = this.#fence().fence;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (!cfg.digging.enabled || fence === null || world === null || feet === null) return state;
    if (!state.nearbyBlocks.known) return state;
    const area: DigArea = {
      fence,
      maxHeightAboveFence: cfg.digging.maxHeightAboveFence,
    };
    const blocks = state.nearbyBlocks.value;
    return {
      ...state,
      nearbyBlocks: {
        known: true,
        value: {
          ...blocks,
          resources: blocks.resources.map((r) => ({
            ...r,
            standAt: standSpotFor(world, area, r.position, feet),
          })),
        },
      },
    };
  }

  perform(validated: ValidatedAction): Promise<ClientActionResult> {
    assertValidatedAction(validated);
    if (this.#phase !== 'play') return Promise.resolve(failed('not connected', 'ERROR'));
    const action = validated.action;
    switch (action.type) {
      case 'OBSERVE_STATE':
        return Promise.resolve(ok('observation is taken by the executor after every action'));
      case 'WAIT':
        return this.#wait(action.args.durationMs);
      case 'PAUSE_AND_ASK_USER':
        // Recorded by the agent; deliberately not sent as in-game chat.
        return Promise.resolve(ok('pause recorded (not sent in-game)', { acknowledged: true }));
      case 'MOVE_TO':
        return this.#walkTo(action.args.target, { stopForThreats: true });
      case 'EXPLORE':
        return this.#explore(action.args);
      case 'RETURN_TO_SAFE_LOCATION':
        // A retreat is how the agent gets away from a threat, so threats do not stop it.
        return this.#retreat(validated.resolvedTarget);
      case 'OPEN_CONTAINER':
        return this.#containerAction(action.args.containerId, null);
      case 'DEPOSIT_ITEM':
        return this.#containerAction(action.args.containerId, {
          direction: 'to_container',
          item: action.args.item,
          quantity: action.args.quantity,
        });
      case 'WITHDRAW_ITEM':
        return this.#containerAction(action.args.containerId, {
          direction: 'to_player',
          item: action.args.item,
          quantity: action.args.quantity,
        });
      case 'CRAFT_ITEM':
        return this.#craft(action.args);
      case 'DIG_BLOCK':
        return this.#dig(action.args.position);
      case 'EAT_FOOD':
      case 'INSPECT_MACHINE':
      case 'REFUEL_KNOWN_GENERATOR':
        return Promise.resolve(
          failed(
            `${action.type} is not available: the GTNH client can observe, walk, use chests, craft and dig`,
            'NOT_IMPLEMENTED',
          ),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Vanilla chests

  /** Why container use cannot start now, or null. */
  #containerBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.containers.enabled) return 'containers are disabled (MC_ENABLE_CONTAINERS)';
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#walking) return 'the player is walking';
    if (this.#digging) return 'the player is digging';
    return null;
  }

  /**
   * OPEN_CONTAINER (transfer null), DEPOSIT_ITEM and WITHDRAW_ITEM on a configured vanilla
   * chest. The chest window stays open afterwards (so the chest's side can be verified);
   * the cursor is always empty when this returns, unless it reports that it is not.
   */
  async #containerAction(
    containerId: string,
    transfer: { direction: TransferDirection; item: string; quantity: number } | null,
  ): Promise<ClientActionResult> {
    const blocker = this.#containerBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.containers.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not using the chest: ${blocker}`, code);
    }
    if (this.#usingContainer) {
      return failed('a chest or crafting operation is already running', 'REFUSED');
    }
    this.#usingContainer = true;
    try {
      const opened = await this.#openChest(containerId);
      if (opened !== null) return opened;
      if (transfer === null) {
        const w = this.#world.openWindow;
        return ok(`opened ${containerId}`, {
          windowId: w?.windowId ?? null,
          slots: w?.containerSlots ?? null,
        });
      }
      return await this.#transfer(transfer);
    } finally {
      this.#usingContainer = false;
    }
  }

  /** Opens the chest (or keeps it open); returns a failure, or null when it is open. */
  async #openChest(containerId: string): Promise<ClientActionResult | null> {
    const chest = this.#opts.config.containers.chests[containerId];
    if (chest === undefined) return failed(`${containerId} is not a configured chest`, 'REFUSED');
    const open = this.#world.openWindow;
    if (open !== null && open.containerId === containerId && open.slotsKnown) return null;
    if (open !== null) {
      const closed = this.#closeOpenWindow();
      if (closed !== null) return closed;
    }
    const opened = await this.#openBlockWindow(containerId, chest.position, VANILLA_CHEST, 'chest');
    if (opened !== null) return opened;
    const w = this.#world.openWindow;
    if (
      w === null ||
      w.containerId !== containerId ||
      w.inventoryType !== CHEST_WINDOW_TYPE ||
      (w.containerSlots !== 27 && w.containerSlots !== 54)
    ) {
      return this.#unexpectedWindow();
    }
    return null;
  }

  /**
   * Right-clicks a configured block with an EMPTY hand, so the click can only open it (never
   * place or use an item), and waits for its window. A failure, or null once it is open.
   */
  async #openBlockWindow(
    containerId: string,
    position: { x: number; y: number; z: number },
    blockName: string,
    what: string,
  ): Promise<ClientActionResult | null> {
    const { x, y, z } = position;
    const blockId = this.#world.blockAt(x, y, z);
    const found = blockId === undefined ? undefined : this.#world.registry?.blocks.get(blockId);
    if (found !== blockName) {
      return failed(
        `the block at (${x}, ${y}, ${z}) is ${found ?? 'not loaded'}, not a ${blockName}`,
        'REFUSED',
      );
    }
    const me = this.#world.ownPosition;
    if (me === null) return failed('player position unknown', 'REFUSED');
    const eyes = { x: me.x, y: me.y + PLAYER_EYE_HEIGHT, z: me.z };
    const reach = Math.hypot(x + 0.5 - eyes.x, y + 0.5 - eyes.y, z + 0.5 - eyes.z);
    if (reach > MAX_BLOCK_DISTANCE) {
      return failed(
        `the ${what} is ${reach.toFixed(1)} blocks away (max ${MAX_BLOCK_DISTANCE})`,
        'REFUSED',
      );
    }

    const hand = this.#emptyHotbarSlot();
    if (hand === null) return failed('no empty hotbar slot to click with', 'REFUSED');
    if (hand !== this.#world.heldSlot) {
      this.#send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }

    this.#world.expectContainer(containerId);
    this.#send(outbound.activateBlock(x, y, z, 1));
    await this.#waitFor(() => {
      const w = this.#world.openWindow;
      return w !== null && w.slotsKnown;
    }, WINDOW_OPEN_TIMEOUT_MS);
    this.#world.expectContainer(null);
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown) return failed(`the ${what} did not open`, 'FAILED');
    return null;
  }

  /** Closes a window that is not the one asked for; the failure to report. */
  #unexpectedWindow(): ClientActionResult {
    const w = this.#world.openWindow;
    const closed = this.#closeOpenWindow();
    return (
      closed ??
      failed(
        `an unexpected window opened (type ${w?.inventoryType ?? '?'}, ${w?.containerSlots ?? '?'} slots)`,
        'FAILED',
      )
    );
  }

  #emptyHotbarSlot(): number | null {
    const w = this.#world.openWindow;
    const inv = this.#world.inventoryWindow;
    const hotbar = (j: number) =>
      w !== null && w.slotsKnown ? w.slots[w.containerSlots + 27 + j] : inv?.[36 + j];
    if (hotbar(this.#world.heldSlot) == null) return this.#world.heldSlot;
    for (let j = 0; j < 9; j++) if (hotbar(j) == null) return j;
    return null;
  }

  /** Moves exactly `quantity` of `item` with confirmed clicks; the cursor ends empty. */
  async #transfer(t: {
    direction: TransferDirection;
    item: string;
    quantity: number;
  }): Promise<ClientActionResult> {
    const target = resolveItemName(this.#world.registry, t.item);
    if (target === null) return failed(`${t.item} is not in the item registry`, 'REFUSED');
    const start = this.#world.openWindow;
    if (start === null || !start.slotsKnown)
      return failed('the chest window is not open', 'FAILED');
    const plan = planTransfer(start, t.direction, target, t.quantity);
    if (!plan.ok) return failed(`not moving items: ${plan.reason}`, 'REFUSED');
    const source = t.direction === 'to_player' ? containerRange(start) : playerRange(start);

    let done = 0;
    for (const click of plan.clicks) {
      const result = await this.#click(click);
      if (result !== 'accepted') {
        const recovered = await this.#recoverCursor(source);
        return failed(
          `click ${done + 1} of ${plan.clicks.length} was ${result}; ${recovered}`,
          'FAILED',
          { clicksDone: done },
        );
      }
      done += 1;
    }
    const end = this.#world.openWindow;
    if (end?.cursor != null) return failed('the cursor is not empty after moving items', 'ERROR');
    return ok(
      `moved ${t.quantity} ${t.item} ${t.direction === 'to_player' ? 'from the chest' : 'into the chest'} in ${plan.clicks.length} clicks`,
      { clicks: plan.clicks.length },
    );
  }

  /**
   * Where clicks go: the open window, or, when none is open, window 0 (the player's own
   * inventory container, with its 2x2 crafting grid). Null while its slots are not known.
   */
  #clickTarget(): { windowId: number; window: WindowSnapshot } | null {
    const open = this.#world.openWindow;
    if (open !== null) return open.slotsKnown ? { windowId: open.windowId, window: open } : null;
    const inventory = this.#world.inventoryClickWindow;
    return inventory === null ? null : { windowId: 0, window: inventory };
  }

  #syncsOf(windowId: number): number {
    return windowId === 0 ? this.#world.inventorySyncs : this.#world.windowSyncs;
  }

  /** One predicted click, sent and confirmed by the server before anything else happens. */
  async #click(click: Click): Promise<ClickOutcome> {
    const target = this.#clickTarget();
    if (target === null || this.#phase !== 'play') return 'unanswered';
    const predicted = applyClick(target.window, click);
    if (!predicted.ok) return 'unpredictable';
    return this.#sendClick(target, click, predicted.claimed, predicted.window);
  }

  /**
   * Sends one click claiming `claimed` (the slot's stack before the click, as the client
   * believes it) and waits for the verdict. Accepted: the server sends nothing else, so the
   * prediction (`target.window` -> `predicted`) becomes the client's view. Rejected: the
   * server re-sends the whole window and then the cursor, and ignores further clicks until
   * the client acknowledges; 'rejected' means that re-sync has arrived.
   */
  async #sendClick(
    target: { windowId: number; window: WindowSnapshot },
    click: Click,
    claimed: Stack | null,
    predicted: WindowSnapshot,
  ): Promise<Exclude<ClickOutcome, 'unpredictable'>> {
    const windowId = target.windowId;
    const action = this.#nextActionNumber;
    this.#nextActionNumber = action >= 32767 ? 1 : action + 1;
    this.#clickVerdicts.delete(action);
    // A rejection comes with an immediate re-sync: count from before the click.
    const syncsBefore = this.#syncsOf(windowId);
    const cursorBefore = this.#world.cursorSyncs;
    this.#send(
      outbound.clickWindow(
        windowId,
        click.slot,
        click.button,
        action,
        claimed,
        this.#decoding.itemStackSizeVarInt,
      ),
    );
    await this.#waitFor(() => this.#clickVerdicts.has(action), CLICK_TIMEOUT_MS);
    const verdict = this.#clickVerdicts.get(action);
    this.#clickVerdicts.delete(action);
    if (verdict === undefined) return 'unanswered';
    if (!verdict) {
      this.#send(outbound.confirmTransaction(windowId, action));
      const resynced = (): boolean =>
        this.#syncsOf(windowId) > syncsBefore && this.#world.cursorSyncs > cursorBefore;
      await this.#waitFor(resynced, CLICK_TIMEOUT_MS);
      return resynced() ? 'rejected' : 'unanswered';
    }
    this.#world.applyAcceptedClick(windowId, target.window, predicted);
    return 'accepted';
  }

  /** After a failed click: put whatever is on the cursor back into an empty slot. */
  async #recoverCursor(preferred: [number, number]): Promise<string> {
    let emptied = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = this.#world.openWindow;
      if (w === null) return 'the window closed';
      if (w.cursor === null) break;
      const clicks = planEmptyCursor(w, preferred);
      if (clicks === null) break;
      for (const c of clicks) {
        if ((await this.#click(c)) !== 'accepted') break;
        emptied += 1;
      }
    }
    const w = this.#world.openWindow;
    if (w?.cursor != null) {
      return `ITEMS MAY BE ON THE CURSOR (${w.cursor.count} of id ${w.cursor.id}); the window was left open`;
    }
    return emptied > 0 ? 'the cursor was emptied' : 'nothing was on the cursor';
  }

  /**
   * Closes the open window, but never with items on the cursor or in a crafting table's
   * grid: the server would drop them into the world.
   */
  #closeOpenWindow(): ClientActionResult | null {
    const w = this.#world.openWindow;
    if (w === null) return null;
    if (w.cursor !== null)
      return failed('refusing to close a window with items on the cursor', 'ERROR');
    if (w.inventoryType === WORKBENCH_WINDOW_TYPE && w.slotsKnown && !gridEmpty(w, TABLE_GRID)) {
      return failed(
        'refusing to close a crafting table with items in its grid (the server would drop them)',
        'ERROR',
      );
    }
    this.#send(outbound.closeWindow(w.windowId));
    this.#world.closeWindowLocally();
    return null;
  }

  // -------------------------------------------------------------------------
  // Crafting (see crafting.ts)

  /** Why crafting cannot start or go on now, or null. */
  #craftingBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.crafting.enabled) return 'crafting is disabled (MC_ENABLE_CRAFTING)';
    if (this.#phase !== 'play') return 'not connected';
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#walking) return 'the player is walking';
    if (this.#digging) return 'the player is digging';
    return null;
  }

  /**
   * CRAFT_ITEM: in the player's own 2x2 grid (window 0; any open window is closed first,
   * since the server takes window-0 clicks only when none is open), or at a configured
   * crafting table (3x3), which is closed again afterwards.
   */
  async #craft(args: {
    recipe: RecipeId;
    times: number;
    craftingTableId: string | null;
  }): Promise<ClientActionResult> {
    const blocker = this.#craftingBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.crafting.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not crafting: ${blocker}`, code);
    }
    if (this.#usingContainer) {
      return failed('a chest or crafting operation is already running', 'REFUSED');
    }
    const recipe = RECIPES[args.recipe];
    const tableId = args.craftingTableId;
    if (tableId === null && needsCraftingTable(recipe)) {
      return failed(`not crafting: ${recipe.id} needs a crafting table (3x3)`, 'REFUSED');
    }
    if (tableId !== null && this.#opts.config.crafting.tables[tableId] === undefined) {
      return failed(`not crafting: ${tableId} is not a configured crafting table`, 'REFUSED');
    }
    const layout = tableId === null ? INVENTORY_GRID : TABLE_GRID;
    const registry = this.#world.registry;
    const placed = placeRecipe(recipe, layout, (name) => resolveItemName(registry, name));
    if (!placed.ok) return failed(`not crafting: ${placed.reason}`, 'REFUSED');
    // Refuse before anything is opened or clicked when the crafts cannot all finish exactly.
    const planned = this.#plannedCraftingWindow(layout);
    if (planned === null) return failed('not crafting: the inventory is not known', 'REFUSED');
    const feasible = simulateCrafts(planned, layout, placed.value, args.times);
    if (!feasible.ok) return failed(`not crafting: ${feasible.reason}`, 'REFUSED');

    this.#usingContainer = true;
    try {
      if (tableId === null) {
        const closed = this.#closeOpenWindow();
        if (closed !== null) return closed;
      } else {
        const opened = await this.#openCraftingTable(tableId);
        if (opened !== null) return opened;
      }
      const result = await this.#runCrafts(recipe, placed.value, args.times, layout);
      if (tableId === null) return result;
      // Leave no crafting table open (refused while its grid or the cursor holds items).
      const closed = this.#closeOpenWindow();
      return closed === null
        ? result
        : craftFailed(`${closed.message}; ${result.message}`, 'ERROR', result.data);
    } finally {
      this.#usingContainer = false;
    }
  }

  /** Opens the configured crafting table (or keeps it open); a failure, or null when open. */
  async #openCraftingTable(tableId: string): Promise<ClientActionResult | null> {
    const table = this.#opts.config.crafting.tables[tableId];
    if (table === undefined) {
      return failed(`${tableId} is not a configured crafting table`, 'REFUSED');
    }
    const open = this.#world.openWindow;
    const isThisTable = (w: typeof open): boolean =>
      w !== null &&
      w.slotsKnown &&
      w.containerId === tableId &&
      w.inventoryType === WORKBENCH_WINDOW_TYPE &&
      w.containerSlots === TABLE_GRID.playerSlots[0];
    if (isThisTable(open)) return null;
    if (open !== null) {
      const closed = this.#closeOpenWindow();
      if (closed !== null) return closed;
    }
    const opened = await this.#openBlockWindow(
      tableId,
      table.position,
      VANILLA_CRAFTING_TABLE,
      'crafting table',
    );
    if (opened !== null) return opened;
    return isThisTable(this.#world.openWindow) ? null : this.#unexpectedWindow();
  }

  /** The player's inventory laid out as `layout`'s window, with an empty grid and cursor. */
  #plannedCraftingWindow(layout: CraftingLayout): WindowSnapshot | null {
    const storage = this.#world.playerStorage();
    if (storage === null) return null;
    const first = layout.playerSlots[0];
    const slots: Array<Stack | null> = Array.from({ length: first }, () => null);
    slots.push(...storage);
    return { containerSlots: first, slots, cursor: null };
  }

  /**
   * The crafts themselves, in the window that is open (or window 0). Each: one item into
   * every pattern cell, a sync, the result taken only if it is exactly the expected item and
   * count, and put into an empty slot. Any failure first returns the grid and the cursor to
   * the inventory.
   */
  async #runCrafts(
    recipe: CraftingRecipe,
    placed: PlacedRecipe,
    times: number,
    layout: CraftingLayout,
  ): Promise<ClientActionResult> {
    // The sync click claims one of the expected result: something an empty slot never holds.
    const claim: Stack = { ...placed.expected, count: 1 };
    let crafts = 0;
    let clicks = 0;
    const syncsAtStart = this.#craftSyncs;
    const facts = (): Record<string, number> => ({
      crafts,
      clicks,
      syncs: this.#craftSyncs - syncsAtStart,
    });
    const view = (): WindowSnapshot | null => this.#clickTarget()?.window ?? null;

    // The server's exact view before anything moves. Anything left in the grid or on the
    // cursor by an earlier failure goes back into the inventory first.
    const initial = view();
    if (initial === null) return craftFailed('not crafting: no crafting window', 'FAILED', facts());
    const leftovers = !gridEmpty(initial, layout) || initial.cursor !== null;
    const cleared = await this.#clearGrid(layout, stackBounds(initial, layout), claim);
    if (cleared !== null) {
      return leftovers
        ? craftFailed(
            `ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR: ${layout.name} already held items and ${cleared}`,
            'ERROR',
            facts(),
          )
        : craftFailed(`not crafting: ${cleared}`, 'FAILED', facts());
    }
    const start = view();
    if (start === null) return craftFailed('not crafting: no crafting window', 'FAILED', facts());
    const bounds = stackBounds(start, layout);
    const feasible = simulateCrafts(start, layout, placed, times);
    if (!feasible.ok) return craftFailed(`not crafting: ${feasible.reason}`, 'REFUSED', facts());

    const stop = async (
      message: string,
      code: 'FAILED' | 'ERROR',
      extra: Record<string, string> = {},
    ): Promise<ClientActionResult> => {
      const cleared = await this.#clearGrid(layout, bounds, claim);
      if (cleared === null) return craftFailed(message, code, { ...facts(), ...extra });
      return craftFailed(
        `ITEMS MAY BE LEFT IN THE CRAFTING GRID OR ON THE CURSOR (${cleared}): ${message}`,
        'ERROR',
        { ...facts(), ...extra },
      );
    };

    while (crafts < times) {
      const n = `craft ${crafts + 1} of ${times}`;
      const blocker = this.#craftingBlocker();
      if (blocker !== null)
        return stop(`stopped after ${crafts} of ${times} crafts: ${blocker}`, 'FAILED');

      // 1. One item into every pattern cell.
      const before = view();
      if (before === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      const fill = planFill(before, layout, placed);
      if (!fill.ok) return stop(`${n}: ${fill.reason}`, 'FAILED');
      for (const c of fill.value.clicks) {
        const outcome = await this.#click(c);
        if (outcome !== 'accepted') return stop(`${n}: a click was ${outcome}`, 'FAILED');
        clicks += 1;
      }

      // 2. What does the server make of it? Only a full sync shows the result slot.
      const predicted = view();
      const synced = await this.#sync(layout, claim);
      if (synced !== null) return stop(`${n}: ${synced}`, 'FAILED');
      const actual = view();
      if (predicted === null || actual === null) {
        return stop(`${n}: the crafting window went away`, 'FAILED');
      }
      const diffs = windowDifferences(predicted, actual, new Set([layout.resultSlot]));
      if (diffs.length > 0) {
        return stop(
          `${n}: the server's window differs from the agent's (${diffs.slice(0, 3).join('; ')})`,
          'FAILED',
        );
      }
      const shown = actual.slots[layout.resultSlot] ?? null;
      if (!sameStack(shown, placed.expected)) {
        const observed = this.#describeStack(shown);
        return stop(
          `the server's crafting result for ${recipe.id} is ${observed}, not the expected ` +
            `${this.#describeStack(placed.expected)}; it was not taken and the ingredients ` +
            `were put back (${crafts} of ${times} crafts done)`,
          'FAILED',
          { observedResult: observed },
        );
      }

      // 3. Take exactly that result...
      const target = this.#clickTarget();
      if (target === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      const take = applyTakeResult(target.window, layout);
      if (!take.ok) return stop(`${n}: ${take.reason}`, 'FAILED');
      const took = await this.#sendClick(
        target,
        { slot: layout.resultSlot, button: 0 },
        take.claimed,
        take.window,
      );
      if (took !== 'accepted') return stop(`${n}: taking the result was ${took}`, 'FAILED');
      clicks += 1;
      crafts += 1;

      // 4. ...and put it into an empty slot (results are never merged into other stacks).
      const holding = view();
      const store = holding === null ? null : planStoreCursor(holding, layout);
      if (store === null) return stop(`${n}: the crafting window went away`, 'FAILED');
      if (!store.ok) return stop(`${n}: ${store.reason}`, 'FAILED');
      const stored = await this.#click(store.value);
      if (stored !== 'accepted') return stop(`${n}: storing the result was ${stored}`, 'FAILED');
      clicks += 1;
    }

    // The server must agree: an empty grid and cursor, everything where the agent put it.
    const predicted = view();
    const last = await this.#sync(layout, claim);
    if (last !== null) return stop(`after ${times} crafts: ${last}`, 'ERROR');
    const actual = view();
    const diffs =
      predicted === null || actual === null
        ? ['the crafting window went away']
        : windowDifferences(predicted, actual, new Set([layout.resultSlot]));
    if (
      diffs.length > 0 ||
      actual === null ||
      !gridEmpty(actual, layout) ||
      actual.cursor !== null
    ) {
      return stop(
        `after ${times} crafts the server's window differs from the agent's (${diffs.slice(0, 3).join('; ')})`,
        'ERROR',
      );
    }
    return ok(
      `crafted ${times} x ${recipe.id}: ${times * recipe.result.count} ${recipe.result.item}, ` +
        `${clicks} clicks and ${this.#craftSyncs - syncsAtStart} syncs`,
      facts(),
    );
  }

  /**
   * Asks the server for its exact view of the crafting window. 1.7.10 never sends the result
   * slot as a slot update, only in a full window sync, and it sends one whenever it rejects
   * a click. So: a left-click on an EMPTY slot with an empty cursor (which changes nothing),
   * claiming `claim`, which an empty slot never holds; the server rejects it and re-sends
   * every slot, then the cursor. Null once synced, else why not.
   */
  async #sync(layout: CraftingLayout, claim: Stack): Promise<string | null> {
    const target = this.#clickTarget();
    if (target === null || this.#phase !== 'play') return 'no crafting window to sync';
    const probe = planSyncClick(target.window, layout);
    if (!probe.ok) return `cannot sync: ${probe.reason}`;
    this.#craftSyncs += 1;
    // If the server accepted after all, its slot held exactly `claim`, now on the cursor.
    const verdict = await this.#sendClick(target, probe.value, claim, {
      ...target.window,
      cursor: claim,
    });
    if (verdict === 'rejected') return null;
    if (verdict === 'accepted') {
      const back = await this.#click(probe.value);
      return (
        `the agent's view of slot ${probe.value.slot} was wrong: the sync click was accepted` +
        (back === 'accepted' ? ' (the item was put back)' : '')
      );
    }
    return 'the server did not answer a sync click';
  }

  /**
   * Returns the cursor and everything in the crafting grid to the inventory, then asks the
   * server to confirm: null when it shows both empty, else why not.
   */
  async #clearGrid(
    layout: CraftingLayout,
    bounds: ReadonlyMap<string, number>,
    claim: Stack,
  ): Promise<string | null> {
    // True while the client's view is the server's own (a sync or a rejection's re-sync).
    let confirmed = false;
    let rounds = 0;
    for (;;) {
      if (this.#phase !== 'play') return 'the connection is closed';
      const w = this.#clickTarget()?.window ?? null;
      if (w === null) return 'the crafting window is not available';
      if (gridEmpty(w, layout) && w.cursor === null) {
        if (confirmed) return null;
        const synced = await this.#sync(layout, claim);
        if (synced !== null) return synced;
        confirmed = true;
        continue;
      }
      if (rounds >= CLEAR_GRID_ATTEMPTS) return 'the grid or the cursor still holds items';
      rounds += 1;
      const plan = planClearGrid(w, layout, bounds);
      if (!plan.ok) return plan.reason;
      confirmed = false;
      for (const c of plan.value.clicks) {
        const outcome = await this.#click(c);
        if (outcome === 'accepted') continue;
        if (outcome !== 'rejected') return `a click was ${outcome}`;
        confirmed = true; // the server re-sent the window: plan again from its view
        break;
      }
    }
  }

  /** The crafting grid (with its window's layout) that holds items or has them on the cursor. */
  #leftovers(): CraftingLayout | null {
    const open = this.#world.openWindow;
    if (open !== null) {
      if (!open.slotsKnown || open.inventoryType !== WORKBENCH_WINDOW_TYPE) return null;
      return !gridEmpty(open, TABLE_GRID) || open.cursor !== null ? TABLE_GRID : null;
    }
    const inventory = this.#world.inventoryClickWindow;
    if (inventory === null) return null;
    return !gridEmpty(inventory, INVENTORY_GRID) || inventory.cursor !== null
      ? INVENTORY_GRID
      : null;
  }

  /** Before disconnecting: whatever a crafting grid or the cursor holds goes back first. */
  async #returnCraftingLeftovers(): Promise<void> {
    if (this.#phase !== 'play' || this.#usingContainer) return;
    const open = this.#world.openWindow;
    if (open !== null && open.inventoryType !== WORKBENCH_WINDOW_TYPE && open.cursor !== null) {
      // A chest window with a stack on the cursor (a failed recovery): one more try.
      this.#log('items are on the cursor: putting them down before disconnecting');
      this.#usingContainer = true;
      try {
        this.#log(await this.#recoverCursor(containerRange(open)));
      } finally {
        this.#usingContainer = false;
      }
      return;
    }
    const layout = this.#leftovers();
    const w = this.#clickTarget()?.window ?? null;
    if (layout === null || w === null) return;
    const sample = [w.cursor, ...layout.gridSlots.map((s) => w.slots[s] ?? null)].find(
      (s): s is Stack => s != null && !s.hasNbt,
    );
    if (sample === undefined) return;
    this.#log(`items are in ${layout.name} or on the cursor: returning them before disconnecting`);
    this.#usingContainer = true;
    try {
      const problem = await this.#clearGrid(layout, stackBounds(w, layout), {
        ...sample,
        count: 1,
      });
      this.#log(problem === null ? 'returned them' : `could not return them: ${problem}`);
    } catch (error) {
      this.#log(`could not return them: ${errorMessage(error)}`);
    } finally {
      this.#usingContainer = false;
    }
  }

  /** "3 x minecraft:planks", or "empty". */
  #describeStack(s: Stack | null): string {
    if (s === null) return 'empty';
    const naming = nameItemStack(this.#world.registry, s.id, s.damage);
    const name = naming.ok ? naming.name : `item ${s.id}@${s.damage}`;
    return `${s.count} x ${name}${s.hasNbt ? ' (with NBT data)' : ''}`;
  }

  // -------------------------------------------------------------------------
  // Digging one block

  /** Why digging cannot start now, or null. */
  #digBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.digging.enabled) {
      return { reason: 'digging is disabled (MC_ENABLE_DIGGING)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#fence();
    if (area.fence === null) return refused(`${area.problem}: digging stays inside the fence`);
    if (!cfg.presenceTicks) return refused('digging needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#haltReason !== null) return refused(`halted: ${this.#haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#walking) return refused('the player is walking');
    if (this.#usingContainer) return refused('a chest or crafting operation is running');
    if (this.#digging) return refused('a dig is already in progress');
    return null;
  }

  /**
   * DIG_BLOCK: break one allowlisted block with an empty hand, like a player: face it, swing
   * the arm, C07 start, the dig time (vanilla x 1.25 + 2 ticks, re-checking everything
   * every tick), C07 finish; a problem on the way sends C07 cancel. Success needs the
   * server's own block change to air, with no re-send after it. Reports whether the drop
   * reached the inventory. A drop that landed out of the player's pickup reach (in a hole
   * next to it, or a few blocks away) is picked up as a player would: by walking onto it,
   * when the spot it lies on is standable (an ordinary checked walk inside the fence).
   */
  async #dig(target: BlockPosition): Promise<ClientActionResult> {
    const dug = await this.#digOnce(target);
    if (dug.drop === null) return dug.result;
    const spot = dug.drop.spot;
    const walked = await this.#walkTo(spot, { stopForThreats: true });
    const gained = walked.ok ? await this.#dropGain(dug.drop.itemsBefore) : [];
    const drops = describeGain(gained);
    const where = `(${Math.floor(spot.x)}, ${spot.y}, ${Math.floor(spot.z)})`;
    this.#log(
      `walked to the drop at ${where}: ${walked.ok ? (gained.length > 0 ? drops : 'no drop') : walked.message}`,
    );
    return ok(
      `${dug.result.message.replace(/; no drop reached.*$/, '')}; ` +
        (walked.ok
          ? gained.length > 0
            ? `walked to the drop at ${where} and picked up ${drops}`
            : `walked to ${where}, but no drop reached the inventory`
          : `the drop lies at ${where}, but walking there failed: ${walked.message}`),
      {
        ...dug.result.data,
        dropCollected: gained.length > 0,
        drops,
        walkedToDrop: walked.ok,
      },
    );
  }

  /** Items gained since `before`, waiting up to DROP_WAIT_MS for the first one. */
  async #dropGain(before: Readonly<Record<string, number>>): Promise<Array<[string, number]>> {
    const increase = (): Array<[string, number]> => {
      const now = this.#world.inventoryItems() ?? {};
      return Object.entries(now)
        .map(([item, n]): [string, number] => [item, n - (before[item] ?? 0)])
        .filter(([, d]) => d > 0);
    };
    await this.#waitFor(() => increase().length > 0, DROP_WAIT_MS);
    return increase();
  }

  async #digOnce(target: BlockPosition): Promise<{
    result: ClientActionResult;
    /** Set when the drop was not picked up and lies on a spot the player can walk to. */
    drop: { itemsBefore: Readonly<Record<string, number>>; spot: Vec3 } | null;
  }> {
    const done = (result: ClientActionResult): { result: ClientActionResult; drop: null } => ({
      result,
      drop: null,
    });
    const blocker = this.#digBlocker();
    const fence = this.#fence().fence;
    if (blocker !== null || fence === null) {
      return done(
        failed(`not digging: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED'),
      );
    }
    const area: DigArea = {
      fence,
      maxHeightAboveFence: this.#opts.config.digging.maxHeightAboveFence,
    };
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    this.#digging = true;
    try {
      // A chest left open by an earlier action is closed first (never with a full cursor).
      if (this.#world.openWindow !== null) {
        const closed = this.#closeOpenWindow();
        if (closed !== null) return done(failed(`not digging: ${closed.message}`, 'REFUSED'));
      }
      const world = this.#world.walkWorld();
      const feet = this.#world.ownPosition;
      if (world === null || feet === null) {
        return done(failed('not digging: block data or position unknown', 'REFUSED'));
      }
      const check = checkDig(world, area, feet, target);
      if (!check.ok) return done(failed(`not digging: ${check.reason}`, 'REFUSED'));
      // An empty hand: no tool can wear out, fell a whole tree or do anything else.
      const hand = this.#emptyHotbarSlot();
      if (hand === null) {
        return done(
          failed(
            'not digging: no empty hotbar slot (the agent digs with an empty hand)',
            'REFUSED',
          ),
        );
      }
      if (hand !== this.#world.heldSlot) {
        this.#send(outbound.selectHotbarSlot(hand));
        this.#world.setHeldSlot(hand);
      }

      const itemsBefore = this.#world.inventoryItems();
      const ticks = digWaitTicks(check.block);
      const guard = {
        placementsAtStart: this.#confirmedPositions,
        healthAtStart: this.#world.health,
      };
      const clock = this.#opts.clock;
      const watch = this.#world.watchBlock(target.x, target.y, target.z);
      const { x, y, z } = target;
      let verdict: { ok: true } | { ok: false; result: ClientActionResult };
      try {
        this.#log(`digging ${check.block} at ${where}: ${ticks} ticks`);
        // Face the block, as a player does (other players see where the head points).
        const look = lookAt(eyesOf(feet), target);
        this.#send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
        this.#lastYaw = look.yaw;
        const self = this.#world.selfEntityId;
        if (self !== null) this.#send(outbound.swingArm(self));
        this.#send(outbound.digBlock(DIG_STATUS.start, x, y, z, check.face));
        const startedAt = clock.now().getTime();
        let tick = 0;
        while (clock.now().getTime() - startedAt < ticks * TICK_MS) {
          await delay(TICK_MS);
          tick += 1;
          // A digging client swings its arm every few ticks; the server shows it to others.
          if (self !== null && tick % 4 === 0 && this.#phase === 'play') {
            this.#send(outbound.swingArm(self));
          }
          const problem = this.#digProblem(area, target, check.blockId, watch, guard);
          if (problem !== null) {
            if (this.#phase === 'play') {
              this.#send(outbound.digBlock(DIG_STATUS.cancel, x, y, z, check.face));
            }
            this.#log(`dig stopped: ${problem}`);
            return done(
              failed(`dig of ${check.block} at ${where} stopped: ${problem}`, 'FAILED', {
                x,
                y,
                z,
                block: check.block,
              }),
            );
          }
        }
        const sentAt = watch.updates.length;
        this.#send(outbound.digBlock(DIG_STATUS.finish, x, y, z, check.face));
        verdict = await this.#digVerdict(watch, sentAt, check.block, where);
      } finally {
        this.#world.unwatch(watch);
      }
      if (!verdict.ok) return done(verdict.result);

      // The drop spawns in the block's cell and is picked up (after 10 ticks) only when it
      // lands within reach of the player's body; report whether it arrived.
      const gained = itemsBefore === null ? [] : await this.#dropGain(itemsBefore);
      const drops = describeGain(gained);
      const dropCollected = gained.length > 0;
      this.#log(`dug ${check.block} at ${where}; drop ${dropCollected ? drops : 'not collected'}`);
      const result = ok(
        `dug ${check.block} at ${where} in ${ticks} ticks; ` +
          (dropCollected
            ? `the drop reached the inventory: ${drops}`
            : itemsBefore === null
              ? 'the inventory was unknown, so the drop could not be checked'
              : `no drop reached the inventory (none, or it lies at ${where} out of pickup reach: walk onto it)`),
        { x, y, z, block: check.block, ticks, dropCollected, drops },
      );
      // Not picked up: the drop fell to the floor of the dug cell (or below it). On terrain,
      // if a player could stand there, walk onto it.
      const terrain = area.fence.min.y !== area.fence.max.y;
      if (dropCollected || itemsBefore === null || !terrain) return { result, drop: null };
      let floor = y;
      while (floor > y - 3 && world.blockAt(x, floor - 1, z) === 0) floor -= 1;
      const standable =
        floor >= area.fence.min.y &&
        floor <= area.fence.max.y &&
        standProblem(world, x, floor, z) === null;
      return {
        result,
        drop: standable ? { itemsBefore, spot: { x: x + 0.5, y: floor, z: z + 0.5 } } : null,
      };
    } finally {
      this.#digging = false;
    }
  }

  /** Why the dig in progress must stop now, or null. Checked every tick. */
  #digProblem(
    area: DigArea,
    target: BlockPosition,
    blockId: number,
    watch: BlockWatch,
    guard: { placementsAtStart: number; healthAtStart: number | null },
  ): string | null {
    if (this.#phase !== 'play') return 'the connection closed';
    const cfg = this.#opts.config;
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#confirmedPositions !== guard.placementsAtStart) {
      return 'the server corrected the position';
    }
    const health = this.#world.health;
    if (guard.healthAtStart !== null && health !== null && health < guard.healthAtStart) {
      return `health dropped from ${guard.healthAtStart} to ${health}`;
    }
    if (!this.#world.entitiesReady(this.#opts.clock.now())) {
      return 'the entities around the player are not fully known';
    }
    const threat = this.#world
      .nearbyEntities(cfg.movement.threatRadius)
      .find((e) => e.category === 'hostile' || e.category === 'unclassified');
    if (threat !== undefined) {
      return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
    }
    // Any update for the block while digging: the server refused the dig (it re-sends the
    // block), or the block changed. Either way this dig is over.
    if (watch.updates.length > 0) {
      return `the server sent the block again while digging (id ${watch.updates[0]}): the dig was refused or the block changed`;
    }
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position became unknown';
    const check = checkDig(world, area, feet, target);
    if (!check.ok) return `it is no longer safe to dig: ${check.reason}`;
    if (check.blockId !== blockId) return 'the block changed';
    return null;
  }

  /**
   * After the finish: the server either breaks the block (Forge first sends "air" to the
   * digging player, then the world's own change follows) or re-sends it. Waits for the
   * first update, then for a quiet DIG_SETTLE_MS, and fails on anything but air.
   */
  async #digVerdict(
    watch: BlockWatch,
    sentAt: number,
    block: string,
    where: string,
  ): Promise<{ ok: true } | { ok: false; result: ClientActionResult }> {
    const clock = this.#opts.clock;
    const deadline = clock.now().getTime() + DIG_OUTCOME_TIMEOUT_MS;
    await this.#waitFor(() => watch.updates.length > sentAt, DIG_OUTCOME_TIMEOUT_MS);
    let seen = watch.updates.length;
    let quietSince = clock.now().getTime();
    while (seen > sentAt && clock.now().getTime() < deadline) {
      if (clock.now().getTime() - quietSince >= DIG_SETTLE_MS) break;
      await delay(TICK_MS);
      if (watch.updates.length !== seen) {
        seen = watch.updates.length;
        quietSince = clock.now().getTime();
      }
    }
    const after = watch.updates.slice(sentAt);
    const fail = (message: string): { ok: false; result: ClientActionResult } => {
      this.#log(message);
      const now = this.#world.blockAt(watch.x, watch.y, watch.z);
      return {
        ok: false,
        result: failed(message, 'FAILED', {
          x: watch.x,
          y: watch.y,
          z: watch.z,
          block,
          airNow: now === 0,
        }),
      };
    };
    if (this.#phase !== 'play')
      return fail(`the connection closed after finishing the dig at ${where}`);
    if (after.length === 0) {
      return fail(
        `no block change arrived within ${DIG_OUTCOME_TIMEOUT_MS} ms of finishing the dig at ${where}`,
      );
    }
    if (after.some((id) => id !== 0)) {
      return fail(
        `the server re-sent the block at ${where} after the finish (updates ${after.slice(0, 4).join(', ')}): ` +
          'the dig was judged too early or the break was cancelled. A vanilla server still ' +
          'breaks a too-early dig on its own once its timer reaches 100%.',
      );
    }
    return { ok: true };
  }

  /**
   * WAIT's postcondition is "observed time advanced by at least `ms`", and a live state is
   * timestamped with the arrival of the last server packet (the honest "as of"). So wait
   * until both the clock and the observed world have moved on by `ms`; the server sends at
   * least a time update every second, so this adds at most about a second.
   */
  async #wait(ms: number): Promise<ClientActionResult> {
    const clock = this.#opts.clock;
    const start = clock.now().getTime();
    const observedStart = this.#world.lastPacketAt?.getTime() ?? start;
    await delay(ms);
    await this.#waitFor(
      () =>
        clock.now().getTime() - start >= ms &&
        (this.#world.lastPacketAt?.getTime() ?? 0) - observedStart >= ms,
      Math.max(3_000, ms),
    );
    return ok(`waited ${clock.now().getTime() - start} ms`);
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
    const fence = this.#fence().fence;
    if (fence === null) return null;
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return { plan: { ok: false, reason: 'block data or position unknown' }, map: [] };
    }
    if (fence.min.y !== fence.max.y) {
      // Terrain fences: plan only (the text map shows a single level).
      const t =
        target === null ? null : planTerrainWalk(world, fence, from, target, m.maxPathLength);
      return {
        plan:
          t === null
            ? null
            : t.ok
              ? { ok: true, waypoints: [from, ...t.moves.map((x) => x.to)], length: t.length }
              : t,
        map: [],
      };
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
    const area = this.#fence();
    if (area.fence === null) return area.problem;
    if (!this.#opts.config.presenceTicks) return 'walking needs presence ticks (MC_PRESENCE_TICKS)';
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(m.stopFile))) return `the stop file ${m.stopFile} exists`;
    if (this.#usingContainer) return 'a chest or crafting operation is running';
    if (this.#digging) return 'the player is digging';
    // Walking away closes an open window server-side, which drops the cursor and a table's grid.
    if (this.#world.openWindow?.cursor != null || this.#leftovers() !== null) {
      return 'items are on the cursor or in a crafting grid';
    }
    return null;
  }

  async #walkTo(
    target: Readonly<Position> | null,
    options: { stopForThreats: boolean },
  ): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const blocker = this.#movementBlocker();
    const fence = this.#fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not walking: ${blocker}`, m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED');
    }
    if (target === null) return failed('not walking: no resolved target', 'ERROR');
    if (this.#walking) return failed('not walking: a walk is already in progress', 'REFUSED');
    const world = this.#world.walkWorld();
    const from = this.#world.ownPosition;
    if (world === null || from === null) {
      return failed('not walking: block data or position unknown', 'REFUSED');
    }
    // A fence on one level walks the flat pen way; a fence with a height range walks terrain.
    const terrain = fence.min.y !== fence.max.y;
    let steps: TerrainStep[];
    let length: number;
    if (terrain) {
      const plan = planTerrainWalk(world, fence, from, target, m.maxPathLength);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      steps = terrainSteps(from, plan.moves);
      length = plan.length;
      const kinds = plan.moves.map((x) => x.kind);
      this.#log(
        `walking ${length.toFixed(2)} blocks over terrain in ${steps.length} steps ` +
          `(${kinds.filter((k) => k === 'step-up').length} up, ${kinds.filter((k) => k === 'drop').length} down)`,
      );
    } else {
      const plan = planWalk(world, fence, from, target, m.maxPathLength);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      steps = stepsAlong(plan.waypoints).map((pos) => ({ pos, onGround: true }));
      length = plan.length;
      this.#log(
        `walking ${length.toFixed(2)} blocks in ${steps.length} steps (${plan.waypoints.length - 1} stretch(es))`,
      );
    }
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
      for (const step of steps) {
        const next = step.pos;
        const reason = this.#stepProblem(world, fence, at, next, {
          placementsAtStart,
          healthAtStart,
          stopForThreats: options.stopForThreats,
          terrain,
        });
        if (reason !== null) return stopped(reason);
        const facing =
          Math.hypot(next.x - at.x, next.z - at.z) > 1e-9 ? yawTowards(at, next) : this.#lastYaw;
        this.#lastYaw = facing;
        this.#send(
          outbound.playerMove(
            { x: next.x, feetY: next.y, z: next.z, yaw: facing, pitch: 0 },
            step.onGround,
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
      return ok(`walked ${length.toFixed(2)} blocks in ${steps.length} steps`, {
        steps: steps.length,
        distance: Number(length.toFixed(3)),
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
    guard: {
      placementsAtStart: number;
      healthAtStart: number | null;
      stopForThreats: boolean;
      terrain: boolean;
    },
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
    // Terrain steps change height (steps up, drops), so check the body where it will be,
    // at that height; the flat walker checks the whole swept stretch.
    const problem = guard.terrain
      ? bodyProblem(world, fence, to)
      : segmentProblem(world, fence, from, to);
    return problem === null ? null : `the way ahead is not clear: ${problem}`;
  }

  // -------------------------------------------------------------------------
  // Travelling in hops (EXPLORE, and far retreats in mode 'follow'): explore.ts picks each
  // hop, and every hop is an ordinary checked walk (#walkTo)

  /** Why it is too dark to be out exploring (evening, night, or the time unknown), or null. */
  #darkness(): string | null {
    const t = this.#world.worldTimeAt(this.#opts.clock.now());
    if (t === null) return 'the time of day is unknown (no time update from the server yet)';
    return t.phase === 'evening' || t.phase === 'night'
      ? `it is ${t.phase}: the agent explores only in daylight`
      : null;
  }

  /**
   * Walks toward `goal` in hops. Each hop goes to the spot inside the current play area that a
   * walk reaches and that is closest to the goal (explore.ts), as an ordinary checked walk
   * (#walkTo: every step re-checked; threats stop it when `stopForThreats`). With threats
   * watched, it first waits until the chunks and entities around each new spot have arrived.
   * After each hop it surveys what it sees (world memory). It stops within `arrive` blocks of
   * the goal, after `maxDistance` blocks walked, when no hop gets closer (water, cliffs), when
   * two hops in a row gain less than a block (stuck), at `maxHops` or `maxMs`, when it gets
   * dark (`daylightOnly`), or on anything that stops a walk (`safe` false).
   */
  async #hops(
    goal: { x: number; z: number },
    opts: {
      maxDistance: number;
      arrive: number;
      stopForThreats: boolean;
      daylightOnly: boolean;
      maxHops: number;
      maxMs: number;
      /** What arriving is called in the result ("reached the target"). */
      arrived: string;
    },
  ): Promise<Trip> {
    const clock = this.#opts.clock;
    const startedAt = clock.now().getTime();
    const seen = new Map<string, SeenChunk>();
    const look = (): void => {
      for (const s of this.#survey(true)) {
        const key = `${s.chunkX},${s.chunkZ}`;
        const before = seen.get(key);
        seen.set(key, before === undefined ? s : mergeSeen(before, s));
      }
    };
    const tried = new Set<string>();
    let walked = 0;
    let hops = 0;
    let stalls = 0;
    const done = (why: string, safe: boolean): Trip => ({
      walked,
      hops,
      stop: { why, safe },
      seen,
    });
    look();
    for (;;) {
      const here = this.#world.ownPosition;
      if (here === null) return done('the player position became unknown', false);
      const left = Math.hypot(goal.x - here.x, goal.z - here.z);
      const budget = opts.maxDistance - walked;
      if (left < opts.arrive) return done(opts.arrived, true);
      if (budget < MIN_HOP_LENGTH) {
        return done(`walked the whole maxDistance (${opts.maxDistance} blocks)`, true);
      }
      if (hops >= opts.maxHops) return done(`made the most hops allowed (${opts.maxHops})`, true);
      if (clock.now().getTime() - startedAt >= opts.maxMs) {
        return done(`took the longest allowed (${opts.maxMs / 1000} s)`, true);
      }
      const blocked = this.#movementBlocker();
      if (blocked !== null) return done(blocked, false);
      if (opts.daylightOnly) {
        const dark = this.#darkness();
        if (dark !== null) return done(dark, true);
      }
      if (opts.stopForThreats) {
        // A new spot: its chunks and the entities in them must have arrived before a hop.
        await this.#waitFor(() => this.#world.entitiesReady(clock.now()), EXPLORE_ENTITIES_WAIT_MS);
        if (!this.#world.entitiesReady(clock.now())) {
          return done('the entities around the player are not fully known', false);
        }
      }
      const fence = this.#fence().fence;
      const world = this.#world.walkWorld();
      if (fence === null || world === null) {
        return done('the play area or the block data is unknown', false);
      }
      const maxLength = Math.min(this.#opts.config.movement.maxPathLength, budget);
      const choice = chooseHop(world, fence, here, goal, maxLength, tried);
      if (!choice.ok) return done(`no way further: ${choice.reason}`, true);
      let walk: ClientActionResult | null = null;
      for (const c of choice.candidates) {
        const r = await this.#walkTo(c.target, { stopForThreats: opts.stopForThreats });
        // REFUSED with no blocker: the walker would not plan this one (nothing was sent).
        if (r.ok || r.code !== 'REFUSED' || this.#movementBlocker() !== null) {
          walk = r;
          break;
        }
        tried.add(`${Math.floor(c.target.x)},${c.target.y},${Math.floor(c.target.z)}`);
      }
      if (walk === null) return done('the walker planned none of the next hops', true);
      if (walk.code === 'REFUSED') return done(walk.message, false);
      hops += 1;
      const after = this.#world.ownPosition ?? here;
      walked += walk.ok
        ? Number(walk.data['distance'])
        : Math.hypot(after.x - here.x, after.z - here.z) + Math.abs(after.y - here.y);
      look();
      if (!walk.ok) return done(walk.message, false);
      stalls = left - Math.hypot(goal.x - after.x, goal.z - after.z) < 1 ? stalls + 1 : 0;
      if (stalls >= 2) return done('stuck: two hops in a row got less than 1 block closer', true);
    }
  }

  /**
   * EXPLORE: walk toward a compass direction or a point, over terrain, in hops (#hops), at most
   * `maxDistance` blocks walked, in daylight only; threats stop it, like MOVE_TO. It stops at
   * the goal (pulled in to the exploration boundary) or earlier (see #hops); FAILED on anything
   * that stops a walk, or with less than a block of progress.
   */
  async #explore(args: {
    toward: ExploreToward;
    maxDistance: number;
  }): Promise<ClientActionResult> {
    const m = this.#opts.config.movement;
    const refuse = (reason: string, code: 'REFUSED' | 'NOT_IMPLEMENTED' = 'REFUSED') =>
      failed(`not exploring: ${reason}`.slice(0, 500), code);
    const blocker = this.#movementBlocker();
    if (blocker !== null) return refuse(blocker, m.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED');
    if (m.mode !== 'follow') {
      return refuse(
        "the play area does not follow the player (EXPLORE needs movement mode 'follow', MC_MOVEMENT_MODE=follow)",
      );
    }
    if (this.#walking || this.#exploring) return refuse('a walk is already in progress');
    const dark = this.#darkness();
    if (dark !== null) return refuse(dark);
    const start = this.#world.ownPosition;
    const boundary = this.#opts.explorationBoundary ?? null;
    if (start === null || boundary === null) return refuse('position or boundary unknown');

    const goal = exploreGoal(start, args.toward, args.maxDistance, boundary);
    let trip: Trip;
    this.#exploring = true;
    try {
      trip = await this.#hops(goal, {
        maxDistance: args.maxDistance,
        arrive: ARRIVED,
        stopForThreats: true,
        daylightOnly: true,
        maxHops: MAX_EXPLORE_HOPS,
        maxMs: MAX_EXPLORE_MS,
        arrived: goal.clipped
          ? 'reached the edge of the exploration boundary'
          : typeof args.toward === 'string'
            ? `went ${args.maxDistance} blocks ${args.toward}`
            : 'reached the target',
      });
    } finally {
      this.#exploring = false;
    }

    const end = this.#world.ownPosition ?? start;
    const progress =
      Math.hypot(goal.x - start.x, goal.z - start.z) - Math.hypot(goal.x - end.x, goal.z - end.z);
    const heading =
      typeof args.toward === 'string'
        ? args.toward.replace('_', '-')
        : `(${args.toward.x}, ${args.toward.z})`;
    const { why, safe } = trip.stop;
    const data = {
      walked: Number(trip.walked.toFixed(2)),
      hops: trip.hops,
      progress: Number(progress.toFixed(2)),
      x: end.x,
      y: end.y,
      z: end.z,
      stoppedBecause: why.slice(0, 200),
      chunksSeen: trip.seen.size,
    };
    if (trip.hops === 0) return failed(`not exploring: ${why}`.slice(0, 500), 'REFUSED', data);
    const message =
      `explored ${trip.walked.toFixed(1)} blocks toward ${heading} in ${trip.hops} hop(s), ` +
      `${progress.toFixed(1)} closer, now at (${end.x.toFixed(1)}, ${end.y.toFixed(1)}, ${end.z.toFixed(1)}); ` +
      `stopped: ${why}. Saw ${describeSightings([...trip.seen.values()])}`;
    this.#log(message);
    if (!safe) return failed(message.slice(0, 500), 'FAILED', data);
    if (progress < 1) {
      return failed(`less than 1 block closer: ${message}`.slice(0, 500), 'FAILED', data);
    }
    return ok(message.slice(0, 500), data);
  }

  /**
   * RETURN_TO_SAFE_LOCATION: a walk that threats do not stop (it is how the agent gets away
   * from them). In mode 'follow', a safe location outside the current play area is reached in
   * hops first (#hops: threats still do not stop it, and it is an escape, so any time of day),
   * then by a last walk onto it. Everything else is the plain walk, as before.
   */
  async #retreat(target: Readonly<Position> | null): Promise<ClientActionResult> {
    const fence = this.#fence().fence;
    const far =
      target !== null &&
      fence !== null &&
      this.#opts.config.movement.mode === 'follow' &&
      !fenceHolds(fence, target);
    if (!far || this.#movementBlocker() !== null || this.#walking || this.#exploring) {
      return this.#walkTo(target, { stopForThreats: false });
    }
    let trip: Trip;
    this.#exploring = true;
    try {
      trip = await this.#hops(
        { x: target.x, z: target.z },
        {
          maxDistance: MAX_RETREAT_WALK,
          arrive: RETREAT_ARRIVE,
          stopForThreats: false,
          daylightOnly: false,
          maxHops: MAX_RETREAT_HOPS,
          maxMs: MAX_RETREAT_MS,
          arrived: 'near the safe location',
        },
      );
    } finally {
      this.#exploring = false;
    }
    const sofar = `${trip.walked.toFixed(1)} blocks in ${trip.hops} hop(s)`;
    if (!trip.stop.safe) {
      return failed(`retreat stopped after ${sofar}: ${trip.stop.why}`.slice(0, 500), 'FAILED', {
        walked: Number(trip.walked.toFixed(2)),
        hops: trip.hops,
      });
    }
    const last = await this.#walkTo(target, { stopForThreats: false });
    const data = { ...last.data, walked: Number(trip.walked.toFixed(2)), hops: trip.hops };
    const message = `retreated ${sofar} (${trip.stop.why}), then: ${last.message}`.slice(0, 500);
    return last.ok
      ? ok(message, data)
      : failed(message, last.code === 'OK' ? 'FAILED' : last.code, data);
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
      case 'confirm-transaction':
        // Verdicts for the window clicks go to: the open window, or window 0 when none is.
        if (packet.windowId === (this.#world.openWindow?.windowId ?? 0)) {
          this.#clickVerdicts.set(packet.actionNumber, packet.accepted);
        }
        break;
      case 'open-window':
      case 'close-window':
      case 'join-game':
      case 'chat':
      case 'spawn-position':
      case 'update-health':
      case 'time-update':
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
    if (channel === GT_CHANNEL) {
      // GregTech's own channel: machine placements and state changes (read-only).
      try {
        this.#world.applyGregTech(decodeGregTechMessage(data));
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        this.#log(`could not decode GregTech message: ${error.message}`);
        this.#world.markMachineProblem(`undecodable GregTech message: ${error.message}`);
      }
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

/** A failure whose message fits a client result (at most 500 characters). */
function craftFailed(
  message: string,
  code: 'FAILED' | 'REFUSED' | 'ERROR',
  data: ClientActionResult['data'],
): ClientActionResult {
  return failed(message.length > 500 ? `${message.slice(0, 497)}...` : message, code, data);
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
