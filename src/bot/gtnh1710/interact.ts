import {
  blockUse,
  PROFILE_IDS,
  slotGroup,
  type ProfileId,
  type SlotRole,
  type WindowLayout,
} from '../../domain/interactions.ts';
import type { ChunkStore } from './chunk-data.ts';
import { applyClick, countItem, type Click, type Stack, type WindowSnapshot } from './container.ts';
import type { ClickPlan, ItemKey, Planned } from './crafting.ts';
import { reachTo } from './digging.ts';
import type { Registry } from './registry.ts';
import { standProblem } from './terrain.ts';
import type { Fence, Vec3, WalkWorld } from './walking.ts';

/**
 * Generic window work for blocks with an interaction profile (src/domain/interactions.ts),
 * and the scan that finds such blocks. Pure: no I/O. The profile decides everything that
 * differs between blocks (layout, which slots take or give items); nothing here knows a
 * furnace from a chest.
 *
 * Like chests and crafting, only clicks whose result the client can predict exactly are
 * used (container.ts): pick up a whole stack, put a whole stack into an EMPTY slot, or
 * place ONE item at a time, never past the largest stack of that item the window has
 * shown (so an item's unknown stack limit never matters). Stacks with NBT data are never
 * touched, and every plan ends with an empty cursor.
 */

/** The client only right-clicks blocks this close to its eyes (the server allows 8). */
export const MAX_INTERACT_REACH = 4.5;

/** Blocks around the feet searched for interactable blocks (a sphere). */
export const INTERACT_SCAN_RADIUS = 16;

/** Interactable table code for an allowlisted block without a profile. */
export const OBSERVE_ONLY_CODE = 255;

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/**
 * Registry id -> 1 + index in PROFILE_IDS for a block with a usable profile, OBSERVE_ONLY_CODE
 * for one the observe-only patterns allow, 0 otherwise. Ids are per world: rebuilt from
 * each login's registry. Profiles that are never opened (a trapped chest) map to 0.
 */
export function buildInteractableTable(
  registry: Registry,
  observePatterns: readonly string[],
): Uint8Array {
  const table = new Uint8Array(65536);
  for (const [id, name] of registry.blocks) {
    if (id <= 0 || id >= 65536) continue;
    const use = blockUse(name, observePatterns);
    if (use.kind === 'profile') table[id] = PROFILE_IDS.indexOf(use.profile.id) + 1;
    else if (use.kind === 'observe-only') table[id] = OBSERVE_ONLY_CODE;
  }
  return table;
}

/** The profile id (or null for observe-only) a table code stands for; undefined for 0. */
export function codeProfile(code: number): ProfileId | null | undefined {
  if (code === 0) return undefined;
  if (code === OBSERVE_ONLY_CODE) return null;
  return PROFILE_IDS[code - 1];
}

export interface FoundInteractable {
  profile: ProfileId | null;
  blockId: number;
  position: { x: number; y: number; z: number };
  distance: number;
}

export type InteractableScan =
  { ok: true; scanRadius: number; blocks: FoundInteractable[] } | { ok: false; reason: string };

/**
 * Interactable blocks within a sphere around the feet, nearest first (ties by position).
 * Like a player, only blocks with a face open to air are seen. Fail closed: a column in
 * range that has not arrived, or could not be decoded, makes the scan unknown. At most `max`
 * are listed; beyond that the declared radius shrinks below the first block left out.
 */
export function scanInteractables(
  store: ChunkStore,
  table: Uint8Array,
  feet: { x: number; y: number; z: number },
  radius = INTERACT_SCAN_RADIUS,
  max = 32,
): InteractableScan {
  const r2 = radius * radius;
  const minX = Math.floor(feet.x - radius);
  const maxX = Math.floor(feet.x + radius);
  const minZ = Math.floor(feet.z - radius);
  const maxZ = Math.floor(feet.z + radius);
  const minY = Math.max(0, Math.floor(feet.y - radius));
  const maxY = Math.min(255, Math.floor(feet.y + radius));
  let missing = 0;
  for (let cx = Math.floor(minX / 16); cx <= Math.floor(maxX / 16); cx++) {
    for (let cz = Math.floor(minZ / 16); cz <= Math.floor(maxZ / 16); cz++) {
      const problem = store.problem(cx, cz);
      if (problem === undefined) missing += 1;
      else if (problem !== null) {
        return fail(`chunk ${cx},${cz} block data unusable: ${problem}`);
      }
    }
  }
  if (missing > 0) return fail(`waiting for ${missing} nearby chunk(s) of block data`);

  const exposed = (x: number, y: number, z: number): boolean =>
    store.blockAt(x + 1, y, z) === 0 ||
    store.blockAt(x - 1, y, z) === 0 ||
    store.blockAt(x, y + 1, z) === 0 ||
    store.blockAt(x, y - 1, z) === 0 ||
    store.blockAt(x, y, z + 1) === 0 ||
    store.blockAt(x, y, z - 1) === 0;

  const found: FoundInteractable[] = [];
  for (let x = minX; x <= maxX; x++) {
    const dx = x + 0.5 - feet.x;
    for (let z = minZ; z <= maxZ; z++) {
      const dz = z + 0.5 - feet.z;
      const h2 = dx * dx + dz * dz;
      if (h2 > r2) continue;
      const sections = store.columnSections(Math.floor(x / 16), Math.floor(z / 16));
      if (sections === undefined) return fail('chunk block data changed during the scan');
      for (let y = minY; y <= maxY; y++) {
        const section = sections[y >> 4];
        if (section === null || section === undefined) {
          y = y | 15; // an all-air section
          continue;
        }
        const id = section[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] as number;
        if (id === 0) continue;
        const profile = codeProfile(table[id] ?? 0);
        if (profile === undefined) continue;
        const dy = y + 0.5 - feet.y;
        const d2 = h2 + dy * dy;
        if (d2 > r2 || !exposed(x, y, z)) continue;
        found.push({ profile, blockId: id, position: { x, y, z }, distance: Math.sqrt(d2) });
      }
    }
  }
  found.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.position.x - b.position.x ||
      a.position.y - b.position.y ||
      a.position.z - b.position.z,
  );
  if (found.length <= max) return { ok: true, scanRadius: radius, blocks: found };
  const firstLeftOut = (found[max] as FoundInteractable).distance;
  const kept = found.slice(0, max).filter((f) => f.distance < firstLeftOut);
  const coverage = Math.max(0, Math.floor((firstLeftOut - 1e-6) * 1000) / 1000);
  return { ok: true, scanRadius: coverage, blocks: kept };
}

