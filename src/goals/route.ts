/**
 * Routes: what a goal needs, calculated exactly, and in which order to get it.
 *
 * Given a goal (items and counts), the inventory, a recipe book and the ways items can be
 * gathered, the route expands every item the inventory does not already cover into its
 * recipe tree (ingredients before what they make; GITM-style post-order), adds up the raw
 * materials to gather, and attaches where each raw material is known to be (from what the
 * agent has seen). Items with no known recipe or source are reported as unresolved. Pure
 * and general: nothing here is specific to GTNH; the book and the places are data.
 *
 * The route is information for the planner (a model), which decides what to do with it.
 */

export interface RouteRecipe {
  id: string;
  output: { item: string; count: number };
  /** Per craft: how many of any mix of `anyOf`. */
  inputs: ReadonlyArray<{ anyOf: readonly string[]; count: number }>;
  /** Where it is made: '2x2' (the player's own grid), 'crafting_table', 'furnace', ... */
  station: string;
}

/** A way to gather an item from the world: dig one of `blocks`, `perAction` items each. */
export interface RouteSource {
  item: string;
  via: 'dig';
  blocks: readonly string[];
  /** Items one action yields on average (e.g. 4 clay balls per clay block, 0.1 flint per gravel). */
  perAction: number;
  /** About how long one action takes, in seconds (dig time plus a short step), if known. */
  secondsPerAction?: number;
}

