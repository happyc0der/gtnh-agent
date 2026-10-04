/**
 * Routes: what a goal needs, calculated exactly, and in which order to get it.
 *
 * Given a goal (items and counts), the inventory, a recipe book and the ways items can be
 * gathered, the route expands every item the inventory does not already cover into its
 * recipe tree (ingredients before what they make; GITM-style post-order), adds up the raw
 * materials to gather, and attaches where each raw material is known to be (from what the
 * agent has seen) or generates (from the book). Items with no known recipe or source are
 * reported as unresolved, with the reason. Pure and general: nothing here is specific to
 * GTNH; the book, the tools and the places are data.
 *
 * With thousands of recipes there are usually several ways to get an item. The route picks
 * the cheapest by an estimate of the work (seconds of digging, crafting and smelting), from
 * what is held, gatherable and craftable: recipes whose station is a machine nobody can use
 * are skipped; one-time needs (a tool for digging, a crafting tool such as a hammer) are
 * counted once. When a dig needs a tool the inventory lacks, the route gets that tool first
 * (expanding its own recipe tree, even when the tool needs the item it will dig: a pickaxe
 * that needs diamonds gets them another way first) and says so. Stations (a crafting table,
 * a furnace) are listed with whether one is known; the route does not place them.
 *
 * The route is information for the planner (a model), which decides what to do with it.
 */

/** The route's line when nothing is missing (planner-provider.ts, plan-steps.ts read it). */
export const EVERYTHING_HELD = 'everything the goal needs is already held';

/** Kinds of one ingredient (any planks, any wool) weighed by what they cost now, at most. */
const MAX_KINDS_WEIGHED = 16;
/** Costs (seconds) closer than this are equal: then the kind seen nearby wins. */
const COST_EPSILON = 0.01;

export interface RouteInput {
  /** Any mix of these items. */
  anyOf: readonly string[];
  /** Per craft. */
  count: number;
  /** A crafting tool (e.g. a hammer): needed once, not consumed. */
  tool?: boolean;
  /** A short name for the alternatives, e.g. "ore:craftingToolHardHammer". */
  label?: string;
}

export interface RouteRecipe {
  id: string;
  /** What one craft makes. */
  output: { item: string; count: number };
  inputs: readonly RouteInput[];
  /** Where it is made: '2x2' (the player's own grid), 'crafting_table', 'furnace', ... */
  station: string;
  /** False when output.count is a lower bound (the data does not say; 1 is assumed). */
  countKnown?: boolean;
  /** Lower ranks win ties: 0 hand-verified, 1 generated (default), higher discouraged. */
  rank?: number;
  /** A note shown with the recipe (e.g. a GT tool's material). */
  label?: string;
}

/** A tool kind at a minimum harvest level, e.g. a pickaxe of level 3 or more. */
export interface ToolRequirement {
  kind: string;
  level: number;
}

/**
 * A way to gather an item from the world: dig one of `blocks` (via 'dig'), or kill one of the
 * creatures named in `blocks` (via 'kill': a mob's drops), `perAction` items each.
 */
export interface RouteSource {
  item: string;
  via: 'dig' | 'kill';
  /** The blocks to dig, or (via 'kill') the creatures to kill, e.g. minecraft:Cow. */
  blocks: readonly string[];
  /** Items one action yields on average (e.g. 4 clay balls per clay block, 0.1 flint per gravel). */
  perAction: number;
  /** About how long one action takes, in seconds (dig time plus a short step), if known. */
  secondsPerAction?: number;
  /** The tool the blocks need (without it they drop nothing or cannot be dug). */
  tool?: ToolRequirement;
  /** Where the blocks generate, e.g. "GT vein Diamond: y 5-20 (Overworld)". */
  where?: string;
}

/** An item that works as a tool of `kind` at `level` (-1: depends on its NBT material). */
export interface RouteTool {
  item: string;
  kind: string;
  level: number;
}

export interface RouteBook {
  recipes: readonly RouteRecipe[];
  sources: readonly RouteSource[];
  /** Where to look for a block when none is known yet (general knowledge, e.g. biomes). */
  hints?: Readonly<Record<string, string>>;
  /** Items that serve as tools (pickaxes and the like), for dig requirements. */
  tools?: readonly RouteTool[];
  /** The item that provides each station, e.g. furnace -> minecraft:furnace. */
  stationItems?: Readonly<Record<string, string>>;
}

/** A place where a raw material was seen. */
export interface KnownPlace {
  /** A block position (or the centre of an area) where it was seen. */
  where: { x: number; y: number; z: number };
  /** Blocks from the player. */
  distance: number;
  /** How many blocks of it were seen there (an estimate). */
  amount: number;
  /** Optional: what kind of place (e.g. "river", "forest", "seen now"). */
  label?: string;
}

/** Where `blocks` are known to be, nearest first. */
export type PlaceLookup = (blocks: readonly string[], item?: string) => KnownPlace[];

/** A container whose contents the agent knows (it saw them, or remembers them). */
export interface StoredContainer {
  id: string;
  where: { x: number; y: number; z: number } | null;
  /** Blocks from the player (null if unknown). */
  distance: number | null;
  items: Readonly<Record<string, number>>;
}

export type RouteLeg =
  | {
      kind: 'withdraw';
      containerId: string;
      item: string;
      quantity: number;
      where: { x: number; y: number; z: number } | null;
      distance: number | null;
    }
  | {
      kind: 'gather';
      item: string;
      quantity: number;
      /** Dig blocks, or kill creatures (a mob's drops). */
      via: 'dig' | 'kill';
      /** Blocks to dig (or creatures to kill), and about how many digs (or kills). */
      blocks: readonly string[];
      actions: number;
      places: KnownPlace[];
      /** The known place to use: the nearest one with enough seen for the whole leg. */
      best: KnownPlace | null;
      /** Where to look when no place is known (from the book's hints). */
      hint: string | null;
      /** Rough minutes: digging plus walking to the best place (null when unknown). */
      minutes: number | null;
      /** The tool the dig needs, if any. */
      tool: ToolRequirement | null;
      /** Where the blocks generate (from the book), if known. */
      where: string | null;
      /** Why this leg is here when it serves a tool (else absent). */
      purpose?: string;
    }
  | {
      kind: 'craft';
      recipe: string;
      times: number;
      makes: { item: string; count: number };
      station: string;
      /** What these crafts consume, in total. */
      uses: Record<string, number>;
      /** False when the output count is a lower bound (it may make more). */
      countKnown: boolean;
      /** Crafting tools the recipe uses (not consumed). */
      tools: string[];
      /** Why this leg is here when it serves a tool (else absent). */
      purpose?: string;
    };

/** One goal item: how many are held, how many the goal needs, how many are missing. */
export interface StockLine {
  item: string;
  /** In the inventory. */
  have: number;
  /** In known containers. */
  stored: number;
  need: number;
  /** Not held and not stored. */
  missing: number;
  /** Every kind of the item counts (planRoute's anyKind): have and stored are of all kinds. */
  anyKind?: true;
}

