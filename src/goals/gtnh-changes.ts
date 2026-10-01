import { loadKnowledge, type GtnhChange } from './knowledge.ts';
import type { Route } from './route.ts';

/**
 * The GTNH-vs-vanilla changes that matter for a route, as short lines for the planner
 * (request.gtnhChanges). The full table is the knowledge base's `changes` (generated from the
 * server's dumps, jars and configs; docs/gtnh-vs-vanilla.md); this picks the few entries that
 * concern what the route makes, uses, digs or needs, so a model that remembers vanilla
 * Minecraft is told where GTNH differs.
 */

/** Most changes one planner request carries. */
export const MAX_GTNH_CHANGES = 8;
/** Longest change line (the planner request's limit). */
export const MAX_GTNH_CHANGE_CHARS = 300;

/** Tool kinds a route can need ("pickaxe level >= 3"), matched against change keys. */
const TOOL_KIND = /^(pickaxe|shovel|axe|sword|hoe)\b/;

/** What a route touches: items it makes (and its goal), every item and block, tool kinds. */
interface RouteKeys {
  goal: ReadonlySet<string>;
  made: ReadonlySet<string>;
  smelted: ReadonlySet<string>;
  all: ReadonlySet<string>;
}

function routeKeys(route: Route): RouteKeys {
  const goal = new Set(Object.keys(route.goal));
  const made = new Set([...goal, ...Object.keys(route.unresolved)]);
  const smelted = new Set<string>();
  const all = new Set<string>([
    ...made,
    ...Object.keys(route.raw),
    ...Object.keys(route.fromInventory),
    ...Object.keys(route.fromStorage),
  ]);
  for (const leg of route.legs) {
    if (leg.kind === 'craft') {
      made.add(leg.makes.item);
      all.add(leg.makes.item);
      for (const item of Object.keys(leg.uses)) {
        all.add(item);
        if (leg.station === 'furnace') smelted.add(item);
      }
      for (const t of leg.tools) all.add(t);
    } else {
      all.add(leg.item);
      if (leg.kind === 'gather') {
        for (const b of leg.blocks) all.add(b);
        if (leg.tool !== null) all.add(leg.tool.kind);
      }
    }
  }
  for (const t of route.tools) {
    const kind = TOOL_KIND.exec(t.need)?.[1];
    if (kind !== undefined) all.add(kind);
    if (t.have !== null) all.add(t.have);
    if (t.get !== null) all.add(t.get);
  }
  for (const s of route.stationNeeds) if (s.item !== null) all.add(s.item);
  return { goal, made, smelted, all };
}

/**
 * How much a change matters for the route (lower first), or null when it does not concern it.
 * A recipe change counts only for an item the route makes (sharing an ingredient is not
 * enough); a smelting change for what the route smelts or makes; the rest for any item,
 * block or tool kind the route touches. `extra` (e.g. the inventory) adds keys at the end.
 */
function rank(c: GtnhChange, k: RouteKeys | null, extra: ReadonlySet<string>): number | null {
  const [first = '', second = ''] = c.keys;
  if (c.kind === 'recipe') {
    if (k === null || !k.made.has(first)) return null;
    return k.goal.has(first) ? 0 : 2;
  }
  if (c.kind === 'smelting') {
    if (k !== null && (k.made.has(second) || k.smelted.has(first))) return 3;
    return extra.has(first) ? 5 : null;
  }
  if (k !== null && c.keys.some((key) => k.all.has(key))) return c.kind === 'food' ? 4 : 1;
  return c.keys.some((key) => extra.has(key)) ? 5 : null;
}

/**
 * The changes that concern `route` (null: no route), most relevant first, at most
 * MAX_GTNH_CHANGES lines. `extra` names more items that matter (e.g. what the player holds).
 */
export function selectGtnhChanges(
  changes: readonly GtnhChange[],
  route: Route | null,
  extra: Iterable<string> = [],
): string[] {
  const keys = route === null ? null : routeKeys(route);
  const more = new Set(extra);
  const picked: Array<{ line: string; rank: number; order: number }> = [];
  const seen = new Set<string>();
  changes.forEach((c, order) => {
    const r = rank(c, keys, more);
    if (r === null) return;
    const line =
      c.change.length > MAX_GTNH_CHANGE_CHARS
        ? `${c.change.slice(0, MAX_GTNH_CHANGE_CHARS - 3)}...`
        : c.change;
    if (seen.has(line)) return;
    seen.add(line);
    picked.push({ line, rank: r, order });
  });
  return picked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MAX_GTNH_CHANGES)
    .map((p) => p.line);
}

/**
 * The changes that concern `route`, from the knowledge base (empty when it cannot be
 * loaded: the route book then warns and plans from hand-verified recipes only).
 */
export function gtnhChangesFor(route: Route | null, extra: Iterable<string> = []): string[] {
  let changes: readonly GtnhChange[];
  try {
    changes = loadKnowledge().changes;
  } catch {
    return [];
  }
  return selectGtnhChanges(changes, route, extra);
}
