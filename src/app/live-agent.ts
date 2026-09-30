import { Gtnh1710Client, type ConnectionInfo } from '../bot/gtnh1710/gtnh-client.ts';
import type { HazardScan } from '../bot/gtnh1710/hazard-scan.ts';
import type { NearbyEntity } from '../bot/gtnh1710/world-model.ts';
import type { AgentConfig } from '../config/env.ts';
import type { GameState } from '../domain/game-state.ts';
import { openDatabase } from '../persistence/database.ts';
import { createRepositories } from '../persistence/repositories.ts';
import { MockPlannerProvider } from '../planner/mock-planner-provider.ts';
import { DeterministicDecisionProvider } from '../system1/decision-provider.ts';
import { systemClock } from '../util/clock.ts';
import { randomIds } from '../util/ids.ts';
import { runSingleCycle, syncConfigToDatabase, type CycleResult } from './agent-loop.ts';

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
): Record<string, unknown> {
  const inv = state.inventory.known ? state.inventory.value : null;
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