/** A tool the route needs: for digging (a kind and level) or for crafting (a tool item). */
export interface RouteToolNeed {
  /** What needs it, e.g. "dig gregtech:gt.blockores@500" or a recipe id. */
  for: string;
  /** E.g. "pickaxe level >= 3", or the kinds of crafting tool that fit. */
  need: string;
  /** The held tool that covers it, if any. */
  have: string | null;
  /** The tool the route gets first (its steps are marked with this purpose), if not held. */
  get: string | null;
  /** The held tool's level is not known from its name (e.g. a Tinkers' Construct tool). */
  unverified?: boolean;
}

export interface RouteStationNeed {
  station: string;
  /**
   * available: the caller says one is usable; held: its item is in the inventory (to place);
   * made: none known, and the route makes its item (in a leg, before the crafts at it), to
   * place then; missing: none known, and the book makes none; unknown: the caller did not say
   * which stations exist.
   */
  status: 'available' | 'held' | 'made' | 'missing' | 'unknown';
  /** The item that provides it, e.g. minecraft:furnace. */
  item: string | null;
  /** How the book makes that item (when not available), e.g. "minecraft:furnace#1: 6 ...". */
  make: string | null;
}

export interface Route {
  goal: Record<string, number>;
  /** Taking stock of the goal itself: have vs need per item. */
  stock: StockLine[];
  /** What the inventory already covers (and the route reserves for the goal). */
  fromInventory: Record<string, number>;
  /** What known containers cover (fetched by withdraw legs). */
  fromStorage: Record<string, number>;
  /** Raw materials to gather, in total. */
  raw: Record<string, number>;
  /** Steps in order: ingredients are always gathered or crafted before what they make. */
  legs: RouteLeg[];
  /** Items with no known recipe or source (or a recipe loop): the route cannot cover them. */
  unresolved: Record<string, number>;
  /** Why each unresolved item cannot be had. */
  why: Record<string, string>;
  /** Stations the crafts need (e.g. 'crafting_table'). */
  stations: string[];
  /** Each needed station, and whether one is known. */
  stationNeeds: RouteStationNeed[];
  /** Tools the route needs, held or to get. */
  tools: RouteToolNeed[];
}

/** Deepest recipe nesting the route expands (tools add a few levels). */
const MAX_DEPTH = 24;
const MAX_PLACES = 3;
/** Walking speed used for time estimates (blocks per second; the walker's pace). */
const WALK_BLOCKS_PER_SECOND = 4;
/** Estimated seconds: one craft, one item smelted, one dig with no estimate, a station. */
const CRAFT_SECONDS = 4;
const SMELT_SECONDS = 10;
const DEFAULT_DIG_SECONDS = 4;
const STATION_SECONDS = 60;
/** The cost of an item nothing can get, when choosing how far an incomplete route goes. */
const SOFT_PENALTY = 1e6;
/** Longest line describeRoute writes (a planner request step is at most 500 characters). */
const MAX_LINE = 480;

type Option = { kind: 'recipe'; recipe: RouteRecipe } | { kind: 'source'; source: RouteSource };

/** What a requirement of an option is: an input it consumes, a crafting tool, a dig tool. */
const Need = { Consumed: 0, CraftTool: 1, DigTool: 2 } as const;
type Need = (typeof Need)[keyof typeof Need];

/**
 * The book as an AND/OR graph for cost estimates: each option (a recipe or a source) has
 * requirements, and each requirement is met by any item of a group (an ingredient's
 * alternatives, or the tools of a kind and level). Built once per book.
 */
interface CostGraph {
  itemId: Map<string, number>;
  items: string[];
  options: Option[];
  optionItem: number[];
  /** Requirement indexes of each option. */
  optionReqs: number[][];
  reqOption: number[];
  reqGroup: number[];
  /** Items consumed per craft (0 for tools). */
  reqWeight: number[];
  reqNeed: Need[];
  groupMembers: number[][];
  /** Requirements each group meets. */
  groupUses: number[][];
  /** The names behind each group (for "is one held?"). */
  groupNames: Array<readonly string[]>;
  /** Groups each item belongs to. */
  itemGroups: number[][];
  /** Dig tool requirements by requirement index. */
  digTool: Map<number, ToolRequirement>;
}

interface BookIndex {
  recipes: Map<string, RouteRecipe[]>;
  sources: Map<string, RouteSource[]>;
  toolsByKind: Map<string, RouteTool[]>;
  /** Tools by exact item name, and by base name (vanilla tools wear: "x:pick@37"). */
  toolsByItem: Map<string, RouteTool[]>;
  /** The book's kinds of each item by base name: minecraft:log -> oak, @1, @2, @3. */
  kinds: Map<string, string[]>;
  stationItems: Readonly<Record<string, string>>;
  graph: CostGraph;
}

const indexes = new WeakMap<RouteBook, BookIndex>();

/** Builds (once per book) the lookups the route needs: recipes by output, sources, tools. */
function indexBook(book: RouteBook): BookIndex {
  const cached = indexes.get(book);
  if (cached !== undefined) return cached;
  const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  const recipes = new Map<string, RouteRecipe[]>();
  const sources = new Map<string, RouteSource[]>();
  const toolsByKind = new Map<string, RouteTool[]>();
  const toolsByItem = new Map<string, RouteTool[]>();
  for (const r of book.recipes) push(recipes, r.output.item, r);
  // Stable by rank: hand-verified recipes come first among equals.
  for (const list of recipes.values()) list.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1));
  for (const s of book.sources) push(sources, s.item, s);
  for (const t of book.tools ?? []) {
    push(toolsByKind, t.kind, t);
    push(toolsByItem, t.item, t);
  }
  for (const list of toolsByKind.values()) list.sort((a, b) => a.level - b.level);
  const kinds = new Map<string, string[]>();
  for (const item of new Set([...recipes.keys(), ...sources.keys()])) {
    push(kinds, item.replace(/@\d+$/, ''), item);
  }
  // The plain name first, then by damage value.
  const damage = (item: string): number => Number(/@(\d+)$/.exec(item)?.[1] ?? 0);
  for (const list of kinds.values()) list.sort((a, b) => damage(a) - damage(b));
  const ix: BookIndex = {
    recipes,
    sources,
    toolsByKind,
    toolsByItem,
    kinds,
    stationItems: book.stationItems ?? {},
    graph: buildGraph(recipes, sources, toolsByKind),
  };
  indexes.set(book, ix);
  return ix;
}

