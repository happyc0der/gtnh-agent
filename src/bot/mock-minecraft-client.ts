import type { ActionType } from '../domain/actions.ts';
import type { DiggableBlock } from '../domain/blocks.ts';
import type { BlockPosition, Position } from '../domain/common.ts';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  MAX_REPORTED_REMOVED,
  MAX_REPORTED_RESOURCES,
  type CurrentTask,
  type GameState,
  type Hazard,
  type KnownRecipeState,
  type MachineStatus,
} from '../domain/game-state.ts';
import { blockCentre, distance, eyeDistanceToBlock, formatPosition } from '../domain/geometry.ts';
import { known, unknown } from '../domain/known.ts';
import { assertValidatedAction, type ValidatedAction } from '../domain/validated-action.ts';
import type { Clock, ManualClock } from '../util/clock.ts';
import { failed, ok, type ClientActionResult, type MinecraftClient } from './minecraft-client.ts';

const STACK_SIZE = 64;
/** Entity scan radius, like the real client. */
const SCAN_RADIUS = 16;
/** Hazards come from chunk data, which covers much more than the entity scan. */
const HAZARD_SCAN_RADIUS = 48;
/** Diggable blocks are listed within this radius, like the real client. */
const BLOCK_SCAN_RADIUS = 16;
const ACTION_OVERHEAD_MS = 250;
/** Simulated time for one dig (the live client takes 0.5-3.9 s per block). */
const MOCK_DIG_MS = 1_000;

/** What a mock dig adds to the inventory (a simplified vanilla drop table). */
const MOCK_DROPS: Readonly<Record<DiggableBlock, { item: string; count: number } | null>> = {
  'minecraft:log': { item: 'minecraft:log', count: 1 },
  'minecraft:log2': { item: 'minecraft:log2', count: 1 },
  'minecraft:leaves': null,
  'minecraft:leaves2': null,
  'minecraft:dirt': { item: 'minecraft:dirt', count: 1 },
  'minecraft:grass': { item: 'minecraft:dirt', count: 1 },
  'minecraft:sand': { item: 'minecraft:sand', count: 1 },
  'minecraft:gravel': { item: 'minecraft:gravel', count: 1 },
  'minecraft:clay': { item: 'minecraft:clay_ball', count: 4 },
};

export interface MockResourceBlock {
  block: DiggableBlock;
  position: BlockPosition;
}

export interface MockContainer {
  id: string;
  name: string;
  position: Position;
  items: Record<string, number>;
}

export interface MockGenerator {
  id: string;
  name: string;
  position: Position;
  fuel: Record<string, number>;
  acceptedFuels: string[];
}

export interface MockMachine {
  id: string;
  name: string;
  position: Position;
  status: MachineStatus;
  powered: boolean;
  lastInspectedAt: string | null;
}

/** Fields the mock can pretend it cannot observe, to exercise fail-closed paths. */
export type MockUnobservable =
  'position' | 'dimension' | 'health' | 'hunger' | 'inventory' | 'threats' | 'hazards' | 'blocks';

/** The whole simulated world. Tests may read and mutate it directly. */
export interface MockWorld {
  player: { position: Position; dimension: string; health: number; hunger: number };
  inventory: { items: Record<string, number>; capacitySlots: number };
  hostiles: Position[];
  /** Entities the agent cannot identify (e.g. unclassified modded mobs). */
  unclassified: Position[];
  hazards: Hazard[];
  /** Diggable blocks (the only blocks the mock simulates; everything else counts as air). */
  resourceBlocks: MockResourceBlock[];
  /** Where diggable blocks were removed, most recent first. */
  removedBlocks: BlockPosition[];
  containers: MockContainer[];
  generators: MockGenerator[];
  machines: MockMachine[];
  openContainerId: string | null;
  task: CurrentTask | null;
  recipe: KnownRecipeState | null;
  /** Food restored per item eaten. */
  foodValues: Record<string, number>;
  unobservable: MockUnobservable[];
  /** Observations are timestamped this many ms in the past (simulates stale data). */
  observationLagMs: number;
  /** Interaction reach enforced by the mock, like a server would. */
  reach: number;
  /** Movement speed used to advance the clock on moves. */
  blocksPerSecond: number;
}

type FailureMode =
  { kind: 'fail'; message: string; remaining: number } | { kind: 'silent-noop'; remaining: number };

/**
 * Deterministic in-memory Minecraft stand-in. Simulates the player, inventory,
 * a safe container, a known generator with fuel, machines, hazards and hostiles,
 * with injectable failures and "reports success but changes nothing" behavior.
 */
