import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Gtnh1710Client, type ConnectionInfo } from '../bot/gtnh1710/gtnh-client.ts';
import type { HazardScan } from '../bot/gtnh1710/hazard-scan.ts';
import type { MachineFlags } from '../bot/gtnh1710/gregtech.ts';
import type { NearbyEntity, TrackedMachine } from '../bot/gtnh1710/world-model.ts';
import type { WalkPlan } from '../bot/gtnh1710/walking.ts';
import type { AgentConfig } from '../config/env.ts';
import type { ActionSpec } from '../domain/actions.ts';
import type { PlaceableItem } from '../domain/blocks.ts';
import type { BlockPosition, Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { AGE0_QUESTS } from '../goals/age0-quests.ts';
import { openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../system1/decision-provider.ts';
import { systemClock } from '../util/clock.ts';
import { randomIds } from '../util/ids.ts';
import {
  buildSafetyContext,
  runSingleCycle,
  runUserAction,
  syncConfigToDatabase,
  type CycleResult,
} from './agent-loop.ts';
import { runSession, type SessionLimits, type SessionResult } from './live-session.ts';
import { createProviders } from './providers.ts';

/**
 * Connects the READ-ONLY GTNH client, runs `fn`, and always disconnects afterwards.
 * All connection guards (live flag, identity marker, private host, server identity)
 * are enforced inside Gtnh1710Client.connect().
 */
export async function withLiveClient<T>(
  config: AgentConfig,
  fn: (client: Gtnh1710Client) => Promise<T>,
  log?: (line: string) => void,
): Promise<T> {
  const client = new Gtnh1710Client({
    config: config.minecraft,
    clock: systemClock,
    // GameState.questBook lists the Age 0 quests and their prerequisites (the quest goals).
    questScope: AGE0_QUESTS.map((q) => q.id),
    ...(log ? { log } : {}),
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/** Which GameState fields are unknown, and why. */
export function unknownFields(state: GameState): Record<string, string> {
  const out: Record<string, string> = {};
  const check = (name: string, k: { known: boolean; reason?: string }): void => {
    if (!k.known) out[name] = k.reason ?? 'unknown';
  };
  check('player.position', state.player.position);
  check('player.dimension', state.player.dimension);
  check('player.health', state.player.health);
  check('player.hunger', state.player.hunger);
  check('player.armor', state.player.armor);
  check('player.heldTool', state.player.heldTool);
  check('inventory', state.inventory);
  check('nearbyThreats', state.nearbyThreats);
  check('environmentHazards', state.environmentHazards);
  check('nearbyBlocks', state.nearbyBlocks);
  check('power.availableEUt', state.power.availableEUt);
  return out;
}

/** The diggable blocks an observation lists, nearest first, for printing. */
export function summarizeDiggable(state: GameState, limit = 10): Record<string, unknown> | null {
  if (!state.nearbyBlocks.known) return null;
  const b = state.nearbyBlocks.value;
  return {
    scanRadius: b.scanRadius,
    count: b.resources.length,
    nearest: b.resources
      .slice(0, limit)
      .map((r) => `${r.block} at (${r.position.x}, ${r.position.y}, ${r.position.z})`),
    removed: b.removed.map((p) => `(${p.x}, ${p.y}, ${p.z})`),
  };
}

/** The placeable cells an observation lists (nearest first) and the placed blocks, for printing. */
export function summarizePlacing(state: GameState, limit = 10): Record<string, unknown> | null {
  if (!state.nearbyBlocks.known) return null;
  const b = state.nearbyBlocks.value;
  return {
    count: b.placeable.length,
    nearest: b.placeable
      .slice(0, limit)
      .map(
        (c) =>
          `(${c.position.x}, ${c.position.y}, ${c.position.z})${c.takesFalling ? '' : ' (no sand or gravel)'}`,
      ),
    placed: b.placed.map(
      (p) => `${p.block} at (${p.position.x}, ${p.position.y}, ${p.position.z})`,
    ),
  };
}

export function summarizeObservation(
  state: GameState,
  info: ConnectionInfo,
  nearby: readonly NearbyEntity[] = [],
  wideHazardScan: HazardScan | null = null,
  machines: ReadonlyArray<TrackedMachine & MachineFlags> = [],
): Record<string, unknown> {
  const inv = state.inventory.known ? state.inventory.value : null;
  const at = state.player.position.known ? state.player.position.value : null;
  return {
    server: info.identity,
    observedAt: state.timestamp,
    position: state.player.position.known ? state.player.position.value : null,
    dimension: state.player.dimension.known ? state.player.dimension.value : null,
    health: state.player.health.known ? state.player.health.value : null,
    hunger: state.player.hunger.known ? state.player.hunger.value : null,
    inventory: inv && {
      usedSlots: inv.usedSlots,
      capacitySlots: inv.capacitySlots,
      items: Object.entries(inv.items)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 15)
        .map(([item, count]) => `${count} x ${item}`),
    },
    threats: state.nearbyThreats.known ? state.nearbyThreats.value : null,
    nearbyEntities: nearby.map(
      (e) => `${e.distance.toFixed(1).padStart(5)} m  ${e.category.padEnd(12)} ${e.name}`,
    ),
    hazards: state.environmentHazards.known
      ? {
          scanRadius: state.environmentHazards.value.scanRadius,
          lavaNearby: state.environmentHazards.value.lavaNearby,
          voidNearby: state.environmentHazards.value.voidNearby,
          count: state.environmentHazards.value.hazards.length,
          nearest: state.environmentHazards.value.hazards.slice(0, 5),
        }
      : null,
    diagnosticHazards:
      wideHazardScan === null
        ? null
        : wideHazardScan.ok
          ? {
              scanRadius: wideHazardScan.scanRadius,
              count: wideHazardScan.hazards.length,
              nearest: wideHazardScan.hazards
                .slice(0, 5)
                .map(
                  (h) =>
                    `${h.distance.toFixed(1)} m ${h.kind} at (${h.position.x}, ${h.position.y}, ${h.position.z})`,
                ),
            }
          : { unavailable: wideHazardScan.reason },
    diggable: summarizeDiggable(state),
    placing: summarizePlacing(state),
    machines: machines
      .map((m) => ({
        m,
        d: at === null ? NaN : Math.hypot(m.x + 0.5 - at.x, m.y + 0.5 - at.y, m.z + 0.5 - at.z),
      }))
      .sort((a, b) => a.d - b.d)
      .map(
        ({ m, d }) =>
          `${d.toFixed(1).padStart(5)} m  ${(m.works ? (m.active ? 'busy' : 'idle') : 'OFF').padEnd(4)}  ` +
          `${m.name} (${m.metaTileId}) at (${m.x}, ${m.y}, ${m.z}) facing ${m.facing}`,
      ),
    unknown: unknownFields(state),
    registry: info.registry,
    sentPackets: info.outboundCounts,
    confirmedServerPositions: info.confirmedServerPositions,
  };
}

/** One observe -> decide -> validate -> execute -> verify cycle against the live server. */
export async function runLiveCycle(
  config: AgentConfig,
  dbPath: string,
  log?: (line: string) => void,
): Promise<{ result: CycleResult; info: ConnectionInfo }> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        const result = await runSingleCycle({
          config,
          client,
          repos,
          ...createProviders(config),
          clock: systemClock,
          newId: randomIds,
        });
        return { result, info: client.info() };
      },
      log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/**
 * Movement (and digging and placing) settings, and whether the stop file currently halts
 * everything.
 */
export function movementStatus(config: AgentConfig): Record<string, unknown> {
  const m = config.minecraft.movement;
  const d = config.minecraft.digging;
  const p = config.minecraft.placing;
  return {
    enabled: m.enabled,
    fence: m.fence,
    stopFile: resolve(m.stopFile),
    halted: existsSync(resolve(m.stopFile)),
    digging: {
      enabled: d.enabled,
      heights:
        m.fence === null ? null : `y=${m.fence.min.y}..${m.fence.min.y + d.maxHeightAboveFence}`,
    },
    placing: {
      enabled: p.enabled,
      heights:
        m.fence === null ? null : `y=${m.fence.min.y}..${m.fence.min.y + p.maxHeightAboveFence}`,
    },
  };
}

/**
 * Creates (halt) or removes (resume) the stop file. While it exists no walk starts, and
 * a walk in progress stops at its next step, even in another process.
 */
export function setMovementHalted(
  config: AgentConfig,
  halted: boolean,
  reason = 'halted by the operator',
): { stopFile: string; halted: boolean; changed: boolean } {
  const file = resolve(config.minecraft.movement.stopFile);
  const existed = existsSync(file);
  if (halted && !existed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()} ${reason}\n`);
  } else if (!halted && existed) {
    rmSync(file);
  }
  return { stopFile: file, halted, changed: existed !== halted };
}

const COORDINATES = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export interface LiveMoveResult {
  /** Null for a dry run. */
  result: CycleResult | null;
  plan: WalkPlan | null;
  mapBefore: string[];
  mapAfter: string[];
  info: ConnectionInfo;
}

/**
 * Walks the player to `to` ("x,y,z" feet coordinates, or a named location) as ONE
 * user-requested action: validated, executed and verified like the agent's own actions.
 * A dry run only plans the walk and draws it. Ctrl+C halts the walk at its next step.
 */
export async function runLiveMove(
  config: AgentConfig,
  dbPath: string,
  to: string,
  options: { tolerance: number; dryRun: boolean; log?: (line: string) => void },
): Promise<LiveMoveResult> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    let spec: ActionSpec;
    let target: Position;
    const m = COORDINATES.exec(to);
    if (m !== null) {
      target = { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
      spec = { type: 'MOVE_TO', args: { target, tolerance: options.tolerance } };
    } else {
      const location = buildSafetyContext(config, repos, new Date()).locations.get(to);
      if (location === undefined)
        throw new Error(`Unknown location "${to}" (use x,y,z or a named location)`);
      target = location.position;
      spec =
        location.kind === 'safe'
          ? { type: 'RETURN_TO_SAFE_LOCATION', args: { locationName: to } }
          : { type: 'MOVE_TO', args: { target, tolerance: options.tolerance } };
    }
    return await withLiveClient(
      config,
      async (client) => {
        const onInterrupt = (): void => client.halt('interrupted (Ctrl+C)');
        process.once('SIGINT', onInterrupt);
        try {
          const before = client.previewWalk(target);
          if (options.dryRun) {
            return {
              result: null,
              plan: before?.plan ?? null,
              mapBefore: before?.map ?? [],
              mapAfter: [],
              info: client.info(),
            };
          }
          const result = await runUserAction(
            {
              config,
              client,
              repos,
              // A human's own action: no decision is made and no planner is asked.
              ...createProviders(config),
              planner: null,
              clock: systemClock,
              newId: randomIds,
            },
            spec,
            `requested by the operator: move --to ${to}`,
          );
          return {
            result,
            plan: before?.plan ?? null,
            mapBefore: before?.map ?? [],
            mapAfter: client.previewWalk(null)?.map ?? [],
            info: client.info(),
          };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      options.log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Vanilla chests
// ---------------------------------------------------------------------------

export interface LiveChestResult {
  results: CycleResult[];
  /** The chest's contents and the player's inventory after the last action (when known). */
  chest: Record<string, number> | null;
  inventory: Record<string, number> | null;
  info: ConnectionInfo;
}

/**
 * Opens a configured chest and optionally moves items, as user-requested actions in one
 * connection (OPEN_CONTAINER first, so the chest's contents are known and a withdrawal can
 * be validated; then DEPOSIT_ITEM or WITHDRAW_ITEM). Each is validated, executed and
 * verified like the agent's own actions. Stops after the first action that does not succeed.
 */
export async function runLiveChest(
  config: AgentConfig,
  dbPath: string,
  containerId: string,
  transfer: { direction: 'deposit' | 'withdraw'; item: string; quantity: number } | null,
  log?: (line: string) => void,
): Promise<LiveChestResult> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        const onInterrupt = (): void => client.halt('interrupted (Ctrl+C)');
        process.once('SIGINT', onInterrupt);
        try {
          const deps = {
            config,
            client,
            repos,
            // A human's own actions: no decision is made and no planner is asked.
            ...createProviders(config),
            planner: null,
            clock: systemClock,
            newId: randomIds,
          };
          const specs: ActionSpec[] = [{ type: 'OPEN_CONTAINER', args: { containerId } }];
          if (transfer !== null) {
            specs.push({
              type: transfer.direction === 'deposit' ? 'DEPOSIT_ITEM' : 'WITHDRAW_ITEM',
              args: { containerId, item: transfer.item, quantity: transfer.quantity },
            });
          }
          const results: CycleResult[] = [];
          for (const spec of specs) {
            const result = await runUserAction(
              deps,
              spec,
              `requested by the operator: chest ${containerId}`,
            );
            results.push(result);
            if (result.status !== 'succeeded') break;
          }
          const state = await client.observe();
          const chest = state.storage.find((s) => s.id === containerId);
          return {
            results,
            chest: chest?.items.known ? chest.items.value : null,
            inventory: state.inventory.known ? state.inventory.value.items : null,
            info: client.info(),
          };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Digging
// ---------------------------------------------------------------------------

const BLOCK_COORDINATES = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$/;

/** "x,y,z" whole-block coordinates, or null. */
export function parseBlockPosition(text: string): BlockPosition | null {
  const m = BLOCK_COORDINATES.exec(text);
  if (m === null) return null;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

export interface LiveDigResult {
  result: CycleResult;
  /** Diggable blocks and the inventory after the dig (when known). */
  diggable: Record<string, unknown> | null;
  inventory: Record<string, number> | null;
  info: ConnectionInfo;
}

/**
 * Digs ONE block as a user-requested action: validated (schema, safety policy,
 * preconditions), dug, re-observed and verified like the agent's own actions. Ctrl+C or
 * the stop file stops the dig at its next tick.
 */
export async function runLiveDig(
  config: AgentConfig,
  dbPath: string,
  at: BlockPosition,
  log?: (line: string) => void,
): Promise<LiveDigResult> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        const onInterrupt = (): void => client.halt('interrupted (Ctrl+C)');
        process.once('SIGINT', onInterrupt);
        try {
          const result = await runUserAction(
            {
              config,
              client,
              repos,
              decisionProvider: new DeterministicDecisionProvider(),
              planner: null,
              clock: systemClock,
              newId: randomIds,
            },
            { type: 'DIG_BLOCK', args: { position: at } },
            `requested by the operator: dig --at ${at.x},${at.y},${at.z}`,
          );
          const state = await client.observe();
          return {
            result,
            diggable: summarizeDiggable(state),
            inventory: state.inventory.known ? state.inventory.value.items : null,
            info: client.info(),
          };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Placing
// ---------------------------------------------------------------------------

export interface LivePlaceResult {
  result: CycleResult;
  /** Placeable cells, placed blocks and the inventory after the placement (when known). */
  placing: Record<string, unknown> | null;
  inventory: Record<string, number> | null;
  info: ConnectionInfo;
}

/**
 * Places ONE block as a user-requested action: validated (schema, safety policy,
 * preconditions), placed, re-observed and verified like the agent's own actions.
 */
export async function runLivePlace(
  config: AgentConfig,
  dbPath: string,
  at: BlockPosition,
  item: PlaceableItem,
  log?: (line: string) => void,
): Promise<LivePlaceResult> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        const onInterrupt = (): void => client.halt('interrupted (Ctrl+C)');
        process.once('SIGINT', onInterrupt);
        try {
          const result = await runUserAction(
            {
              config,
              client,
              repos,
              decisionProvider: new DeterministicDecisionProvider(),
              planner: null,
              clock: systemClock,
              newId: randomIds,
            },
            { type: 'PLACE_BLOCK', args: { position: at, item } },
            `requested by the operator: place --at ${at.x},${at.y},${at.z} --item ${item}`,
          );
          const state = await client.observe();
          return {
            result,
            placing: summarizePlacing(state),
            inventory: state.inventory.known ? state.inventory.value.items : null,
            info: client.info(),
          };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Bounded auto-run
// ---------------------------------------------------------------------------

/**
 * Runs cycles for the current task on ONE connection until the task is done or anything
 * needs a human (see live-session.ts). Ctrl+C halts a walk at its next step and stops the
 * run before its next cycle; so does the stop file (`cli halt`, also from another terminal).
 */
export async function runLiveSession(
  config: AgentConfig,
  dbPath: string,
  limits: SessionLimits,
  onCycle: (result: CycleResult, index: number) => void,
  log?: (line: string) => void,
): Promise<SessionResult & { info: ConnectionInfo }> {
  const db = openDatabase(dbPath);
  try {
    const repos = createRepositories(db, systemClock);
    syncConfigToDatabase(config, repos);
    return await withLiveClient(
      config,
      async (client) => {
        let interrupted = false;
        const onInterrupt = (): void => {
          interrupted = true;
          client.halt('interrupted (Ctrl+C)');
        };
        process.once('SIGINT', onInterrupt);
        try {
          const stopFile = resolve(config.minecraft.movement.stopFile);
          const result = await runSession(
            {
              config,
              client,
              repos,
              ...createProviders(config),
              clock: systemClock,
              newId: randomIds,
            },
            limits,
            {
              stopRequested: () =>
                interrupted
                  ? 'interrupted (Ctrl+C)'
                  : existsSync(stopFile)
                    ? `the stop file ${stopFile} exists`
                    : null,
              onCycle,
            },
          );
          return { ...result, info: client.info() };
        } finally {
          process.removeListener('SIGINT', onInterrupt);
        }
      },
      log,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Watching (read-only)
// ---------------------------------------------------------------------------

/** One compact, human-readable line of what the agent sees now. */
export function describeView(client: Gtnh1710Client, state: GameState): string {
  const k = <T>(v: { known: true; value: T } | { known: false; reason?: string }): T | '?' =>
    v.known ? v.value : '?';
  const p = k(state.player.position);
  const pos = p === '?' ? '?' : `(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
  const threats = state.nearbyThreats.known
    ? `${state.nearbyThreats.value.hostileCount} hostile, ${state.nearbyThreats.value.unclassifiedCount} unidentified`
    : '?';
  const hazards = state.environmentHazards.known
    ? state.environmentHazards.value.hazards
        .slice(0, 3)
        .map((h) => `${h.kind}@(${h.position.x},${h.position.y},${h.position.z})`)
        .join(' ') || 'none'
    : '?';
  const entities = client.world
    .nearbyEntities(16)
    .slice(0, 4)
    .map((e) => `${e.name}[${e.category}] ${e.distance.toFixed(1)}m`)
    .join(', ');
  // Other players exactly as the agent tracks them (compare with their own F3 X/Y/Z).
  const players = client.world
    .trackedEntities()
    .filter((e) => e.kind === 'player')
    .map(
      (e) => `${e.classification.name}@(${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)})`,
    )
    .join(' ');
  const machines = state.machines.map((m) => `${m.name}@${m.id.slice(3)}=${m.status}`).join(' ');
  const inv = state.inventory.known
    ? Object.entries(state.inventory.value.items)
        .map(([name, n]) => `${n} ${name}`)
        .join(', ')
    : '?';
  return [
    `pos ${pos} ${k(state.player.dimension)}`,
    `health ${k(state.player.health)} food ${k(state.player.hunger)}`,
    `threats ${threats}${entities ? ` (${entities})` : ''}`,
    ...(players ? [`players ${players}`] : []),
    `hazards ${hazards}`,
    `machines ${machines || 'none'}`,
    `inventory ${inv || 'empty'}`,
    `open ${state.openContainerId ?? '-'}`,
  ].join(' | ');
}

/**
 * Stays connected for `seconds` (read-only: presence ticks only, so the bot stands where it
 * is and other players can see it) and reports what the agent sees every `everySeconds`.
 */
export async function watchLive(
  config: AgentConfig,
  seconds: number,
  everySeconds: number,
  onLine: (line: string) => void,
  log?: (line: string) => void,
): Promise<void> {
  await withLiveClient(
    config,
    async (client) => {
      let stop = false;
      const onInterrupt = (): void => {
        stop = true;
      };
      process.once('SIGINT', onInterrupt);
      try {
        const end = Date.now() + seconds * 1000;
        while (!stop && Date.now() < end) {
          const state = await client.observe();
          onLine(`${new Date().toISOString().slice(11, 19)} ${describeView(client, state)}`);
          const wait = Math.min(everySeconds * 1000, Math.max(0, end - Date.now()));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
      } finally {
        process.removeListener('SIGINT', onInterrupt);
      }
    },
    log,
  );
}
