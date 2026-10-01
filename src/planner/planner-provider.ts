import { ACTION_TYPES, isAllowlistedActionType } from '../domain/actions.ts';
import { isQuestBookActionType } from '../domain/quest-book.ts';
import { DIGGABLE_BLOCKS, PLACEABLE_ITEMS } from '../domain/blocks.ts';
import { attackRefusal } from '../domain/combat.ts';
import type { Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock } from '../domain/geometry.ts';
import { SafetyConfigSchema, type SafetyConfig } from '../domain/safety.ts';
import { gtnhChangesFor } from '../goals/gtnh-changes.ts';
import { ROUTE_BOOK } from '../goals/route-book.ts';
import { describeRoute, planRoute, type PlaceLookup } from '../goals/route.ts';
import { parseToolName, usesLeft } from '../domain/tools.ts';
import type { ExplorationSummary, PlaceKind } from '../domain/world-memory.ts';
import { candidateOf, fightProblems } from '../safety/combat-checks.ts';
import { forbiddenKeywords, operatorApprovedTypes } from '../safety/forbidden-actions.ts';
import { isProtected } from '../safety/protected-items.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';
import {
  MAX_COMPACT_PLACEABLE,
  MAX_COMPACT_INTERACTABLES,
  MAX_COMPACT_ENTITIES,
  MAX_COMPACT_RESOURCES,
  MAX_COMPACT_TOOLS,
  PlannerRequestSchema,
  type CompactState,
  type PlannerRequest,
  type PlannerResponse,
} from './plan-schema.ts';
import { estimateFurnace } from '../domain/interactions.ts';

/**
 * High-level planner (a local LLM in the future; a fixture-driven mock today).
 *
 * Contract:
 *  - It receives only a PlannerRequest (compact state, task, allowlist, constraints, history).
 *  - It returns a PlannerResponse: a strict Plan or an explicit escalation.
 *  - It has NO execution authority. The agent loop validates every step against the
 *    schema and the safety policy, and only the executor performs actions.
 *  - It is called only for REQUEST_PLANNER decisions (unknown/blocked work).
 */
export interface PlannerProvider {
  readonly name: string;
  plan(request: PlannerRequest): Promise<PlannerResponse>;
}

export interface RecentActionSummary {
  actionType: (typeof ACTION_TYPES)[number];
  status: string;
  reason: string;
}

export interface RecentFailureSummary {
  actionType: (typeof ACTION_TYPES)[number];
  fingerprint: string;
  failures: number;
}

/**
 * The tools DIG_BLOCK may hold, from the inventory's names (a worn tool shows its damage:
 * "minecraft:wooden_shovel@12"), best first: fastest, then most digs left. Protected tools
 * are left out (the client never uses them).
 */
function plannerTools(
  items: Readonly<Record<string, number>>,
  protectedItems: ReadonlySet<string>,
): CompactState['tools'] {
  return Object.entries(items)
    .flatMap(([name, count]) => {
      const parsed = parseToolName(name);
      if (parsed === null || count <= 0 || isProtected(name, protectedItems)) return [];
      return [{ ...parsed, count }];
    })
    .sort(
      (a, b) =>
        b.tool.speed - a.tool.speed ||
        usesLeft(b.tool, b.damage) - usesLeft(a.tool, a.damage) ||
        (a.tool.item < b.tool.item ? -1 : 1),
    )
    .slice(0, MAX_COMPACT_TOOLS)
    .map(({ tool, damage, count }) => ({
      item: tool.item,
      count,
      durabilityLeft: usesLeft(tool, damage),
      digsFaster: [...tool.digsFaster],
    }));
}

/**
 * Reduces GameState to what a planner needs. Unknown values stay null and are listed.
 * `protectedItems` keeps protected tools out of `tools`; `config` sets the fighting
 * thresholds behind `fightProblems` (defaults when omitted).
 */
