import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Gtnh1710Client, type ConnectionInfo } from '../../bot/gtnh1710/gtnh-client.ts';
import type { WalkPlan } from '../../bot/gtnh1710/walking.ts';
import type { AgentConfig } from '../../config/env.ts';
import {
  ExploreDirectionSchema,
  ExploreTowardSchema,
  type ActionSpec,
  type ExploreToward,
} from '../../domain/actions.ts';
import type { PlaceableItem } from '../../domain/blocks.ts';
import type { BlockPosition, Position } from '../../domain/common.ts';
import type { GameState } from '../../domain/game-state.ts';
import type { ExplorationSummary } from '../../domain/world-memory.ts';
import { AGE0_QUESTS } from '../../goals/age0-quests.ts';
import { openDatabase } from '../../persistence/database.ts';
import { createRepositories } from '../../persistence/repositories.ts';
import { DeterministicDecisionProvider } from '../../system1/decision-provider.ts';
import { systemClock } from '../../util/clock.ts';
import { randomIds } from '../../util/ids.ts';
import { runSingleCycle, runUserAction, type CycleResult } from '../loop/agent-loop.ts';
import { buildSafetyContext, explorationFor, syncConfigToDatabase } from '../loop/agent-memory.ts';
import { runSession, type SessionLimits, type SessionResult } from '../loop/live-session.ts';
import { createProviders } from '../providers.ts';
import {
  describeView,
  summarizeDiggable,
  summarizeEntities,
  summarizeInteractables,
  summarizePlacing,
} from './live-view.ts';

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
    // Movement mode 'follow': the play area never leaves the safety boundary.
    explorationBoundary: config.safety.boundary,
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
    mode: m.mode,
    fence: m.fence,
    playArea:
      m.mode === 'follow'
        ? {
            ...m.area,
            note: 'centred on the player, inside the exploration boundary (safety.boundary)',
            explorationBoundary: {
              min: config.safety.boundary.min,
              max: config.safety.boundary.max,
            },
          }
        : null,
    stopFile: resolve(m.stopFile),
    halted: existsSync(resolve(m.stopFile)),
    // How walks over terrain move (the walk policy); breaking and placing need their abilities.
    path: {
      ...m.path,
      breaks: m.path.allowBreak && d.enabled,
      places: m.path.allowPlace && p.enabled,
    },
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
    combat: { enabled: config.minecraft.combat.enabled, ...config.safety.combat },
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
          // Planned as the action walks: a MOVE_TO may break leaves in its way.
          const before = client.previewWalk(target, spec.type === 'MOVE_TO');
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

export interface LiveAttackResult {
  result: CycleResult;
  /** The creatures, the weapon and recent deaths after the burst (when known). */
  entities: Record<string, unknown> | null;
  health: number | null;
  info: ConnectionInfo;
}

/**
 * ONE human-requested ATTACK_ENTITY on the live server: validated (the target and the moment
 * by the safety policy), executed by the client's checked burst and verified, like the
 * agent's own. Ctrl+C halts the burst at its next tick.
 */
export async function runLiveAttack(
  config: AgentConfig,
  dbPath: string,
  entityId: number,
  log?: (line: string) => void,
): Promise<LiveAttackResult> {
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
            { type: 'ATTACK_ENTITY', args: { entityId } },
            `requested by the operator: attack --entity ${entityId}`,
          );
          const state = await client.observe();
          return {
            result,
            entities: summarizeEntities(state),
            health: state.player.health.known ? state.player.health.value : null,
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
// Exploring
// ---------------------------------------------------------------------------

const POINT_XZ = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

/** "north", "south_east" (or "south-east"), or "x,z": where EXPLORE heads; null if neither. */
export function parseExploreToward(text: string): ExploreToward | null {
  const direction = ExploreDirectionSchema.safeParse(text.trim().toLowerCase().replace('-', '_'));
  if (direction.success) return direction.data;
  const m = POINT_XZ.exec(text);
  if (m === null) return null;
  const point = ExploreTowardSchema.safeParse({ x: Number(m[1]), z: Number(m[2]) });
  return point.success ? point.data : null;
}

export interface LiveExploreResult {
  result: CycleResult;
  /** What world memory knows afterwards (null unless the play area follows the player). */
  exploration: ExplorationSummary | null;
  info: ConnectionInfo;
}

/**
 * EXPLOREs once as a user-requested action: validated (schema, safety policy, preconditions),
 * walked in hops, re-observed and verified like the agent's own actions; what the player saw
 * goes into world memory. Ctrl+C or the stop file stops it at its next step.
 */
export async function runLiveExplore(
  config: AgentConfig,
  dbPath: string,
  toward: ExploreToward,
  maxDistance: number,
  log?: (line: string) => void,
): Promise<LiveExploreResult> {
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
          const where = typeof toward === 'string' ? toward : `${toward.x},${toward.z}`;
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
            { type: 'EXPLORE', args: { toward, maxDistance } },
            `requested by the operator: explore --toward ${where} --distance ${maxDistance}`,
          );
          const state = await client.observe();
          return {
            result,
            exploration: explorationFor(config, repos, state, new Date()) ?? null,
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
// Interacting with blocks
// ---------------------------------------------------------------------------

export interface LiveInteractResult {
  results: CycleResult[];
  /** The block window after the last action, and the blocks the agent may use. */
  window: GameState['blockWindow'];
  interactables: string[];
  inventory: Record<string, number> | null;
  info: ConnectionInfo;
}

/**
 * Opens a block (INTERACT_BLOCK) and optionally smelts in it or takes its output, as checked
 * user actions in one connection: each validated, executed and verified like the agent's own.
 * Stops after the first action that does not succeed.
 */
export async function runLiveInteract(
  config: AgentConfig,
  dbPath: string,
  at: BlockPosition,
  then:
    | { kind: 'smelt'; input: string; quantity: number; fuel: string; fuelQuantity: number }
    | { kind: 'take'; item: string }
    | null,
  log?: (line: string) => void,
): Promise<LiveInteractResult> {
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
            decisionProvider: new DeterministicDecisionProvider(),
            planner: null,
            clock: systemClock,
            newId: randomIds,
          };
          const specs: ActionSpec[] = [{ type: 'INTERACT_BLOCK', args: { position: at } }];
          if (then?.kind === 'smelt') {
            specs.push({
              type: 'SMELT',
              args: {
                position: at,
                input: then.input,
                quantity: then.quantity,
                fuel: then.fuel,
                fuelQuantity: then.fuelQuantity,
              },
            });
          }
          if (then?.kind === 'take') {
            specs.push({ type: 'TAKE_OUTPUT', args: { position: at, item: then.item } });
          }
          const results: CycleResult[] = [];
          for (const spec of specs) {
            const result = await runUserAction(
              deps,
              spec,
              `requested by the operator: interact --at ${at.x},${at.y},${at.z}`,
            );
            results.push(result);
            if (result.status !== 'succeeded') break;
          }
          const state = await client.observe();
          return {
            results,
            window: state.blockWindow,
            interactables: summarizeInteractables(state),
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
