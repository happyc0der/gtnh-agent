import type { ConnectionInfo, Gtnh1710Client } from '../../bot/gtnh1710/gtnh-client.ts';
import type { HazardScan } from '../../bot/gtnh1710/hazard-scan.ts';
import type { MachineFlags } from '../../bot/gtnh1710/gregtech.ts';
import type { NearbyEntity, TrackedMachine } from '../../bot/gtnh1710/world-model.ts';
import { attackRefusal } from '../../domain/combat.ts';
import type { GameState } from '../../domain/game-state.ts';

/**
 * What the live commands print (live-commands.ts, cli-live.ts): an observation summarized
 * (observe, and what dig, place, attack and interact show afterwards), and the line `watch`
 * prints each time it looks. Nothing here connects.
 */

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

/**
 * The creatures the agent could name as an ATTACK_ENTITY target, nearest first: id, what it
 * is, distance, health, and whether it may be attacked at all (and why not).
 */
export function summarizeEntities(state: GameState, limit = 12): Record<string, unknown> | null {
  if (!state.nearbyEntities.known) return null;
  const e = state.nearbyEntities.value;
  const weapon = state.player.weapon.known ? state.player.weapon.value : null;
  return {
    weapon:
      weapon === null ? null : `${weapon.item ?? 'bare hand'} (${weapon.damage} per full hit)`,
    nearest: e.entities.slice(0, limit).map((x) => {
      const refusal = attackRefusal(x);
      return (
        `#${x.id} ${x.type} ${x.distance.toFixed(1)} m` +
        `${x.health === null ? '' : `, health ${x.health}`}` +
        `${refusal !== null ? `: never (${refusal})` : x.calm ? ', calm: no threat, not provoked' : ', attackable'}`
      );
    }),
    recentDeaths: e.recentDeaths.map((d) => `#${d.id} ${d.type} at ${d.at}`),
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
    interactables: summarizeInteractables(state),
    nearbyEntities: nearby.map(
      (e) =>
        `${e.distance.toFixed(1).padStart(5)} m  ${e.category.padEnd(12)} ${e.name} #${e.entityId}${e.calm ? ' (calm)' : ''}`,
    ),
    combat: summarizeEntities(state),
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

/** One line per interactable block: profile, block, position (and a furnace's state). */
export function summarizeInteractables(state: GameState): string[] {
  if (!state.interactables.known) return [`unknown: ${state.interactables.reason}`];
  return state.interactables.value.blocks.map((b) => {
    const p = `(${b.position.x}, ${b.position.y}, ${b.position.z})`;
    const seen = b.furnace?.seen;
    const furnace =
      b.furnace === undefined
        ? ''
        : ` ${b.furnace.burning ? 'burning' : 'not burning'}` +
          (seen == null
            ? ''
            : `; in ${seen.input?.count ?? 0} ${seen.input?.item ?? '-'}, fuel ${seen.fuel?.count ?? 0} ${seen.fuel?.item ?? '-'}, out ${seen.output?.count ?? 0} ${seen.output?.item ?? '-'}`);
    return `${b.profile ?? 'observe-only'} ${b.block} at ${p}${furnace}`;
  });
}

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
    .map(
      (e) =>
        `${e.name}#${e.entityId}[${e.category}${e.calm ? ', calm' : ''}] ${e.distance.toFixed(1)}m`,
    )
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