function buildGraph(
  recipes: Map<string, RouteRecipe[]>,
  sources: Map<string, RouteSource[]>,
  toolsByKind: Map<string, RouteTool[]>,
): CostGraph {
  const g: CostGraph = {
    itemId: new Map(),
    items: [],
    options: [],
    optionItem: [],
    optionReqs: [],
    reqOption: [],
    reqGroup: [],
    reqWeight: [],
    reqNeed: [],
    groupMembers: [],
    groupUses: [],
    groupNames: [],
    itemGroups: [],
    digTool: new Map(),
  };
  const id = (item: string): number => {
    let i = g.itemId.get(item);
    if (i === undefined) {
      i = g.items.length;
      g.items.push(item);
      g.itemId.set(item, i);
      g.itemGroups.push([]);
    }
    return i;
  };
  // Ingredient lists are shared arrays in big books: one group per array.
  const groupOfList = new Map<readonly string[], number>();
  const groupOfTool = new Map<string, number>();
  const newGroup = (names: readonly string[]): number => {
    const gid = g.groupMembers.length;
    const members = [...new Set(names)].map(id);
    g.groupMembers.push(members);
    g.groupUses.push([]);
    g.groupNames.push(names);
    for (const m of members) g.itemGroups[m]?.push(gid);
    return gid;
  };
  const listGroup = (names: readonly string[]): number => {
    let gid = groupOfList.get(names);
    if (gid === undefined) {
      gid = newGroup(names);
      groupOfList.set(names, gid);
    }
    return gid;
  };
  const toolGroup = (req: ToolRequirement): number => {
    const key = reqKey(req);
    let gid = groupOfTool.get(key);
    if (gid === undefined) {
      const fit = (toolsByKind.get(req.kind) ?? []).filter(
        (t) => t.level >= req.level && t.level >= 0,
      );
      gid = newGroup(fit.map((t) => t.item));
      groupOfTool.set(key, gid);
    }
    return gid;
  };
  const addReq = (option: number, group: number, weight: number, need: Need): number => {
    const r = g.reqOption.length;
    g.reqOption.push(option);
    g.reqGroup.push(group);
    g.reqWeight.push(weight);
    g.reqNeed.push(need);
    g.optionReqs[option]?.push(r);
    g.groupUses[group]?.push(r);
    return r;
  };
  const addOption = (o: Option, item: string): number => {
    const oid = g.options.length;
    g.options.push(o);
    g.optionItem.push(id(item));
    g.optionReqs.push([]);
    return oid;
  };
  for (const [item, list] of sources) {
    for (const source of list) {
      const oid = addOption({ kind: 'source', source }, item);
      if (source.tool !== undefined) {
        const r = addReq(oid, toolGroup(source.tool), 0, Need.DigTool);
        g.digTool.set(r, source.tool);
      }
    }
  }
  for (const [item, list] of recipes) {
    for (const recipe of list) {
      const oid = addOption({ kind: 'recipe', recipe }, item);
      for (const input of recipe.inputs) {
        addReq(
          oid,
          listGroup(input.anyOf),
          input.tool === true ? 0 : input.count,
          input.tool === true ? Need.CraftTool : Need.Consumed,
        );
      }
    }
  }
  return g;
}

const baseName = (item: string): string => item.replace(/@\d+$/, '');
const reqText = (r: ToolRequirement): string => `${r.kind} level >= ${r.level}`;
const reqKey = (r: ToolRequirement): string => `${r.kind}>=${r.level}`;

/** The tools an item works as (worn vanilla tools carry their wear as damage). */
function toolsOf(ix: BookIndex, item: string): RouteTool[] {
  return ix.toolsByItem.get(item) ?? ix.toolsByItem.get(baseName(item)) ?? [];
}

interface CostContext {
  /** Is a dig tool requirement met by a held (or already got) tool? */
  heldDigTool(req: ToolRequirement): boolean;
  /** Is one of these crafting tools held (or already got)? */
  heldToolItem(anyOf: readonly string[]): boolean;
  station(s: string): 'yes' | 'slow' | 'no';
  /** Options to leave out (a tool bootstrap leaves out the digs that need the tool). */
  skip?(item: string, o: Option): boolean;
}

/** A min-heap of (cost, item id). */
class Heap {
  readonly #cost: number[] = [];
  readonly #item: number[] = [];
  get size(): number {
    return this.#cost.length;
  }
  push(cost: number, item: number): void {
    const c = this.#cost;
    const it = this.#item;
    let i = c.length;
    c.push(cost);
    it.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((c[p] ?? 0) <= cost) break;
      c[i] = c[p] ?? 0;
      it[i] = it[p] ?? 0;
      i = p;
    }
    c[i] = cost;
    it[i] = item;
  }
  pop(): [number, number] {
    const c = this.#cost;
    const it = this.#item;
    const top: [number, number] = [c[0] ?? 0, it[0] ?? 0];
    const lastCost = c.pop() ?? 0;
    const lastItem = it.pop() ?? 0;
    const n = c.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && (c[r] ?? 0) < (c[l] ?? 0) ? r : l;
        if ((c[m] ?? 0) >= lastCost) break;
        c[i] = c[m] ?? 0;
        it[i] = it[m] ?? 0;
        i = m;
      }
      c[i] = lastCost;
      it[i] = lastItem;
    }
    return top;
  }
}

/**
 * Per-unit cost estimates (seconds) of every item's cheapest way to get it, by Knuth's
 * generalization of Dijkstra's algorithm over the AND/OR graph: items are settled cheapest
 * first; an option becomes usable once each of its requirements is met by a settled item.
 * Cycles cost nothing extra and cannot make an item look impossible. Held items count at
 * their making cost (the route weighs what is held itself), except tools.
 */
class CostTable {
  readonly #g: CostGraph;
  readonly #cost: Float64Array;

  constructor(ix: BookIndex, ctx: CostContext) {
    const g = ix.graph;
    this.#g = g;
    const nOptions = g.options.length;
    const remaining = new Int32Array(nOptions);
    const accum = new Float64Array(nOptions);
    const reqDone = new Uint8Array(g.reqOption.length);
    const groupSettled = new Uint8Array(g.groupMembers.length);
    const cost = new Float64Array(g.items.length).fill(Infinity);
    const heap = new Heap();
    const optionCost = (oid: number): number => {
      const o = g.options[oid];
      if (o === undefined) return Infinity;
      if (o.kind === 'source') {
        return (o.source.secondsPerAction ?? DEFAULT_DIG_SECONDS) / o.source.perAction;
      }
      const base = o.recipe.station === 'furnace' ? SMELT_SECONDS : CRAFT_SECONDS;
      return (base + (accum[oid] ?? 0)) / Math.max(1, o.recipe.output.count);
    };
    for (let oid = 0; oid < nOptions; oid++) {
      const o = g.options[oid];
      const item = g.items[g.optionItem[oid] ?? -1];
      if (o === undefined || item === undefined) continue;
      const disabled =
        (o.kind === 'source' && o.source.perAction <= 0) ||
        (o.kind === 'recipe' && ctx.station(o.recipe.station) === 'no') ||
        ctx.skip?.(item, o) === true;
      if (disabled) {
        remaining[oid] = -1;
        continue;
      }
      let left = 0;
      for (const r of g.optionReqs[oid] ?? []) {
        const need = g.reqNeed[r];
        const held =
          need === Need.DigTool
            ? ctx.heldDigTool(g.digTool.get(r) ?? { kind: '', level: 0 })
            : need === Need.CraftTool && ctx.heldToolItem(g.groupNames[g.reqGroup[r] ?? -1] ?? []);
        if (held) reqDone[r] = 1;
        else left++;
      }
      remaining[oid] = left;
      if (left === 0) heap.push(optionCost(oid), g.optionItem[oid] ?? 0);
    }
    while (heap.size > 0) {
      const [c, item] = heap.pop();
      if (cost[item] !== Infinity) continue;
      cost[item] = c;
      for (const gid of g.itemGroups[item] ?? []) {
        if (groupSettled[gid] === 1) continue;
        groupSettled[gid] = 1; // the first settled member is the group's cheapest
        for (const r of g.groupUses[gid] ?? []) {
          if (reqDone[r] === 1) continue;
          reqDone[r] = 1;
          const oid = g.reqOption[r] ?? 0;
          if ((remaining[oid] ?? 0) <= 0) continue;
          accum[oid] = (accum[oid] ?? 0) + (g.reqWeight[r] ?? 0) * c;
          remaining[oid] = (remaining[oid] ?? 0) - 1;
          if (remaining[oid] === 0) heap.push(optionCost(oid), g.optionItem[oid] ?? 0);
        }
      }
    }
    this.#cost = cost;
  }