// ---------------------------------------------------------------------------
// Where the agent may use a block: reach and the fence
// ---------------------------------------------------------------------------

const fmt = (p: { x: number; y: number; z: number }): string => `(${p.x}, ${p.y}, ${p.z})`;

/**
 * Why a block may not be used as an interaction target in this fence, or null. Inside the
 * fence's columns, from one block below its lowest feet level (a block in the floor) to two
 * above its highest (head height).
 */
export function interactAreaProblem(
  fence: Fence | null,
  target: { x: number; y: number; z: number },
): string | null {
  if (fence === null) return null;
  const { x, y, z } = target;
  if (x < fence.min.x || x > fence.max.x || z < fence.min.z || z > fence.max.z) {
    return `${fmt(target)} is outside the fence's columns`;
  }
  if (y < fence.min.y - 1 || y > fence.max.y + 2) {
    return `${fmt(target)} is outside the fence's heights y=${fence.min.y - 1}..${fence.max.y + 2}`;
  }
  return null;
}

/** Feet heights tried for a stand spot, relative to the block: beside it, on it, below it. */
const STAND_HEIGHTS = [0, 1, -1] as const;

/**
 * Where the player can stand to use the block at `target`: feet at the centre of one of the
 * 8 columns around it, standable by the terrain rules, inside the fence, within reach of
 * the eyes. The spot nearest to `from`; null when there is none.
 */
export function interactStandSpot(
  world: WalkWorld,
  fence: Fence,
  target: { x: number; y: number; z: number },
  from: Vec3,
): Vec3 | null {
  let best: { spot: Vec3; d: number } | null = null;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dz === 0) continue;
      const fx = target.x + dx;
      const fz = target.z + dz;
      if (fx < fence.min.x || fx > fence.max.x || fz < fence.min.z || fz > fence.max.z) continue;
      for (const dy of STAND_HEIGHTS) {
        const fy = target.y + dy;
        if (fy < fence.min.y || fy > fence.max.y) continue;
        if (standProblem(world, fx, fy, fz) !== null) continue;
        const spot = { x: fx + 0.5, y: fy, z: fz + 0.5 };
        if (reachTo(spot, target) > MAX_INTERACT_REACH + 1e-9) continue;
        const d = Math.hypot(spot.x - from.x, spot.y - from.y, spot.z - from.z);
        if (best === null || d < best.d - 1e-9) best = { spot, d };
      }
    }
  }
  return best?.spot ?? null;
}

// ---------------------------------------------------------------------------
// Window work from a profile's layout
// ---------------------------------------------------------------------------

/** The player's 36 slots in a window with this layout (main inventory, then hotbar). */
export function playerRangeOf(layout: WindowLayout): [number, number] {
  return [layout.containerSlots, layout.containerSlots + 35];
}

const sameKind = (s: Stack, item: ItemKey): boolean =>
  !s.hasNbt && s.id === item.id && s.damage === item.damage;

/**
 * The largest NBT-free stack of `item` the window shows (player slots and `extra`), capped
 * at 64: a stack that exists proves the item stacks at least that high.
 */
export function provenStackBound(
  w: WindowSnapshot,
  range: [number, number],
  item: ItemKey,
  extra: readonly number[] = [],
): number {
  let bound = 0;
  const look = (i: number): void => {
    const s = w.slots[i];
    if (s != null && sameKind(s, item)) bound = Math.max(bound, s.count);
  };
  for (let i = range[0]; i <= range[1]; i++) look(i);
  for (const i of extra) look(i);
  return Math.min(64, bound);
}