export interface RouteBook {
  recipes: readonly RouteRecipe[];
  sources: readonly RouteSource[];
  /** Where to look for a block when none is known yet (general knowledge, e.g. biomes). */
  hints?: Readonly<Record<string, string>>;
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
export type PlaceLookup = (blocks: readonly string[]) => KnownPlace[];

export type RouteLeg =
  | {
      kind: 'gather';
      item: string;
      quantity: number;
      /** Blocks to dig, and about how many digs. */
      blocks: readonly string[];
      actions: number;
      places: KnownPlace[];
      /** The known place to use: the nearest one with enough seen for the whole leg. */
      best: KnownPlace | null;
      /** Where to look when no place is known (from the book's hints). */
      hint: string | null;
      /** Rough minutes: digging plus walking to the best place (null when unknown). */
      minutes: number | null;
    }
  | {
      kind: 'craft';
      recipe: string;
      times: number;
      makes: { item: string; count: number };
      station: string;
      /** What these crafts consume, in total. */
      uses: Record<string, number>;
    };

/** One goal item: how many are held, how many the goal needs, how many are missing. */
export interface StockLine {
  item: string;
  have: number;
  need: number;
  missing: number;
}

export interface Route {
  goal: Record<string, number>;
  /** Taking stock of the goal itself: have vs need per item. */
  stock: StockLine[];
  /** What the inventory already covers (and the route reserves for the goal). */
  fromInventory: Record<string, number>;
  /** Raw materials to gather, in total. */
  raw: Record<string, number>;
  /** Steps in order: ingredients are always gathered or crafted before what they make. */
  legs: RouteLeg[];
  /** Items with no known recipe or source (or a recipe loop): the route cannot cover them. */
  unresolved: Record<string, number>;
  /** Stations the crafts need (e.g. 'crafting_table'). */
  stations: string[];
}

const MAX_DEPTH = 16;
const MAX_PLACES = 3;
/** Walking speed used for time estimates (blocks per second; the walker's pace). */
const WALK_BLOCKS_PER_SECOND = 4;

export function planRoute(
  goal: Readonly<Record<string, number>>,
  inventory: Readonly<Record<string, number>>,
  book: RouteBook,
  places: PlaceLookup = () => [],
): Route {
  const pool = new Map(Object.entries(inventory).filter(([, n]) => n > 0));
  const fromInventory: Record<string, number> = {};
  const raw: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  const legs: RouteLeg[] = [];
  const add = (into: Record<string, number>, item: string, n: number): void => {
    into[item] = (into[item] ?? 0) + n;
  };
  const recipesFor = (item: string): RouteRecipe[] =>
    book.recipes.filter((r) => r.output.item === item);
  const sourceFor = (item: string): RouteSource | undefined =>
    book.sources.find((s) => s.item === item);
  /** Takes up to `n` of `item` from the pool; returns how many were taken. */
  const take = (item: string, n: number): number => {
    const have = pool.get(item) ?? 0;
    const used = Math.min(have, n);
    if (used > 0) {
      pool.set(item, have - used);
      add(fromInventory, item, used);
    }
    return used;
  };
  // Whether an item can be had at all (held, gathered, or crafted from obtainable inputs).
  // Memoized per item: big books with many interchangeable kinds stay fast.
  const memo = new Map<string, boolean>();
  const obtainable = (item: string, stack: ReadonlySet<string>, depth: number): boolean => {
    if ((pool.get(item) ?? 0) > 0 || sourceFor(item) !== undefined) return true;
    if (depth >= MAX_DEPTH || stack.has(item)) return false;
    const cached = memo.get(item);
    if (cached !== undefined) return cached;
    const inner = new Set([...stack, item]);
    const result = recipesFor(item).some((r) =>
      r.inputs.every((i) => i.anyOf.some((v) => obtainable(v, inner, depth + 1))),
    );
    memo.set(item, result);
    return result;
  };

  const acquire = (item: string, n: number, depth: number, stack: Set<string>): void => {
    const rest = n - take(item, n);
    if (rest <= 0) return;
    if (depth > MAX_DEPTH || stack.has(item)) {
      add(unresolved, item, rest);
      return;
    }
    // Prefer a recipe whose inputs can all be obtained; else gather; else any recipe.
    const recipes = recipesFor(item);
    const recipe =
      recipes.find((r) =>
        r.inputs.every((i) => i.anyOf.some((v) => obtainable(v, new Set([...stack, item]), depth))),
      ) ?? (sourceFor(item) === undefined ? recipes[0] : undefined);
    if (recipe !== undefined) {
      const times = Math.ceil(rest / recipe.output.count);
      stack.add(item);
      const uses: Record<string, number> = {};
      for (const input of recipe.inputs) {
        acquireAny(input.anyOf, input.count * times, depth + 1, stack, uses);
      }
      stack.delete(item);
      legs.push({
        kind: 'craft',
        recipe: recipe.id,
        times,
        makes: { item, count: times * recipe.output.count },
        station: recipe.station,
        uses,
      });
      const surplus = times * recipe.output.count - rest;
      if (surplus > 0) pool.set(item, (pool.get(item) ?? 0) + surplus);
      return;
    }
    const source = sourceFor(item);
    if (source !== undefined) {
      add(raw, item, rest);
      const leg = legs.find((l) => l.kind === 'gather' && l.item === item);
      if (leg !== undefined && leg.kind === 'gather') {
        leg.quantity += rest;
        leg.actions = Math.ceil(leg.quantity / source.perAction);
        if (source.secondsPerAction !== undefined) {
          const walk = leg.best === null ? 0 : leg.best.distance / WALK_BLOCKS_PER_SECOND;
          leg.minutes = roundMinutes(leg.actions * source.secondsPerAction + walk);
        }
      } else {
        const known = places(source.blocks);
        const actions = Math.ceil(rest / source.perAction);
        const best = known.find((p) => p.amount >= actions) ?? known[0] ?? null;
        legs.push({
          kind: 'gather',
          item,
          quantity: rest,
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
        });
      }
      return;
    }
    add(unresolved, item, rest);
  };

  /** `n` of any mix of `anyOf`: held ones first, then the first obtainable kind. */
  const acquireAny = (
    anyOf: readonly string[],
    n: number,
    depth: number,
    stack: Set<string>,
    uses: Record<string, number>,
  ): void => {
    let rest = n;
    for (const v of anyOf) {
      if (rest <= 0) break;
      const have = pool.get(v) ?? 0;
      if (have <= 0) continue;
      const used = Math.min(have, rest);
      // Reserve without counting it as "from inventory" twice: acquire() does the taking.
      acquire(v, used, depth, stack);
      add(uses, v, used);
      rest -= used;
    }
    if (rest <= 0) return;
    const kind = anyOf.find((v) => obtainable(v, stack, depth)) ?? anyOf[0];
    if (kind === undefined) return;
    acquire(kind, rest, depth, stack);
    add(uses, kind, rest);
  };

  const stock: StockLine[] = Object.entries(goal)
    .filter(([, n]) => n > 0)
    .map(([item, need]) => {
      const have = inventory[item] ?? 0;
      return { item, have, need, missing: Math.max(0, need - have) };
    });
  for (const [item, n] of Object.entries(goal)) if (n > 0) acquire(item, n, 0, new Set());
  const stations = [
    ...new Set(legs.flatMap((l) => (l.kind === 'craft' && l.station !== '2x2' ? [l.station] : []))),
  ];
  return { goal: { ...goal }, stock, fromInventory, raw, legs, unresolved, stations };
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
    `stock: ${route.stock.map((x) => `${x.item} have ${x.have} / need ${x.need}`).join('; ')}`,
  );
  if (Object.keys(route.fromInventory).length > 0) {
    lines.push(`already held for this: ${list(route.fromInventory)}`);
  }
  if (Object.keys(route.raw).length > 0) lines.push(`raw materials to gather: ${list(route.raw)}`);
  route.legs.forEach((leg, i) => {
    if (leg.kind === 'gather') {
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
      lines.push(
        `${i + 1}. gather ${leg.quantity} ${leg.item}: dig ${leg.blocks.join(' or ')} ` +
          `(~${leg.actions} digs${leg.minutes === null ? '' : `, ~${leg.minutes} min`}); ${where}`,
      );
    } else {
      lines.push(
        `${i + 1}. craft ${leg.recipe} x${leg.times} -> ${leg.makes.count} ${leg.makes.item} ` +
          `(${leg.station}; uses ${list(leg.uses)})`,
      );
    }
  });
  if (Object.keys(route.unresolved).length > 0) {
    lines.push(`no known way to get: ${list(route.unresolved)}`);
  }
  if (route.legs.length === 0 && Object.keys(route.unresolved).length === 0) {
    lines.push('everything the goal needs is already held');
  }
  return lines;
}