export function sanitizeStateForPlanner(
  state: GameState,
  protectedItems: ReadonlySet<string> = new Set(),
  config: SafetyConfig = SafetyConfigSchema.parse({}),
): CompactState {
  const unknownFields: string[] = [];
  const val = <T>(
    name: string,
    k: { known: true; value: T } | { known: false; reason: string },
  ): T | null => {
    if (k.known) return k.value;
    unknownFields.push(name);
    return null;
  };

  const position = val('player.position', state.player.position);
  const dimension = val('player.dimension', state.player.dimension);
  const health = val('player.health', state.player.health);
  const hunger = val('player.hunger', state.player.hunger);
  const inventory = val('inventory', state.inventory);
  const threats = val('nearbyThreats', state.nearbyThreats);
  const hazards = val('environmentHazards', state.environmentHazards);
  const blocks = val('nearbyBlocks', state.nearbyBlocks);
  const entities = val('nearbyEntities', state.nearbyEntities);
  val('power.availableEUt', state.power.availableEUt);
  val('interactables', state.interactables);

  const inventoryTop = inventory
    ? Object.entries(inventory.items)
        .filter(([, q]) => q > 0)
        .sort(([a, qa], [b, qb]) => qb - qa || (a < b ? -1 : 1))
        .slice(0, 20)
        .map(([item, quantity]) => ({ item, quantity }))
    : [];
  /** Blocks from the player, computed here so a planner never has to do the arithmetic. */
  const distanceTo = (p: { known: true; value: Position } | { known: false }): number | null =>
    position !== null && p.known ? Number(distance(position, p.value).toFixed(1)) : null;

  return {
    observedAt: state.timestamp,
    position,
    dimension,
    health,
    hunger,
    inventoryTop,
    inventoryFill: inventory
      ? Number((inventory.usedSlots / inventory.capacitySlots).toFixed(3))
      : null,
    threats: threats
      ? { hostileCount: threats.hostileCount, unclassifiedCount: threats.unclassifiedCount }
      : null,
    hazards: hazards ? { lavaNearby: hazards.lavaNearby, voidNearby: hazards.voidNearby } : null,
    // A block with no stand spot (standAt null, computed by the adapter) cannot be dug from
    // anywhere now (e.g. sand on top would fall): it is not offered.
    diggableBlocks: (blocks?.resources ?? [])
      .filter((r) => r.standAt !== null)
      .slice(0, MAX_COMPACT_RESOURCES)
      .map((r) => ({
        block: r.block,
        position: { ...r.position },
        reach:
          position === null ? null : Number(eyeDistanceToBlock(position, r.position).toFixed(2)),
        standAt: r.standAt ?? null,
      })),
    tools: inventory ? plannerTools(inventory.items, protectedItems) : [],
    placeableCells: (blocks?.placeable ?? []).slice(0, MAX_COMPACT_PLACEABLE).map((c) => ({
      position: { ...c.position },
      reach: position === null ? null : Number(eyeDistanceToBlock(position, c.position).toFixed(2)),
      takesFalling: c.takesFalling,
    })),
    machines: state.machines.slice(0, 32).map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      position: m.position.known ? m.position.value : null,
      distance: distanceTo(m.position),
    })),
    storage: state.storage.slice(0, 32).map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position.known ? s.position.value : null,
      distance: distanceTo(s.position),
      // What it holds, if seen or remembered (the 20 largest stacks), else null.
      items: s.items.known
        ? Object.entries(s.items.value)
            .filter(([, q]) => q > 0)
            .sort(([a, qa], [b, qb]) => qb - qa || (a < b ? -1 : 1))
            .slice(0, 20)
            .map(([item, quantity]) => ({ item, quantity }))
        : null,
    })),
    craftingTables: state.craftingTables.slice(0, 32).map((t) => ({
      id: t.id,
      name: t.name,
      position: t.position.known ? t.position.value : null,
    })),
    interactables: compactInteractables(state, position),
    generators: state.power.generators.slice(0, 32).map((g) => ({
      id: g.id,
      name: g.name,
      status: g.status,
      position: g.position.known ? g.position.value : null,
      distance: distanceTo(g.position),
      acceptedFuels: g.acceptedFuels,
    })),
    knownRecipe: state.knownRecipeState
      ? {
          target: state.knownRecipeState.target,
          missingComponents: state.knownRecipeState.missingComponents,
        }
      : null,
    // Creatures only: names from the agent's own tables, never name tags or player names.
    entities: (entities?.entities ?? [])
      .filter((e) => e.kind === 'mob')
      .slice(0, MAX_COMPACT_ENTITIES)
      .map((e) => ({
        id: e.id,
        type: e.type,
        category: e.category,
        distance: Number(e.distance.toFixed(1)),
        health: e.health,
        attackable: attackRefusal(candidateOf(e)) === null,
      })),
    weapon: state.player.weapon.known ? { ...state.player.weapon.value } : null,
    fightProblems: fightProblems(state, config).map((p) => p.code),
    time: state.time.known
      ? {
          phase: state.time.value.phase,
          timeOfDay: state.time.value.timeOfDay,
          minutesUntilNight: state.time.value.minutesUntilNight,
          minutesUntilDay: state.time.value.minutesUntilDay,
        }
      : null,
    unknownFields,
  };
}

