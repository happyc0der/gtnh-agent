import { ACTION_TYPES, isAllowlistedActionType, isCodeOnlyActionType } from '../domain/actions.ts';
import { isQuestBookActionType } from '../domain/quest-book.ts';
import { DIGGABLE_BLOCKS, nearestOfEachKind, PLACEABLE_ITEMS } from '../domain/blocks.ts';
import { attackRefusal, calmRefusal } from '../domain/combat.ts';
import type { GardenBlock } from '../domain/blocks.ts';
import {
  ANIMAL_DROPS,
  carriedFoodPoints,
  FOOD_ANIMALS,
  FOOD_GARDENS,
  FOOD_TASK_ID,
  FOOD_TRIP_POINTS,
  GARDEN_DROPS,
} from '../domain/food.ts';
import type { BlockPosition, Position } from '../domain/common.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, eyeDistanceToBlock } from '../domain/geometry.ts';
import { SafetyConfigSchema, type SafetyConfig } from '../domain/safety.ts';
import { gtnhChangesFor } from '../goals/gtnh-changes.ts';
import { ROUTE_BOOK } from '../goals/route-book.ts';
import { describeRoute, planRoute, type KnownPlace, type PlaceLookup } from '../goals/route.ts';
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
    // anywhere now (e.g. sand on top would fall): it is not offered. Shared fairly between
    // kinds, so every kind in view shows.
    diggableBlocks: nearestOfEachKind(
      (blocks?.resources ?? []).filter((r) => r.standAt !== null),
      (r) => r.block,
      MAX_COMPACT_RESOURCES,
    ).map((r) => ({
      block: r.block,
      position: { ...r.position },
      reach: position === null ? null : Number(eyeDistanceToBlock(position, r.position).toFixed(2)),
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
    // Creatures only: names from the agent's own tables, never name tags or player names. A
    // calm spider is listed as such, and not attackable (a blow would provoke it).
    entities: (entities?.entities ?? [])
      .filter((e) => e.kind === 'mob')
      .slice(0, MAX_COMPACT_ENTITIES)
      .map((e) => ({
        id: e.id,
        type: e.type,
        category: e.category,
        distance: Number(e.distance.toFixed(1)),
        health: e.health,
        calm: e.calm,
        attackable: attackRefusal(candidateOf(e)) === null && calmRefusal(e) === null,
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
  garden: FOOD_GARDENS,
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
  // HarvestCraft's gardens (food.ts GARDEN_BIOMES): plains, forests, savannas, hills, jungles
  // and wet biomes; the test world's Hot Forest and Hot Plains are plains and savannas.
  {
    blocks: FOOD_GARDENS,
    biomes:
      /forest|plains|savanna|jungle|swamp|hills|mountain|mesa|meadow|grove|woods|birch|roofed|marsh|bayou|wetland|shrubland|thicket/i,
  },
];

/**
 * A biome patch this close (its nearest chunk's centre, blocks) is where the player stands: the
 * resource scan already covers it.
 */
const BIOME_HERE = 16;

/** The seen biomes where one of `blocks` is common, nearest first; empty when none is known. */
function likelyBiomes(
  blocks: readonly string[],
  exploration: ExplorationSummary,
): ExplorationSummary['biomes'] {
  const rule = LIKELY_BIOMES.find((r) => r.blocks.some((b) => blocks.includes(b)));
  return rule === undefined ? [] : exploration.biomes.filter((b) => rule.biomes.test(b.biome));
}

/**
 * The nearest seen biome where one of `blocks` is common, away from where the player stands, as
 * a route hint; or null. Not the patch the player stands in: what it has in view is listed
 * already, or out of reach from here (seen live: "EXPLORE toward x 24, z 40", 1.6 blocks
 * away, three sessions running); biomeHere names that one, last.
 */
function biomeAway(blocks: readonly string[], exploration: ExplorationSummary): string | null {
  const away = likelyBiomes(blocks, exploration).find((b) => b.distance > BIOME_HERE);
  if (away === undefined) return null;
  return (
    `the ${away.biome} at x ${away.x}, z ${away.z}, ${away.distance} m ${away.direction} ` +
    `(seen, ${away.chunks} chunk(s)): it is common there; EXPLORE toward that x and z`
  );
}

/** When the only likely biome seen is the patch the player stands in: explore on through it. */
function biomeHere(blocks: readonly string[], exploration: ExplorationSummary): string | null {
  const here = likelyBiomes(blocks, exploration)[0];
  if (here === undefined) return null;
  return (
    `the ${here.biome} the player stands in (seen, ${here.chunks} chunk(s)), beyond what it can ` +
    'reach from here: EXPLORE on through it, toward a direction with little seen'
  );
}

/** Raw materials that lie on river and lake beds and shores: remembered water points to them. */
const BY_WATER: ReadonlySet<string> = new Set([
  'minecraft:gravel',
  'minecraft:clay',
  'minecraft:sand',
]);

/**
 * The nearest remembered water away from the player, as a route hint for gravel, clay or sand;
 * or null. In 1.7.10 they generate mostly as disks around water: BiomeDecorator's gravel, sand
 * and clay generators start only where a column's top is water, and turn the dirt and grass up
 * to 2 levels above or below it into gravel or sand (clay: the dirt, 1 level), so the disks lie
 * on beds and reach the banks. Seen live: 94 chunks of desert and forest around spawn held no
 * gravel, water or clay, and a player after gravel heads for water. Water the resource scan
 * covers (`covered`), or as close as a biome patch the player stands in, is left out: its
 * shore here is in view already (the scan lists sand, gravel and clay down to a level below
 * the feet), and what lies under it cannot be dug (the agent does not wade).
 */
function waterNear(
  blocks: readonly string[],
  exploration: ExplorationSummary,
  covered: (b: BlockPosition) => boolean,
): string | null {
  if (!blocks.some((b) => BY_WATER.has(b))) return null;
  const water = exploration.places
    .filter(
      (p) =>
        p.resource === 'water' &&
        p.distance > BIOME_HERE &&
        (p.y === null || !covered({ x: p.x, y: p.y, z: p.z })),
    )
    .sort((a, b) => a.distance - b.distance)[0];
  if (water === undefined) return null;
  return (
    `the shore of the water at x ${water.x}, z ${water.z}, ${water.distance} m ` +
    `${water.direction} (seen ${water.seenMinutesAgo} min ago): gravel, clay and sand lie on ` +
    'river and lake shores and beds; EXPLORE toward that x and z'
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
  const covered = scanCovers(state);
  return (wanted) => {
    const remembered = (exploration?.places ?? []).flatMap((p) =>
      p.y !== null &&
      !covered({ x: p.x, y: p.y, z: p.z }) &&
      PLACE_BLOCKS[p.resource].some((b) => wanted.includes(b))
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

/**
 * Where world memory remembers `block` beyond what the current scan covers, nearest first: a
 * GATHER with none of it in view heads for the nearest (gather.ts GatherOptions.remembered).
 */
export function rememberedPlacesOf(
  block: string,
  state: GameState,
  exploration: ExplorationSummary | undefined,
): Array<{ x: number; y: number; z: number; distance: number }> {
  if (exploration === undefined) return [];
  const covered = scanCovers(state);
  return exploration.places
    .flatMap((p) =>
      p.y !== null &&
      PLACE_BLOCKS[p.resource].includes(block) &&
      !covered({ x: p.x, y: p.y, z: p.z })
        ? [{ x: p.x, y: p.y, z: p.z, distance: p.distance }]
        : [],
    )
    .sort((a, b) => a.distance - b.distance);
}

/** Room (blocks to the boundary) a direction needs to be worth an EXPLORE toward it. */
const MIN_EXPLORE_ROOM = 64;

/**
 * Where to look when neither a place nor a likely biome is known: the direction with the most
 * room past what has been seen that way (ties: the least seen), as a concrete EXPLORE. Seen
 * live: with no gravel, water or clay in 94 chunks of desert and forest, the model went back
 * and forth between two nearby points instead of into new ground.
 */
function unexploredDirection(exploration: ExplorationSummary): string | null {
  const best = Object.entries(exploration.directions)
    .map(([direction, d]) => ({ direction, ...d, beyond: d.room - d.seen }))
    .filter((d) => d.room >= MIN_EXPLORE_ROOM && d.beyond > 0)
    .sort((a, b) => b.beyond - a.beyond || a.seen - b.seen)[0];
  if (best === undefined) return null;
  return (
    `new ground, none seen so far: EXPLORE ${best.direction} (seen only ${best.seen} blocks ` +
    `that way, ${best.room} blocks of room)`
  );
}

/**
 * Whether the current resource scan covers block `b`: inside its sphere, at or above the
 * feet level, where it lists every kind (scanResources). A remembered place it covers is in
 * view already (listed, with a spot a walk reaches to dig it from) or out of reach from here,
 * so it is no place to EXPLORE toward (seen live: the model planned EXPLORE toward logs 8 m
 * away, walled in by leaves and cactus, again and again).
 */
function scanCovers(state: GameState): (b: BlockPosition) => boolean {
  const at = state.player.position.known ? state.player.position.value : null;
  const radius = state.nearbyBlocks.known ? state.nearbyBlocks.value.scanRadius : null;
  if (at === null || radius === null) return () => false;
  const feetLevel = Math.floor(at.y + 1e-6);
  return (b) =>
    b.y >= feetLevel && Math.hypot(b.x + 0.5 - at.x, b.y + 0.5 - at.y, b.z + 0.5 - at.z) <= radius;
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
 * none known gets where to look as its hint (routeAndChangesForPlanner).
 */
export function routeForPlanner(
  state: GameState,
  exploration?: ExplorationSummary,
  food?: FoodContext,
): PlannerRequest['route'] {
  return routeAndChangesForPlanner(state, exploration, food).route;
}

/** What the food task's route needs to count the food carried (approved foods, meals). */
export interface FoodContext {
  safety: SafetyContext;
  /** Foods eaten lately, newest first (Spice of Life). */
  recentMeals: readonly string[];
  /** The client may fight (MC_ENABLE_COMBAT): without it no animal is offered to hunt. */
  combatEnabled: boolean;
}

/** "in view (3, 64, 1) 4 m away, ~2 seen": a known place, as route lines show one. */
function placeText(p: KnownPlace): string {
  return (
    `${p.label === undefined ? '' : `${p.label} `}(${p.where.x}, ${p.where.y}, ${p.where.z}) ` +
    `${p.distance.toFixed(0)} m away, ~${p.amount} seen`
  );
}

/**
 * The food task's route (FOOD_TASK_ID: src/app/food.ts), calculated in code like any route:
 * the food carried against what the trip brings back (hunger points, approved foods only, with
 * Spice of Life's diminishing returns: food.ts carriedFoodPoints), then the food sources, each
 * with the GATHER step that gets it:
 *  - HarvestCraft gardens with food among their drops, in view with a stand spot (nearest
 *    first), then remembered from exploring (EXPLORE toward them first);
 *  - grown, unowned cows, pigs and sheep in view, whose raw meat is approved: only with combat
 *    enabled and while the moment allows a fight (fightProblems: food 8 and health 14 at
 *    least, no hostile near), so the planner is never offered a hunt that would be refused;
 *  - with none of those, where to look: the nearest seen biome where gardens grow, else a
 *    direction with little seen ("no known place yet: explore", which the agent loop's
 *    escalation check knows).
 * The count of a GATHER counts all its source's drops, so it is the food still missing over
 * the share of food among them.
 */
function foodRouteForPlanner(
  state: GameState,
  food: FoodContext | undefined,
  exploration?: ExplorationSummary,
): PlannerRequest['route'] {
  const config = food?.safety.config ?? SafetyConfigSchema.parse({});
  const approved = new Set(config.approvedFoods);
  const isProtectedFood = (item: string): boolean =>
    food !== undefined && isProtected(item, food.safety.protectedItems);
  const items = state.inventory.known ? state.inventory.value.items : {};
  const have = carriedFoodPoints(
    items,
    config.approvedFoods,
    food?.recentMeals ?? [],
    isProtectedFood,
    FOOD_TRIP_POINTS,
  );
  const missing = Math.max(0, FOOD_TRIP_POINTS - have);
  const stock = [
    {
      item: 'food (hunger points of approved food carried)',
      have,
      stored: 0,
      need: FOOD_TRIP_POINTS,
      missing,
    },
  ];
  const hunger = state.player.hunger.known ? state.player.hunger.value : null;
  const steps: string[] = [
    `food ${hunger ?? 'unknown'}/20 and too little food carried: get ${missing} more hunger ` +
      `points of food, then the quest goes on. Most foods restore 1 here (HungerOverhaul), and ` +
      `the same food eaten 5 times among the last 20 meals restores nothing (Spice of Life): ` +
      'mixed garden produce is the best food.',
  ];
  if (missing === 0) {
    return { stock, steps: [...steps, 'enough food is carried already'] };
  }
  const places = knownPlaces(state, exploration);
  const lines: string[] = [];
  const share = (drops: readonly string[]): number =>
    drops.filter((d) => approved.has(d)).length / Math.max(1, drops.length);
  // Gardens in view first (a dig is instant and gives three), then remembered ones.
  const gardens = FOOD_GARDENS.filter((g) => share(GARDEN_DROPS[g]) > 0);
  const inView = gardens
    .map((g) => ({ g, place: placesInView(state)([g])[0] }))
    .filter((x): x is { g: GardenBlock; place: KnownPlace } => x.place !== undefined)
    .sort((a, b) => a.place.distance - b.place.distance);
  for (const { g, place } of inView) {
    const count = Math.min(64, Math.ceil(missing / share(GARDEN_DROPS[g])));
    lines.push(
      `gather food: dig ${g} (3 a dig, any of ${GARDEN_DROPS[g].join(', ')}); best: ` +
        `${placeText(place)}: GATHER {"block":"${g}","count":${count}}`,
    );
  }
  // Animals: only when the moment allows a hunt at all (the safety policy's own rule).
  const hunt = fightProblems(state, config).map((p) => p.code);
  const animals = new Map<string, { nearest: number; count: number }>();
  if (state.nearbyEntities.known && food?.combatEnabled === true) {
    for (const e of state.nearbyEntities.value.entities) {
      const meat = ANIMAL_DROPS[e.type]?.[0]?.item;
      if (!FOOD_ANIMALS.has(e.type) || meat === undefined || !approved.has(meat)) continue;
      if (attackRefusal(candidateOf(e)) !== null || calmRefusal(e) !== null) continue;
      const a = animals.get(e.type);
      if (a === undefined) animals.set(e.type, { nearest: e.distance, count: 1 });
      else a.count += 1;
    }
  }
  if (animals.size > 0 && hunt.length > 0) {
    lines.push(
      `animals are in view, but hunting is not allowed now (${hunt.join(', ')}): gardens only`,
    );
  } else {
    for (const [type, a] of [...animals].sort((x, y) => x[1].nearest - y[1].nearest)) {
      const drops = ANIMAL_DROPS[type] ?? [];
      const avg = (d: { min: number; max: number }): number => (d.min + d.max) / 2;
      const all = drops.reduce((n, d) => n + avg(d), 0);
      const meat = drops[0];
      const meatShare = meat === undefined || all === 0 ? 1 : avg(meat) / all;
      const count = Math.min(64, Math.ceil(missing / meatShare));
      lines.push(
        `gather food: kill ${type} (${meat?.min ?? 1}-${meat?.max ?? 3} ${meat?.item ?? 'meat'} ` +
          `each; a bare hand needs about 10 hits, a walk after each); in view: ${a.count}, ` +
          `nearest ${a.nearest.toFixed(0)} m away: GATHER {"animal":"${type}","count":${count}}`,
      );
    }
  }
  if (lines.length === 0) {
    const remembered = places(gardens).filter((p) => p.label?.startsWith('remembered') === true);
    const best = remembered[0];
    if (best !== undefined) {
      lines.push(
        `gather food: dig a HarvestCraft garden; best: ${placeText(best)}: EXPLORE toward its ` +
          `x and z first (out of view), then GATHER it`,
      );
    } else {
      const where =
        (exploration === undefined
          ? null
          : (biomeAway(gardens, exploration) ??
            biomeHere(gardens, exploration) ??
            unexploredDirection(exploration))) ??
        'plains, forests, savannas, hills, jungles and swamps: HarvestCraft gardens grow there, and cows, pigs and sheep graze on grass';
      lines.push(
        'gather food: a HarvestCraft garden, or a cow, pig or sheep; no known place yet: ' +
          `explore (look in ${where})`,
      );
    }
  }
  return {
    stock,
    steps: [...steps, ...lines.map((l, i) => `${i + 1}. ${l}`)].map((l) =>
      l.length > 480 ? `${l.slice(0, 477)}...` : l,
    ),
  };
}

/**
 * The route (as routeForPlanner) and the GTNH-vs-vanilla changes that concern it and what
 * the player holds (request.gtnhChanges), from one route calculation.
 *
 * A gather leg with no known place gets where to look, the surest first: a seen biome where
 * the material is common, away from here (it is common there, all of it); remembered water,
 * for gravel, clay and sand (they lie on its shores, if not everywhere along them); the biome
 * patch the player stands in, explored on through (what it holds within reach is in view
 * already); and last, new ground in the direction with the most room left unseen.
 */
export function routeAndChangesForPlanner(
  state: GameState,
  exploration?: ExplorationSummary,
  food?: FoodContext,
): {
  route: PlannerRequest['route'];
  gtnhChanges: string[];
} {
  // A building task (e.g. the night shelter): the blueprint is the route.
  const blueprint = state.currentTask?.blueprint;
  if (blueprint !== undefined && blueprint.length > 0) {
    return { route: { stock: [], steps: blueprint }, gtnhChanges: [] };
  }
  // The food task: its own route, food sources rather than items (foodRouteForPlanner).
  if (state.currentTask?.taskId === FOOD_TASK_ID) {
    const held = state.inventory.known ? Object.keys(state.inventory.value.items) : [];
    return {
      route: foodRouteForPlanner(state, food, exploration),
      gtnhChanges: gtnhChangesFor(null, held),
    };
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
  const covered = scanCovers(state);
  const legs = route.legs.map((leg) => {
    if (leg.kind !== 'gather' || leg.places.length > 0 || exploration === undefined) return leg;
    const where =
      biomeAway(leg.blocks, exploration) ??
      waterNear(leg.blocks, exploration, covered) ??
      biomeHere(leg.blocks, exploration) ??
      unexploredDirection(exploration);
    if (where === null) return leg;
    return { ...leg, hint: leg.hint === null ? where : `${where}; ${leg.hint}` };
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
  /** Foods eaten lately, newest first (the food task's route counts food with them). */
  recentMeals?: readonly string[];
  /** The client may fight: the food task's route offers animals to hunt only then. */
  combatEnabled?: boolean;
}): PlannerRequest {
  const { config } = input.safety;
  // World memory's places the current scan covers are in view already or out of reach: the
  // model never sees them as places to EXPLORE toward (seen live: it read the remembered logs
  // 8 m away from this list, after the route had left them out, and planned the same failing
  // EXPLORE until the repeated-failure rule stopped play).
  const covered = scanCovers(input.state);
  const exploration =
    input.exploration === undefined
      ? undefined
      : {
          ...input.exploration,
          places: input.exploration.places.filter(
            (p) => p.y === null || !covered({ x: p.x, y: p.y, z: p.z }),
          ),
          // Nor the biome patch the player stands in, as a point (seen live: "EXPLORE toward
          // x 24, z 40", the Hot Forest's nearest chunk, 0.7 blocks away, again and again).
          biomes: input.exploration.biomes.filter((b) => b.distance > BIOME_HERE),
        };
  const { route, gtnhChanges } = routeAndChangesForPlanner(input.state, exploration, {
    safety: input.safety,
    recentMeals: input.recentMeals ?? [],
    combatEnabled: input.combatEnabled ?? false,
  });
  return PlannerRequestSchema.parse({
    state: sanitizeStateForPlanner(input.state, input.safety.protectedItems, config),
    task: input.state.currentTask,
    // Quest-book clicks are the play loop's, and DIG_DOWN the night pit's (code's own step),
    // never a plan's (plan-validator.ts refuses them).
    allowedActions: ACTION_TYPES.filter(
      (t) =>
        !isQuestBookActionType(t) &&
        !isCodeOnlyActionType(t) &&
        (t !== 'EXPLORE' || exploration !== undefined),
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
      forbiddenExceptions: operatorApprovedTypes().filter(
        (t) => isAllowlistedActionType(t) && !isCodeOnlyActionType(t),
      ),
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