/** How many of `item` the player has in this window: its 36 slots plus the cursor. */
export function playerCount(w: WindowSnapshot, layout: WindowLayout, item: ItemKey): number {
  const onCursor = w.cursor !== null && sameKind(w.cursor, item) ? w.cursor.count : 0;
  return countItem(w, playerRangeOf(layout), item) + onCursor;
}

/**
 * Clicks that move exactly `quantity` of `item` from the player's slots into ONE container
 * slot that the layout lets the agent fill (`put`). The slot must be empty or already hold
 * the same item, and it never gets more than the largest stack of the item the window has
 * shown. Stacks are taken in slot order: pick one up, put it down whole into the empty slot
 * when it fits, else place one item per right-click, then put the rest back where it came
 * from.
 */
export function planInsert(
  w: WindowSnapshot,
  layout: WindowLayout,
  target: number,
  item: ItemKey,
  quantity: number,
): Planned<ClickPlan> {
  if (w.cursor !== null) return fail('the cursor is not empty');
  if (!Number.isInteger(quantity) || quantity < 1) return fail('bad quantity');
  const group = slotGroup(layout, target);
  if (group === null || !group.put) return fail(`slot ${target} does not take items`);
  const range = playerRangeOf(layout);
  const current = w.slots[target];
  if (current === undefined) return fail(`slot ${target} does not exist`);
  if (current !== null && !sameKind(current, item)) {
    return fail(
      `the ${group.role} slot holds something else (item ${current.id}@${current.damage}${current.hasNbt ? ' with NBT data' : ''})`,
    );
  }
  const start = current?.count ?? 0;
  const bound = provenStackBound(w, range, item, [target]);
  if (start + quantity > bound) {
    return fail(
      `the ${group.role} slot would hold ${start + quantity}, more than the largest stack of this item seen (${bound})`,
    );
  }
  const available = countItem(w, range, item);
  if (available < quantity) {
    return fail(`only ${available} available without NBT data, need ${quantity}`);
  }

  const clicks: Click[] = [];
  let window = w;
  const click = (c: Click): string | null => {
    const r = applyClick(window, c);
    if (!r.ok) return r.reason;
    clicks.push(c);
    window = r.window;
    return null;
  };
  let remaining = quantity;
  while (remaining > 0) {
    let source: number | null = null;
    for (let i = range[0]; i <= range[1]; i++) {
      const s = window.slots[i];
      if (s != null && sameKind(s, item)) {
        source = i;
        break;
      }
    }
    if (source === null) return fail('internal: the source ran out');
    const pick = click({ slot: source, button: 0 });
    if (pick !== null) return fail(pick);
    const held = window.cursor;
    if (held === null) return fail('internal: nothing was picked up');
    if (window.slots[target] === null && held.count <= remaining) {
      const put = click({ slot: target, button: 0 });
      if (put !== null) return fail(put);
      remaining -= held.count;
      continue;
    }
    const k = Math.min(remaining, held.count);
    for (let n = 0; n < k; n++) {
      const one = click({ slot: target, button: 1 });
      if (one !== null) return fail(one);
    }
    remaining -= k;
    if (window.cursor !== null) {
      const back = click({ slot: source, button: 0 });
      if (back !== null) return fail(back);
    }
  }
  if (window.cursor !== null) return fail('internal: the plan ends with a full cursor');
  return { ok: true, value: { clicks, after: window } };
}

/**
 * Clicks that take the WHOLE stack in a container slot the layout lets the agent empty
 * (`take`) and put it into the first EMPTY player slot. Never merged into another stack.
 */
export function planTakeAll(
  w: WindowSnapshot,
  layout: WindowLayout,
  source: number,
): Planned<ClickPlan & { taken: Stack }> {
  if (w.cursor !== null) return fail('the cursor is not empty');
  const group = slotGroup(layout, source);
  if (group === null || !group.take) return fail(`slot ${source} does not give items`);
  const s = w.slots[source];
  if (s == null) return fail(`the ${group.role} slot is empty`);
  if (s.hasNbt) return fail(`the ${group.role} slot holds a stack with NBT data`);
  const range = playerRangeOf(layout);
  let empty: number | null = null;
  for (let i = range[0]; i <= range[1]; i++) {
    if (w.slots[i] === null) {
      empty = i;
      break;
    }
  }
  if (empty === null) return fail(`no empty inventory slot for the ${group.role}`);
  const clicks: Click[] = [
    { slot: source, button: 0 },
    { slot: empty, button: 0 },
  ];
  let window = w;
  for (const c of clicks) {
    const r = applyClick(window, c);
    if (!r.ok) return fail(r.reason);
    window = r.window;
  }
  return { ok: true, value: { clicks, after: window, taken: s } };
}

/** The role of a window slot under a profile layout: a container slot's role, else null. */
export function roleOf(layout: WindowLayout | null, slot: number): SlotRole | null {
  if (layout === null || slot >= layout.containerSlots) return null;
  return slotGroup(layout, slot)?.role ?? null;
}

/** True when every container slot of the layout takes (`put`) or gives (`take`) items. */
export function allSlots(layout: WindowLayout, access: 'put' | 'take'): boolean {
  return layout.groups.every((g) => g[access]);
}