/** The blocks behind each resource kind world memory remembers (world-survey.ts). */
const PLACE_BLOCKS: Readonly<Record<PlaceKind, readonly string[]>> = {
  log: ['minecraft:log', 'minecraft:log2'],
  dirt: ['minecraft:dirt', 'minecraft:grass', 'minecraft:mycelium'],
  sand: ['minecraft:sand'],
  gravel: ['minecraft:gravel'],
  clay: ['minecraft:clay'],
  water: [],
  stone: ['minecraft:stone', 'minecraft:cobblestone'],
  ore: [],
};

/**
 * Where a raw material is common, by biome name: when no place of it is known yet, the
 * route points the planner at the nearest seen biome like that (vanilla 1.7.10 and
 * Biomes O' Plenty names; "Hot Forest" is a forest).
 */
const LIKELY_BIOMES: ReadonlyArray<{ blocks: readonly string[]; biomes: RegExp }> = [
  {
    blocks: ['minecraft:dirt', 'minecraft:grass'],
    biomes: /forest|plains|taiga|jungle|swamp|savanna|hills|meadow|grove|woods|birch|roofed/i,
  },
  {
    blocks: ['minecraft:log', 'minecraft:log2'],
    biomes: /forest|taiga|jungle|swamp|woods|grove|birch|roofed/i,
  },
  { blocks: ['minecraft:sand'], biomes: /desert|beach|river/i },
  { blocks: ['minecraft:gravel'], biomes: /river|beach|ocean|gravel|extreme/i },
  { blocks: ['minecraft:clay'], biomes: /river|swamp|beach|lake/i },
];

/** The nearest seen biome where one of `blocks` is common, as a route hint; or null. */
function likelyBiome(blocks: readonly string[], exploration: ExplorationSummary): string | null {
  const rule = LIKELY_BIOMES.find((r) => r.blocks.some((b) => blocks.includes(b)));
  if (rule === undefined) return null;
  const biome = exploration.biomes.find((b) => rule.biomes.test(b.biome));
  if (biome === undefined) return null;
  const where =
    biome.direction === 'here' ? 'around here' : `${biome.distance} m ${biome.direction}`;
  return (
    `the ${biome.biome} at x ${biome.x}, z ${biome.z}, ${where} ` +
    `(seen, ${biome.chunks} chunk(s)): it is common there; EXPLORE toward that x and z`
  );
}

/**
 * Places where blocks were seen, for the route, nearest first within each kind: the blocks
 * in the current observation (with stand spots), then the places world memory remembers
 * from exploring (the summary's nearest and richest per resource; x and z to EXPLORE
 * toward).
 */
