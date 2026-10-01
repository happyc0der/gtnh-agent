import type { ActionType, ExploreToward } from '../domain/actions.ts';
import {
  fallsWhenPlaced,
  isDiggableBlock,
  placedBlockOf,
  type DiggableBlock,
  type PlaceableBlock,
  type PlaceableItem,
} from '../domain/blocks.ts';
import { COMPASS } from '../domain/world-memory.ts';
import type { BlockPosition, Position } from '../domain/common.ts';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSchema,
  MAX_REPORTED_PLACEABLE,
  MAX_REPORTED_PLACED,
  MAX_REPORTED_REMOVED,
  MAX_REPORTED_RESOURCES,
  type CurrentTask,
  type GameState,
  type Hazard,
  type KnownRecipeState,
  type MachineStatus,
  worldTime,
  type PlaceableCell,
} from '../domain/game-state.ts';
import {
  blockCentre,
  bodyColumns,
  distance,
  eyeDistanceToBlock,
  formatPosition,
} from '../domain/geometry.ts';
import { known, unknown } from '../domain/known.ts';
import {
  describeIngredient,
  ingredientRequirements,
  needsCraftingTable,
  RECIPES,
  type RecipeId,
} from '../domain/recipes.ts';
import { bestTool, parseToolName, toolProblem, usesLeft } from '../domain/tools.ts';
import { assertValidatedAction, type ValidatedAction } from '../domain/validated-action.ts';
import { isProtected } from '../safety/protected-items.ts';
import type { Clock, ManualClock } from '../util/clock.ts';
import { bodyOverlaps, entityOverlaps } from './gtnh1710/placing.ts';
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

