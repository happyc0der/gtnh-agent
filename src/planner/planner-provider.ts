import { ACTION_TYPES, isAllowlistedActionType } from '../domain/actions.ts';
import { isQuestBookActionType } from '../domain/quest-book.ts';
import { DIGGABLE_BLOCKS, PLACEABLE_ITEMS } from '../domain/blocks.ts';
import type { Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock } from '../domain/geometry.ts';
import { ROUTE_BOOK } from '../goals/route-book.ts';
import { describeRoute, planRoute, type PlaceLookup } from '../goals/route.ts';
import { parseToolName, usesLeft } from '../domain/tools.ts';
import type { ExplorationSummary } from '../domain/world-memory.ts';
import { forbiddenKeywords, operatorApprovedTypes } from '../safety/forbidden-actions.ts';
import { isProtected } from '../safety/protected-items.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';
import {
  MAX_COMPACT_PLACEABLE,
  MAX_COMPACT_INTERACTABLES,
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
 * `protectedItems` keeps protected tools out of `tools`.
 */
export function sanitizeStateForPlanner(
  state: GameState,
  protectedItems: ReadonlySet<string> = new Set(),
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

/**
 * Places where blocks were seen, for the route: today the blocks in the current
 * observation (nearest first, with stand spots); exploration adds remembered places.
 */
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

/** The route for the current task's required items, as the planner reads it. */
export function routeForPlanner(state: GameState): PlannerRequest['route'] {
  // A building task (e.g. the night shelter): the blueprint is the route.
  const blueprint = state.currentTask?.blueprint;
  if (blueprint !== undefined && blueprint.length > 0) return { stock: [], steps: blueprint };
  const goal = state.currentTask?.requirements;
  if (goal === undefined || Object.keys(goal).length === 0) return null;
  const inventory = state.inventory.known ? state.inventory.value.items : {};
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
  const route = planRoute(goal, inventory, ROUTE_BOOK, placesInView(state), storage);
  return { stock: route.stock.slice(0, 32), steps: describeRoute(route).slice(0, 40) };
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
  return PlannerRequestSchema.parse({
    state: sanitizeStateForPlanner(input.state, input.safety.protectedItems),
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
    route: routeForPlanner(input.state),
    journal: [...(input.journal ?? [])].slice(-32),
  });
}
