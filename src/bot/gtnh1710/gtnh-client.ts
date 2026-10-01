import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { resolve as resolvePath } from 'node:path';
import type { MinecraftConfig } from '../../config/env.ts';
import { assertPrivateDestination } from '../../config/network.ts';
import type { GameState } from '../../domain/game-state.ts';
import { placedBlockOf, type DiggableBlock, type PlaceableItem } from '../../domain/blocks.ts';
import type { BlockPosition, Position } from '../../domain/common.ts';
import { known } from '../../domain/known.ts';
import { BARE_HAND_SPEED, digWaitTicks, instantDig, TICK_MS } from '../../domain/dig-time.ts';
import {
  needsCraftingTable,
  RECIPES,
  type CraftingRecipe,
  type RecipeId,
} from '../../domain/recipes.ts';
import type { ExploreToward } from '../../domain/actions.ts';
import { mergeSeen, type SeenChunk } from '../../domain/world-memory.ts';
import {
  bestTool,
  toolInfo,
  toolProblem,
  toolSpeedOn,
  usesLeft,
  type ToolInfo,
} from '../../domain/tools.ts';
import { assertValidatedAction, type ValidatedAction } from '../../domain/validated-action.ts';
import { isProtected } from '../../safety/protected-items.ts';
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
import {
  attackRefusal,
  BARE_HAND,
  calmRefusal,
  ENGAGE_RADIUS,
  FARM_ANIMALS,
  killStrikeAllowed,
  MAX_BURST_MS,
  MAX_SWINGS_PER_BURST,
  mayExplode,
  mayKill,
  strikeReach,
  SWING_INTERVAL_TICKS,
  type Weapon,
} from '../../domain/combat.ts';
import {
  chooseWeapon,
  dropSpot,
  eyeHeightOf,
  insideFence,
  lineOfSightClear,
  lookAtPoint,
  playerEyes,
  withinPickup,
} from './combat.ts';
import {
  BQ_CHANNEL,
  BqAssembler,
  choiceRewardOf,
  claimRewardItems,
  decodeBqMessage,
  describeQuestTasks,
  plainText,
  questBookRequestProblem,
  type BqOutbound,
  type QuestBookRequest,
} from './better-questing.ts';
import { rewardSlotsNeeded } from '../../domain/quest-items.ts';
import {
  checkDig,
  checkDigDown,
  checkWalkBreak,
  DIG_SETTLE_TICKS,
  eyesOf,
  faceTowards,
  reachTo,
  standSpotFor,
  underFeetOf,
  walkBreaks,
  type DigArea,
  type DigCheck,
} from './digging.ts';
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
import {
  checkPlace,
  placeAreaProblem,
  type EntityPosition,
  type PlaceArea,
  type PlaceCheck,
} from './placing.ts';
import {
  blockUse,
  FURNACE_SLOT,
  furnaceFuelTicks,
  INTERACTION_PROFILES,
  observedStorageId,
  parseObservedStorageId,
  type InteractionProfile,
  type WindowLayout,
} from '../../domain/interactions.ts';
import {
  allSlots,
  interactAreaProblem,
  interactStandSpot,
  MAX_INTERACT_REACH,
  planInsert,
  planTakeAll,
  playerCount,
  playerRangeOf,
} from './interact.ts';
import { parseObservedTableId } from './world-model.ts';
import { fenceHolds, playArea, type PlayArea, type PointBox } from './play-area.ts';
import { nameItemStack, resolveItemName, type Registry } from './registry.ts';
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
  type WalkWorld,
} from './walking.ts';
import { passProblem } from './passable.ts';
import {
  bodyProblem,
  checkSupport,
  fallDistances,
  landingHazard,
  MAX_SAFE_FALL,
  planTerrainWalk,
  reachableFeet,
  restingY,
  standProblem,
  terrainSteps,
  type TerrainStep,
  type WalkBreaks,
} from './terrain.ts';
import { FrameDecoder, ProtocolError, type Frame } from './wire.ts';
import {
  ENTITY_SCAN_RADIUS,
  WORKBENCH_WINDOW_TYPE,
  WorldModel,
  type BlockWatch,
} from './world-model.ts';
import { describeSightings, SurveyTracker } from './world-survey.ts';

/**
 * Blocks a right-click with an empty hand does nothing to (no window, no state change, no
 * teleport), so clicking one only ends the spawn protection (#endSpawnProtection).
 */
const PLAIN_GROUND: ReadonlySet<string> = new Set([
  'minecraft:grass',
  'minecraft:dirt',
  'minecraft:mycelium',
  'minecraft:sand',
  'minecraft:gravel',
  'minecraft:clay',
  'minecraft:stone',
  'minecraft:cobblestone',
  'minecraft:mossy_cobblestone',
  'minecraft:sandstone',
  'minecraft:hardened_clay',
  'minecraft:stained_hardened_clay',
  'minecraft:snow',
  'minecraft:netherrack',
]);
/** How long after a death the client asks to respawn (the death screen's button delay). */
const RESPAWN_DELAY_MS = 1_000;
/** Longest wait for the server to finish eating (vanilla 32 ticks; HungerOverhaul longer). */
const EAT_TIMEOUT_MS = 8_000;
/** Vanilla clients send one "player" packet per tick (20 per second). */
const IDLE_TICK_MS = 50;
/** Walking sends one position per tick. */
const WALK_TICK_MS = 50;
/** After the last step, ticks to wait for a server correction before calling a walk done. */
const SETTLE_TICKS = 5;
/** Idle ticks between two checks that something still holds the player up (gravity). */
const SUPPORT_CHECK_TICKS = 10;
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
/** Never put into a furnace: lava interaction is not allowed. */
const LAVA_BUCKET = 'minecraft:lava_bucket';

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
const DIG_SETTLE_MS = DIG_SETTLE_TICKS * TICK_MS;
/** How long the drop may take to reach the inventory: a 10-tick pickup delay, plus falling. */
const DROP_WAIT_MS = 2_000;
/**
 * After a walk broke leaves on its way: how long after the last break it waits before it
 * reports (the drop's 10-tick pickup delay, plus 5), so what they drop now and then (a
 * sapling, an apple) reaches the inventory during the walk, not during the next action,
 * whose own drop and inventory checks it would confuse.
 */
const BREAK_DROP_WAIT_MS = 15 * TICK_MS;
/** After the click: how long to wait for the server's block change at the cell. */
const PLACE_OUTCOME_TIMEOUT_MS = 2_000;
/**
 * After the first block change: a quiet period with no further update for the cell. A mod
 * that cancels the placement restores the cell, and sand or gravel that found nothing under
 * it would fall within these ticks.
 */
const PLACE_SETTLE_MS = 5 * TICK_MS;
/** How long the server's re-send of the held slot (S2F, one item fewer) may take. */
const PLACE_STACK_TIMEOUT_MS = 1_000;

/** What a dig holds: hotbar slot `slot`, with `tool` (null: an empty hand) at `damage`. */
interface Hand {
  ok: true;
  slot: number;
  tool: ToolInfo | null;
  damage: number;
  /** Tools for the block that were passed over, and why (or null). */
  note: string | null;
}

/**
 * Better Questing completes quests in its quest loop, every 60 of the player's ticks (3 s at 20
 * per second), and syncs changed quests every 20 ticks: a submit is judged after 8 s.
 */
const QUEST_SUBMIT_TIMEOUT_MS = 8_000;
/** A ticked box or a claim is synced back within 20 player ticks (1 s); 5 s is generous. */
const QUEST_SYNC_TIMEOUT_MS = 5_000;
/** The server echoes a reward choice at once. */
const QUEST_CHOICE_TIMEOUT_MS = 3_000;
/** Reward items arrive as slot updates on the server's next tick. */
const QUEST_REWARD_ITEMS_TIMEOUT_MS = 2_000;

/** "2 x minecraft:sand, 1 x minecraft:flint" (at most 200 characters). */
function describeGain(gained: ReadonlyArray<[string, number]>): string {
  return gained
    .map(([item, n]) => `${n} x ${item}`)
    .join(', ')
    .slice(0, 200);
}

/**
 * An ATTACK_ENTITY burst's outcome: the action's result, and the kill when the target died
 * (where it last stood, its type, and the weapon struck with: null for a bare hand).
 */
interface Burst {
  result: ClientActionResult;
  kill: { at: Vec3; type: string; weapon: string | null } | null;
}

/** What a walk broke: "2 leaves on the way: (1, 64, 0), (1, 65, 0)". */
function describeBroken(cells: readonly BlockPosition[]): string {
  const n = cells.length;
  return (
    `${n === 1 ? 'a leaf block' : `${n} leaves`} on the way: ` +
    cells.map((c) => `(${c.x}, ${c.y}, ${c.z})`).join(', ')
  );
}