export class MockMinecraftClient implements MinecraftClient {
  readonly kind = 'mock';
  readonly world: MockWorld;
  readonly performed: ValidatedAction[] = [];
  readonly userMessages: string[] = [];
  readonly #clock: ManualClock;
  readonly #failures = new Map<ActionType, FailureMode>();
  #connected = false;

  constructor(world: MockWorld, clock: ManualClock) {
    this.world = world;
    this.#clock = clock;
  }

  get clock(): Clock {
    return this.#clock;
  }

  /** The next `times` executions of `type` fail with `message`. */
  failNext(type: ActionType, message = 'simulated failure', times = 1): void {
    this.#failures.set(type, { kind: 'fail', message, remaining: times });
  }

  /** The next `times` executions of `type` report OK without changing the world. */
  silentNoop(type: ActionType, times = 1): void {
    this.#failures.set(type, { kind: 'silent-noop', remaining: times });
  }

  connect(): Promise<void> {
    this.#connected = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#connected = false;
    return Promise.resolve();
  }

  get connected(): boolean {
    return this.#connected;
  }

  observe(): Promise<GameState> {
    return Promise.resolve(this.snapshot());
  }

  /** Synchronous observation, handy in tests. */
  snapshot(): GameState {
    const w = this.world;
    const hidden = new Set(w.unobservable);
    const pos = w.player.position;
    const timestamp = new Date(this.#clock.now().getTime() - w.observationLagMs).toISOString();

    const hostileDistances = w.hostiles
      .map((h) => distance(pos, h))
      .filter((d) => d <= SCAN_RADIUS);
    const unclassifiedDistances = w.unclassified
      .map((u) => distance(pos, u))
      .filter((d) => d <= SCAN_RADIUS);
    const nearbyHazards = w.hazards.filter((h) => distance(pos, h.position) <= HAZARD_SCAN_RADIUS);
    const near = (b: BlockPosition): number => distance(pos, blockCentre(b));
    // Like the live client: at or above the feet level (never the ground it stands on).
    const resources = w.resourceBlocks
      .filter((r) => r.position.y >= Math.floor(pos.y) && near(r.position) <= BLOCK_SCAN_RADIUS)
      .sort((a, b) => near(a.position) - near(b.position))
      .slice(0, MAX_REPORTED_RESOURCES);
    const removed = w.removedBlocks
      .filter((p) => near(p) <= BLOCK_SCAN_RADIUS)
      .slice(0, MAX_REPORTED_REMOVED);

    const state: GameState = {
      schemaVersion: GAME_STATE_SCHEMA_VERSION,
      timestamp,
      source: 'mock',
      player: {
        position: hidden.has('position') ? unknown('mock: position hidden') : known({ ...pos }),
        dimension: hidden.has('dimension')
          ? unknown('mock: dimension hidden')
          : known(w.player.dimension),
        health: hidden.has('health') ? unknown('mock: health hidden') : known(w.player.health),
        hunger: hidden.has('hunger') ? unknown('mock: hunger hidden') : known(w.player.hunger),
        armor: known({ equippedPieces: 0, lowestDurabilityFraction: null }),
        heldTool: known(null),
      },
      inventory: hidden.has('inventory')
        ? unknown('mock: inventory hidden')
        : known({
            items: nonZero(w.inventory.items),
            usedSlots: usedSlots(w.inventory.items),
            capacitySlots: w.inventory.capacitySlots,
          }),
      nearbyThreats: hidden.has('threats')
        ? unknown('mock: threats hidden')
        : known({
            scanRadius: SCAN_RADIUS,
            hostileCount: hostileDistances.length,
            nearestHostileDistance:
              hostileDistances.length > 0 ? Math.min(...hostileDistances) : null,
            unclassifiedCount: unclassifiedDistances.length,
            nearestUnclassifiedDistance:
              unclassifiedDistances.length > 0 ? Math.min(...unclassifiedDistances) : null,
          }),
      environmentHazards: hidden.has('hazards')
        ? unknown('mock: hazards hidden')
        : known({
            scanRadius: HAZARD_SCAN_RADIUS,
            lavaNearby: nearbyHazards.some((h) => h.kind === 'lava'),
            voidNearby: nearbyHazards.some((h) => h.kind === 'void'),
            hazards: nearbyHazards.map((h) => ({ kind: h.kind, position: { ...h.position } })),
          }),
      nearbyBlocks: hidden.has('blocks')
        ? unknown('mock: blocks hidden')
        : known({
            scanRadius: BLOCK_SCAN_RADIUS,
            resources: resources.map((r) => ({ block: r.block, position: { ...r.position } })),
            removed: removed.map((p) => ({ ...p })),
          }),
      power: {
        availableEUt: unknown('mock: EU/t is not simulated'),
        generators: w.generators.map((g) => ({
          id: g.id,
          name: g.name,
          position: known({ ...g.position }),
          status: totalItems(g.fuel) > 0 ? ('running' as const) : ('out_of_fuel' as const),
          fuel: known(nonZero(g.fuel)),
          acceptedFuels: [...g.acceptedFuels],
        })),
      },
      machines: w.machines.map((m) => ({
        id: m.id,
        name: m.name,
        position: known({ ...m.position }),
        status: m.status,
        powered: known(m.powered),
        lastInspectedAt: m.lastInspectedAt,
      })),
      storage: w.containers.map((c) => ({
        id: c.id,
        name: c.name,
        position: known({ ...c.position }),
        items: known(nonZero(c.items)),
      })),
      openContainerId: w.openContainerId,
      currentTask: w.task === null ? null : { ...w.task },
      knownRecipeState: w.recipe === null ? null : structuredClone(w.recipe),
      lastAction: null,
    };
    return GameStateSchema.parse(state);
  }

  perform(validated: ValidatedAction): Promise<ClientActionResult> {
    assertValidatedAction(validated);
    if (!this.#connected) return Promise.resolve(failed('mock client is not connected', 'ERROR'));
    this.performed.push(validated);

    const action = validated.action;
    const mode = this.#failures.get(action.type);
    if (mode !== undefined) {
      mode.remaining -= 1;
      if (mode.remaining <= 0) this.#failures.delete(action.type);
      this.#clock.advance(ACTION_OVERHEAD_MS);
      if (mode.kind === 'fail') return Promise.resolve(failed(mode.message));
      return Promise.resolve(ok(`${action.type} reported success (silent no-op)`));
    }

    if (action.type !== 'OBSERVE_STATE' && action.type !== 'OPEN_CONTAINER') {
      this.world.openContainerId = null;
    }
    this.#clock.advance(ACTION_OVERHEAD_MS);
    return Promise.resolve(this.#apply(validated));
  }

  #apply(validated: ValidatedAction): ClientActionResult {
    const w = this.world;
    const action = validated.action;
    switch (action.type) {
      case 'OBSERVE_STATE':
        return ok('observed');

      case 'MOVE_TO':
        return this.#moveTo(action.args.target);

      case 'RETURN_TO_SAFE_LOCATION':
        if (validated.resolvedTarget === null) return failed('no resolved safe location', 'ERROR');
        return this.#moveTo(validated.resolvedTarget);

      case 'WAIT':
        this.#clock.advance(action.args.durationMs);
        for (const m of w.machines) if (m.status === 'busy') m.status = 'idle';
        return ok(`waited ${action.args.durationMs} ms`);

      case 'EAT_FOOD': {
        const { item } = action.args;
        if ((w.inventory.items[item] ?? 0) < 1) return failed(`no ${item} in inventory`);
        if (w.player.hunger >= 20) return failed('player is not hungry');
        w.inventory.items[item] = (w.inventory.items[item] ?? 0) - 1;
        w.player.hunger = Math.min(20, w.player.hunger + (w.foodValues[item] ?? 4));
        return ok(`ate ${item}`, { hunger: w.player.hunger });
      }

      case 'OPEN_CONTAINER': {
        const c = this.#container(action.args.containerId);
        if (typeof c === 'string') return failed(c);
        w.openContainerId = c.id;
        return ok(`opened ${c.id}`);
      }

      case 'DEPOSIT_ITEM': {
        const { item, quantity } = action.args;
        const c = this.#container(action.args.containerId);
        if (typeof c === 'string') return failed(c);
        if ((w.inventory.items[item] ?? 0) < quantity) return failed(`not enough ${item}`);
        w.inventory.items[item] = (w.inventory.items[item] ?? 0) - quantity;
        c.items[item] = (c.items[item] ?? 0) + quantity;
        return ok(`deposited ${quantity} ${item} into ${c.id}`);
      }

      case 'WITHDRAW_ITEM': {
        const { item, quantity } = action.args;
        const c = this.#container(action.args.containerId);
        if (typeof c === 'string') return failed(c);
        if ((c.items[item] ?? 0) < quantity)
          return failed(`${c.id} does not hold ${quantity} ${item}`);
        const after = { ...w.inventory.items, [item]: (w.inventory.items[item] ?? 0) + quantity };
        if (usedSlots(after) > w.inventory.capacitySlots) return failed('inventory full');
        c.items[item] = (c.items[item] ?? 0) - quantity;
        w.inventory.items[item] = after[item] ?? 0;
        return ok(`withdrew ${quantity} ${item} from ${c.id}`);
      }

      case 'INSPECT_MACHINE': {
        const m = w.machines.find((x) => x.id === action.args.machineId);
        if (m === undefined) return failed(`no machine ${action.args.machineId}`);
        if (distance(w.player.position, m.position) > w.reach)
          return failed(`${m.id} is out of reach`);
        m.lastInspectedAt = this.#clock.now().toISOString();
        return ok(`inspected ${m.id}`, { status: m.status, powered: m.powered });
      }

      case 'REFUEL_KNOWN_GENERATOR': {
        const { fuelItem, quantity } = action.args;
        const g = w.generators.find((x) => x.id === action.args.generatorId);
        if (g === undefined) return failed(`no generator ${action.args.generatorId}`);
        if (distance(w.player.position, g.position) > w.reach)
          return failed(`${g.id} is out of reach`);
        if (!g.acceptedFuels.includes(fuelItem)) return failed(`${g.id} rejects ${fuelItem}`);
        if ((w.inventory.items[fuelItem] ?? 0) < quantity) return failed(`not enough ${fuelItem}`);
        w.inventory.items[fuelItem] = (w.inventory.items[fuelItem] ?? 0) - quantity;
        g.fuel[fuelItem] = (g.fuel[fuelItem] ?? 0) + quantity;
        return ok(`added ${quantity} ${fuelItem} to ${g.id}`);
      }

      case 'DIG_BLOCK':
        return this.#dig(action.args.position);

      case 'PAUSE_AND_ASK_USER':
        this.userMessages.push(action.args.question);
        return ok('user notified', { acknowledged: true });
    }
  }

  /** Removes the block and adds its drop, like a server would (within reach, if any room). */
  #dig(p: BlockPosition): ClientActionResult {
    const w = this.world;
    const at = w.resourceBlocks.findIndex(
      (r) => r.position.x === p.x && r.position.y === p.y && r.position.z === p.z,
    );
    const found = w.resourceBlocks[at];
    if (found === undefined) return failed(`no diggable block at ${formatPosition(p)}`);
    if (eyeDistanceToBlock(w.player.position, p) > w.reach) {
      return failed(`${formatPosition(p)} is out of reach`);
    }
    this.#clock.advance(MOCK_DIG_MS);
    w.resourceBlocks.splice(at, 1);
    w.removedBlocks = [{ ...p }, ...w.removedBlocks];
    const drop = MOCK_DROPS[found.block];
    let dropCollected = false;
    if (drop !== null) {
      const after = {
        ...w.inventory.items,
        [drop.item]: (w.inventory.items[drop.item] ?? 0) + drop.count,
      };
      if (usedSlots(after) <= w.inventory.capacitySlots) {
        w.inventory.items[drop.item] = after[drop.item] ?? 0;
        dropCollected = true;
      }
    }
    return ok(`dug ${found.block} at ${formatPosition(p)}`, {
      block: found.block,
      dropCollected,
      drops: drop === null || !dropCollected ? '' : `${drop.count} x ${drop.item}`,
    });
  }

  #moveTo(target: Position): ClientActionResult {
    const d = distance(this.world.player.position, target);
    this.world.player.position = { ...target };
    this.#clock.advance(Math.round((d / this.world.blocksPerSecond) * 1000));
    return ok(`moved ${d.toFixed(1)} blocks`, { distance: Number(d.toFixed(2)) });
  }

  #container(id: string): MockContainer | string {
    const c = this.world.containers.find((x) => x.id === id);
    if (c === undefined) return `no container ${id}`;
    if (distance(this.world.player.position, c.position) > this.world.reach)
      return `${id} is out of reach`;
    return c;
  }
}

function nonZero(items: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(items).filter(([, q]) => q > 0));
}

function totalItems(items: Record<string, number>): number {
  return Object.values(items).reduce((a, b) => a + b, 0);
}

/** Slots used if every item kind is packed into full stacks. */
function usedSlots(items: Record<string, number>): number {
  return Object.values(items).reduce(
    (slots, q) => slots + Math.ceil(Math.max(0, q) / STACK_SIZE),
    0,
  );
}