function knownPlaces(state: GameState, exploration?: ExplorationSummary): PlaceLookup {
  const inView = placesInView(state);
  return (wanted) => {
    const remembered = (exploration?.places ?? []).flatMap((p) =>
      p.y !== null && PLACE_BLOCKS[p.resource].some((b) => wanted.includes(b))
        ? [
            {
              where: { x: p.x, y: p.y, z: p.z },
              distance: p.distance,
              amount: p.count,
              label:
                `remembered${p.biome === null ? '' : ` (${p.biome})`}, ` +
                `seen ${p.seenMinutesAgo} min ago, ${p.direction}`,
            },
          ]
        : [],
    );
    return [...inView(wanted), ...remembered];
  };
}

/** The blocks in the current observation, as places (nearest first, with stand spots). */
function placesInView(state: GameState): PlaceLookup {
  const blocks = state.nearbyBlocks.known ? state.nearbyBlocks.value.resources : [];
  const at = state.player.position.known ? state.player.position.value : null;
  return (wanted) => {
    const seen = blocks.filter((b) => wanted.includes(b.block) && b.standAt !== null);
    const nearest = seen[0];
    if (nearest === undefined || at === null) return [];
    return [
      {
        where: { ...nearest.position },
        distance: Number(eyeDistanceToBlock(at, nearest.position).toFixed(1)),
        amount: seen.length,
        label: 'in view',
      },
    ];
  };
}

/**
 * The route for the current task's required items, as the planner reads it. With world
 * memory (`exploration`), remembered places count as known places, and a raw material with
 * none known gets the nearest seen biome where it is common as its hint.
 */
export function routeForPlanner(
  state: GameState,
  exploration?: ExplorationSummary,
): PlannerRequest['route'] {
  return routeAndChangesForPlanner(state, exploration).route;
}

/**
 * The route (as routeForPlanner) and the GTNH-vs-vanilla changes that concern it and what
 * the player holds (request.gtnhChanges), from one route calculation.
 */
export function routeAndChangesForPlanner(
  state: GameState,
  exploration?: ExplorationSummary,
): {
  route: PlannerRequest['route'];
  gtnhChanges: string[];
} {
  // A building task (e.g. the night shelter): the blueprint is the route.
  const blueprint = state.currentTask?.blueprint;
  if (blueprint !== undefined && blueprint.length > 0) {
    return { route: { stock: [], steps: blueprint }, gtnhChanges: [] };
  }
  const inventory = state.inventory.known ? state.inventory.value.items : {};
  const held = Object.keys(inventory);
  const goal = state.currentTask?.requirements;
  if (goal === undefined || Object.keys(goal).length === 0) {
    return { route: null, gtnhChanges: gtnhChangesFor(null, held) };
  }
  const at = state.player.position.known ? state.player.position.value : null;
  // Containers whose contents are known (seen now, or remembered by the agent).
  const storage = state.storage.flatMap((s) =>
    s.items.known
      ? [
          {
            id: s.id,
            where: s.position.known ? { ...s.position.value } : null,
            distance:
              at !== null && s.position.known
                ? Number(distance(at, s.position.value).toFixed(1))
                : null,
            items: s.items.value,
          },
        ]
      : [],
  );
  const route = planRoute(goal, inventory, ROUTE_BOOK, knownPlaces(state, exploration), storage);
  const legs = route.legs.map((leg) => {
    if (leg.kind !== 'gather' || leg.places.length > 0 || exploration === undefined) return leg;
    const biome = likelyBiome(leg.blocks, exploration);
    if (biome === null) return leg;
    return { ...leg, hint: leg.hint === null ? biome : `${biome}; ${leg.hint}` };
  });
  return {
    route: {
      stock: route.stock.slice(0, 32),
      steps: describeRoute({ ...route, legs }).slice(0, 40),
    },
    gtnhChanges: gtnhChangesFor(route, held),
  };
}