/** Yaw and pitch (degrees, Minecraft's convention) from the eyes to a point. */
function lookAt(eyes: Vec3, point: Vec3): { yaw: number; pitch: number } {
  const dx = point.x - eyes.x;
  const dy = point.y - eyes.y;
  const dz = point.z - eyes.z;
  return {
    yaw: (Math.atan2(-dx, dz) * 180) / Math.PI,
    pitch: (-Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

const centreOf = (b: BlockPosition): Vec3 => ({ x: b.x + 0.5, y: b.y + 0.5, z: b.z + 0.5 });

/** The registry id of a block, by name; null when this world's registry does not have it. */
function blockIdOf(registry: Registry | null, name: string): number | null {
  if (registry === null) return null;
  for (const [id, n] of registry.blocks) if (n === name) return id;
  return null;
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
  /**
   * The quests GameState.questBook reports (the agent's Age 0 closure, in order). Quest-book
   * actions are possible only for these. None when absent.
   */
  questScope?: readonly string[];
  /** Overrides how long a quest-book click waits for the server's verdict (tests). */
  questBookTimeoutMs?: number;
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
/** A threat this close stops a walk whichever way it goes (#walkInterruption). */
const CLOSE_THREAT_RADIUS = 6;
/** A flee (#flee) walks at most this far, to a spot at least FLEE_MIN_GAIN farther from the threats. */
const FLEE_MAX_PATH = 32;
const FLEE_MIN_GAIN = 6;
/** Blocks from the threats a block of walking is worth when choosing where to flee. */
const FLEE_WALK_WEIGHT = 0.1;
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
 * can WALK (and EXPLORE) inside a fence or a moving play area, use configured vanilla
 * CHESTS, CRAFT, DIG and PLACE allowlisted blocks, use BLOCK WINDOWS (furnaces and other
 * blocks with an interaction profile) and FIGHT one checked entity, each only when explicitly
 * enabled.
 *
 * Guarantees, enforced here and in packets.ts:
 *  - never connects unless live connections are enabled, an identity marker is set, the
 *    host is private, and the server's status ping shows that marker, Forge and GregTech;
 *  - can only send: handshake, status request, login start, keep-alive, FML handshake /
 *    channel registration, idle ticks, confirmations of server-assigned positions, walking
 *    steps, the window packets chests and crafting need (empty-hand block activation,
 *    hotbar selection, predictable clicks, confirmations, closing a window), digging
 *    start/cancel/finish, a block placement with the held block item, attacks on one checked
 *    entity (C02, attack only), the cosmetic head look and arm swing, and Better Questing's
 *    four typed quest-book messages (the main_sync answer that reading the quest book needs,
 *    and submit, checkbox, choice and claim when the quest book is enabled);
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
 *    boundary: #fence()), and every step is re-checked just before it is sent; it stops on
 *    a server correction, a health drop, a nearby threat (MOVE_TO, EXPLORE), a blocked or
 *    dangerous way ahead, the stop file, halt(), or a lost connection;
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
 */
export class Gtnh1710Client implements MinecraftClient {
  readonly kind = 'gtnh1710';
  readonly #opts: Gtnh1710ClientOptions;
  readonly #world = new WorldModel();
  readonly #multipart = new MultipartAssembler();
  /** Better Questing's sliced messages from the server, reassembled. */
  readonly #questBookSlices = new BqAssembler();
  readonly #outboundCounts = new Map<OutboundKind, number>();
  #socket: Socket | null = null;
  #phase: Phase = 'idle';
  #handshake: FmlClientHandshake | null = null;
  #identity: ServerIdentity | null = null;
  #decoding: PlayDecodeOptions = VANILLA_DECODING;
  #idleTimer: NodeJS.Timeout | null = null;
  /** Idle ticks sent (for the support check every SUPPORT_CHECK_TICKS). */
  #idleTicks = 0;
  /** The last "in the air" problem logged, so it is logged once, not every check. */
  #floatingNote: string | null = null;
  #closedReason: string | null = null;
  #connectedAt: Date | null = null;
  #confirmedPositions = 0;
  /** The player died and a respawn was asked for (until the server sends health again). */
  #respawnAsked = false;
  /** Where the last server position packet put the player, in words (#noteCorrection). */
  #lastCorrection: string | null = null;
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
  /** An ATTACK_ENTITY burst is running (it excludes walking, window work, digging and placing). */
  #fighting = false;
  #placing = false;
  /** An EAT_FOOD is running: the hand holds the food until the server finishes eating it. */
  #eating = false;
  /** Sync clicks sent while crafting (diagnostics). */
  #craftSyncs = 0;
  /** An EXPLORE is running (its hops are walks; no second EXPLORE starts meanwhile). */
  #exploring = false;
  /** What the player has seen around it, for world memory (world-survey.ts). */
  readonly #surveys = new SurveyTracker();
  /** A quest-book click is waiting for the server's verdict. */
  #questBookBusy = false;

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
    this.#log(`block format: ${this.#decoding.neid ? 'NotEnoughIDs (16-bit ids)' : 'vanilla'}`);
    this.#log(
      `item stack format: ${this.#decoding.itemStackSizeVarInt ? 'ModularUI (VarInt stack size)' : 'vanilla'}`,
    );
    await this.#join(deadline);
    // Wait (bounded) until health, inventory, a complete entity picture and the chunks the
    // hazard scan needs have arrived: a first observation without them is unreliable, and the
    // safety policy pauses on it (seen live right after a login).
    await this.#waitFor(
      () =>
        this.#world.hasHealth &&
        this.#world.hasInventory &&
        this.#world.entitiesReady(this.#opts.clock.now()) &&
        this.#world.surroundingsKnown,
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

  async observe(): Promise<GameState> {
    if (this.#phase !== 'play') {
      throw new Error(
        this.#closedReason === null ? 'not connected' : `connection lost: ${this.#closedReason}`,
      );
    }
    // A player the server put in the air lands first (#keepSupported), so what is observed,
    // the night pit's "standing on a block" above all, sees it on the ground. Seen live: saved
    // mid-jump at logout, the player joined 0.42 above the sand, and the session went offline
    // for the night ("no pit: the player is not standing on a block").
    await this.#keepSupported();
    if (this.#phase !== 'play') {
      throw new Error(`connection lost: ${this.#closedReason ?? 'closed'}`);
    }
    const now = this.#opts.clock.now();
    const last = this.#world.lastPacketAt;
    // While packets keep arriving the model is current; if the server goes quiet the
    // timestamp stops advancing, so the safety policy's staleness check fires.
    const asOf = last !== null && now.getTime() - last.getTime() > FRESHNESS_WINDOW_MS ? last : now;
    this.#survey(false);
    return this.#withInteractables(this.#withWorkAreas(this.#world.toGameState(asOf)));
  }

  /**
   * Keeps only the interactable blocks (and found crafting tables) the agent may use inside
   * the fence of the moment (#fence()), and adds where to stand to use each (interact.ts).
   */
  #withInteractables(state: GameState): GameState {
    if (!state.interactables.known) return state;
    const fence = this.#fence().fence;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const key = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`;
    const blocks = state.interactables.value.blocks
      .filter((b) => interactAreaProblem(fence, b.position) === null)
      .map((b) =>
        fence === null || world === null || feet === null
          ? b
          : { ...b, standAt: interactStandSpot(world, fence, b.position, feet) },
      );
    const kept = new Set(blocks.map((b) => key(b.position)));
    return {
      ...state,
      interactables: { known: true, value: { ...state.interactables.value, blocks } },
      craftingTables: state.craftingTables.filter((t) => {
        const observed = parseObservedTableId(t.id);
        return observed === null || kept.has(key(observed));
      }),
      storage: state.storage.filter((s) => {
        const observed = parseObservedStorageId(s.id);
        return observed === null || kept.has(key(observed.position));
      }),
    };
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
   * The fence every walk, dig, placement and stand-spot check uses NOW: the configured fence
   * (movement mode 'fixed'), or the play area around the player clipped to the exploration
   * boundary (mode 'follow'). Each action takes it once when it starts (play-area.ts).
   */
  #fence(): PlayArea {
    return playArea(
      this.#opts.config.movement,
      this.#opts.explorationBoundary ?? null,
      this.#world.ownPosition,
    );
  }

  /**
   * The fence walks, digs and placements use right now (#fence()), read-only, for code that
   * plans with the client's own rules (the night shelter); null when there is none.
   */
  currentFence(): Fence | null {
    return this.#fence().fence;
  }

  /**
   * Fits the nearby blocks to the fence. Digging enabled: adds, for the listed diggable
   * blocks, where the player can stand to dig each (digging.ts standSpotFor), so a planner
   * can walk there and dig. Placing enabled: keeps only the placeable cells inside the area
   * placing may change. Without the fence (or with both disabled) they are left as they are.
   */
  #withWorkAreas(state: GameState): GameState {
    const cfg = this.#opts.config;
    const fence = this.#fence().fence;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (fence === null || world === null || feet === null) return state;
    if (!state.nearbyBlocks.known) return state;
    let blocks = state.nearbyBlocks.value;
    if (cfg.digging.enabled) {
      const area: DigArea = {
        fence,
        maxHeightAboveFence: cfg.digging.maxHeightAboveFence,
      };
      // Only stand spots a walk from here reaches (seen live: logs walled in by leaves,
      // cactus and foliage were offered, and every walk to them failed). Terrain fences only:
      // a one-level fence (the pen) walks by planWalk, which the flood does not model. When
      // the player cannot walk at all, blocks in reach stay diggable where it stands. A
      // walk may break leaves on its way (#walkBreaks), as a MOVE_TO there then does.
      const reachable =
        fence.min.y === fence.max.y
          ? undefined
          : reachableFeet(world, fence, feet, cfg.movement.maxPathLength, this.#walkBreaks(fence));
      const walkable = reachable !== undefined && reachable.size > 0 ? reachable : undefined;
      blocks = {
        ...blocks,
        resources: blocks.resources.map((r) => ({
          ...r,
          standAt: standSpotFor(world, area, r.position, feet, walkable),
        })),
        // The ground in the player's own column (DIG_DOWN, the night pit only).
        underFeet: underFeetOf(world, feet),
      };
    }
    if (cfg.placing.enabled) {
      const area: PlaceArea = {
        fence,
        maxHeightAboveFence: cfg.placing.maxHeightAboveFence,
      };
      blocks = {
        ...blocks,
        placeable: blocks.placeable.filter(
          (c) => placeAreaProblem(area, feet, c.position) === null,
        ),
      };
    }
    return { ...state, nearbyBlocks: known(blocks) };
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
        // Over terrain with digging enabled it may break a few leaves in its way.
        return this.#walkTo(action.args.target, {
          stopForThreats: true,
          breakLeaves: true,
          protectedItems: new Set(validated.protectedItems),
        });
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
        return this.#dig(action.args.position, new Set(validated.protectedItems));
      case 'DIG_DOWN':
        return this.#digDown(action.args.position, new Set(validated.protectedItems));
      case 'PLACE_BLOCK':
        return this.#place(action.args);
      case 'INTERACT_BLOCK':
        return this.#interact(action.args.position);
      case 'SMELT':
        return this.#smelt(action.args);
      case 'TAKE_OUTPUT':
        return this.#takeOutput(action.args);
      case 'ATTACK_ENTITY':
        return this.#attack(action.args.entityId);
      case 'SUBMIT_QUEST':
        return this.#questBookAction({ kind: 'submit', questId: action.args.questId });
      case 'CHECK_QUEST_BOX':
        return this.#questBookAction({
          kind: 'check',
          questId: action.args.questId,
          taskIndex: action.args.taskIndex,
        });
      case 'CLAIM_QUEST_REWARD':
        return this.#questBookAction({
          kind: 'claim',
          questId: action.args.questId,
          choice: action.args.choice,
        });
      case 'EAT_FOOD':
        return this.#eat(action.args.item);
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
    if (this.#placing) return 'the player is placing a block';
    if (this.#eating) return 'the player is eating';
    if (this.#fighting) return 'the player is fighting';
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
      const opened =
        this.#opts.config.containers.chests[containerId] === undefined &&
        parseObservedStorageId(containerId) !== null
          ? await this.#openObservedStorage(containerId, transfer?.direction ?? null)
          : await this.#openChest(containerId);
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

  /**
   * Opens a storage block the observation found (`<profile>:<x>.<y>.<z>`: a chest, an Iron
   * Chests chest...) through its interaction profile, or keeps it open. It also needs
   * MC_ENABLE_INTERACT. A move must be one the layout allows for every slot (an Iron Chests
   * dirt chest takes only dirt, so nothing is ever put into it). A failure, or null once open.
   */
  async #openObservedStorage(
    containerId: string,
    direction: TransferDirection | null,
  ): Promise<ClientActionResult | null> {
    const parsed = parseObservedStorageId(containerId);
    if (parsed === null) return failed(`${containerId} is not a storage block id`, 'REFUSED');
    const blocker = this.#interactBlocker();
    if (blocker !== null) return failed(`not using ${containerId}: ${blocker}`, 'REFUSED');
    const t = this.#interactTarget(parsed.position, parsed.profile);
    if (!t.ok) return t.result;
    const opened = await this.#openInteractable(parsed.position, t.block, t.profile);
    if (!opened.ok) return opened.result;
    const layout = opened.layout;
    if (layout === null) return failed('internal: the storage block has no layout', 'ERROR');
    if (direction === 'to_container' && !allSlots(layout, 'put')) {
      return failed(`not depositing: ${containerId} does not take items in every slot`, 'REFUSED');
    }
    if (direction === 'to_player' && !allSlots(layout, 'take')) {
      return failed(
        `not withdrawing: ${containerId} does not give items from every slot`,
        'REFUSED',
      );
    }
    return null;
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

  /**
   * The stack in hotbar slot `j` (0-8), from the open window or else window 0; null or
   * undefined when the slot is empty or not known.
   */
  #hotbar(j: number): Stack | null | undefined {
    const w = this.#world.openWindow;
    const inv = this.#world.inventoryWindow;
    return w !== null && w.slotsKnown && w.layoutKnown !== false
      ? w.slots[w.containerSlots + 27 + j]
      : inv?.[36 + j];
  }

  #emptyHotbarSlot(): number | null {
    if (this.#hotbar(this.#world.heldSlot) == null) return this.#world.heldSlot;
    for (let j = 0; j < 9; j++) if (this.#hotbar(j) == null) return j;
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
    // Windows of blocks the agent only looks at, or whose layout is unknown, are never clicked.
    if (open !== null) {
      return open.slotsKnown && open.clickable !== false
        ? { windowId: open.windowId, window: open }
        : null;
    }
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
    if (this.#placing) return 'the player is placing a block';
    if (this.#eating) return 'the player is eating';
    if (this.#fighting) return 'the player is fighting';
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
    if (tableId !== null) {
      const where = this.#craftingTablePosition(tableId);
      if (typeof where === 'string') return failed(`not crafting: ${where}`, 'REFUSED');
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

  /**
   * Where a crafting table is: a configured one, or one the scan found
   * (`crafting_table:<x>.<y>.<z>`, a vanilla crafting table by its interaction profile),
   * which must lie inside the fence when one is set. The block itself is checked when the
   * table is opened. The position, or why the table may not be used.
   */
  #craftingTablePosition(tableId: string): { x: number; y: number; z: number } | string {
    const configured = this.#opts.config.crafting.tables[tableId];
    if (configured !== undefined) return configured.position;
    const found = parseObservedTableId(tableId);
    if (found === null) return `${tableId} is not a configured crafting table`;
    const fence = this.#fence().fence;
    const area = interactAreaProblem(fence, found);
    return area === null ? found : `crafting table ${tableId}: ${area}`;
  }

  /** Opens the crafting table (or keeps it open); a failure, or null when open. */
  async #openCraftingTable(tableId: string): Promise<ClientActionResult | null> {
    const table = this.#craftingTablePosition(tableId);
    if (typeof table === 'string') return failed(table, 'REFUSED');
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
      table,
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
    if (open !== null && open.block != null && open.cursor !== null) {
      // A block window (a furnace...) with a stack on the cursor: back into an empty player
      // slot only, never into the block's own slots (an output slot takes nothing).
      const layout =
        open.block.profile === null
          ? null
          : this.#profileLayout(INTERACTION_PROFILES[open.block.profile]);
      if (layout === null) return;
      this.#log('items are on the cursor: putting them down before disconnecting');
      this.#usingContainer = true;
      try {
        this.#log((await this.#returnCursorToPlayer(layout)) ?? 'the cursor was emptied');
      } finally {
        this.#usingContainer = false;
      }
      return;
    }
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
  // Interacting with blocks (src/domain/interactions.ts profiles; interact.ts plans)

  /** Why a block window action cannot start now, or null. */
  #interactBlocker(): string | null {
    const cfg = this.#opts.config;
    if (!cfg.interact.enabled) return 'interacting with blocks is disabled (MC_ENABLE_INTERACT)';
    if (this.#phase !== 'play') return 'not connected';
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#walking) return 'the player is walking';
    if (this.#digging) return 'the player is digging';
    if (this.#placing) return 'the player is placing a block';
    if (this.#eating) return 'the player is eating';
    if (this.#fighting) return 'the player is fighting';
    return null;
  }

  /** Runs one block window action alone: no walk, dig, chest or crafting at the same time. */
  async #interactAction(
    what: string,
    run: () => Promise<ClientActionResult>,
  ): Promise<ClientActionResult> {
    const blocker = this.#interactBlocker();
    if (blocker !== null) {
      const code = this.#opts.config.interact.enabled ? 'REFUSED' : 'NOT_IMPLEMENTED';
      return failed(`not ${what}: ${blocker}`, code);
    }
    if (this.#usingContainer) {
      return failed('a chest, crafting or block window operation is already running', 'REFUSED');
    }
    this.#usingContainer = true;
    try {
      return await run();
    } finally {
      this.#usingContainer = false;
    }
  }

  /**
   * What the block at `target` is and how the agent may use it, checked on the blocks the
   * server sent: loaded and named, a profile (never opened ones refused) or the observe-only
   * allowlist, within reach of the eyes, inside the fence. `need` is a profile the action
   * requires (a furnace for SMELT).
   */
  #interactTarget(
    target: BlockPosition,
    need: InteractionProfile['id'] | null,
  ):
    | { ok: true; block: string; profile: InteractionProfile | null }
    | { ok: false; result: ClientActionResult } {
    const refuse = (reason: string): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result: failed(reason, 'REFUSED'),
    });
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    const id = this.#world.blockAt(target.x, target.y, target.z);
    if (id === undefined) return refuse(`the block at ${where} is not loaded`);
    if (id === 0) return refuse(`there is no block at ${where}`);
    const block = this.#world.registry?.blocks.get(id);
    if (block === undefined) return refuse(`block id ${id} at ${where} is not in the registry`);
    const use = blockUse(block, this.#opts.config.interact.observeOnly);
    if (use.kind === 'refused') return refuse(`not opening ${where}: ${use.reason}`);
    const profile = use.kind === 'profile' ? use.profile : null;
    if (need !== null && profile?.id !== need) {
      return refuse(`the block at ${where} is ${block}, not a ${need}`);
    }
    const feet = this.#world.ownPosition;
    if (feet === null) return refuse('player position unknown');
    const reach = reachTo(feet, target);
    if (reach > MAX_INTERACT_REACH + 1e-9) {
      return refuse(
        `${block} at ${where} is ${reach.toFixed(2)} blocks from the eyes (max ${MAX_INTERACT_REACH})`,
      );
    }
    const fence = this.#fence().fence;
    const area = interactAreaProblem(fence, target);
    if (area !== null) return refuse(`not opening ${block}: ${area}`);
    return { ok: true, block, profile };
  }

  /**
   * Opens the window of the block at `target` with an EMPTY hand (never sneaking), or keeps
   * it open, and checks that the window is the one its profile describes. A failure, or the
   * window's layout (null for an observe-only block) once it is open.
   */
  async #openInteractable(
    target: BlockPosition,
    block: string,
    profile: InteractionProfile | null,
  ): Promise<
    { ok: true; layout: WindowLayout | null } | { ok: false; result: ClientActionResult }
  > {
    const done = (result: ClientActionResult): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result,
    });
    const same = (p: { x: number; y: number; z: number } | undefined): boolean =>
      p !== undefined && p.x === target.x && p.y === target.y && p.z === target.z;
    const what = profile?.label.toLowerCase() ?? block;
    const open = this.#world.openWindow;
    if (open !== null && profile !== null && same(open.block?.position) && open.slotsKnown) {
      const layout = this.#profileLayout(profile);
      if (layout !== null) return { ok: true, layout };
    }
    if (open !== null) {
      const closed = this.#closeOpenWindow();
      if (closed !== null) return done(closed);
    }
    const feet = this.#world.ownPosition;
    if (feet === null) return done(failed('player position unknown', 'REFUSED'));
    const hand = this.#emptyHotbarSlot();
    if (hand === null) return done(failed('no empty hotbar slot to click with', 'REFUSED'));
    if (hand !== this.#world.heldSlot) {
      this.#send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }
    // A storage block opened this way is a container: a configured chest keeps its id, any
    // other gets its position id, so its contents show up in GameState.storage.
    const configured =
      profile?.id === 'chest'
        ? Object.entries(this.#opts.config.containers.chests).find(([, c]) => same(c.position))
        : undefined;
    const containerId =
      configured?.[0] ??
      (profile !== null && profile.storage ? observedStorageId(profile.id, target) : null);
    this.#world.expectBlockWindow({
      position: { ...target },
      block,
      profile: profile?.id ?? null,
    });
    this.#world.expectContainer(containerId);
    const face = faceTowards(eyesOf(feet), target);
    this.#send(outbound.activateBlock(target.x, target.y, target.z, face));
    await this.#waitFor(() => {
      const w = this.#world.openWindow;
      return w !== null && w.slotsKnown;
    }, WINDOW_OPEN_TIMEOUT_MS);
    this.#world.expectBlockWindow(null);
    this.#world.expectContainer(null);
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown) return done(failed(`the ${what} did not open`, 'FAILED'));
    if (!same(w.block?.position)) return done(this.#unexpectedWindow());
    if (profile === null) return { ok: true, layout: null };
    const layout = this.#profileLayout(profile);
    return layout === null ? done(this.#unexpectedWindow()) : { ok: true, layout };
  }

  /**
   * The open window's layout if it belongs to a block with this profile and is exactly a
   * window the profile knows (opener and slot count, matched by the world model), else null.
   */
  #profileLayout(profile: InteractionProfile): WindowLayout | null {
    const w = this.#world.openWindow;
    if (w === null || !w.slotsKnown || w.layoutKnown === false) return null;
    if (w.block?.profile !== profile.id) return null;
    return w.layout ?? null;
  }

  /** A short description of the open block window, for results (contents: 300 characters). */
  #describeOpenBlockWindow(layout: WindowLayout | null): {
    opener: string;
    slots: number;
    contents: string;
  } {
    const w = this.#world.openWindow;
    if (w === null) return { opener: 'none', slots: 0, contents: 'no window is open' };
    const playerFirst = layout === null ? Infinity : layout.containerSlots;
    const items = w.slots
      .map((s, i) => ({ s, i }))
      .filter(({ s, i }) => s != null && (i < playerFirst || i >= playerFirst + 36))
      .map(({ s, i }) => `slot ${i}: ${this.#describeStack(s ?? null)}`)
      .join('; ');
    return {
      opener: w.fml != null ? `fml:${w.fml.modId}:${w.fml.guiId}` : `vanilla:${w.inventoryType}`,
      slots: w.slots.length,
      contents: (items === '' ? 'empty' : items).slice(0, 300),
    };
  }

  /**
   * INTERACT_BLOCK: opens the block's window and reports it. A block with a profile keeps
   * its window open (its contents stay in the observation); an observe-only block's window
   * is closed again at once: nothing in it is ever clicked.
   */
  #interact(target: BlockPosition): Promise<ClientActionResult> {
    return this.#interactAction('opening the block', async () => {
      const t = this.#interactTarget(target, null);
      if (!t.ok) return t.result;
      const opened = await this.#openInteractable(target, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const where = `(${target.x}, ${target.y}, ${target.z})`;
      const seen = this.#describeOpenBlockWindow(opened.layout);
      const data = { block: t.block, profile: t.profile?.id ?? null, ...seen };
      if (t.profile === null) {
        const closed = this.#closeOpenWindow();
        if (closed !== null) return closed;
        this.#log(`looked at ${t.block} at ${where}: ${seen.contents}`);
        return ok(
          `looked at ${t.block} at ${where} (observe-only, nothing clicked; closed again): ` +
            `${seen.opener}, ${seen.slots} slots`,
          data,
        );
      }
      return ok(`opened the ${t.profile.label.toLowerCase()} at ${where}`, data);
    });
  }

  /**
   * Moves exactly `quantity` of `item` from the player's slots into one container slot of
   * the open window, with predicted clicks (interact.ts planInsert). A rejected click (the
   * furnace ticking under the agent, e.g. lighting and using a fuel item) is not an
   * error: the server re-sends the window, the cursor goes back to an empty player slot,
   * and the rest is planned again from the server's own counts. Null on success.
   */
  async #insertExactly(
    layout: WindowLayout,
    target: number,
    item: { id: number; damage: number },
    quantity: number,
    label: string,
  ): Promise<{ ok: true; clicks: number } | { ok: false; result: ClientActionResult }> {
    const view = (): WindowSnapshot | null => this.#clickTarget()?.window ?? null;
    const start = view();
    if (start === null) return { ok: false, result: failed('the window is not open', 'FAILED') };
    const startCount = playerCount(start, layout, item);
    let clicks = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const now = view();
      if (now === null) {
        return {
          ok: false,
          result: failed(`the window closed while moving the ${label}`, 'FAILED'),
        };
      }
      const moved = startCount - playerCount(now, layout, item);
      const remaining = quantity - moved;
      if (remaining === 0 && now.cursor === null) return { ok: true, clicks };
      if (remaining < 0) {
        return {
          ok: false,
          result: failed(`moved ${moved} ${label}, more than the ${quantity} asked`, 'ERROR'),
        };
      }
      const plan = planInsert(now, layout, target, item, remaining);
      if (!plan.ok) {
        return {
          ok: false,
          result: failed(
            moved === 0
              ? `not moving the ${label}: ${plan.reason}`
              : `moved ${moved} of ${quantity} ${label}, then: ${plan.reason}`,
            moved === 0 ? 'REFUSED' : 'FAILED',
            { moved },
          ),
        };
      }
      let rejected = false;
      for (const c of plan.value.clicks) {
        const outcome = await this.#click(c);
        if (outcome === 'accepted') {
          clicks += 1;
          continue;
        }
        const back = await this.#returnCursorToPlayer(layout);
        if (outcome !== 'rejected' || back !== null) {
          return {
            ok: false,
            result: failed(
              `moving the ${label}: a click was ${outcome}${back === null ? '' : `; ${back}`}`,
              back === null ? 'FAILED' : 'ERROR',
              { clicks },
            ),
          };
        }
        rejected = true;
        break;
      }
      if (!rejected) {
        const after = view();
        const done = after === null ? null : startCount - playerCount(after, layout, item);
        if (done === quantity && after?.cursor === null) return { ok: true, clicks };
      }
    }
    return {
      ok: false,
      result: failed(`moving the ${label}: still not done after 3 attempts`, 'FAILED', { clicks }),
    };
  }

  /**
   * After a rejected click: puts the cursor back into an EMPTY player slot (never into the
   * block's own slots). Null when the cursor is empty, else the problem.
   */
  async #returnCursorToPlayer(layout: WindowLayout): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const w = this.#clickTarget()?.window ?? null;
      if (w === null) return 'the window closed';
      if (w.cursor === null) return null;
      const [first, last] = playerRangeOf(layout);
      let empty: number | null = null;
      for (let i = first; i <= last; i++) {
        if (w.slots[i] === null) {
          empty = i;
          break;
        }
      }
      if (empty === null) break;
      const outcome = await this.#click({ slot: empty, button: 0 });
      if (outcome !== 'accepted' && outcome !== 'rejected') break;
    }
    const w = this.#world.openWindow;
    return w?.cursor == null
      ? null
      : `ITEMS MAY BE ON THE CURSOR (${w.cursor.count} of id ${w.cursor.id}); the window was left open`;
  }

  /**
   * SMELT: opens the furnace and puts exactly the fuel (first: an unlit furnace cannot light
   * while its input slot is empty) and then the input into it. Everything is planned on the
   * window before the first click, and refused if it cannot finish exactly. The furnace keeps
   * its items and smelts on its own; its window stays open, so the observation shows it.
   */
  #smelt(args: {
    position: BlockPosition;
    input: string;
    quantity: number;
    fuel: string;
    fuelQuantity: number;
  }): Promise<ClientActionResult> {
    return this.#interactAction('smelting', async () => {
      if (args.input === LAVA_BUCKET || args.fuel === LAVA_BUCKET) {
        return failed('not smelting: lava is never used', 'REFUSED');
      }
      if (args.fuelQuantity > 0 && furnaceFuelTicks(args.fuel) === null) {
        return failed(`not smelting: ${args.fuel} is not a known furnace fuel`, 'REFUSED');
      }
      const registry = this.#world.registry;
      const input = resolveItemName(registry, args.input);
      const fuel = resolveItemName(registry, args.fuel);
      if (input === null) return failed(`${args.input} is not in the item registry`, 'REFUSED');
      if (fuel === null) return failed(`${args.fuel} is not in the item registry`, 'REFUSED');
      const t = this.#interactTarget(args.position, 'furnace');
      if (!t.ok) return t.result;
      const opened = await this.#openInteractable(args.position, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const layout = opened.layout;
      if (layout === null) return failed('internal: the furnace has no layout', 'ERROR');

      // Refuse before the first click when the two moves cannot both finish exactly.
      const start = this.#clickTarget()?.window ?? null;
      if (start === null) return failed('the furnace window is not open', 'FAILED');
      let preview = start;
      if (args.fuelQuantity > 0) {
        const p = planInsert(preview, layout, FURNACE_SLOT.fuel, fuel, args.fuelQuantity);
        if (!p.ok) return failed(`not smelting: fuel: ${p.reason}`, 'REFUSED');
        preview = p.value.after;
      }
      const p = planInsert(preview, layout, FURNACE_SLOT.input, input, args.quantity);
      if (!p.ok) return failed(`not smelting: input: ${p.reason}`, 'REFUSED');

      let clicks = 0;
      if (args.fuelQuantity > 0) {
        const f = await this.#insertExactly(
          layout,
          FURNACE_SLOT.fuel,
          fuel,
          args.fuelQuantity,
          'fuel',
        );
        if (!f.ok) return f.result;
        clicks += f.clicks;
      }
      const i = await this.#insertExactly(
        layout,
        FURNACE_SLOT.input,
        input,
        args.quantity,
        'input',
      );
      if (!i.ok) {
        return args.fuelQuantity > 0
          ? failed(
              `the fuel went in, the input did not: ${i.result.message}`,
              i.result.code === 'OK' ? 'FAILED' : i.result.code,
              i.result.data,
            )
          : i.result;
      }
      clicks += i.clicks;
      const where = `(${args.position.x}, ${args.position.y}, ${args.position.z})`;
      return ok(
        `put ${args.quantity} ${args.input}` +
          (args.fuelQuantity > 0 ? ` and ${args.fuelQuantity} ${args.fuel}` : '') +
          ` into the furnace at ${where} in ${clicks} clicks; it smelts on its own (10 s per item)`,
        { clicks, ...this.#describeOpenBlockWindow(layout) },
      );
    });
  }

  /**
   * TAKE_OUTPUT: opens the furnace and takes the WHOLE stack in its output slot, which must
   * be `item`, into an empty inventory slot. Reports how many were taken, counted from the
   * player's own slots (a click the server rejected because another item finished meanwhile
   * still took everything the slot held).
   */
  #takeOutput(args: { position: BlockPosition; item: string }): Promise<ClientActionResult> {
    return this.#interactAction('taking the output', async () => {
      const item = resolveItemName(this.#world.registry, args.item);
      if (item === null) return failed(`${args.item} is not in the item registry`, 'REFUSED');
      const t = this.#interactTarget(args.position, 'furnace');
      if (!t.ok) return t.result;
      const opened = await this.#openInteractable(args.position, t.block, t.profile);
      if (!opened.ok) return opened.result;
      const layout = opened.layout;
      if (layout === null) return failed('internal: the furnace has no layout', 'ERROR');
      const start = this.#clickTarget()?.window ?? null;
      if (start === null) return failed('the furnace window is not open', 'FAILED');
      const output = start.slots[FURNACE_SLOT.output] ?? null;
      if (output === null) return failed("the furnace's output slot is empty", 'REFUSED');
      if (output.hasNbt || output.id !== item.id || output.damage !== item.damage) {
        return failed(
          `the furnace's output is ${this.#describeStack(output)}, not ${args.item}`,
          'REFUSED',
        );
      }
      const plan = planTakeAll(start, layout, FURNACE_SLOT.output);
      if (!plan.ok) return failed(`not taking the output: ${plan.reason}`, 'REFUSED');
      const before = playerCount(start, layout, item);
      let clicks = 0;
      for (const c of plan.value.clicks) {
        const outcome = await this.#click(c);
        if (outcome === 'accepted') {
          clicks += 1;
          continue;
        }
        const back = await this.#returnCursorToPlayer(layout);
        if (outcome !== 'rejected' || back !== null) {
          return failed(
            `taking the output: a click was ${outcome}${back === null ? '' : `; ${back}`}`,
            back === null ? 'FAILED' : 'ERROR',
            { clicks },
          );
        }
        break; // the server re-sent the window; the cursor is back in the inventory
      }
      const end = this.#clickTarget()?.window ?? null;
      if (end === null || end.cursor !== null) {
        return failed('the cursor is not empty after taking the output', 'ERROR');
      }
      const taken = playerCount(end, layout, item) - before;
      if (taken < 1) return failed('nothing reached the inventory', 'FAILED', { clicks });
      const where = `(${args.position.x}, ${args.position.y}, ${args.position.z})`;
      return ok(`took ${taken} ${args.item} from the furnace at ${where}`, {
        item: args.item,
        taken,
        clicks,
        ...this.#describeOpenBlockWindow(layout),
      });
    });
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
    if (this.#placing) return refused('the player is placing a block');
    if (this.#fighting) return refused('the player is fighting');
    return null;
  }

  /**
   * DIG_BLOCK: break one allowlisted block like a player: hold the best allowlisted tool for
   * it (src/domain/tools.ts; else an empty hand), face it, swing the arm, C07 start, the dig
   * time (vanilla x 1.25 + 2 ticks at the tool's verified speed, re-checking everything
   * every tick), C07 finish; a problem on the way sends C07 cancel. Success needs the
   * server's own block change to air, with no re-send after it. Reports the tool used and
   * its uses left, and whether the drop reached the inventory. A drop that landed out of
   * the player's pickup reach (in a hole next to it, or a few blocks away) is picked up as a
   * player would: by walking onto it, when the spot it lies on is standable (an ordinary
   * checked walk inside the fence).
   */
  async #dig(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
  ): Promise<ClientActionResult> {
    const dug = await this.#digOnce(target, protectedItems);
    if (dug.drop === null) return dug.result;
    const spot = dug.drop.spot;
    const walked = await this.#walkTo(spot, { stopForThreats: true });
    const gained = walked.ok ? await this.#dropGain(dug.drop.itemsBefore, dug.drop.tool) : [];
    const drops = describeGain(gained);
    const where = `(${Math.floor(spot.x)}, ${spot.y}, ${Math.floor(spot.z)})`;
    this.#log(
      `walked to the drop at ${where}: ${walked.ok ? (gained.length > 0 ? drops : 'no drop') : walked.message}`,
    );
    return ok(
      (
        `${dug.result.message.replace(/; no drop reached.*$/, '')}; ` +
        (walked.ok
          ? gained.length > 0
            ? `walked to the drop at ${where} and picked up ${drops}`
            : `walked to ${where}, but no drop reached the inventory`
          : `the drop lies at ${where}, but walking there failed: ${walked.message}`)
      ).slice(0, 500),
      {
        ...dug.result.data,
        dropCollected: gained.length > 0,
        drops,
        walkedToDrop: walked.ok,
      },
    );
  }

  /**
   * DIG_DOWN (the night pit only; approved 2026-10-01): dig the block under the player's own
   * feet, exactly as DIG_BLOCK digs (the best allowed tool or an empty hand, the dig time,
   * every tick re-checked, C07 start/finish, success only on the server's change to air),
   * with digging.ts checkDigDown's rules instead of checkDig's: exactly one block down onto a
   * plain full block, nothing but air, plants and plain blocks around it. Then the player
   * falls onto the block below with vanilla gravity (#fallInto), and the result reports the
   * new feet position. Walking must be allowed: the fall is a move.
   */
  async #digDown(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
  ): Promise<ClientActionResult> {
    const moving = this.#movementBlocker();
    if (moving !== null && this.#opts.config.digging.enabled) {
      return failed(`not digging down: the player falls into the hole, and ${moving}`, 'REFUSED');
    }
    return (await this.#digOnce(target, protectedItems, true)).result;
  }

  /**
   * DIG_DOWN's fall, as a game client would make it (this client does not otherwise simulate
   * physics): the block under the feet is gone, so the player drops straight down with
   * vanilla gravity onto the block below, one block. Only when checkSupport shows nothing
   * holding the player up and the floor exactly at `landY`, with no hazard next to the
   * landing. Then SETTLE_TICKS for a server correction. Null when it landed, else why not.
   */
  async #fallInto(
    landY: number,
    guard: { placementsAtStart: number; healthAtStart: number | null },
  ): Promise<string | null> {
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position became unknown';
    const support = checkSupport(world, feet);
    if (support.kind !== 'floating' || support.landY !== landY) {
      return support.kind === 'floating'
        ? `the floor is at y=${support.landY ?? 'none'}, not y=${landY}`
        : `the player is still ${support.kind === 'supported' ? 'held up' : 'over unknown blocks'}`;
    }
    const hazard = landingHazard(world, Math.floor(feet.x), landY, Math.floor(feet.z));
    if (hazard !== null) return `the landing is ${hazard}`;
    // Falling is a walk of its own: nothing else may start meanwhile.
    this.#walking = true;
    this.#stopIdle();
    try {
      const fallen = fallDistances(feet.y - landY);
      for (const [i, d] of fallen.entries()) {
        if (this.#phase !== 'play') return 'the connection closed';
        const last = i === fallen.length - 1;
        const pos = { x: feet.x, y: last ? landY : feet.y - d, z: feet.z };
        this.#send(
          outbound.playerMove(
            { x: pos.x, feetY: pos.y, z: pos.z, yaw: this.#lastYaw, pitch: 0 },
            last,
          ),
        );
        this.#world.setOwnPosition(pos);
        await delay(WALK_TICK_MS);
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      for (let i = 0; i < SETTLE_TICKS; i++) {
        if (this.#phase !== 'play') return 'the connection closed';
        if (this.#confirmedPositions !== guard.placementsAtStart) {
          return 'the server corrected the position after the fall';
        }
        this.#send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      if (this.#confirmedPositions !== guard.placementsAtStart) {
        return 'the server corrected the position after the fall';
      }
      // The feet must be exactly where the fall ended: straight down, on the block below.
      const now = this.#world.ownPosition;
      if (now === null || now.x !== feet.x || now.z !== feet.z || Math.abs(now.y - landY) > 1e-9) {
        return `the feet are not on the landing after the fall (${now === null ? 'unknown' : `${now.x}, ${now.y}, ${now.z}`})`;
      }
      this.#log(`fell ${(feet.y - landY).toFixed(2)} blocks into the hole, onto y=${landY}`);
      return null;
    } finally {
      this.#walking = false;
      if (this.#phase === 'play') this.#startIdle();
    }
  }

  /**
   * Items gained since `before`, waiting up to DROP_WAIT_MS for the first one. The tool used
   * (if any) is left out: its wear changes its name (`@damage`), which is not a gain.
   */
  async #dropGain(
    before: Readonly<Record<string, number>>,
    tool: ToolInfo | null,
  ): Promise<Array<[string, number]>> {
    await this.#waitFor(() => this.#gainSince(before, tool).length > 0, DROP_WAIT_MS);
    return this.#gainSince(before, tool);
  }

  /** Items gained since `before`, now (the tool used, if any, left out: see #dropGain). */
  #gainSince(
    before: Readonly<Record<string, number>>,
    tool: ToolInfo | null,
  ): Array<[string, number]> {
    const isTool = (item: string): boolean =>
      tool !== null && (item === tool.item || item.startsWith(`${tool.item}@`));
    const now = this.#world.inventoryItems() ?? {};
    return Object.entries(now)
      .filter(([item]) => !isTool(item))
      .map(([item, n]): [string, number] => [item, n - (before[item] ?? 0)])
      .filter(([, d]) => d > 0);
  }

  async #digOnce(
    target: BlockPosition,
    protectedItems: ReadonlySet<string>,
    /** DIG_DOWN: the block under the feet, by checkDigDown's rules, then the fall into it. */
    down = false,
  ): Promise<{
    result: ClientActionResult;
    /** Set when the drop was not picked up and lies on a spot the player can walk to. */
    drop: {
      itemsBefore: Readonly<Record<string, number>>;
      spot: Vec3;
      tool: ToolInfo | null;
    } | null;
  }> {
    const done = (result: ClientActionResult): { result: ClientActionResult; drop: null } => ({
      result,
      drop: null,
    });
    const verb = down ? 'digging down' : 'digging';
    const blocker = this.#digBlocker();
    const fence = this.#fence().fence;
    if (blocker !== null || fence === null) {
      return done(
        failed(`not ${verb}: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED'),
      );
    }
    const area: DigArea = {
      fence,
      maxHeightAboveFence: this.#opts.config.digging.maxHeightAboveFence,
    };
    /** The rules this dig is checked by, before it starts and every tick (digging.ts). */
    const rule = (world: WalkWorld, at: Vec3): DigCheck =>
      down ? checkDigDown(world, area, at, target) : checkDig(world, area, at, target);
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    this.#digging = true;
    try {
      const dug = await this.#digChecked(target, rule, protectedItems, verb, null);
      if (!dug.ok) return done(dug.result);
      const { world, check, hand, held, itemsBefore, ticks, guard } = dug;
      const tool = hand.tool;
      const { x, y, z } = target;

      // DIG_DOWN: the block under the feet is gone; fall onto the one below it at once.
      if (down) {
        const fell = await this.#fallInto(y, guard);
        if (fell !== null) {
          this.#log(`dug ${check.block} at ${where}, but did not fall into the hole: ${fell}`);
          return done(
            failed(
              `dug ${check.block} at ${where}, but the fall into the hole failed: ${fell}`,
              'FAILED',
              { x, y, z, block: check.block },
            ),
          );
        }
      }

      // The tool wore by one: the server sends its slot again (a tick or so later).
      const wear = held === null || tool === null ? null : await this.#toolAfterDig(held, tool);
      // The drop spawns in the block's cell and is picked up (after 10 ticks) only when it
      // lands within reach of the player's body; report whether it arrived.
      const gained = itemsBefore === null ? [] : await this.#dropGain(itemsBefore, tool);
      const drops = describeGain(gained);
      const dropCollected = gained.length > 0;
      const used =
        tool === null
          ? `an empty hand${hand.note === null ? '' : ` (${hand.note.slice(0, 120)})`}`
          : `${tool.item} (${wear?.text ?? 'its wear was not seen'})`;
      this.#log(
        `dug ${check.block} at ${where} with ${used}; drop ${dropCollected ? drops : 'not collected'}`,
      );
      const now = this.#world.ownPosition;
      const result = ok(
        (
          `dug ${check.block} at ${where} in ${ticks} ticks with ${used}; ` +
          (down && now !== null
            ? `fell into the hole: the feet are at (${now.x}, ${now.y}, ${now.z}); `
            : '') +
          (dropCollected
            ? `the drop reached the inventory: ${drops}`
            : itemsBefore === null
              ? 'the inventory was unknown, so the drop could not be checked'
              : `no drop reached the inventory (none, or it lies at ${where} out of pickup reach: walk onto it)`)
        ).slice(0, 500),
        {
          x,
          y,
          z,
          block: check.block,
          ticks,
          tool: tool?.item ?? null,
          toolUsesLeft: wear?.usesLeft ?? null,
          ...(hand.note === null ? {} : { toolNote: hand.note.slice(0, 200) }),
          dropCollected,
          drops,
          ...(down && now !== null ? { feetX: now.x, feetY: now.y, feetZ: now.z } : {}),
        },
      );
      // Not picked up: the drop fell to the floor of the dug cell (or below it). On terrain,
      // if a player could stand there, walk onto it. (After DIG_DOWN the player stands in
      // that cell already.)
      const terrain = area.fence.min.y !== area.fence.max.y;
      if (dropCollected || itemsBefore === null || !terrain || down) return { result, drop: null };
      let floor = y;
      while (floor > y - 3 && world.blockAt(x, floor - 1, z) === 0) floor -= 1;
      const standable =
        floor >= area.fence.min.y &&
        floor <= area.fence.max.y &&
        standProblem(world, x, floor, z) === null;
      return {
        result,
        drop: standable ? { itemsBefore, spot: { x: x + 0.5, y: floor, z: z + 0.5 }, tool } : null,
      };
    } finally {
      this.#digging = false;
    }
  }

  /**
   * The dig itself, as DIG_BLOCK, DIG_DOWN and a walk's breaks all make it (the caller holds
   * #digging and has checked its blockers). A window left open is closed first (never with a
   * full cursor); `rule` is checked on the latest blocks, the hand chosen (#chooseHand) and
   * `rule` checked again; then it faces the block, swings, sends C07 start, waits the dig time
   * (digWaitTicks at the tool's speed) with `rule`, the guard, the block and the tool in hand
   * re-checked every tick (C07 cancel on any problem), sends C07 finish and takes the server's
   * verdict (#digVerdict: air, and no re-send). The guard is the caller's (a walk's own),
   * else taken just before the start.
   */
  async #digChecked(
    target: BlockPosition,
    rule: (world: WalkWorld, at: Vec3) => DigCheck,
    protectedItems: ReadonlySet<string>,
    verb: string,
    callerGuard: { placementsAtStart: number; healthAtStart: number | null } | null,
  ): Promise<
    | { ok: false; result: ClientActionResult }
    | {
        ok: true;
        world: WalkWorld;
        check: Extract<DigCheck, { ok: true }>;
        hand: Hand;
        held: { slot: number; stack: Stack | null } | null;
        itemsBefore: Readonly<Record<string, number>> | null;
        ticks: number;
        guard: { placementsAtStart: number; healthAtStart: number | null };
      }
  > {
    const done = (result: ClientActionResult): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result,
    });
    const where = `(${target.x}, ${target.y}, ${target.z})`;
    // A chest left open by an earlier action is closed first (never with a full cursor).
    if (this.#world.openWindow !== null) {
      const closed = this.#closeOpenWindow();
      if (closed !== null) return done(failed(`not ${verb}: ${closed.message}`, 'REFUSED'));
    }
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) {
      return done(failed(`not ${verb}: block data or position unknown`, 'REFUSED'));
    }
    const first = rule(world, feet);
    if (!first.ok) return done(failed(`not ${verb}: ${first.reason}`, 'REFUSED'));
    // What to hold: the best allowlisted tool for this block that one more use cannot
    // break (src/domain/tools.ts), moved into the hotbar if needed; else an empty hand.
    const hand = await this.#chooseHand(first.block, protectedItems);
    if (!hand.ok) return done(failed(`not ${verb}: ${hand.reason}`, hand.code));
    if (hand.slot !== this.#world.heldSlot) {
      this.#send(outbound.selectHotbarSlot(hand.slot));
      this.#world.setHeldSlot(hand.slot);
    }
    const tool = hand.tool;
    // Choosing the hand may have taken a few clicks: check again before starting.
    const check = rule(world, this.#world.ownPosition ?? feet);
    if (!check.ok) return done(failed(`not ${verb}: ${check.reason}`, 'REFUSED'));
    const held = tool === null ? null : { slot: hand.slot, stack: this.#hotbar(hand.slot) ?? null };

    const itemsBefore = this.#world.inventoryItems();
    // A block of hardness 0 (a HarvestCraft garden) breaks on the dig's start: the server's
    // ItemInWorldManager.onBlockClicked harvests it there, and a vanilla client sends no finish.
    const instant = instantDig(check.block);
    const ticks = instant
      ? 0
      : digWaitTicks(check.block, tool === null ? BARE_HAND_SPEED : tool.speed);
    const holding =
      tool === null ? 'an empty hand' : `${tool.item} (${usesLeft(tool, hand.damage)} uses left)`;
    const guard = callerGuard ?? {
      placementsAtStart: this.#confirmedPositions,
      healthAtStart: this.#world.health,
    };
    const clock = this.#opts.clock;
    const watch = this.#world.watchBlock(target.x, target.y, target.z);
    const { x, y, z } = target;
    let verdict: { ok: true } | { ok: false; result: ClientActionResult };
    try {
      this.#log(`digging ${check.block} at ${where} with ${holding}: ${ticks} ticks`);
      // Face the block, as a player does (other players see where the head points).
      const look = lookAt(eyesOf(feet), centreOf(target));
      this.#send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
      this.#lastYaw = look.yaw;
      const self = this.#world.selfEntityId;
      if (self !== null) this.#send(outbound.swingArm(self));
      const startSentAt = watch.updates.length;
      this.#send(outbound.digBlock(DIG_STATUS.start, x, y, z, check.face));
      if (instant) {
        // The server's answer to the start is the verdict: air with no re-send, as for a
        // finish (a cancelled break re-sends the block).
        verdict = await this.#digVerdict(watch, startSentAt, check.block, where);
        if (!verdict.ok) return done(verdict.result);
        this.#world.noteDug(target);
        return { ok: true, world, check, hand, held, itemsBefore, ticks, guard };
      }
      const startedAt = clock.now().getTime();
      let tick = 0;
      while (clock.now().getTime() - startedAt < ticks * TICK_MS) {
        await delay(TICK_MS);
        tick += 1;
        // A digging client swings its arm every few ticks; the server shows it to others.
        if (self !== null && tick % 4 === 0 && this.#phase === 'play') {
          this.#send(outbound.swingArm(self));
        }
        const problem = this.#digProblem(rule, check.blockId, watch, guard, held);
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
    this.#world.noteDug(target);
    return { ok: true, world, check, hand, held, itemsBefore, ticks, guard };
  }

  /**
   * What to dig `block` with. The fastest tool for it from the allowlist (src/domain/tools.ts)
   * that has no NBT data, is not protected, and that one more use cannot break; at equal
   * speed the one already in hand, then the hotbar, then the main inventory. A tool in the
   * main inventory is first moved into an empty hotbar slot (two confirmed clicks in window
   * 0). With no usable tool, an empty hotbar slot: an empty hand. `note` says which tools
   * for this block were passed over, and why.
   */
  async #chooseHand(
    block: DiggableBlock,
    protectedItems: ReadonlySet<string>,
  ): Promise<Hand | { ok: false; reason: string; code: 'REFUSED' | 'FAILED' | 'ERROR' }> {
    const storage = this.#world.playerStorage();
    const registry = this.#world.registry;
    interface Candidate {
      tool: ToolInfo;
      damage: number;
      /** 0-26 main inventory, 27-35 hotbar (playerStorage order). */
      index: number;
      stack: Stack;
    }
    const candidates: Candidate[] = [];
    const passedOver: string[] = [];
    if (storage !== null && registry !== null) {
      const heldIndex = 27 + this.#world.heldSlot;
      const order = [heldIndex];
      for (let i = 27; i < 36; i++) if (i !== heldIndex) order.push(i);
      for (let i = 0; i < 27; i++) order.push(i);
      for (const index of order) {
        const s = storage[index];
        if (s == null) continue;
        const base = registry.items.get(s.id);
        const tool = base === undefined ? null : toolInfo(base);
        if (tool === null || toolSpeedOn(tool, block) === null) continue;
        const naming = nameItemStack(registry, s.id, s.damage);
        const problem = !naming.ok
          ? `${tool.item}: ${naming.reason}`
          : isProtected(naming.name, protectedItems)
            ? `${tool.item} is a protected item`
            : toolProblem({ tool, damage: s.damage, count: s.count, hasNbt: s.hasNbt }, block);
        if (problem === null) candidates.push({ tool, damage: s.damage, index, stack: s });
        else passedOver.push(problem);
      }
    }
    const note = passedOver.length === 0 ? null : `not used: ${passedOver.slice(0, 2).join('; ')}`;
    const inHotbar = (c: Candidate): boolean => c.index >= 27;
    const use = (c: Candidate, slot: number): Hand => ({
      ok: true,
      slot,
      tool: c.tool,
      damage: c.damage,
      note,
    });

    const best = bestTool(block, candidates, () => true);
    if (best !== null && inHotbar(best)) return use(best, best.index - 27);
    if (best !== null) {
      const free = this.#emptyHotbarSlot();
      if (free !== null) {
        const moved = await this.#moveToHotbar(9 + best.index, free, best.stack);
        if (moved === null) return use(best, free);
        return {
          ok: false,
          reason: `the ${best.tool.item} could not be moved into the hotbar: ${moved}`,
          code: moved.startsWith('ITEMS MAY') ? 'ERROR' : 'FAILED',
        };
      }
      // No room to move it: a slower tool already in the hotbar, else nothing to dig with.
      const slower = bestTool(block, candidates.filter(inHotbar), () => true);
      if (slower !== null) return use(slower, slower.index - 27);
      return {
        ok: false,
        reason: `no empty hotbar slot (to move the ${best.tool.item} into, or to dig with an empty hand)`,
        code: 'REFUSED',
      };
    }
    const empty = this.#emptyHotbarSlot() ?? this.#plainHotbarSlot();
    if (empty === null) {
      return {
        ok: false,
        reason:
          'no empty hotbar slot (with no usable tool for this block, the agent digs with an empty hand)' +
          (note === null ? '' : `; ${note}`),
        code: 'REFUSED',
      };
    }
    return { ok: true, slot: empty, tool: null, damage: 0, note };
  }

  /**
   * With no empty hotbar slot: one holding a plain block item (sand, dirt, a log, a sapling;
   * not a tool, no NBT), the held one first. Digging with it is digging with a bare hand: in
   * 1.7.10 a non-tool item's dig speed is 1 (Item.getDigSpeed), it harvests what a hand
   * harvests, and nothing of it wears or is used (a left click places nothing). Seen live:
   * the hotbar full of sand, dirt, logs and saplings, and every dig of the gravel it had
   * walked to refused: "no empty hotbar slot". Null when none holds such an item.
   */
  #plainHotbarSlot(): number | null {
    const registry = this.#world.registry;
    if (registry === null) return null;
    const blocks = new Set(registry.blocks.values());
    const held = this.#world.heldSlot;
    for (const j of [held, ...[0, 1, 2, 3, 4, 5, 6, 7, 8].filter((k) => k !== held)]) {
      const s = this.#hotbar(j);
      if (s == null || s.hasNbt) continue;
      const name = registry.items.get(s.id) ?? registry.blocks.get(s.id);
      if (name !== undefined && blocks.has(name) && toolInfo(name) === null) return j;
    }
    return null;
  }

  /**
   * Moves the stack in window-0 slot `from` into the empty hotbar slot `hotbar`: a left-click
   * picks it up, a left-click on the empty slot puts it down, each confirmed by the server.
   * After a click that is not accepted, the cursor goes back into the inventory. Null when
   * moved, else why not ("ITEMS MAY BE ON THE CURSOR..." when that failed too).
   */
  async #moveToHotbar(from: number, hotbar: number, stack: Stack): Promise<string | null> {
    if (this.#world.openWindow !== null) return 'a window is open';
    if (this.#clickTarget() === null) return 'the inventory window is not known';
    const clicks: Click[] = [
      { slot: from, button: 0 },
      { slot: 36 + hotbar, button: 0 },
    ];
    for (const click of clicks) {
      const outcome = await this.#click(click);
      if (outcome === 'accepted') continue;
      const w = this.#clickTarget()?.window;
      const cleared =
        w === undefined
          ? 'the inventory is not known'
          : await this.#clearGrid(INVENTORY_GRID, stackBounds(w, INVENTORY_GRID), {
              ...stack,
              count: 1,
            });
      return cleared === null
        ? `a click was ${outcome}`
        : `ITEMS MAY BE ON THE CURSOR (${cleared}): a click was ${outcome}`;
    }
    this.#log(`moved the tool from slot ${from} into hotbar slot ${hotbar}`);
    return null;
  }

  /**
   * After a dig with a tool: waits (up to 1 s) for the server to re-send its slot with one
   * more damage, then describes its state.
   */
  async #toolAfterDig(
    held: { slot: number; stack: Stack | null },
    tool: ToolInfo,
  ): Promise<{ usesLeft: number | null; text: string }> {
    await this.#waitFor(() => !sameStack(this.#hotbar(held.slot) ?? null, held.stack), 1_000);
    const now = this.#hotbar(held.slot) ?? null;
    const before = held.stack;
    if (now === null) return { usesLeft: 0, text: 'the tool is gone from its slot' };
    if (before === null || now.id !== before.id || now.hasNbt) {
      return { usesLeft: null, text: 'its slot now holds something else' };
    }
    const left = usesLeft(tool, now.damage);
    const wore = now.damage - before.damage;
    return {
      usesLeft: left,
      text:
        wore === 1
          ? `${left} uses left`
          : `${left} uses left; its damage went from ${before.damage} to ${now.damage}`,
    };
  }

  /**
   * Why work on a block (a dig, a placement) must stop or not start now, or null: the
   * connection, halt(), the stop file, a server correction or a health drop since `guard`
   * was taken, an incomplete entity picture, or a hostile (not a calm spider) or unidentified
   * entity within threatRadius.
   */
  #interruption(guard: { placementsAtStart: number; healthAtStart: number | null }): string | null {
    if (this.#phase !== 'play') return 'the connection closed';
    const cfg = this.#opts.config;
    if (this.#haltReason !== null) return `halted: ${this.#haltReason}`;
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return `the stop file ${cfg.movement.stopFile} exists`;
    }
    if (this.#confirmedPositions !== guard.placementsAtStart) return this.#corrected();
    const health = this.#world.health;
    if (
      !this.#starving() &&
      guard.healthAtStart !== null &&
      health !== null &&
      health < guard.healthAtStart
    ) {
      return `health dropped from ${guard.healthAtStart} to ${health}`;
    }
    const now = this.#opts.clock.now();
    if (!this.#world.entitiesReady(now)) {
      return 'the entities around the player are not fully known';
    }
    const threat = this.#world
      .nearbyEntities(cfg.movement.threatRadius, now)
      .find((e) => (e.category === 'hostile' && !e.calm) || e.category === 'unclassified');
    if (threat !== undefined) {
      return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
    }
    return null;
  }

  /**
   * Why the dig in progress must stop now, or null. Checked every tick, with the dig's own
   * rules (`rule`: checkDig, or checkDigDown for DIG_DOWN).
   */
  #digProblem(
    rule: (world: WalkWorld, feet: Vec3) => DigCheck,
    blockId: number,
    watch: BlockWatch,
    guard: { placementsAtStart: number; healthAtStart: number | null },
    held: { slot: number; stack: Stack | null } | null,
  ): string | null {
    const interrupted = this.#interruption(guard);
    if (interrupted !== null) return interrupted;
    // The server digs with whatever is in hand: with a tool, it must stay exactly as it was.
    if (
      held !== null &&
      (this.#world.heldSlot !== held.slot ||
        !sameStack(this.#hotbar(held.slot) ?? null, held.stack))
    ) {
      return 'the tool in hand changed';
    }
    // Any update for the block while digging: the server refused the dig (it re-sends the
    // block), or the block changed. Either way this dig is over.
    if (watch.updates.length > 0) {
      return `the server sent the block again while digging (id ${watch.updates[0]}): the dig was refused or the block changed`;
    }
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) return 'block data or position became unknown';
    const check = rule(world, feet);
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

  // -------------------------------------------------------------------------
  // Placing one block (see placing.ts)

  /** Why placing cannot start now, or null. */
  #placeBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.placing.enabled) {
      return { reason: 'placing is disabled (MC_ENABLE_PLACING)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#fence();
    if (area.fence === null) return refused(`placing stays inside the fence: ${area.problem}`);
    if (!cfg.presenceTicks) return refused('placing needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#haltReason !== null) return refused(`halted: ${this.#haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#walking) return refused('the player is walking');
    if (this.#usingContainer) return refused('a chest or crafting operation is running');
    if (this.#digging) return refused('the player is digging');
    if (this.#placing) return refused('a placement is already in progress');
    if (this.#fighting) return refused('the player is fighting');
    return null;
  }

  /** checkPlace on the latest block data, position and entities, after #interruption. */
  #placeCheck(
    area: PlaceArea,
    target: BlockPosition,
    item: PlaceableItem,
    guard: { placementsAtStart: number; healthAtStart: number | null },
  ): PlaceCheck {
    const interrupted = this.#interruption(guard);
    if (interrupted !== null) return { ok: false, reason: interrupted };
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    if (world === null || feet === null) {
      return { ok: false, reason: 'block data or position unknown' };
    }
    const entities: EntityPosition[] = this.#world
      .trackedEntities()
      .map(({ x, y, z }) => ({ x, y, z }));
    return checkPlace(world, area, feet, target, item, entities);
  }

  /**
   * PLACE_BLOCK: put ONE allowlisted block the player carries into an empty cell, like a
   * player: hold it (a stack from the main inventory is moved into an empty hotbar slot first
   * when none is in the hotbar), face the plain block placing.ts chose to place it against,
   * click that block's face (C08 with the held stack) and swing the arm. Everything is
   * checked again just before the click. Success needs the server's own change of the cell
   * to the placed block, with nothing else after it; the result reports whether the held
   * stack shrank by one.
   */
  async #place(args: {
    position: BlockPosition;
    item: PlaceableItem;
  }): Promise<ClientActionResult> {
    const blocker = this.#placeBlocker();
    const fence = this.#fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not placing: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED');
    }
    const area: PlaceArea = {
      fence,
      maxHeightAboveFence: this.#opts.config.placing.maxHeightAboveFence,
    };
    const target = args.position;
    const { x, y, z } = target;
    const where = `(${x}, ${y}, ${z})`;
    const block = placedBlockOf(args.item);
    this.#placing = true;
    try {
      // A chest left open by an earlier action is closed first (never with a full cursor):
      // the hotbar is arranged with window-0 clicks.
      if (this.#world.openWindow !== null) {
        const closed = this.#closeOpenWindow();
        if (closed !== null) return failed(`not placing: ${closed.message}`, 'REFUSED');
      }
      const registry = this.#world.registry;
      const item = resolveItemName(registry, args.item);
      const blockId = blockIdOf(registry, block);
      if (item === null || blockId === null) {
        return failed(`not placing: ${args.item} is not in this world's registry`, 'REFUSED');
      }
      const guard = {
        placementsAtStart: this.#confirmedPositions,
        healthAtStart: this.#world.health,
      };
      const check = this.#placeCheck(area, target, args.item, guard);
      if (!check.ok) return failed(`not placing: ${check.reason}`, 'REFUSED');

      const hand = await this.#holdForPlacing(item, args.item);
      if (!hand.ok) return hand.result;
      const moved = hand.moved === null ? '' : ` (${hand.moved})`;

      // Everything again, just before the click: arranging the hotbar took time.
      const final = this.#placeCheck(area, target, args.item, guard);
      if (!final.ok) return failed(`not placing: ${final.reason}${moved}`, 'REFUSED');
      const held = this.#world.playerStorage()?.[27 + hand.slot] ?? null;
      const feet = this.#world.ownPosition;
      if (
        held === null ||
        held.id !== item.id ||
        held.damage !== item.damage ||
        held.hasNbt ||
        feet === null
      ) {
        return failed(`not placing: hotbar slot ${hand.slot} does not hold ${args.item}`, 'ERROR');
      }
      const { clicked, face, cursor } = final.support;
      const clickedName =
        registry?.blocks.get(this.#world.blockAt(clicked.x, clicked.y, clicked.z) ?? -1) ??
        'a block';
      const against = `${clickedName} at (${clicked.x}, ${clicked.y}, ${clicked.z}), face ${face}`;
      const facts = { x, y, z, block, item: args.item, against };

      const clickedWatch = this.#world.watchBlock(clicked.x, clicked.y, clicked.z);
      const cellWatch = this.#world.watchBlock(x, y, z);
      let verdict: { ok: true } | { ok: false; result: ClientActionResult };
      try {
        // Face the point that is clicked, as a player does (others see where the head points).
        const point = {
          x: clicked.x + cursor.x / 16,
          y: clicked.y + cursor.y / 16,
          z: clicked.z + cursor.z / 16,
        };
        const look = lookAt(eyesOf(feet), point);
        this.#send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
        this.#lastYaw = look.yaw;
        this.#log(`placing ${args.item} at ${where} against ${against}`);
        const sent = {
          clicked: clickedWatch.updates.length,
          cell: cellWatch.updates.length,
          clickedId: this.#world.blockAt(clicked.x, clicked.y, clicked.z) ?? -1,
        };
        this.#send(
          outbound.placeBlock(
            clicked.x,
            clicked.y,
            clicked.z,
            face,
            held,
            cursor,
            this.#decoding.itemStackSizeVarInt,
          ),
        );
        // A vanilla client swings the arm once the use went through.
        const self = this.#world.selfEntityId;
        if (self !== null) this.#send(outbound.swingArm(self));
        verdict = await this.#placeVerdict(clickedWatch, cellWatch, sent, blockId, block, where);
      } finally {
        this.#world.unwatch(clickedWatch);
        this.#world.unwatch(cellWatch);
      }

      // The click opened a window: the block was not plain after all. Close it again.
      const opened = this.#world.openWindow;
      if (opened !== null) {
        const closed = this.#closeOpenWindow();
        return failed(
          `clicking ${against} opened a window (type ${opened.inventoryType}) instead of placing` +
            `${closed === null ? '; it was closed again' : `; ${closed.message}`}`,
          'FAILED',
          facts,
        );
      }
      if (!verdict.ok) return verdict.result;

      // The server takes the item and re-sends the held slot (S2F) with one fewer.
      const expected = held.count - 1;
      const count = (): number => this.#world.playerStorage()?.[27 + hand.slot]?.count ?? 0;
      await this.#waitFor(() => count() === expected, PLACE_STACK_TIMEOUT_MS);
      const stackUsed = count() === expected;
      this.#log(`placed ${block} at ${where}; held stack ${held.count} -> ${count()}`);
      return ok(
        `placed ${block} at ${where} against ${against}; ` +
          (stackUsed
            ? `the held ${args.item} went from ${held.count} to ${expected}`
            : `the held ${args.item} did not shrink by one within ${PLACE_STACK_TIMEOUT_MS} ms (${held.count} -> ${count()})`) +
          moved,
        { ...facts, stackUsed, stackBefore: held.count, stackAfter: count() },
      );
    } finally {
      this.#placing = false;
    }
  }

  /**
   * Holds `item` (registry id and damage; never a stack with NBT data) in the selected
   * hotbar slot: the held slot if it holds it, else the first hotbar slot that does, else a
   * stack from the main inventory is moved into the first empty hotbar slot with two
   * confirmed window-0 clicks (pick it up, put it down). Refuses when none can be held.
   */
  async #holdForPlacing(
    item: { id: number; damage: number },
    name: string,
  ): Promise<
    { ok: true; slot: number; moved: string | null } | { ok: false; result: ClientActionResult }
  > {
    const refuse = (reason: string): { ok: false; result: ClientActionResult } => ({
      ok: false,
      result: failed(`not placing: ${reason}`, 'REFUSED'),
    });
    const storage = this.#world.playerStorage();
    if (storage === null) return refuse('the inventory is not known');
    const holds = (s: Stack | null | undefined): boolean =>
      s != null && s.id === item.id && s.damage === item.damage && !s.hasNbt && s.count > 0;
    const hotbar = (j: number): Stack | null => storage[27 + j] ?? null;
    let slot: number | null = holds(hotbar(this.#world.heldSlot)) ? this.#world.heldSlot : null;
    for (let j = 0; slot === null && j < 9; j++) if (holds(hotbar(j))) slot = j;
    let moved: string | null = null;
    if (slot === null) {
      const from = storage.slice(0, 27).findIndex(holds);
      if (from === -1) return refuse(`no ${name} without NBT data in the inventory`);
      const to = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((j) => hotbar(j) === null);
      if (to === undefined) {
        return refuse(`no ${name} in the hotbar, and no empty hotbar slot to move one into`);
      }
      const problem = await this.#moveStackToSlot(9 + from, 36 + to);
      if (problem !== null) {
        return {
          ok: false,
          result: failed(
            `not placing: ${problem}`,
            problem.includes('ITEMS MAY BE ON THE CURSOR') ? 'ERROR' : 'FAILED',
          ),
        };
      }
      slot = to;
      moved = `moved ${name} from inventory slot ${9 + from} to hotbar slot ${to}`;
    }
    if (slot !== this.#world.heldSlot) {
      this.#send(outbound.selectHotbarSlot(slot));
      this.#world.setHeldSlot(slot);
    }
    return { ok: true, slot, moved };
  }

  /**
   * Moves the whole stack in window-0 slot `from` into the EMPTY slot `to` with two confirmed
   * clicks; null on success. A failed click puts the stack back (see #emptyInventoryCursor).
   */
  async #moveStackToSlot(from: number, to: number): Promise<string | null> {
    if (this.#clickTarget()?.windowId !== 0) return 'the inventory cannot be clicked now';
    const take = await this.#click({ slot: from, button: 0 });
    if (take !== 'accepted') {
      return `picking up the stack was ${take}${await this.#emptyInventoryCursor(from)}`;
    }
    const put = await this.#click({ slot: to, button: 0 });
    if (put !== 'accepted') {
      return `putting it into the hotbar was ${put}${await this.#emptyInventoryCursor(from)}`;
    }
    return null;
  }

  /** After a failed window-0 click: whatever is on the cursor goes into an empty player slot. */
  async #emptyInventoryCursor(preferred: number): Promise<string> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const target = this.#clickTarget();
      if (target === null || target.windowId !== 0 || target.window.cursor === null) break;
      const slots = target.window.slots;
      const empty = [preferred, ...Array.from({ length: 36 }, (_, i) => 9 + i)].find(
        (i) => slots[i] === null,
      );
      if (empty === undefined) break;
      await this.#click({ slot: empty, button: 0 });
    }
    const cursor = this.#clickTarget()?.window.cursor ?? null;
    if (cursor !== null) {
      return `; ITEMS MAY BE ON THE CURSOR (${cursor.count} of id ${cursor.id})`;
    }
    return '; nothing was left on the cursor';
  }

  /**
   * After the click the server sends S23 for the clicked block, then for the cell (both as
   * they are after its attempt), and the world's own change follows. As in mineflayer's
   * placeBlock (MIT), the clicked block's update is the acknowledgement: updates for the
   * cell before it are stale, and the first one after it is the server's answer. Waits for
   * both and a quiet PLACE_SETTLE_MS; succeeds only if every cell update after the
   * acknowledgement is the placed block.
   */
  async #placeVerdict(
    clicked: BlockWatch,
    cell: BlockWatch,
    sent: { clicked: number; cell: number; clickedId: number },
    blockId: number,
    block: string,
    where: string,
  ): Promise<{ ok: true } | { ok: false; result: ClientActionResult }> {
    const clock = this.#opts.clock;
    const deadline = clock.now().getTime() + PLACE_OUTCOME_TIMEOUT_MS + PLACE_SETTLE_MS;
    const answers = (): number[] => {
      const ack = clicked.order[sent.clicked];
      if (ack === undefined) return [];
      return cell.updates.filter((_, i) => i >= sent.cell && (cell.order[i] ?? 0) > ack);
    };
    await this.#waitFor(() => answers().length > 0, PLACE_OUTCOME_TIMEOUT_MS);
    let seen = cell.updates.length;
    let quietSince = clock.now().getTime();
    while (answers().length > 0 && clock.now().getTime() < deadline) {
      if (clock.now().getTime() - quietSince >= PLACE_SETTLE_MS) break;
      await delay(TICK_MS);
      if (cell.updates.length !== seen) {
        seen = cell.updates.length;
        quietSince = clock.now().getTime();
      }
    }
    const after = answers();
    const fail = (message: string): { ok: false; result: ClientActionResult } => {
      this.#log(message);
      const now = this.#world.blockAt(cell.x, cell.y, cell.z);
      return {
        ok: false,
        result: failed(message, 'FAILED', {
          x: cell.x,
          y: cell.y,
          z: cell.z,
          block,
          placedNow: now === blockId,
        }),
      };
    };
    if (this.#phase !== 'play') return fail(`the connection closed after the click at ${where}`);
    if (clicked.updates.length <= sent.clicked) {
      return fail(
        `the server did not answer the click within ${PLACE_OUTCOME_TIMEOUT_MS} ms (no update for the clicked block)`,
      );
    }
    if (after.length === 0) {
      return fail(`the server answered the click but sent nothing for ${where}`);
    }
    if (after.some((id) => id !== blockId)) {
      const nameOf = (id: number): string =>
        id === 0
          ? 'minecraft:air'
          : id === -1
            ? 'an unloaded chunk'
            : (this.#world.registry?.blocks.get(id) ?? `block id ${id}`);
      // The server places into the clicked cell itself when that block has become
      // replaceable: the agent's view of it was wrong.
      const ack = clicked.updates[sent.clicked];
      const changed =
        ack !== undefined && ack !== sent.clickedId
          ? `; the clicked block had become ${nameOf(ack)}`
          : '';
      return fail(
        `the server did not place ${block} at ${where} (it sent ${after.slice(0, 4).map(nameOf).join(', ')}${changed}): ` +
          'it refused (something in the way, out of reach, a protected spot, or a mod cancelled ' +
          'it), or the block did not stay',
      );
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Fighting: one ATTACK_ENTITY burst (combat.ts, src/domain/combat.ts)

  /** Why fighting cannot start now, or null. */
  #combatBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.combat.enabled) {
      return { reason: 'combat is disabled (MC_ENABLE_COMBAT)', code: 'NOT_IMPLEMENTED' };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    const area = this.#fence();
    if (area.fence === null) {
      return refused(`${area.problem}: the player and its target stay inside the fence`);
    }
    if (!cfg.presenceTicks) return refused('fighting needs presence ticks (MC_PRESENCE_TICKS)');
    if (this.#haltReason !== null) return refused(`halted: ${this.#haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#walking) return refused('the player is walking');
    if (this.#usingContainer) return refused('a chest or crafting operation is running');
    if (this.#digging) return refused('the player is digging');
    if (this.#placing) return refused('the player is placing a block');
    if (this.#exploring) return refused('the player is exploring');
    if (this.#questBookBusy) return refused('a quest-book action is running');
    if (this.#fighting) return refused('a fight is already in progress');
    return null;
  }

  /** Why this target cannot be engaged (never, not now, or not from here), or null. */
  #targetProblem(entityId: number, fence: Fence): string | null {
    const t = this.#world.combatEntity(entityId, this.#opts.clock.now());
    if (t === null) return `entity ${entityId} is not tracked near the player`;
    const refusal = attackRefusal(t) ?? calmRefusal(t);
    if (refusal !== null) return refusal;
    if (!insideFence(t.position, fence)) return `the ${t.type} is outside the fence`;
    if (t.distance > ENGAGE_RADIUS) {
      return `the ${t.type} is ${t.distance.toFixed(1)} blocks away (engages within ${ENGAGE_RADIUS})`;
    }
    return null;
  }

  /**
   * Why the moment is unsafe for fighting, or null: the entity picture is incomplete, an
   * unidentified entity is within the threat radius, or something that explodes (or might:
   * anything unidentified) is within the scan. Checked before the burst and every tick of it.
   */
  #fightMomentProblem(): string | null {
    const now = this.#opts.clock.now();
    if (!this.#world.entitiesReady(now)) {
      return 'the entities around the player are not fully known';
    }
    const unidentified = this.#world
      .nearbyEntities(this.#opts.config.movement.threatRadius, now)
      .find((e) => e.category === 'unclassified');
    if (unidentified !== undefined) {
      return `unidentified entity ${unidentified.name} ${unidentified.distance.toFixed(1)} blocks away`;
    }
    const explosive = this.#world
      .nearbyEntities(ENTITY_SCAN_RADIUS, now)
      .find(
        (e) =>
          (e.category === 'hostile' || e.category === 'unclassified') &&
          mayExplode(e.name, e.category),
      );
    if (explosive !== undefined) {
      return `${explosive.name} ${explosive.distance.toFixed(1)} blocks away may explode: back off`;
    }
    return null;
  }

  /**
   * ATTACK_ENTITY: engage ONE entity for a bounded burst. The player does not move. It holds
   * the best allowlisted weapon in the hotbar (else an empty hand), and strikes as a player
   * does (C05 look, C0A arm swing, C02 attack) whenever the target is within reach, one full
   * hit per SWING_INTERVAL_TICKS (a mob takes full damage again only 10 ticks after one),
   * until the target dies, MAX_SWINGS_PER_BURST swings, or MAX_BURST_MS. Every tick it stops
   * for: the halt, the stop file, a server correction, a lost connection, ANY damage taken (so
   * System 1 decides again), an unidentified entity or something that may explode nearby, and
   * a target that is gone, out of the fence or out of range. A blow that may kill is held
   * back while the player would not survive GTNH's kill explosion from where it stands.
   * After killing a farm animal it picks up the drops (#collectKillDrops), as a dig does.
   */
  async #attack(entityId: number): Promise<ClientActionResult> {
    const blocker = this.#combatBlocker();
    const fence = this.#fence().fence;
    if (blocker !== null || fence === null) {
      return failed(`not attacking: ${blocker?.reason ?? 'no fence'}`, blocker?.code ?? 'REFUSED');
    }
    const me = this.#world.ownPosition;
    if (me === null) return failed('not attacking: player position unknown', 'REFUSED');
    if (!insideFence(me, fence))
      return failed('not attacking: the player is outside the fence', 'REFUSED');
    const notTarget = this.#targetProblem(entityId, fence);
    if (notTarget !== null) return failed(`not attacking: ${notTarget}`, 'REFUSED');
    const unsafe = this.#fightMomentProblem();
    if (unsafe !== null) return failed(`not attacking: ${unsafe}`, 'REFUSED');

    const itemsBefore = this.#world.inventoryItems();
    let burst: Burst;
    this.#fighting = true;
    try {
      // A window left open by an earlier action is closed first (never with a full cursor).
      if (this.#world.openWindow !== null) {
        const closed = this.#closeOpenWindow();
        if (closed !== null) return failed(`not attacking: ${closed.message}`, 'REFUSED');
      }
      const hotbar = this.#world.hotbar();
      if (hotbar === null) return failed('not attacking: the inventory is not known', 'REFUSED');
      // The best allowlisted weapon in the hotbar, else an empty hand: never anything else
      // (a held item's own left-click code could do anything).
      const choice = chooseWeapon(hotbar, this.#world.heldSlot);
      let slot: number;
      let weapon: Weapon;
      if (choice !== null) {
        slot = choice.slot;
        weapon = choice.weapon;
      } else {
        const hand = this.#emptyHotbarSlot();
        if (hand === null) {
          return failed(
            'not attacking: no allowlisted weapon and no empty hotbar slot to strike with',
            'REFUSED',
          );
        }
        slot = hand;
        weapon = BARE_HAND;
      }
      if (slot !== this.#world.heldSlot) {
        this.#send(outbound.selectHotbarSlot(slot));
        this.#world.setHeldSlot(slot);
      }
      burst = await this.#strikeBurst(entityId, fence, weapon);
    } finally {
      this.#fighting = false;
    }
    const { result, kill } = burst;
    // Hunting: a farm animal's drops are what it was killed for. Never after a fight with a
    // hostile (DEFEND): walking to its drops is no escape.
    if (!result.ok || kill === null || !FARM_ANIMALS.has(kill.type) || itemsBefore === null) {
      return result;
    }
    return this.#collectKillDrops(result, kill.at, itemsBefore, kill.weapon);
  }

  /**
   * One ATTACK_ENTITY burst (see #attack): the action's result and, when the target died,
   * where it last stood (its drops spawn there), its type and the weapon struck with.
   */
  async #strikeBurst(entityId: number, fence: Fence, weapon: Weapon): Promise<Burst> {
    const clock = this.#opts.clock;
    const first = this.#world.combatEntity(entityId);
    if (first === null) {
      return { result: failed('not attacking: the target is gone', 'REFUSED'), kill: null };
    }
    let lastAt: Vec3 = first.position;
    const what = `${first.type} ${entityId}`;
    const startedAt = clock.now().getTime();
    const deadline = startedAt + MAX_BURST_MS;
    // The held item's damage counts only after the server's next player tick (idle ticks run
    // every 50 ms), so the first swing waits two ticks.
    let nextSwingAt = startedAt + 2 * TICK_MS;
    const healthAtStart = this.#world.health;
    const placementsAtStart = this.#confirmedPositions;
    let hurt = first.hurtCount;
    let lastHealth = first.health;
    let swings = 0;
    let heldBack = 0;
    let stop: { reason: string; hard: boolean } | null = null;
    this.#log(`engaging ${what} with ${weapon.item ?? 'a bare hand'} (${weapon.damage} per hit)`);

    while (stop === null) {
      await delay(TICK_MS);
      const now = clock.now().getTime();
      // Hard stops: the operator, the connection, the server moving the player.
      if (this.#phase !== 'play') stop = { reason: 'the connection closed', hard: true };
      else if (this.#haltReason !== null)
        stop = { reason: `halted: ${this.#haltReason}`, hard: true };
      else if (existsSync(resolvePath(this.#opts.config.movement.stopFile))) {
        stop = {
          reason: `the stop file ${this.#opts.config.movement.stopFile} exists`,
          hard: true,
        };
      } else if (this.#confirmedPositions !== placementsAtStart) {
        stop = { reason: this.#corrected(), hard: true };
      }
      if (stop !== null) break;
      const t = this.#world.combatEntity(entityId);
      if (t !== null) {
        hurt = Math.max(hurt, t.hurtCount);
        lastHealth = t.health ?? lastHealth;
        lastAt = t.position;
      }
      const health = this.#world.health;
      if (this.#world.hasDied(entityId) || t?.dead === true) {
        stop = { reason: 'the target died', hard: false };
      } else if (t === null) {
        stop = { reason: 'the target is gone', hard: false };
      } else if (healthAtStart !== null && health !== null && health < healthAtStart) {
        stop = { reason: `the player took ${healthAtStart - health} damage`, hard: false };
      } else {
        const moment = this.#fightMomentProblem();
        const target = moment ?? this.#targetProblem(entityId, fence);
        if (target !== null) stop = { reason: target, hard: false };
        else if (swings >= MAX_SWINGS_PER_BURST && now >= nextSwingAt) {
          stop = { reason: `${swings} swings`, hard: false };
        } else if (now >= deadline) {
          stop = { reason: 'the burst is over', hard: false };
        }
      }
      if (stop !== null || t === null || swings >= MAX_SWINGS_PER_BURST || now < nextSwingAt) {
        continue;
      }
      const feet = this.#world.ownPosition;
      if (feet === null) {
        stop = { reason: 'player position unknown', hard: true };
        continue;
      }
      const eyes = playerEyes(feet);
      const aim = { x: t.position.x, y: t.position.y + eyeHeightOf(t.type), z: t.position.z };
      const world = this.#world.walkWorld();
      const sight = world !== null && lineOfSightClear(world, eyes, aim);
      if (t.distance > strikeReach(weapon, sight)) continue; // wait for it to come within reach
      if (mayKill(t.health, weapon) && !killStrikeAllowed(health ?? 0, t.distance)) {
        // GTNH's AngerMod may blow up what a player kills: not from this close, at this health.
        if (heldBack === 0) {
          this.#log(
            `holding a blow that may kill the ${t.type} ${t.distance.toFixed(1)} blocks away`,
          );
        }
        heldBack += 1;
        continue;
      }
      const look = lookAtPoint(eyes, aim);
      this.#send(outbound.playerLook(look.yaw, look.pitch, ON_GROUND));
      this.#lastYaw = look.yaw;
      const self = this.#world.selfEntityId;
      if (self !== null) this.#send(outbound.swingArm(self));
      this.#send(outbound.attackEntity(entityId));
      swings += 1;
      nextSwingAt = now + SWING_INTERVAL_TICKS * TICK_MS;
    }

    // The answers to the last swing (hurt and death statuses, the new health) take a tick.
    if (swings > 0 && this.#phase === 'play') {
      await this.#waitFor(() => this.#world.hasDied(entityId), 4 * TICK_MS);
      const t = this.#world.combatEntity(entityId);
      if (t !== null) {
        hurt = Math.max(hurt, t.hurtCount);
        lastHealth = t.health ?? lastHealth;
        lastAt = t.position;
      }
    }
    const killed = this.#world.hasDied(entityId);
    const hits = hurt - first.hurtCount;
    const healthNow = this.#world.health;
    const damageTaken =
      healthAtStart !== null && healthNow !== null ? Math.max(0, healthAtStart - healthNow) : null;
    const reason = stop?.reason ?? 'the burst is over';
    const data = {
      entityId,
      target: first.type,
      weapon: weapon.item,
      swings,
      hits,
      kills: killed ? 1 : 0,
      targetHealthBefore: first.health,
      targetHealthAfter: killed ? 0 : lastHealth,
      damageTaken,
      heldBack,
      stopReason: reason.slice(0, 200),
    };
    this.#log(
      `fight with ${what}: ${swings} swing(s), ${hits} hit(s)${killed ? ', killed' : ''}; ${reason}`,
    );
    const summary =
      `${killed ? 'killed' : 'struck'} ${what}: ${swings} swing(s), ${hits} hit(s) seen` +
      `${first.health !== null ? `, health ${first.health} -> ${killed ? 0 : (lastHealth ?? '?')}` : ''}` +
      `${damageTaken !== null && damageTaken > 0 ? `, took ${damageTaken} damage` : ''}; stopped: ${reason}`;
    const kill = killed ? { at: lastAt, type: first.type, weapon: weapon.item } : null;
    if (stop?.hard === true) {
      return { result: craftFailed(`fight stopped: ${summary}`, 'FAILED', data), kill };
    }
    if (hits > 0 || killed) return { result: ok(summary.slice(0, 500), data), kill };
    return { result: craftFailed(`no hit landed on ${what}: ${summary}`, 'FAILED', data), kill };
  }

  /**
   * After killing a farm animal: its drops (raw meat, leather, wool...) spawn where it died,
   * and the player struck from up to 2.2 blocks away with a bare hand (4.5 with an axe), out
   * of the pickup reach (the body's box grown by 1 sideways and 0.5 up and down: the vanilla
   * player's onLivingUpdate). As a dig fetches a drop it cannot reach (#dig), it walks onto the
   * spot the animal died on, or the nearest standable spot beside it, with an ordinary checked
   * walk that stops for threats, then waits for the drops to arrive. The kill stands whatever
   * the walk does; the result says what was picked up.
   */
  async #collectKillDrops(
    result: ClientActionResult,
    at: Vec3,
    itemsBefore: Readonly<Record<string, number>>,
    weapon: string | null,
  ): Promise<ClientActionResult> {
    // A struck weapon wears (its name's @damage changes): that is no drop.
    const isWeapon = (item: string): boolean =>
      weapon !== null && (item === weapon || item.startsWith(`${weapon}@`));
    const gains = (): Array<[string, number]> =>
      this.#gainSince(itemsBefore, null).filter(([item]) => !isWeapon(item));
    const where = `(${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#fence().fence;
    let walked: ClientActionResult | null = null;
    if (world !== null && feet !== null && fence !== null && !withinPickup(feet, at)) {
      const spot = dropSpot(world, fence, at);
      walked =
        spot === null
          ? failed(`no spot a player could stand on at or beside ${where}`, 'REFUSED')
          : await this.#walkTo(spot, { stopForThreats: true });
    }
    if (walked === null || walked.ok) {
      await this.#waitFor(() => gains().length > 0, DROP_WAIT_MS);
      // Several stacks (meat and leather) arrive a tick or two apart.
      if (gains().length > 0) await delay(5 * TICK_MS);
    }
    const gained = gains();
    const drops = describeGain(gained);
    const how =
      walked === null
        ? gained.length > 0
          ? `picked up ${drops}`
          : 'no drop reached the inventory'
        : !walked.ok
          ? `its drops lie at ${where}, but walking there failed: ${walked.message}`
          : gained.length > 0
            ? `walked to the drops at ${where} and picked up ${drops}`
            : `walked to ${where}, but no drop reached the inventory`;
    this.#log(`after the kill: ${how}`);
    return ok(`${result.message}; ${how}`.slice(0, 500), {
      ...result.data,
      dropsCollected: gained.length > 0,
      drops,
      walkedToDrops: walked?.ok ?? false,
    });
  }

  // -------------------------------------------------------------------------
  // The quest book (Better Questing; see better-questing.ts)

  /** Why a quest-book click cannot be made now, or null. */
  #questBookBlocker(): { reason: string; code: 'NOT_IMPLEMENTED' | 'REFUSED' } | null {
    const cfg = this.#opts.config;
    if (!cfg.questBook.enabled) {
      return {
        reason: 'quest-book actions are disabled (MC_ENABLE_QUEST_BOOK)',
        code: 'NOT_IMPLEMENTED',
      };
    }
    const refused = (reason: string) => ({ reason, code: 'REFUSED' as const });
    // The server's quest loop runs on the player's own ticks: without them nothing completes.
    if (!cfg.presenceTicks) {
      return refused('quest-book actions need presence ticks (MC_PRESENCE_TICKS)');
    }
    if (this.#haltReason !== null) return refused(`halted: ${this.#haltReason}`);
    if (existsSync(resolvePath(cfg.movement.stopFile))) {
      return refused(`the stop file ${cfg.movement.stopFile} exists`);
    }
    if (this.#walking || this.#exploring) return refused('the player is walking');
    if (this.#digging) return refused('the player is digging');
    if (this.#placing) return refused('the player is placing a block');
    if (this.#usingContainer) return refused('a chest or crafting operation is running');
    if (this.#fighting) return refused('the player is fighting');
    if (this.#questBookBusy) return refused('a quest-book action is already running');
    return null;
  }

  #sendQuestBook(message: BqOutbound): void {
    for (const p of outbound.questBook(message)) this.#send(p);
  }

  /**
   * SUBMIT_QUEST, CHECK_QUEST_BOX and CLAIM_QUEST_REWARD: the quest book's own clicks, sent
   * only after re-checking the server's quest book as it is now, and judged by the server's
   * next sync (the quest completed, the box ticked, the rewards claimed and in the inventory).
   */
  async #questBookAction(req: QuestBookRequest): Promise<ClientActionResult> {
    const blocker = this.#questBookBlocker();
    if (blocker !== null)
      return failed(`not using the quest book: ${blocker.reason}`, blocker.code);
    const book = this.#world.questBook;
    const problem = questBookRequestProblem(book, this.#opts.questScope ?? [], req);
    if (problem !== null) return failed(`not using the quest book: ${problem}`, 'REFUSED');
    this.#questBookBusy = true;
    try {
      switch (req.kind) {
        case 'submit':
          return await this.#submitQuest(req.questId);
        case 'check':
          return await this.#checkQuestBox(req.questId, req.taskIndex);
        case 'claim':
          return await this.#claimQuest(req.questId, req.choice);
      }
    } finally {
      this.#questBookBusy = false;
    }
  }

  #questTimeout(ms: number): number {
    return this.#opts.questBookTimeoutMs ?? ms;
  }

  #questName(id: string): string {
    return `"${plainText(this.#world.questBook.config(id)?.name ?? id)}"`;
  }

  /** Inventory decreases since `before`, as "2 x minecraft:log". */
  #handedIn(before: Readonly<Record<string, number>> | null): string {
    const now = this.#world.inventoryItems();
    if (before === null || now === null) return '';
    return describeGain(
      Object.entries(before)
        .map(([item, n]): [string, number] => [item, n - (now[item] ?? 0)])
        .filter(([, d]) => d > 0),
    );
  }

  async #submitQuest(id: string): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    const before = this.#world.inventoryItems();
    this.#sendQuestBook({ kind: 'quest-action', action: 'detect', questIds: [id] });
    await this.#waitFor(() => book.completed(id), this.#questTimeout(QUEST_SUBMIT_TIMEOUT_MS));
    const handedIn = this.#handedIn(before);
    if (!book.completed(id)) {
      return failed(
        `the server did not record ${this.#questName(id)} as completed within ` +
          `${this.#questTimeout(QUEST_SUBMIT_TIMEOUT_MS) / 1000} s of the submit (tasks: ${describeQuestTasks(book, id)})` +
          (handedIn === '' ? '' : `; handed in: ${handedIn}`),
        'FAILED',
        { questId: id, handedIn },
      );
    }
    this.#log(`quest book: ${this.#questName(id)} completed after a submit`);
    return ok(
      `submitted ${this.#questName(id)}: the server records it as completed` +
        (handedIn === '' ? '' : ` (handed in ${handedIn})`),
      { questId: id, handedIn },
    );
  }

  async #checkQuestBox(id: string, taskIndex: number): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    this.#sendQuestBook({ kind: 'task-checkbox', questId: id, taskIndex });
    const done = (): boolean => book.taskComplete(id, taskIndex) || book.completed(id);
    await this.#waitFor(done, this.#questTimeout(QUEST_SYNC_TIMEOUT_MS));
    if (!done()) {
      return failed(
        `the server did not record checkbox ${taskIndex} of ${this.#questName(id)} as ticked`,
        'FAILED',
        { questId: id, taskIndex },
      );
    }
    return ok(`ticked checkbox ${taskIndex} of ${this.#questName(id)}`, { questId: id, taskIndex });
  }

  async #claimQuest(id: string, choice: number | null): Promise<ClientActionResult> {
    const book = this.#world.questBook;
    const config = book.config(id);
    const expected = config === null ? 'unknown quest' : claimRewardItems(config, choice);
    if (typeof expected === 'string') {
      return failed(`not claiming ${this.#questName(id)}: ${expected}`, 'REFUSED');
    }
    if (config === null) return failed(`not claiming: unknown quest ${id}`, 'REFUSED');
    // Rewards that do not fit are dropped into the world: refuse without room for them.
    const storage = this.#world.playerStorage();
    if (storage === null) return failed('not claiming: the inventory is not known', 'REFUSED');
    const free = storage.filter((s) => s === null).length;
    const needed = rewardSlotsNeeded([...expected.values()].map((count) => ({ count })));
    if (free < needed) {
      return failed(
        `not claiming ${this.#questName(id)}: its rewards need ${needed} free slots, ${free} are free`,
        'REFUSED',
      );
    }
    const choiceReward = choiceRewardOf(config);
    if (choice !== null && choiceReward !== null && typeof choiceReward !== 'string') {
      const r = choiceReward.index;
      if (book.selection(id, r) !== choice) {
        this.#sendQuestBook({
          kind: 'choice-reward',
          questId: id,
          rewardIndex: r,
          selection: choice,
        });
        await this.#waitFor(
          () => book.selection(id, r) === choice,
          this.#questTimeout(QUEST_CHOICE_TIMEOUT_MS),
        );
        if (book.selection(id, r) !== choice) {
          return failed(
            `the server did not acknowledge choice ${choice} for ${this.#questName(id)}`,
            'FAILED',
            { questId: id },
          );
        }
      }
    }
    const before = this.#world.inventoryItems() ?? {};
    this.#sendQuestBook({ kind: 'quest-action', action: 'claim', questIds: [id] });
    await this.#waitFor(() => book.claimed(id), this.#questTimeout(QUEST_SYNC_TIMEOUT_MS));
    if (!book.claimed(id)) {
      return failed(
        `the server did not record the rewards of ${this.#questName(id)} as claimed`,
        'FAILED',
        { questId: id },
      );
    }
    // The items arrive as slot updates (usually before the sync): wait for all of them.
    const gains = (): Array<[string, number]> => {
      const now = this.#world.inventoryItems() ?? {};
      return [...new Set([...Object.keys(now), ...expected.keys()])]
        .map((item): [string, number] => [item, (now[item] ?? 0) - (before[item] ?? 0)])
        .filter(([, d]) => d !== 0);
    };
    const complete = (): boolean =>
      [...expected].every(([item, n]) => gains().some(([g, d]) => g === item && d >= n));
    await this.#waitFor(complete, this.#questTimeout(QUEST_REWARD_ITEMS_TIMEOUT_MS));
    const gained = describeGain(gains());
    this.#log(`quest book: claimed ${this.#questName(id)}: ${gained || 'no items'}`);
    return ok(`claimed the rewards of ${this.#questName(id)}: ${gained || 'no items'}`, {
      questId: id,
      gained,
    });
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

  /**
   * EAT_FOOD, as a player eats: the food into a hotbar slot (moved there from the main
   * inventory if need be) and into the hand, then "use the held item in the air" (C08, face
   * 255), standing still while the server counts the eating down (32 ticks in vanilla; mods may
   * take longer), until the stack shrinks. Seen live: the agent had an apple, hunger fell, and
   * EAT_FOOD was not implemented, so every EAT failed until the repeated-failure rule stopped it.
   */
  async #eat(item: string): Promise<ClientActionResult> {
    const refuse = (why: string, code: 'REFUSED' | 'FAILED' | 'ERROR' = 'REFUSED') =>
      failed(`not eating: ${why}`.slice(0, 500), code);
    if (this.#phase !== 'play') return refuse('not connected', 'ERROR');
    if (!this.#opts.config.eating.enabled) {
      return failed('eating is disabled (MC_ENABLE_EATING)', 'NOT_IMPLEMENTED');
    }
    if (this.#walking || this.#exploring) return refuse('a walk is in progress');
    if (this.#digging || this.#placing || this.#fighting || this.#eating) {
      return refuse('the hand is busy (digging, placing, fighting or eating)');
    }
    if (this.#usingContainer || this.#world.openWindow !== null) return refuse('a window is open');
    const food = this.#world.food;
    if (food === null) return refuse('the food level is not known yet');
    if (food >= 20) return refuse('the player is not hungry (food 20)');
    const registry = this.#world.registry;
    const storage = this.#world.playerStorage();
    if (registry === null || storage === null) return refuse('the inventory is not known yet');
    // The held slot first, then the rest of the hotbar, then the main inventory.
    const heldIndex = 27 + this.#world.heldSlot;
    const order = [heldIndex];
    for (let i = 27; i < 36; i++) if (i !== heldIndex) order.push(i);
    for (let i = 0; i < 27; i++) order.push(i);
    const index = order.find((i) => {
      const s = storage[i];
      if (s == null || s.hasNbt) return false;
      const naming = nameItemStack(registry, s.id, s.damage);
      return naming.ok && naming.name === item;
    });
    if (index === undefined) return refuse(`no ${item} in the inventory`);
    let slot = index - 27;
    if (index < 27) {
      const free = this.#emptyHotbarSlot();
      if (free === null)
        return refuse(`the ${item} is not in the hotbar, and no hotbar slot is free`);
      const moved = await this.#moveToHotbar(9 + index, free, storage[index] as Stack);
      if (moved !== null) {
        return refuse(
          `the ${item} could not be moved into the hotbar: ${moved}`,
          moved.startsWith('ITEMS MAY') ? 'ERROR' : 'FAILED',
        );
      }
      slot = free;
    }
    // GTNH's AngerMod protects a player after each join (angermod.cfg ProtectionEnabled:
    // invulnerable for up to 90 s, until it walks 5 blocks, attacks or right-clicks a block),
    // and EntityPlayer.canEat() is false while it is: the server answers the use with the
    // inventory as it was, and nothing is eaten (seen live: every EAT right after joining
    // failed). A click in the air does not end it; a click on a block does, as for a player
    // whose right-click with food in hand first lands on the ground.
    if (this.#world.damageDisabled === true) {
      const still = await this.#endSpawnProtection();
      if (still !== null) return refuse(still);
    }
    // Always (re)select it: the server eats what it thinks is in hand.
    this.#send(outbound.selectHotbarSlot(slot));
    this.#world.setHeldSlot(slot);
    const held = this.#hotbar(slot);
    if (held == null) return refuse(`the ${item} left the hotbar`, 'FAILED');
    const before = held.count;
    this.#eating = true;
    try {
      this.#log(`eating ${item} (food ${food})`);
      this.#send(
        outbound.useHeldItem(
          { id: held.id, damage: held.damage, count: held.count, hasNbt: false },
          this.#decoding.itemStackSizeVarInt,
        ),
      );
      // The server finishes eating on its own after the use time, and sends the slot.
      await this.#waitFor(() => {
        const now = this.#hotbar(slot);
        return now == null || now.id !== held.id || now.count < before;
      }, EAT_TIMEOUT_MS);
      const now = this.#hotbar(slot);
      const ate = now == null || now.id !== held.id || now.count < before;
      if (!ate) {
        return failed(
          `not eaten: the server did not finish eating the ${item} within ${EAT_TIMEOUT_MS / 1000} s`,
          'FAILED',
        );
      }
      // The food level comes in its own packet, a tick or so after the slot.
      await this.#waitFor(() => (this.#world.food ?? 0) > food, 1_000);
      const after = this.#world.food;
      return ok(`ate 1 x ${item}: food ${food} -> ${after ?? 'unknown'}`, {
        foodBefore: food,
        foodAfter: after,
      });
    } finally {
      this.#eating = false;
    }
  }

  /**
   * Ends the server's spawn protection (see #eat) with a right-click on the plain ground
   * underfoot with an empty hand, which uses, places and opens nothing. Null once it has
   * ended, else why it is still on.
   */
  async #endSpawnProtection(): Promise<string | null> {
    const on =
      'the server still protects the player after it joined (a protected player cannot eat; ' +
      'it ends after 90 s or a 5-block walk)';
    const feet = this.#world.ownPosition;
    const registry = this.#world.registry;
    if (feet === null || registry === null) return `${on}, and the ground underfoot is not known`;
    // The first block below the feet: the server may have put the player a little above the
    // ground at login (seen live: saved mid-jump, at y 92.42 over sand at 91).
    const x = Math.floor(feet.x);
    const z = Math.floor(feet.z);
    let y = Math.floor(feet.y - 0.01);
    let id = this.#world.blockAt(x, y, z);
    while (id === 0 && y > Math.floor(feet.y) - 3) id = this.#world.blockAt(x, --y, z);
    const ground =
      id === undefined ? undefined : id === 0 ? 'minecraft:air' : registry.blocks.get(id);
    if (ground === undefined || !PLAIN_GROUND.has(ground)) {
      return `${on}, and the block underfoot (${ground ?? 'unknown'}) is not plain ground to click`;
    }
    const hand = this.#emptyHotbarSlot();
    if (hand === null) return `${on}, and no hotbar slot is empty to click the ground with`;
    if (hand !== this.#world.heldSlot) {
      this.#send(outbound.selectHotbarSlot(hand));
      this.#world.setHeldSlot(hand);
    }
    this.#log(`clicking the ${ground} underfoot with an empty hand: it ends the spawn protection`);
    this.#send(outbound.activateBlock(x, y, z, 1));
    await this.#waitFor(() => this.#world.damageDisabled === false, 1_000);
    return this.#world.damageDisabled === false
      ? null
      : `${on}: a click on the ground did not end it`;
  }

  /** Stops a walk in progress at its next step and refuses new walks (e.g. on Ctrl+C). */
  halt(reason: string): void {
    this.#haltReason = reason;
  }

  /**
   * Plans a walk without moving (for previews and dry runs), with a text map of the fence.
   * Works whether or not movement is enabled; null when no fence is configured. With
   * `breakLeaves` it plans as MOVE_TO does (#walkBreaks).
   */
  previewWalk(
    target: Position | null,
    breakLeaves = false,
  ): { plan: WalkPlan | null; map: string[] } | null {
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
      const breaks = breakLeaves ? this.#walkBreaks(fence) : undefined;
      const t =
        target === null
          ? null
          : planTerrainWalk(world, fence, from, target, m.maxPathLength, breaks);
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
    const entities = this.#world.nearbyEntities(64, this.#opts.clock.now()).map((e) => ({
      id: e.entityId,
      threat: (e.category === 'hostile' && !e.calm) || e.category === 'unclassified',
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
    if (this.#fighting) return 'the player is fighting';
    if (this.#digging) return 'the player is digging';
    if (this.#placing) return 'the player is placing a block';
    if (this.#eating) return 'the player is eating';
    // Walking away closes an open window server-side, which drops the cursor and a table's grid.
    if (this.#world.openWindow?.cursor != null || this.#leftovers() !== null) {
      return 'items are on the cursor or in a crafting grid';
    }
    return null;
  }

  /**
   * The leaves a terrain walk may break on its way (digging.ts walkBreaks), or undefined:
   * only with digging enabled (and presence ticks, which digging needs), on a fence with a
   * height range, and with an empty hotbar slot to break them with (no allowlisted tool is
   * faster on leaves, so the hand is empty; without one every break would be refused).
   * #withWorkAreas offers stand spots with it and MOVE_TO plans with it, so a stand spot a
   * walk reaches by breaking leaves is one a MOVE_TO plans to the same way.
   */
  #walkBreaks(fence: Fence): WalkBreaks | undefined {
    const cfg = this.#opts.config;
    if (!cfg.digging.enabled || !cfg.presenceTicks || fence.min.y === fence.max.y) {
      return undefined;
    }
    if (this.#emptyHotbarSlot() === null) return undefined;
    return walkBreaks(
      { fence, maxHeightAboveFence: cfg.digging.maxHeightAboveFence },
      this.#opts.explorationBoundary ?? null,
    );
  }

  async #walkTo(
    target: Readonly<Position> | null,
    options: {
      stopForThreats: boolean;
      /** MOVE_TO: over terrain, with digging enabled, break leaves in the way (#walkBreaks). */
      breakLeaves?: boolean;
      /** Never held for a break (the validated action's protected items). */
      protectedItems?: ReadonlySet<string>;
    },
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
    // The steps, move by move, each with what to break before it (terrain walks only).
    let moves: Array<{ breaks: readonly BlockPosition[]; steps: TerrainStep[] }>;
    let length: number;
    if (terrain) {
      const breaks = options.breakLeaves === true ? this.#walkBreaks(fence) : undefined;
      const plan = planTerrainWalk(world, fence, from, target, m.maxPathLength, breaks);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      let end = from;
      moves = plan.moves.map((move) => {
        const steps = terrainSteps(end, [move]);
        end = move.to;
        return { breaks: move.breaks ?? [], steps };
      });
      length = plan.length;
      const kinds = plan.moves.map((x) => x.kind);
      const toBreak = moves.reduce((n, mv) => n + mv.breaks.length, 0);
      this.#log(
        `walking ${length.toFixed(2)} blocks over terrain in ${moves.reduce((n, mv) => n + mv.steps.length, 0)} steps ` +
          `(${kinds.filter((k) => k === 'step-up').length} up, ${kinds.filter((k) => k === 'drop').length} down)` +
          (toBreak > 0 ? `, breaking ${toBreak} block(s) on the way` : ''),
      );
    } else {
      const plan = planWalk(world, fence, from, target, m.maxPathLength);
      if (!plan.ok) return failed(`not walking: ${plan.reason}`, 'REFUSED');
      const steps = stepsAlong(plan.waypoints).map((pos) => ({ pos, onGround: true }));
      moves = [{ breaks: [], steps }];
      length = plan.length;
      this.#log(
        `walking ${length.toFixed(2)} blocks in ${steps.length} steps (${plan.waypoints.length - 1} stretch(es))`,
      );
    }
    const steps = moves.flatMap((mv) => mv.steps);
    const guard = {
      placementsAtStart: this.#confirmedPositions,
      // An escape (threats do not stop it) keeps going when hit, too (seen live: a retreat
      // from a skeleton stopped at its first arrow, and the next walk led back into range).
      healthAtStart: options.stopForThreats ? this.#world.health : null,
      stopForThreats: options.stopForThreats,
      terrain,
    };
    // What it broke on its way, when it broke the last one, and the inventory before the
    // walk: what the leaves dropped (a sapling, an apple) is reported with the walk.
    const broken: BlockPosition[] = [];
    let lastBreakAt: number | null = null;
    const itemsBefore = moves.some((mv) => mv.breaks.length > 0)
      ? this.#world.inventoryItems()
      : null;
    let at: Vec3 = from;
    let taken = 0;
    const stopped = (reason: string): ClientActionResult => {
      const where = this.#world.ownPosition ?? at;
      this.#log(`walk stopped after ${taken}/${steps.length} steps: ${reason}`);
      return failed(
        (
          `walk stopped after ${taken} of ${steps.length} steps: ${reason}` +
          (broken.length === 0 ? '' : `; it broke ${describeBroken(broken)}`)
        ).slice(0, 500),
        'FAILED',
        {
          stepsTaken: taken,
          stepsPlanned: steps.length,
          x: where.x,
          y: where.y,
          z: where.z,
          ...(broken.length === 0 ? {} : { broken: broken.length }),
        },
      );
    };

    this.#walking = true;
    this.#stopIdle();
    try {
      for (const move of moves) {
        if (move.breaks.length > 0) {
          const before = broken.length;
          const problem = await this.#breakOnTheWay(
            move.breaks,
            fence,
            guard,
            options.protectedItems ?? new Set(),
            broken,
          );
          if (broken.length > before) lastBreakAt = this.#opts.clock.now().getTime();
          if (problem !== null) return stopped(problem);
        }
        for (const step of move.steps) {
          const next = step.pos;
          const reason = this.#stepProblem(world, fence, at, next, guard);
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
      }
      // A correction (S08) or a kick arrives within a few ticks of a move the server rejects.
      // After breaks it also stays until what they dropped could be picked up.
      const until = lastBreakAt === null ? 0 : lastBreakAt + BREAK_DROP_WAIT_MS;
      for (let i = 0; i < SETTLE_TICKS || this.#opts.clock.now().getTime() < until; i++) {
        if (this.#phase !== 'play') return stopped('the connection closed');
        if (this.#confirmedPositions !== guard.placementsAtStart) {
          return stopped('the server corrected the final position');
        }
        this.#send(outbound.playerIdle(ON_GROUND));
        await delay(WALK_TICK_MS);
      }
      if (this.#phase !== 'play') return stopped('the connection closed');
      if (this.#confirmedPositions !== guard.placementsAtStart) {
        return stopped('the server corrected the final position');
      }
      const gained =
        itemsBefore === null || broken.length === 0 ? [] : this.#gainSince(itemsBefore, null);
      const drops = describeGain(gained);
      return ok(
        (
          `walked ${length.toFixed(2)} blocks in ${steps.length} steps` +
          (broken.length === 0 ? '' : `; broke ${describeBroken(broken)}`) +
          (gained.length === 0 ? '' : `; picked up ${drops}`)
        ).slice(0, 500),
        {
          steps: steps.length,
          distance: Number(length.toFixed(3)),
          x: at.x,
          y: at.y,
          z: at.z,
          ...(broken.length === 0 ? {} : { broken: broken.length, drops }),
        },
      );
    } finally {
      this.#walking = false;
      if (this.#phase === 'play') this.#startIdle();
    }
  }

  /**
   * Breaks what a terrain walk's next move needs out of its way (planned by planTerrainWalk
   * with #walkBreaks: leaves only), standing where the walk has got to, exactly as DIG_BLOCK
   * digs (#digChecked): checkWalkBreak (checkDig's rules, leaves only, inside the safety
   * boundary) on the blocks the server sent just before each dig and every tick while
   * digging, with the walk's own guard; the dig time; C07 start and finish; success only on
   * the server's change to air with no re-send. The walk's checks come first
   * (#walkInterruption: the stop file, halt(), a correction, health, threats), and presence
   * ticks go on while the player stands and digs. A cell that is open already (a leaf
   * decayed) is passed over. Null when the way is open, else why the walk must stop;
   * `broken` collects what it broke.
   */
  async #breakOnTheWay(
    cells: readonly BlockPosition[],
    fence: Fence,
    guard: { placementsAtStart: number; healthAtStart: number | null; stopForThreats: boolean },
    protectedItems: ReadonlySet<string>,
    broken: BlockPosition[],
  ): Promise<string | null> {
    const cfg = this.#opts.config;
    const area: DigArea = { fence, maxHeightAboveFence: cfg.digging.maxHeightAboveFence };
    const boundary = this.#opts.explorationBoundary ?? null;
    for (const cell of cells) {
      const where = `(${cell.x}, ${cell.y}, ${cell.z})`;
      if (!cfg.digging.enabled) return 'digging is disabled (MC_ENABLE_DIGGING)';
      const interrupted = this.#walkInterruption(guard);
      if (interrupted !== null) return interrupted;
      const world = this.#world.walkWorld();
      if (world === null) return 'the block data became unknown';
      if (passProblem(world, cell.x, cell.y, cell.z) === null) continue;
      this.#digging = true;
      // The player stands while it digs: presence ticks go on, as for any dig.
      const presence = setInterval(() => this.#send(outbound.playerIdle(ON_GROUND)), IDLE_TICK_MS);
      try {
        const rule = (w: WalkWorld, feet: Vec3): DigCheck =>
          checkWalkBreak(w, area, feet, cell, boundary);
        const dug = await this.#digChecked(cell, rule, protectedItems, 'digging', guard);
        if (!dug.ok) {
          // A leaf that decayed while it was dug (its log was just chopped) is out of the way
          // all the same (seen live: "the server sent the block again while digging (id 0)").
          const now = this.#world.walkWorld();
          if (now !== null && passProblem(now, cell.x, cell.y, cell.z) === null) continue;
          return `breaking ${where} out of the way failed: ${dug.result.message}`;
        }
        broken.push({ x: cell.x, y: cell.y, z: cell.z });
        this.#log(`broke the ${dug.check.block} at ${where} out of the way`);
      } finally {
        clearInterval(presence);
        this.#digging = false;
      }
    }
    return null;
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
    const interrupted = this.#walkInterruption(guard, { from, to });
    if (interrupted !== null) return interrupted;
    // Terrain steps change height (steps up, drops), so check the body where it will be,
    // at that height; the flat walker checks the whole swept stretch.
    const problem = guard.terrain
      ? bodyProblem(world, fence, to)
      : segmentProblem(world, fence, from, to);
    return problem === null ? null : `the way ahead is not clear: ${problem}`;
  }

  /**
   * Why a walk must stop now, whatever the way ahead, or null; checked before every step and
   * every block it breaks on its way: the connection, anything that blocks walking (the stop
   * file, halt()...), a server correction or a health drop since it started, and with
   * `stopForThreats` a hostile (not a calm spider) or unidentified entity within threatRadius.
   */
  #walkInterruption(
    guard: {
      placementsAtStart: number;
      healthAtStart: number | null;
      stopForThreats: boolean;
    },
    step?: { from: Vec3; to: Vec3 },
  ): string | null {
    if (this.#phase !== 'play') return 'the connection closed';
    const blocker = this.#movementBlocker();
    if (blocker !== null) return blocker;
    if (this.#confirmedPositions !== guard.placementsAtStart) return this.#corrected();
    const health = this.#world.health;
    if (
      !this.#starving() &&
      guard.healthAtStart !== null &&
      health !== null &&
      health < guard.healthAtStart
    ) {
      return `health dropped from ${guard.healthAtStart} to ${health}`;
    }
    if (guard.stopForThreats) {
      const now = this.#opts.clock.now();
      if (!this.#world.entitiesReady(now)) {
        return 'the entities around the player are not fully known';
      }
      const radius = this.#opts.config.movement.threatRadius;
      // A step that takes the player away from a threat that is not close goes on: a person
      // walks on away from a creeper nine blocks behind (seen live: a concussion creeper
      // standing 10 blocks from the way to the gravel stopped every walk there, even the
      // walks away from it). Close, or a step toward it, stops the walk.
      const away = (e: { position: { x: number; z: number } }): boolean =>
        step !== undefined &&
        Math.hypot(e.position.x - step.to.x, e.position.z - step.to.z) >
          Math.hypot(e.position.x - step.from.x, e.position.z - step.from.z);
      const threat = this.#world
        .nearbyEntities(radius, now)
        .find(
          (e) =>
            ((e.category === 'hostile' && !e.calm) || e.category === 'unclassified') &&
            (e.distance <= CLOSE_THREAT_RADIUS || !away(e)),
        );
      if (threat !== undefined) {
        return `${threat.category} entity ${threat.name} ${threat.distance.toFixed(1)} blocks away`;
      }
    }
    return null;
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
      if (!choice.ok) {
        // When a hop as long as the walker allows would get closer, what was left of
        // maxDistance was too short, not the way: no dead end (seen live: nearly every EXPLORE
        // ended "no way further" a few blocks short of 64, each remembered as a dead end).
        const full = this.#opts.config.movement.maxPathLength;
        if (maxLength < full && chooseHop(world, fence, here, goal, full, tried).ok) {
          return done(
            `walked nearly the whole maxDistance (${walked.toFixed(1)} of ${opts.maxDistance} blocks)`,
            true,
          );
        }
        return done(`no way further: ${choice.reason}`, true);
      }
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
    const follow =
      target !== null && fence !== null && this.#opts.config.movement.mode === 'follow';
    const far = follow && !fenceHolds(fence, target);
    if (!far || this.#movementBlocker() !== null || this.#walking || this.#exploring) {
      const walk = await this.#walkTo(target, { stopForThreats: false });
      // A path longer than one walk may take is walked in hops too, like a far location (seen
      // live: 49 blocks around a slope with the limit at 32, refused twice, play stopped).
      const tooLong = /the path is [\d.]+ blocks long|inside the fence within \d+ blocks/;
      if (walk.ok || !follow || !tooLong.test(walk.message)) return walk;
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
    if (last.ok) return ok(message, data);
    // No way on to the safe location from here, and a threat near: away from it instead.
    const fled = await this.#flee();
    if (fled !== null) return failed(`${message}; ${fled}`.slice(0, 500), 'FAILED', data);
    return failed(message, last.code === 'OK' ? 'FAILED' : last.code, data);
  }

  /**
   * Flees from the threats near (hostile, not a calm spider, or unidentified) when a retreat
   * cannot get on to its safe location: to the reachable spot (a walk of at most
   * FLEE_MAX_PATH within the play area) farthest from the nearest of them, and farther than
   * the player is now, as an escape walk (threats do not stop it). Seen live: a fishing
   * zombie 2.3 blocks off and a husk 11, the trail too close to them, home 90 blocks back
   * over a cliff: the retreat home failed four times on the spot, and play stopped. Says
   * where it went, or null when there was no threat near or nowhere farther from them.
   */
  async #flee(): Promise<string | null> {
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#fence().fence;
    if (world === null || feet === null || fence === null || this.#movementBlocker() !== null) {
      return null;
    }
    const threats = this.#world
      .nearbyEntities(this.#opts.config.movement.threatRadius, this.#opts.clock.now())
      .filter((e) => (e.category === 'hostile' && !e.calm) || e.category === 'unclassified');
    if (threats.length === 0) return null;
    const away = (x: number, z: number): number =>
      Math.min(...threats.map((e) => Math.hypot(e.position.x - x, e.position.z - z)));
    const now = away(feet.x, feet.z);
    let best: { x: number; y: number; z: number; score: number } | null = null;
    for (const n of reachableFeet(world, fence, feet, FLEE_MAX_PATH).values()) {
      const far = away(n.x + 0.5, n.z + 0.5);
      if (far < now + FLEE_MIN_GAIN) continue;
      // Farthest from them first; of two about as far, the shorter walk.
      const score = far - FLEE_WALK_WEIGHT * n.length;
      if (best === null || score > best.score) best = { x: n.x + 0.5, y: n.y, z: n.z + 0.5, score };
    }
    if (best === null) return null;
    const spot = { x: best.x, y: best.y, z: best.z };
    const walk = await this.#walkTo(spot, { stopForThreats: false });
    const where = `(${spot.x}, ${spot.y}, ${spot.z})`;
    return walk.ok
      ? `fled instead to ${where}, ${away(spot.x, spot.z).toFixed(1)} blocks from the nearest threat (it was ${now.toFixed(1)})`
      : `fleeing to ${where} failed: ${walk.message}`;
  }

  #startIdle(): void {
    if (this.#idleTimer !== null || this.#walking) return;
    this.#idleTimer = setInterval(() => {
      this.#send(outbound.playerIdle(ON_GROUND));
      this.#idleTicks += 1;
      if (this.#idleTicks % SUPPORT_CHECK_TICKS === 0) void this.#keepSupported();
    }, IDLE_TICK_MS);
  }

  /**
   * Gravity, which this client does not otherwise simulate. When nothing holds the player up
   * (a walk stopped between a jump's or a drop's steps, the ground fell away, or the server
   * put it in the air at login), it falls onto the block below as a game client would: the
   * server kicks a player that floats for 4 seconds ("Flying is not enabled on this server").
   * Only when walking is allowed and nothing else runs, only within the fence, and only a fall
   * of at most MAX_SAFE_FALL blocks (no damage) onto a spot with no hazard next to it;
   * otherwise it logs why and stays (a kick is harmless, a bad fall is not).
   */
  async #keepSupported(): Promise<void> {
    if (this.#phase !== 'play' || this.#walking || this.#exploring) return;
    if (this.#digging || this.#placing || this.#fighting || this.#questBookBusy) return;
    if (this.#movementBlocker() !== null) return;
    const world = this.#world.walkWorld();
    const feet = this.#world.ownPosition;
    const fence = this.#fence().fence;
    if (world === null || feet === null || fence === null) return;
    const support = checkSupport(world, feet);
    if (support.kind === 'unknown') return;
    // Held up for the server, the feet may still hang a little above the ground: they come
    // to rest on it, as in a game client (restingY).
    const resting = support.kind === 'supported' ? restingY(world, feet) : null;
    if (support.kind === 'supported' && resting === null) {
      this.#floatingNote = null;
      return;
    }
    const note = (why: string): void => {
      if (this.#floatingNote === why) return;
      this.#floatingNote = why;
      this.#log(
        `in the air at (${feet.x}, ${feet.y.toFixed(2)}, ${feet.z}) and not falling: ${why}`,
      );
    };
    const landY = support.kind === 'floating' ? support.landY : resting;
    if (landY === null || feet.y - landY > MAX_SAFE_FALL) {
      note(`no floor within ${MAX_SAFE_FALL} blocks below`);
      return;
    }
    const landing = { x: feet.x, y: landY, z: feet.z };
    if (!fenceHolds(fence, landing)) {
      note('the floor below is outside the fence');
      return;
    }
    const hazard = landingHazard(world, Math.floor(feet.x), landY, Math.floor(feet.z));
    if (hazard !== null) {
      note(`the floor below is ${hazard}`);
      return;
    }
    // Falling is a walk of its own: nothing else may start meanwhile.
    this.#walking = true;
    this.#stopIdle();
    try {
      const fallen = fallDistances(feet.y - landY);
      for (const [i, d] of fallen.entries()) {
        const pos = { x: feet.x, y: i === fallen.length - 1 ? landY : feet.y - d, z: feet.z };
        this.#send(
          outbound.playerMove(
            { x: pos.x, feetY: pos.y, z: pos.z, yaw: this.#lastYaw, pitch: 0 },
            i === fallen.length - 1,
          ),
        );
        this.#world.setOwnPosition(pos);
        await delay(WALK_TICK_MS);
      }
      this.#floatingNote = null;
      this.#log(`fell ${(feet.y - landY).toFixed(2)} blocks onto the ground at y=${landY}`);
    } finally {
      this.#walking = false;
      if (this.#phase === 'play') this.#startIdle();
    }
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
          // Better Questing keys this player's progress by this UUID (GameProfile id).
          this.#world.questBook.setPlayer(packet.uuid);
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
    if (packet.type === 'server-position') this.#noteCorrection(packet);
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
      case 'update-health':
        if (packet.health <= 0) this.#onDeath();
        else this.#respawnAsked = false;
        break;
      case 'open-window':
      case 'close-window':
      case 'window-property':
      case 'join-game':
      case 'chat':
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
    if (channel === BQ_CHANNEL) {
      this.#onQuestBookMessage(data);
      return;
    }
    if (channel === 'FML') {
      // Forge runtime messages: this is how GTNH's modded mobs are spawned and moved.
      try {
        this.#world.applyFml(decodeFmlRuntimeMessage(data, this.#decoding), this.#opts.clock.now());
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
        for (const p of outbound.questBook({ kind: 'main-sync-reply' })) this.#send(p);
        this.#log('quest book: answered main_sync; waiting for the quest database');
      }
      if (message.type === 'quest-sync' && !message.merge) {
        this.#log(`quest book: ${message.entries.length} quests from the server`);
      }
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      this.#log(`could not decode a Better Questing message: ${error.message}`);
      this.#world.markQuestBookProblem(`undecodable Better Questing message: ${error.message}`);
    }
  }

  /**
   * Acknowledge the server's placement (exact echo) and start idle ticks, if presence is
   * enabled. A placement during a walk stops the walk (its step check sees the count change).
   */
  /**
   * A server position packet (S08) moves the player: at login, on a teleport, or to correct a
   * move the server did not accept. Where it put the player, against where the client had it,
   * goes into the reason a walk or a dig stops (seen live: a retreat stopped with only "the
   * server corrected the position", and nothing said where).
   */
  #noteCorrection(to: ServerPosition): void {
    const was = this.#world.ownPosition;
    if (was === null) {
      this.#lastCorrection = null;
      return;
    }
    const feetY = to.eyeY - PLAYER_EYE_HEIGHT;
    const at = (x: number, y: number, z: number) =>
      `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
    const moved = Math.hypot(to.x - was.x, feetY - was.y, to.z - was.z);
    this.#lastCorrection =
      `to ${at(to.x, feetY, to.z)}, ${moved.toFixed(2)} blocks from where the client had it ` +
      at(was.x, was.y, was.z);
    this.#log(`the server moved the player ${this.#lastCorrection}`);
  }

  /**
   * The food bar is empty: the server takes health every few seconds (on Hard, with
   * HungerOverhaul's damageOnStarve, until the player dies), so a drop in health is hunger,
   * and a walk or a dig that stopped for each would never reach food (seen live: the food
   * trip's walks stopped after 34 and 104 steps, "health dropped"). Threats still stop them
   * (stopForThreats, the dig's own entity check), as do the agent loop's dangers.
   */
  #starving(): boolean {
    return this.#world.food === 0;
  }

  /** The stop reason for a server correction, with where it put the player (#noteCorrection). */
  #corrected(): string {
    return this.#lastCorrection === null
      ? 'the server corrected the position'
      : `the server corrected the position ${this.#lastCorrection}`;
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
    this.#log(
      `THE PLAYER DIED${at === null ? '' : ` at (${at.x.toFixed(1)}, ${at.y.toFixed(1)}, ${at.z.toFixed(1)})`}` +
        ` (food ${this.#world.food ?? 'unknown'}): asking the server to respawn it`,
    );
    const timer = setTimeout(() => {
      if (this.#phase === 'play') this.#send(outbound.respawn());
    }, RESPAWN_DELAY_MS);
    timer.unref();
  }

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