export interface MockPlacedBlock {
  block: PlaceableBlock;
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

export interface MockCraftingTable {
  id: string;
  name: string;
  position: Position;
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
  /**
   * Diggable blocks. With the placed blocks, the only blocks the mock simulates: everything
   * else counts as air (and as nothing to place against).
   */
  resourceBlocks: MockResourceBlock[];
  /** Where diggable blocks were removed, most recent first. */
  removedBlocks: BlockPosition[];
  /** Blocks the agent placed, most recent first (diggable ones are resource blocks too). */
  placedBlocks: MockPlacedBlock[];
  containers: MockContainer[];
  generators: MockGenerator[];
  machines: MockMachine[];
  craftingTables: MockCraftingTable[];
  /**
   * What the simulated server's crafting grid shows where it differs from the agent's
   * recipe table (GTNH changes recipes); null = no result at all. Like the live client, the
   * mock then crafts nothing and reports what the server showed.
   */
  craftingResults: Partial<Record<RecipeId, { item: string; count: number } | null>>;
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
  /** Ticks into the Minecraft day (0 sunrise, 6000 noon, 18000 midnight); default noon. */
  timeOfDay?: number;
}

type FailureMode =
  { kind: 'fail'; message: string; remaining: number } | { kind: 'silent-noop'; remaining: number };

/**
 * Deterministic in-memory Minecraft stand-in. Simulates the player, inventory,
 * a safe container, a known generator with fuel, machines, crafting (with server recipes
 * that may differ from the agent's table), digging and placing blocks, hazards and hostiles,
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
    const placed = w.placedBlocks
      .filter((p) => near(p.position) <= BLOCK_SCAN_RADIUS)
      .slice(0, MAX_REPORTED_PLACED);

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
            placeable: this.#placeableCells().slice(0, MAX_REPORTED_PLACEABLE),
            placed: placed.map((p) => ({ block: p.block, position: { ...p.position } })),
          }),
      time: known(worldTime(w.timeOfDay ?? 6000, true)),
      questBook: unknown('mock: the quest book is not simulated'),
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
      craftingTables: w.craftingTables.map((t) => ({
        id: t.id,
        name: t.name,
        position: known({ ...t.position }),
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

      case 'EXPLORE':
        return this.#explore(action.args.toward, action.args.maxDistance);

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
        return this.#dig(action.args.position, new Set(validated.protectedItems));
      case 'PLACE_BLOCK':
        return this.#place(action.args.position, action.args.item);
      case 'CRAFT_ITEM':
        return this.#craft(action.args);

      case 'PAUSE_AND_ASK_USER':
        this.userMessages.push(action.args.question);
        return ok('user notified', { acknowledged: true });

      case 'SUBMIT_QUEST':
      case 'CHECK_QUEST_BOX':
      case 'CLAIM_QUEST_REWARD':
        return failed('mock: the quest book is not simulated', 'NOT_IMPLEMENTED');
    }
  }

  /**
   * Removes the block and adds its drop, like a server would (within reach, if any room).
   * Like the live client, it holds the best usable tool for the block (src/domain/tools.ts),
   * found by inventory name, and wears it by one: "minecraft:wooden_shovel" becomes
   * "minecraft:wooden_shovel@1".
   */
  #dig(p: BlockPosition, protectedItems: ReadonlySet<string>): ClientActionResult {
    const w = this.world;
    const at = w.resourceBlocks.findIndex(
      (r) => r.position.x === p.x && r.position.y === p.y && r.position.z === p.z,
    );
    const found = w.resourceBlocks[at];
    if (found === undefined) return failed(`no diggable block at ${formatPosition(p)}`);
    if (eyeDistanceToBlock(w.player.position, p) > w.reach) {
      return failed(`${formatPosition(p)} is out of reach`);
    }
    const tools = Object.entries(w.inventory.items).flatMap(([name, count]) => {
      const t = parseToolName(name);
      return t === null || count <= 0 ? [] : [{ ...t, name }];
    });
    const tool = bestTool(
      found.block,
      tools,
      (t) =>
        !isProtected(t.name, protectedItems) &&
        toolProblem({ ...t, count: 1, hasNbt: false }, found.block) === null,
    );
    if (tool !== null) {
      const worn = `${tool.tool.item}@${tool.damage + 1}`;
      w.inventory.items[tool.name] = (w.inventory.items[tool.name] ?? 0) - 1;
      w.inventory.items[worn] = (w.inventory.items[worn] ?? 0) + 1;
    }
    this.#clock.advance(MOCK_DIG_MS);
    w.resourceBlocks.splice(at, 1);
    w.removedBlocks = [{ ...p }, ...w.removedBlocks];
    w.placedBlocks = w.placedBlocks.filter((b) => !samePosition(b.position, p));
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
    const toolUsesLeft = tool === null ? null : usesLeft(tool.tool, tool.damage + 1);
    return ok(
      `dug ${found.block} at ${formatPosition(p)} with ` +
        (tool === null ? 'an empty hand' : `${tool.tool.item} (${toolUsesLeft} uses left)`),
      {
        block: found.block,
        tool: tool?.tool.item ?? null,
        toolUsesLeft,
        dropCollected,
        drops: drop === null || !dropCollected ? '' : `${drop.count} x ${drop.item}`,
      },
    );
  }

  /**
   * Places the block, like a server would: only into a placeable cell (see #placeableCells),
   * never sand or gravel where it would fall, and only with the item in the inventory.
   */
  #place(p: BlockPosition, item: PlaceableItem): ClientActionResult {
    const w = this.world;
    const have = w.inventory.items[item] ?? 0;
    if (have < 1) return failed(`no ${item} in inventory`);
    const cell = this.#placeableCells().find((c) => samePosition(c.position, p));
    if (cell === undefined) return failed(`${formatPosition(p)} is not a placeable cell`);
    if (fallsWhenPlaced(item) && !cell.takesFalling) {
      return failed(`${item} would fall at ${formatPosition(p)}`);
    }
    const block = placedBlockOf(item);
    w.inventory.items[item] = have - 1;
    w.placedBlocks = [{ block, position: { ...p } }, ...w.placedBlocks];
    if (isDiggableBlock(block)) w.resourceBlocks.push({ block, position: { ...p } });
    return ok(`placed ${block} at ${formatPosition(p)}`, { block, item, stackUsed: true });
  }

  /**
   * Like the live client: empty cells within reach of the eyes, clear of the player's body
   * and of every hostile or unidentified entity, next to a simulated block to place against,
   * touching no container, machine, crafting table or generator and no hazard. Sand and
   * gravel may go where a simulated block is right below, outside the player's own columns.
   * Nearest to the eyes first.
   */
  #placeableCells(): PlaceableCell[] {
    const w = this.world;
    const feet = w.player.position;
    const key = (b: BlockPosition): string => `${b.x},${b.y},${b.z}`;
    const cellOf = (q: Position): BlockPosition => ({
      x: Math.floor(q.x),
      y: Math.floor(q.y),
      z: Math.floor(q.z),
    });
    const solid = new Set([
      ...w.resourceBlocks.map((r) => key(r.position)),
      ...w.placedBlocks.map((b) => key(b.position)),
    ]);
    const fixtures = new Set(
      [...w.containers, ...w.machines, ...w.craftingTables, ...w.generators].map((f) =>
        key(cellOf(f.position)),
      ),
    );
    const hazards = w.hazards.map((h) => cellOf(h.position));
    const entities = [...w.hostiles, ...w.unclassified];
    const own = bodyColumns(feet);
    const faces: ReadonlyArray<readonly [number, number, number]> = [
      [0, -1, 0],
      [0, 1, 0],
      [0, 0, -1],
      [0, 0, 1],
      [-1, 0, 0],
      [1, 0, 0],
    ];
    const around = (b: BlockPosition): BlockPosition[] =>
      faces.map(([dx, dy, dz]) => ({ x: b.x + dx, y: b.y + dy, z: b.z + dz }));
    const candidates = new Map<string, BlockPosition>();
    for (const s of [...w.resourceBlocks, ...w.placedBlocks]) {
      for (const n of around(s.position)) {
        if (!solid.has(key(n)) && !fixtures.has(key(n))) candidates.set(key(n), n);
      }
    }
    return [...candidates.values()]
      .filter(
        (c) =>
          c.y >= 1 &&
          c.y <= 254 &&
          eyeDistanceToBlock(feet, c) <= w.reach &&
          !bodyOverlaps(feet, c) &&
          !entities.some((e) => entityOverlaps(e, c)) &&
          !around(c).some((n) => fixtures.has(key(n))) &&
          !hazards.some(
            (h) => Math.abs(h.x - c.x) <= 1 && Math.abs(h.y - c.y) <= 1 && Math.abs(h.z - c.z) <= 1,
          ),
      )
      .sort(
        (a, b) =>
          eyeDistanceToBlock(feet, a) - eyeDistanceToBlock(feet, b) ||
          a.x - b.x ||
          a.y - b.y ||
          a.z - b.z,
      )
      .map((c) => ({
        position: c,
        takesFalling:
          solid.has(key({ ...c, y: c.y - 1 })) && !own.some((o) => o.x === c.x && o.z === c.z),
      }));
  }

  /** Like the live client: the server's result must match the table, or nothing is crafted. */
  #craft(args: {
    recipe: RecipeId;
    times: number;
    craftingTableId: string | null;
  }): ClientActionResult {
    const w = this.world;
    const recipe = RECIPES[args.recipe];
    if (args.craftingTableId !== null) {
      const table = w.craftingTables.find((t) => t.id === args.craftingTableId);
      if (table === undefined) return failed(`no crafting table ${args.craftingTableId}`);
      if (distance(w.player.position, table.position) > w.reach) {
        return failed(`${table.id} is out of reach`);
      }
    } else if (needsCraftingTable(recipe)) {
      return failed(`${recipe.id} needs a crafting table`, 'REFUSED');
    }
    const shown = w.craftingResults[recipe.id];
    if (
      shown !== undefined &&
      (shown === null || shown.item !== recipe.result.item || shown.count !== recipe.result.count)
    ) {
      return failed(
        `the server's crafting result for ${recipe.id} is ${shown === null ? 'empty' : `${shown.count} x ${shown.item}`}, ` +
          `not the expected ${recipe.result.count} x ${recipe.result.item}; nothing was crafted`,
      );
    }
    const after = { ...w.inventory.items };
    for (const req of ingredientRequirements(recipe)) {
      let need = req.perCraft * args.times;
      for (const item of req.anyOf) {
        const take = Math.min(need, after[item] ?? 0);
        after[item] = (after[item] ?? 0) - take;
        need -= take;
      }
      if (need > 0) return failed(`not enough ${describeIngredient(req.anyOf)}`);
    }
    const made = recipe.result.count * args.times;
    after[recipe.result.item] = (after[recipe.result.item] ?? 0) + made;
    if (usedSlots(after) > w.inventory.capacitySlots) return failed('inventory full');
    w.inventory.items = after;
    return ok(`crafted ${args.times} x ${recipe.id}: +${made} ${recipe.result.item}`, {
      crafts: args.times,
    });
  }

  #moveTo(target: Position): ClientActionResult {
    const d = distance(this.world.player.position, target);
    this.world.player.position = { ...target };
    this.#clock.advance(Math.round((d / this.world.blocksPerSecond) * 1000));
    return ok(`moved ${d.toFixed(1)} blocks`, { distance: Number(d.toFixed(2)) });
  }

  /** A straight walk (no terrain is simulated) toward the direction or point, at most maxDistance. */
  #explore(toward: ExploreToward, maxDistance: number): ClientActionResult {
    const p = this.world.player.position;
    const heading =
      typeof toward === 'string' ? COMPASS[toward] : { x: toward.x - p.x, z: toward.z - p.z };
    const length = Math.hypot(heading.x, heading.z);
    const d = typeof toward === 'string' ? maxDistance : Math.min(maxDistance, length);
    if (length < 1e-9 || d < 1) return failed('already there', 'REFUSED');
    const target = {
      x: p.x + (heading.x / length) * d,
      y: p.y,
      z: p.z + (heading.z / length) * d,
    };
    const moved = this.#moveTo(target);
    return ok(`explored ${d.toFixed(1)} blocks`, { ...moved.data, walked: Number(d.toFixed(2)) });
  }

  #container(id: string): MockContainer | string {
    const c = this.world.containers.find((x) => x.id === id);
    if (c === undefined) return `no container ${id}`;
    if (distance(this.world.player.position, c.position) > this.world.reach)
      return `${id} is out of reach`;
    return c;
  }
}

function samePosition(a: BlockPosition, b: BlockPosition): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
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