/**
 * Interactable blocks for the planner, nearest first, with reach and, for furnaces, what is
 * inside and how long until it is all smelted (from the furnace's last-seen contents and
 * timers, minus the time since; null when it went out or was never seen).
 */
function compactInteractables(
  state: GameState,
  position: Position | null,
): CompactState['interactables'] {
  if (!state.interactables.known) return [];
  const now = Date.parse(state.timestamp);
  const stack = (s: { item: string; count: number } | null): string | null =>
    s === null ? null : `${s.count} ${s.item}`;
  return state.interactables.value.blocks.slice(0, MAX_COMPACT_INTERACTABLES).map((b) => {
    let furnace: CompactState['interactables'][number]['furnace'] = null;
    if (b.furnace !== undefined) {
      const seen = b.furnace.seen;
      const ago = seen === null ? null : Math.max(0, (now - Date.parse(seen.observedAt)) / 1000);
      const estimate = seen === null ? null : estimateFurnace(seen);
      const left =
        estimate?.secondsToFinish == null || ago === null
          ? null
          : estimate.secondsToFinish === 0
            ? 0
            : b.furnace.burning
              ? Math.max(0, estimate.secondsToFinish - ago)
              : null;
      furnace = {
        burning: b.furnace.burning,
        input: stack(seen?.input ?? null),
        fuel: stack(seen?.fuel ?? null),
        output: stack(seen?.output ?? null),
        secondsLeft: left === null ? null : Number(left.toFixed(1)),
        seenSecondsAgo: ago === null ? null : Number(ago.toFixed(1)),
      };
    }
    return {
      profile: b.profile,
      block: b.block,
      position: { ...b.position },
      reach: position === null ? null : Number(eyeDistanceToBlock(position, b.position).toFixed(2)),
      standAt: b.standAt ?? null,
      furnace,
    };
  });
}

export function buildPlannerRequest(input: {
  state: GameState;
  safety: SafetyContext;
  maxPlanSteps: number;
  recentActions: RecentActionSummary[];
  recentFailures: RecentFailureSummary[];
  /** The task's compact journal (checkpoints so far), oldest first. */
  journal?: readonly string[];
  /** World memory's summary, only when the agent can explore; EXPLORE is offered only then. */
  exploration?: ExplorationSummary;
}): PlannerRequest {
  const { config } = input.safety;
  const { exploration } = input;
  const { route, gtnhChanges } = routeAndChangesForPlanner(input.state, exploration);
  return PlannerRequestSchema.parse({
    state: sanitizeStateForPlanner(input.state, input.safety.protectedItems, config),
    task: input.state.currentTask,
    // Quest-book clicks are the play loop's, never a plan's (plan-validator.ts refuses them).
    allowedActions: ACTION_TYPES.filter(
      (t) => !isQuestBookActionType(t) && (t !== 'EXPLORE' || exploration !== undefined),
    ),
    ...(exploration === undefined ? {} : { exploration }),
    safetyConstraints: {
      boundaryMin: config.boundary.min,
      boundaryMax: config.boundary.max,
      allowedDimensions: config.boundary.allowedDimensions,
      protectedItems: [...input.safety.protectedItems].sort(),
      approvedFoods: config.approvedFoods,
      approvedFuels: config.approvedFuels,
      maxMoveDistance: config.maxMoveDistance,
      safeLocations: [...input.safety.locations.entries()]
        .filter(([, l]) => l.kind === 'safe')
        .map(([name]) => name)
        .sort(),
      forbidden: [...forbiddenKeywords()],
      forbiddenExceptions: operatorApprovedTypes().filter(isAllowlistedActionType),
      diggableBlocks: [...DIGGABLE_BLOCKS],
      placeableItems: [...PLACEABLE_ITEMS],
    },
    recentActions: input.recentActions,
    recentFailures: input.recentFailures,
    maxPlanSteps: input.maxPlanSteps,
    route,
    gtnhChanges,
    journal: [...(input.journal ?? [])].slice(-32),
  });
}