  unit(item: string): number {
    const i = this.#g.itemId.get(item);
    return i === undefined ? Infinity : (this.#cost[i] ?? Infinity);
  }

  /** The cheapest of some items (first wins ties). */
  cheapest(anyOf: readonly string[]): { item: string | null; cost: number } {
    let best: { item: string | null; cost: number } = { item: null, cost: Infinity };
    for (const v of anyOf) {
      const c = this.unit(v);
      if (c < best.cost) best = { item: v, cost: c };
    }
    return best;
  }

  /** Per-item cost of one recipe (tools as feasibility only). */
  recipeUnit(
    r: RouteRecipe,
    station: 'yes' | 'slow' | 'no',
    heldToolItem: (a: readonly string[]) => boolean,
  ): number {
    if (station === 'no') return Infinity;
    let total = r.station === 'furnace' ? SMELT_SECONDS : CRAFT_SECONDS;
    for (const input of r.inputs) {
      const c = this.cheapest(input.anyOf).cost;
      if (input.tool === true) {
        if (!heldToolItem(input.anyOf) && c === Infinity) return Infinity;
      } else total += input.count * c;
    }
    return total / Math.max(1, r.output.count);
  }
}

function optionsOf(ix: BookIndex, item: string): Option[] {
  const out: Option[] = [];
  for (const source of ix.sources.get(item) ?? []) out.push({ kind: 'source', source });
  for (const recipe of ix.recipes.get(item) ?? []) out.push({ kind: 'recipe', recipe });
  return out;
}

/**
 * Plans how to get `goal` from `inventory`. `stations`: the stations the agent can use now
 * (e.g. a known crafting table); when omitted, stations are listed as needed but not judged.
 * `anyKind`: goal items of which every kind counts (all their damage values: an owner's "16
 * logs" are any wood): what is held of every kind counts, and the rest is got as the kind
 * cheapest now (birch planks from birch logs held).
 */
export function planRoute(
  goal: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
  book: RouteBook,
  places: PlaceLookup = () => [],
  storage: readonly StoredContainer[] = [],
  stations?: readonly string[],
  anyKind: ReadonlySet<string> = new Set(),
): Route {
  const first = planRouteOnce(goal, inventory, book, places, storage, stations, anyKind);
  // A station the crafts need with none usable or held, that the book makes: the route makes
  // its item first, as a person does (seen live 2026-10-04: "make a crafting table: 2 flint,
  // 2 logs, then place it" with no flint held, and nothing in the route to get any; the
  // first step was refused, and the model then crafted the pickaxe without a table).
  const make = first.stationNeeds.filter(
    (s): s is RouteStationNeed & { item: string } =>
      s.status === 'missing' && s.item !== null && s.make !== null,
  );
  if (make.length === 0) return first;
  const withStations: Record<string, number> = {};
  for (const s of make) withStations[s.item] = 1;
  for (const [item, n] of Object.entries(goal)) withStations[item] = (withStations[item] ?? 0) + n;
  const second = planRouteOnce(withStations, inventory, book, places, storage, stations, anyKind);
  // Only when the station's own tree can be had: else listed as missing, as before.
  if (Object.keys(second.unresolved).some((item) => !(item in first.unresolved))) return first;
  const made = new Set(make.map((s) => s.item));
  const madeHere = (item: string): boolean =>
    second.legs.some((l) => l.kind === 'craft' && l.makes.item === item);
  return {
    ...second,
    goal: { ...goal },
    // The station's item is a means, not the goal: off the stock (unless the goal is it).
    stock: second.stock.filter((x) => !made.has(x.item) || (goal[x.item] ?? 0) > 0),
    stationNeeds: second.stationNeeds.map((s) =>
      s.item !== null && made.has(s.item) && s.status === 'missing' && madeHere(s.item)
        ? { ...s, status: 'made' as const }
        : s,
    ),
  };
}

/** One pass of planRoute: the route for `goal` as it is (stations listed, not made). */
function planRouteOnce(
  goal: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
  book: RouteBook,
  places: PlaceLookup,
  storage: readonly StoredContainer[],
  stations: readonly string[] | undefined,
  anyKind: ReadonlySet<string>,
): Route {
  const ix = indexBook(book);
  const pool = new Map(Object.entries(inventory).filter(([, n]) => n > 0));
  /** What the route's own crafts made beyond what they were for (not "held"). */
  const spare = new Map<string, number>();
  const available = (item: string): number => (pool.get(item) ?? 0) + (spare.get(item) ?? 0);
  // Containers nearest first (unknown distance last), each with what is left in it.
  const stores = [...storage]
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .map((c) => ({ ...c, left: new Map(Object.entries(c.items).filter(([, n]) => n > 0)) }));
  const fromInventory: Record<string, number> = {};
  const fromStorage: Record<string, number> = {};
  const raw: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  const why: Record<string, string> = {};
  const legs: RouteLeg[] = [];
  const tools: RouteToolNeed[] = [];
  /** Tools the route gets on the way (then counted as held). */
  const acquired = new Set<string>();
  /** Tool requirements and tool items being got right now (a tool must not need itself). */
  const toolReqsInProgress = new Set<string>();
  const toolItemsInProgress = new Set<string>();
  const add = (into: Record<string, number>, item: string, n: number): void => {
    into[item] = (into[item] ?? 0) + n;
  };
  const stationList = stations === undefined ? null : new Set(stations);

  const heldTool = (req: ToolRequirement): { item: string; unverified: boolean } | null => {
    let unverified: string | null = null;
    for (const item of [...pool.keys(), ...spare.keys(), ...acquired]) {
      if (available(item) <= 0 && !acquired.has(item)) continue;
      for (const t of toolsOf(ix, item)) {
        if (t.kind !== req.kind) continue;
        if (t.level >= req.level) return { item, unverified: false };
        if (t.level < 0) unverified ??= item;
      }
    }
    return unverified === null ? null : { item: unverified, unverified: true };
  };
  const hasToolItem = (anyOf: readonly string[]): boolean =>
    anyOf.some((v) => available(v) > 0 || acquired.has(v));
  const stationState = (s: string): 'yes' | 'slow' | 'no' => {
    if (s === '2x2') return 'yes';
    const item = ix.stationItems[s];
    if (stationList === null) return item === undefined ? 'no' : 'yes';
    if (stationList.has(s)) return 'yes';
    return item === undefined ? 'no' : 'slow';
  };
  const context = (skip?: CostContext['skip']): CostContext => ({
    heldDigTool: (r) => heldTool(r) !== null,
    heldToolItem: hasToolItem,
    station: stationState,
    ...(skip === undefined ? {} : { skip }),
  });
  // Cost tables, rebuilt when the route gets a tool (it makes more things possible).
  let main: CostTable | null = null;
  const bootstrap = new Map<string, CostTable>();
  const table = (): CostTable => (main ??= new CostTable(ix, context()));
  const gotTool = (item: string): void => {
    acquired.add(item);
    main = null;
    bootstrap.clear();
  };
  /** Costs without the ways of getting `item` that need tool `req` (a tool bootstrap). */
  const tableWithout = (item: string, req: ToolRequirement): CostTable => {
    const key = `${item}|${reqKey(req)}`;
    let t = bootstrap.get(key);
    if (t === undefined) {
      t = new CostTable(
        ix,
        context(
          (it, o) =>
            it === item &&
            o.kind === 'source' &&
            o.source.tool?.kind === req.kind &&
            o.source.tool.level >= req.level,
        ),
      );
      bootstrap.set(key, t);
    }
    return t;
  };
  /** The tool to get for a requirement, and its cost (for digging `forItem`). */
  const bestTool = (
    req: ToolRequirement,
    forItem: string,
  ): { item: string; cost: number } | null => {
    // Only when some way of getting `forItem` needs the tool is a bootstrap table needed.
    const t = optionsOf(ix, forItem).some(
      (o) => o.kind === 'source' && o.source.tool?.kind === req.kind,
    )
      ? tableWithout(forItem, req)
      : table();
    let best: { item: string; cost: number } | null = null;
    for (const tool of ix.toolsByKind.get(req.kind) ?? []) {
      if (tool.level < req.level || toolItemsInProgress.has(tool.item)) continue;
      const c = t.unit(tool.item);
      if (c < (best?.cost ?? Infinity)) best = { item: tool.item, cost: c };
    }
    return best;
  };

  /** Takes up to `n` of `item` (spare first, then the inventory); returns how many. */
  const take = (item: string, n: number): number => {
    const extra = spare.get(item) ?? 0;
    const fromSpare = Math.min(extra, n);
    if (fromSpare > 0) spare.set(item, extra - fromSpare);
    const have = pool.get(item) ?? 0;
    const used = Math.min(have, n - fromSpare);
    if (used > 0) {
      pool.set(item, have - used);
      add(fromInventory, item, used);
    }
    return fromSpare + used;
  };

  /** Fetches up to `n` of `item` from known containers (nearest first); returns how many. */
  const fetch = (item: string, n: number): number => {
    let got = 0;
    for (const c of stores) {
      if (got >= n) break;
      const there = c.left.get(item) ?? 0;
      if (there <= 0) continue;
      const q = Math.min(there, n - got);
      c.left.set(item, there - q);
      got += q;
      add(fromStorage, item, q);
      const leg = legs.find(
        (l) => l.kind === 'withdraw' && l.containerId === c.id && l.item === item,
      );
      if (leg !== undefined && leg.kind === 'withdraw') leg.quantity += q;
      else {
        legs.push({
          kind: 'withdraw',
          containerId: c.id,
          item,
          quantity: q,
          where: c.where,
          distance: c.distance,
        });
      }
    }
    return got;
  };

  /**
   * Per-item cost of the cheapest of some items. `soft`: an item nothing can get costs a
   * large penalty instead of Infinity (less when only a missing tool blocks it), so a route
   * that cannot be completed still shows how far it gets and exactly what is missing.
   */
  const unitOf = (anyOf: readonly string[], soft: boolean): number => {
    const cost = table().cheapest(anyOf).cost;
    if (cost < Infinity || !soft) return cost;
    const d = Math.min(...anyOf.slice(0, 8).map((v) => toolBlocked(v, 0)));
    return SOFT_PENALTY * (d === Infinity ? 100 : 1 + d);
  };

  /** What `need` more of any mix of `anyOf` costs now (held ones are free). */
  const inputCost = (anyOf: readonly string[], need: number, soft: boolean): number => {
    let held = 0;
    for (const v of anyOf) held += available(v);
    if (held >= need) return 0;
    return (need - held) * unitOf(anyOf, soft);
  };

  /** The total cost of getting `rest` of `item` by an option, now. */
  const evaluate = (item: string, rest: number, o: Option, soft = false): number => {
    if (o.kind === 'source') {
      const s = o.source;
      if (s.perAction <= 0) return Infinity;
      let total = (rest / s.perAction) * (s.secondsPerAction ?? DEFAULT_DIG_SECONDS);
      if (s.tool !== undefined && heldTool(s.tool) === null) {
        if (toolReqsInProgress.has(reqKey(s.tool))) return Infinity;
        total += bestTool(s.tool, item)?.cost ?? Infinity;
      }
      return total;
    }
    const r = o.recipe;
    const station = stationState(r.station);
    if (station === 'no') return Infinity;
    const times = Math.ceil(rest / Math.max(1, r.output.count));
    let total =
      times * (r.station === 'furnace' ? SMELT_SECONDS : CRAFT_SECONDS) +
      (station === 'slow' ? STATION_SECONDS : 0);
    for (const input of r.inputs) {
      if (input.tool === true) {
        if (!hasToolItem(input.anyOf)) total += unitOf(input.anyOf, soft);
      } else total += inputCost(input.anyOf, input.count * times, soft);
      if (total === Infinity) return Infinity;
    }
    return total;
  };

  /** The cheapest option for `rest` more of `item` (null: none can be completed). */
  const choose = (item: string, rest: number, soft: boolean): Option | null => {
    let chosen: Option | null = null;
    let best = Infinity;
    for (const o of optionsOf(ix, item)) {
      const c = evaluate(item, rest, o, soft);
      if (c < best) {
        best = c;
        chosen = o;
      }
    }
    return chosen;
  };

  /**
   * Why nothing can get `item`, following the first missing ingredient down (for the
   * planner). Digs blocked only by a tool are also listed as tool needs, with where the
   * blocks generate.
   */
  const explain = (item: string, depth = 0, seen = new Set<string>()): string => {
    const options = optionsOf(ix, item);
    if (options.length === 0) return 'no recipe or source known';
    seen.add(item);
    const blocked = options.flatMap((o) =>
      o.kind === 'source' && o.source.tool !== undefined && heldTool(o.source.tool) === null
        ? [o.source]
        : [],
    );
    for (const s of blocked) {
      const forWhat = `dig ${s.blocks.join(' or ')}`;
      if (s.tool !== undefined && !tools.some((t) => t.for === forWhat && t.get === null)) {
        tools.push({ for: forWhat, need: reqText(s.tool), have: null, get: null });
      }
    }
    const ownBlocks = new Set(blocked.flatMap((s) => s.blocks));
    const digs = blocked
      .slice(0, 2)
      .map(
        (s) =>
          `digging ${s.blocks.join(' or ')}${s.where === undefined ? '' : ` (${s.where})`} needs a ` +
          `${s.tool === undefined ? 'tool' : reqText(s.tool)}: none held, none known to make`,
      );
    const usable = options.flatMap((o) =>
      o.kind === 'recipe' && stationState(o.recipe.station) !== 'no' ? [o.recipe] : [],
    );
    let viaRecipe: string | null = null;
    if (usable.length === 0) {
      if (digs.length === 0) viaRecipe = 'made only in machines the agent cannot use';
    } else if (depth >= 4) {
      if (digs.length === 0)
        viaRecipe = 'every known recipe needs something with no known way to get it';
    } else {
      const missing = (r: RouteRecipe): RouteInput[] =>
        r.inputs.filter(
          (i) => !hasToolItem(i.anyOf) && table().cheapest(i.anyOf).cost === Infinity,
        );
      // Prefer the recipe a missing tool blocks most directly: that is what to fix first.
      const inputDepth = (i: RouteInput): number =>
        Math.min(...i.anyOf.slice(0, 8).map((v) => toolBlocked(v, 0)));
      const ranked = usable
        .map((r) => ({ r, miss: missing(r) }))
        .filter((x) => x.miss.length > 0)
        .map((x) => ({ ...x, d: Math.max(...x.miss.map(inputDepth)) }))
        // With blocked digs of its own, add a recipe only when another blocked dig is right
        // below it (e.g. a vein's raw ore to smelt, besides the item's own small ore).
        .filter(
          (x) =>
            digs.length === 0 ||
            (x.d <= 1 &&
              x.miss.some((i) =>
                i.anyOf
                  .slice(0, 8)
                  .some((v) =>
                    optionsOf(ix, v).some(
                      (o) =>
                        o.kind === 'source' &&
                        o.source.tool !== undefined &&
                        heldTool(o.source.tool) === null &&
                        o.source.blocks.some((b) => !ownBlocks.has(b)),
                    ),
                  ),
              )),
        )
        .sort((a, b) => a.d - b.d || a.miss.length - b.miss.length);
      for (const { r, miss } of ranked) {
        const input = [...miss].sort((a, b) => inputDepth(a) - inputDepth(b))[0];
        if (input === undefined) continue;
        const free = input.anyOf.filter((v) => !seen.has(v));
        const closest = [...free].sort((a, b) => toolBlocked(a, 0) - toolBlocked(b, 0))[0];
        const next =
          closest !== undefined && toolBlocked(closest, 0) < Infinity
            ? closest
            : (free.find((v) => optionsOf(ix, v).length > 0) ?? free[0]);
        if (next === undefined) continue;
        viaRecipe = `${r.id} needs ${input.label ?? next}: ${explain(next, depth + 1, seen)}`;
        break;
      }
      if (digs.length === 0) viaRecipe ??= 'every known recipe loops back to it';
    }
    const text = [...digs, ...(viaRecipe === null ? [] : [viaRecipe])].join('; or ');
    return text.length > 400 ? `${text.slice(0, 397)}...` : text;
  };
  /**
   * How many recipe steps above a dig that only a missing tool blocks `item` is (0: such a
   * dig gets it directly; Infinity: none within a few steps).
   */
  const blockedMemo = new Map<string, number>();
  const toolBlocked = (item: string, depth: number): number => {
    const known = blockedMemo.get(item);
    if (known !== undefined) return known;
    if (depth > 3) return Infinity;
    blockedMemo.set(item, Infinity);
    const options = optionsOf(ix, item);
    let result = options.some(
      (o) => o.kind === 'source' && o.source.tool !== undefined && heldTool(o.source.tool) === null,
    )
      ? 0
      : Infinity;
    if (result > 0) {
      for (const o of options) {
        if (o.kind !== 'recipe' || stationState(o.recipe.station) === 'no') continue;
        let worst = 0;
        for (const i of o.recipe.inputs) {
          if (hasToolItem(i.anyOf) || table().cheapest(i.anyOf).cost < Infinity) continue;
          worst = Math.max(
            worst,
            Math.min(...i.anyOf.slice(0, 8).map((v) => toolBlocked(v, depth + 1))) + 1,
          );
        }
        if (worst > 0) result = Math.min(result, worst);
      }
    }
    blockedMemo.set(item, result);
    return result;
  };

  const acquire = (
    item: string,
    n: number,
    depth: number,
    stack: Set<string>,
    purpose: string | undefined,
  ): void => {
    let rest = n - take(item, n);
    if (rest <= 0) return;
    rest -= fetch(item, rest);
    if (rest <= 0) return;
    if (depth > MAX_DEPTH || stack.has(item)) {
      add(unresolved, item, rest);
      why[item] ??= depth > MAX_DEPTH ? 'too deep a recipe tree' : 'its recipe loops back to it';
      return;
    }
    // When nothing completes, follow the recipe that gets closest (its missing leaves are
    // then reported precisely), unless the item's own dig is what a missing tool blocks.
    const chosen =
      choose(item, rest, false) ??
      (optionsOf(ix, item).some(
        (o) =>
          o.kind === 'source' && o.source.tool !== undefined && heldTool(o.source.tool) === null,
      )
        ? null
        : choose(item, rest, true));
    if (chosen === null) {
      add(unresolved, item, rest);
      why[item] ??= explain(item);
      return;
    }
    if (chosen.kind === 'source') {
      gather(item, rest, chosen.source, depth, purpose);
      return;
    }
    const recipe = chosen.recipe;
    const times = Math.ceil(rest / Math.max(1, recipe.output.count));
    stack.add(item);
    const toolNames: string[] = [];
    for (const input of recipe.inputs) {
      if (input.tool === true) toolNames.push(craftTool(input, recipe.id, depth, stack, purpose));
    }
    const uses: Record<string, number> = {};
    for (const input of recipe.inputs) {
      if (input.tool !== true)
        acquireAny(input.anyOf, input.count * times, depth + 1, stack, uses, purpose);
    }
    stack.delete(item);
    const last = legs[legs.length - 1];
    if (last?.kind === 'craft' && last.recipe === recipe.id && last.purpose === purpose) {
      // The same craft right after itself: one step.
      last.times += times;
      last.makes.count += times * recipe.output.count;
      for (const [k, v] of Object.entries(uses)) add(last.uses, k, v);
    } else {
      legs.push({
        kind: 'craft',
        recipe: recipe.id,
        times,
        makes: { item, count: times * recipe.output.count },
        station: recipe.station,
        uses,
        countKnown: recipe.countKnown !== false,
        tools: toolNames,
        ...(purpose === undefined ? {} : { purpose }),
      });
    }
    const surplus = times * recipe.output.count - rest;
    if (surplus > 0) spare.set(item, (spare.get(item) ?? 0) + surplus);
  };

  /** A crafting tool for a recipe: held, already got, or got now. Returns its name. */
  const craftTool = (
    input: RouteInput,
    recipeId: string,
    depth: number,
    stack: Set<string>,
    purpose: string | undefined,
  ): string => {
    const anyOf = input.anyOf;
    const have = anyOf.find((v) => available(v) > 0 || acquired.has(v));
    const need =
      input.label ??
      (anyOf.length > 3 ? `${anyOf.slice(0, 3).join(' | ')} | ...` : anyOf.join(' | '));
    if (have !== undefined) {
      if (!tools.some((t) => t.have === have && t.need === need)) {
        tools.push({ for: recipeId, need, have, get: null });
      }
      return have;
    }
    const pick = table().cheapest(anyOf.filter((v) => !toolItemsInProgress.has(v))).item;
    tools.push({ for: recipeId, need, have: null, get: pick });
    if (pick === null) {
      add(unresolved, anyOf[0] ?? 'tool', 1);
      why[anyOf[0] ?? 'tool'] ??= `a crafting tool for ${recipeId} that the book cannot make`;
      return anyOf[0] ?? 'tool';
    }
    toolItemsInProgress.add(pick);
    acquire(pick, 1, depth + 1, stack, purpose ?? `tool for ${recipeId}`);
    toolItemsInProgress.delete(pick);
    gotTool(pick);
    return pick;
  };

  const gather = (
    item: string,
    rest: number,
    source: RouteSource,
    depth: number,
    purpose: string | undefined,
  ): void => {
    const req = source.tool;
    if (req !== undefined) {
      const forWhat = `dig ${source.blocks.join(' or ')}`;
      const held = heldTool(req);
      if (held !== null) {
        // Once per dig (a tool got for it earlier in the route is already listed).
        if (!tools.some((t) => t.for === forWhat && t.need === reqText(req))) {
          tools.push({
            for: forWhat,
            need: reqText(req),
            have: held.item,
            get: null,
            ...(held.unverified ? { unverified: true } : {}),
          });
        }
      } else {
        const tool = bestTool(req, item);
        tools.push({ for: forWhat, need: reqText(req), have: null, get: tool?.item ?? null });
        if (tool !== null) {
          // A fresh stack: the tool may need the very item it will dig (got another way).
          toolReqsInProgress.add(reqKey(req));
          toolItemsInProgress.add(tool.item);
          acquire(tool.item, 1, depth + 1, new Set(), `tool: ${reqText(req)} to ${forWhat}`);
          toolItemsInProgress.delete(tool.item);
          toolReqsInProgress.delete(reqKey(req));
          gotTool(tool.item);
        }
      }
    }
    add(raw, item, rest);
    const leg = legs.find(
      (l) => l.kind === 'gather' && l.item === item && l.blocks === source.blocks,
    );
    if (leg !== undefined && leg.kind === 'gather') {
      leg.quantity += rest;
      leg.actions = Math.ceil(leg.quantity / source.perAction);
      if (source.secondsPerAction !== undefined) {
        const walk = leg.best === null ? 0 : leg.best.distance / WALK_BLOCKS_PER_SECOND;
        leg.minutes = roundMinutes(leg.actions * source.secondsPerAction + walk);
      }
      return;
    }
    const known = places(source.blocks, item);
    const actions = Math.ceil(rest / source.perAction);
    const best = known.find((p) => p.amount >= actions) ?? known[0] ?? null;
    legs.push({
      kind: 'gather',
      item,
      quantity: rest,
      via: source.via,
      blocks: source.blocks,
      actions,
      places: known.slice(0, MAX_PLACES),
      best,
      hint: source.blocks.map((b) => book.hints?.[b]).find((h) => h !== undefined) ?? null,
      minutes:
        source.secondsPerAction === undefined
          ? null
          : roundMinutes(
              actions * source.secondsPerAction +
                (best === null ? 0 : best.distance / WALK_BLOCKS_PER_SECOND),
            ),
      tool: req ?? null,
      where: source.where ?? null,
      ...(purpose === undefined ? {} : { purpose }),
    });
  };

  /**
   * Whether `item`'s raw material is seen nearby: a source of it with a known place, or a
   * recipe for it with an input that has one (birch planks: birch logs in view).
   */
  const seenNearby = (item: string): boolean => {
    const known = (v: string): boolean =>
      optionsOf(ix, v).some((o) => o.kind === 'source' && places(o.source.blocks, v).length > 0);
    if (known(item)) return true;
    return optionsOf(ix, item).some(
      (o) =>
        o.kind === 'recipe' &&
        o.recipe.inputs.some((i) => i.tool !== true && i.anyOf.slice(0, 8).some(known)),
    );
  };

  /**
   * Of kinds that do the same (any planks), the one cheapest to get `n` of now: what is held
   * one recipe down counts as free (birch logs held make birch planks the cheapest), then one
   * whose raw material is seen nearby, then the book's order; null when none can be had. Seen
   * live 2026-10-04: in a forest of other woods the route asked for oak, the first of equal
   * costs, and the bot walked from tree to tree until dark.
   */
  const cheapestNow = (kinds: readonly string[], n: number): string | null => {
    let best: { item: string; cost: number; seen: boolean } | null = null;
    for (const v of kinds.slice(0, MAX_KINDS_WEIGHED)) {
      let cost = Infinity;
      for (const o of optionsOf(ix, v)) cost = Math.min(cost, evaluate(v, n, o));
      if (cost === Infinity) continue;
      const seen = seenNearby(v);
      if (
        best === null ||
        cost < best.cost - COST_EPSILON ||
        (Math.abs(cost - best.cost) <= COST_EPSILON && seen && !best.seen)
      ) {
        best = { item: v, cost, seen };
      }
    }
    return best?.item ?? null;
  };

  /** `n` of any mix of `anyOf`: held ones first, then the cheapest kind to get. */
  const acquireAny = (
    anyOf: readonly string[],
    n: number,
    depth: number,
    stack: Set<string>,
    uses: Record<string, number>,
    purpose: string | undefined,
  ): void => {
    let rest = n;
    for (const v of anyOf) {
      if (rest <= 0) break;
      const have = available(v);
      if (have <= 0) continue;
      const used = Math.min(have, rest);
      acquire(v, used, depth, stack, purpose);
      add(uses, v, used);
      rest -= used;
    }
    if (rest <= 0) return;
    const open = anyOf.filter((v) => !stack.has(v));
    // The cheapest kind; if none can be had, the one a missing tool blocks most directly.
    const kind =
      cheapestNow(open, rest) ??
      table().cheapest(open).item ??
      [...open].sort((a, b) => toolBlocked(a, 0) - toolBlocked(b, 0))[0] ??
      anyOf[0];
    if (kind === undefined) return;
    acquire(kind, rest, depth, stack, purpose);
    add(uses, kind, rest);
  };

  /** "minecraft:furnace#1: 6 minecraft:cobblestone, 3 minecraft:flint (crafting_table)". */
  const makeText = (item: string): string | null => {
    let best: { recipe: RouteRecipe; cost: number } | null = null;
    for (const r of ix.recipes.get(item) ?? []) {
      const c = table().recipeUnit(r, stationState(r.station), hasToolItem);
      if (c < (best?.cost ?? Infinity)) best = { recipe: r, cost: c };
    }
    if (best === null) return null;
    const parts = best.recipe.inputs.map((i) => {
      const pick = table().cheapest(i.anyOf).item ?? i.anyOf[0] ?? '?';
      return i.tool === true ? `a ${i.label ?? pick} (tool)` : `${i.count} ${pick}`;
    });
    return `${best.recipe.id}: ${parts.join(', ')} (${best.recipe.station})`;
  };

  /**
   * The kinds a goal item may be had as: for an any-kind one, the item, the book's other kinds
   * of it and the kinds held (worn tools are kinds the book does not list); else the item.
   */
  const goalKinds = (item: string): string[] => {
    if (!anyKind.has(item)) return [item];
    const base = baseName(item);
    const held = Object.keys(inventory).filter((i) => baseName(i) === base);
    return [...new Set([item, ...(ix.kinds.get(base) ?? []), ...held])];
  };
  const stock: StockLine[] = Object.entries(goal)
    .filter(([, n]) => n > 0)
    .map(([item, need]) => {
      const kinds = goalKinds(item);
      const have = kinds.reduce((sum, k) => sum + (inventory[k] ?? 0), 0);
      const stored = storage.reduce(
        (sum, c) => sum + kinds.reduce((s, k) => s + (c.items[k] ?? 0), 0),
        0,
      );
      const line = { item, have, stored, need, missing: Math.max(0, need - have - stored) };
      return anyKind.has(item) ? { ...line, anyKind: true as const } : line;
    });
  for (const [item, n] of Object.entries(goal)) {
    if (n <= 0) continue;
    const kinds = goalKinds(item);
    if (kinds.length > 1) acquireAny(kinds, n, 0, new Set(), {}, undefined);
    else acquire(item, n, 0, new Set(), undefined);
  }
  const stationsUsed = [
    ...new Set(legs.flatMap((l) => (l.kind === 'craft' && l.station !== '2x2' ? [l.station] : []))),
  ];
  const stationNeeds: RouteStationNeed[] = stationsUsed.map((station) => {
    const item = ix.stationItems[station] ?? null;
    const status: RouteStationNeed['status'] =
      stationList?.has(station) === true
        ? 'available'
        : item !== null && (inventory[item] ?? 0) > 0
          ? 'held'
          : stationList === null
            ? 'unknown'
            : 'missing';
    return {
      station,
      status,
      item,
      make: status === 'available' || item === null ? null : makeText(item),
    };
  });
  return {
    goal: { ...goal },
    stock,
    fromInventory,
    fromStorage,
    raw,
    legs,
    unresolved,
    why,
    stations: stationsUsed,
    stationNeeds,
    tools,
  };
}

const roundMinutes = (seconds: number): number => Number((seconds / 60).toFixed(1));

/** The route in a few short lines for a planner (a small model reads it). */
export function describeRoute(route: Route): string[] {
  const lines: string[] = [];
  const list = (r: Record<string, number>): string =>
    Object.entries(r)
      .map(([item, n]) => `${n} ${item}`)
      .join(', ');
  lines.push(
    `stock: ${route.stock
      .map(
        (x) =>
          `${x.item}${x.anyKind === true ? ' (any kind)' : ''} have ${x.have}` +
          `${x.stored > 0 ? ` + ${x.stored} stored` : ''} / need ${x.need}`,
      )
      .join('; ')}`,
  );
  if (Object.keys(route.fromInventory).length > 0) {
    lines.push(`already held for this: ${list(route.fromInventory)}`);
  }
  if (Object.keys(route.raw).length > 0) lines.push(`raw materials to gather: ${list(route.raw)}`);
  for (const t of route.tools) {
    const state =
      t.have !== null
        ? `held: ${t.have}${t.unverified === true ? ' (its level is not known: check it)' : ''}`
        : t.get !== null
          ? `get ${t.get} first (steps marked "for: tool")`
          : 'none held and the book knows no way to make one';
    lines.push(`tool: ${t.need} for ${t.for}: ${state}`);
  }
  for (const s of route.stationNeeds) {
    if (s.status === 'available') continue;
    if (s.status === 'made') {
      const at = route.legs.findIndex((l) => l.kind === 'craft' && l.makes.item === s.item);
      lines.push(
        `note: no ${s.station} is known: step ${at + 1} makes one (${s.item}), placed right after`,
      );
      continue;
    }
    const make = s.make === null ? '' : `make one: ${s.make}, then place it`;
    const what =
      s.status === 'held'
        ? `${s.item ?? s.station} is held: place it`
        : s.status === 'missing'
          ? `none known${make === '' ? '' : `; ${make}`}`
          : `needed${make === '' ? '' : ` (if none is placed: ${make})`}`;
    lines.push(`station: ${s.station}: ${what}`);
  }
  route.legs.forEach((leg, i) => {
    const forTool =
      leg.kind !== 'withdraw' && leg.purpose !== undefined ? ` [for: ${leg.purpose}]` : '';
    if (leg.kind === 'withdraw') {
      const at =
        leg.where === null
          ? ''
          : ` at (${leg.where.x}, ${leg.where.y}, ${leg.where.z})` +
            (leg.distance === null ? '' : ` ${leg.distance.toFixed(0)} m away`);
      lines.push(`${i + 1}. withdraw ${leg.quantity} ${leg.item} from ${leg.containerId}${at}`);
    } else if (leg.kind === 'gather') {
      const place = (p: KnownPlace): string =>
        `${p.label === undefined ? '' : `${p.label} `}(${p.where.x}, ${p.where.y}, ${p.where.z}) ` +
        `${p.distance.toFixed(0)} m away, ~${p.amount} seen`;
      const where =
        leg.places.length === 0
          ? `no known place yet: explore${leg.hint === null ? '' : ` (look in ${leg.hint})`}`
          : `best: ${leg.best === null ? place(leg.places[0] as KnownPlace) : place(leg.best)}` +
            (leg.places.length > 1
              ? `; also ${leg.places
                  .filter((p) => p !== leg.best)
                  .map(place)
                  .join('; ')}`
              : '');
      const tool = leg.tool === null ? '' : `; needs a ${reqText(leg.tool)}`;
      const gen = leg.where === null ? '' : `; generates: ${leg.where}`;
      const verb = leg.via === 'kill' ? 'kill' : 'dig';
      lines.push(
        `${i + 1}. gather ${leg.quantity} ${leg.item}: ${verb} ${leg.blocks.join(' or ')} ` +
          `(~${leg.actions} ${verb === 'kill' ? 'kills' : 'digs'}` +
          `${leg.minutes === null ? '' : `, ~${leg.minutes} min`}${tool}); ` +
          `${where}${gen}${forTool}`,
      );
    } else {
      const count = leg.countKnown ? `${leg.makes.count}` : `>=${leg.makes.count}`;
      if (leg.station === 'furnace') {
        lines.push(
          `${i + 1}. smelt ${list(leg.uses)} -> ${count} ${leg.makes.item} ` +
            `(furnace; fuel for ${leg.times} items)${forTool}`,
        );
        return;
      }
      const extra = leg.tools.length > 0 ? `; tools ${leg.tools.join(', ')}` : '';
      lines.push(
        `${i + 1}. craft ${leg.recipe} x${leg.times} -> ${count} ${leg.makes.item} ` +
          `(${leg.station}; uses ${list(leg.uses)}${extra})${forTool}`,
      );
    }
  });
  if (Object.keys(route.unresolved).length > 0) {
    lines.push(`no known way to get: ${list(route.unresolved)}`);
    for (const [item, reason] of Object.entries(route.why)) {
      if (route.unresolved[item] !== undefined) lines.push(`  ${item}: ${reason}`);
    }
  }
  if (route.legs.length === 0 && Object.keys(route.unresolved).length === 0) {
    lines.push(EVERYTHING_HELD);
  }
  // Lines stay short enough for the planner request (a step is at most 500 characters).
  return lines.map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 3)}...` : l));
}
