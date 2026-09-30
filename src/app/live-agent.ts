import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Gtnh1710Client, type ConnectionInfo } from '../bot/gtnh1710/gtnh-client.ts';
import type { HazardScan } from '../bot/gtnh1710/hazard-scan.ts';
import type { MachineFlags } from '../bot/gtnh1710/gregtech.ts';
import type { NearbyEntity, TrackedMachine } from '../bot/gtnh1710/world-model.ts';
import type { WalkPlan } from '../bot/gtnh1710/walking.ts';
import type { AgentConfig } from '../config/env.ts';
import type { ActionSpec } from '../domain/actions.ts';
import type { Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import { MockPlannerProvider } from '../planner/mock-planner-provider.ts';
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
  check('power.availableEUt', state.power.availableEUt);
  return out;
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
          decisionProvider: new DeterministicDecisionProvider(),
          planner: new MockPlannerProvider([]),
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

/** Movement settings and whether the stop file currently halts all walking. */
export function movementStatus(config: AgentConfig): Record<string, unknown> {
  const m = config.minecraft.movement;
  return {
    enabled: m.enabled,
    fence: m.fence,
    stopFile: resolve(m.stopFile),
    halted: existsSync(resolve(m.stopFile)),
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
              decisionProvider: new DeterministicDecisionProvider(),
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
