import type { Action, Postcondition } from '../domain/actions.ts';
import type { ClientActionResult } from '../bot/minecraft-client.ts';
import type { GameState, InteractableBlock } from '../domain/game-state.ts';
import { distance, formatPosition } from '../domain/geometry.ts';
import { COMPASS } from '../domain/world-memory.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerificationResult {
  verified: boolean;
  postcondition: Postcondition;
  checks: VerificationCheck[];
}

export interface VerifyInput {
  action: Action;
  before: GameState;
  /** Fresh observation after execution, or null if observing failed. */
  after: GameState | null;
  execution: ClientActionResult;
  ctx: SafetyContext;
}

/**
 * Compares the observed world against the action's expected postcondition.
 * Everything is fail-closed: an unknown value, a missing observation or a
 * failed execution all mean "not verified".
 */
export function verifyPostcondition(input: VerifyInput): VerificationResult {
  const { action, before, after, execution, ctx } = input;
  const post = action.expectedPostcondition;
  const checks: VerificationCheck[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
  };
  const done = (): VerificationResult => ({
    verified: checks.length > 0 && checks.every((c) => c.passed),
    postcondition: post,
    checks,
  });

  check('execution-ok', execution.ok, `${execution.code}: ${execution.message}`);
  if (after === null) {
    check('observed-after', false, 'no observation after execution');
    return done();
  }
  const beforeMs = Date.parse(before.timestamp);
  const afterMs = Date.parse(after.timestamp);
  check(
    'observation-fresh',
    afterMs >= beforeMs,
    `after ${after.timestamp} vs before ${before.timestamp}`,
  );

  const inv = (s: GameState, item: string): number | null =>
    s.inventory.known ? (s.inventory.value.items[item] ?? 0) : null;

  switch (post.kind) {
    case 'STATE_OBSERVED':
      break;

    case 'PLAYER_NEAR':
    case 'AT_SAFE_LOCATION': {
      const target =
        post.kind === 'PLAYER_NEAR'
          ? post.target
          : (ctx.locations.get(post.locationName)?.position ?? null);
      const tolerance = post.kind === 'PLAYER_NEAR' ? post.tolerance : ctx.config.interactionReach;
      if (target === null) {
        check(
          'target-known',
          false,
          `location ${post.kind === 'AT_SAFE_LOCATION' ? post.locationName : ''} unknown`,
        );
        break;
      }
      if (!after.player.position.known) {
        check('player-near-target', false, 'player position unknown after move');
        break;
      }
      const d = distance(after.player.position.value, target);
      check(
        'player-near-target',
        d <= tolerance,
        `${d.toFixed(2)} blocks from ${formatPosition(target)} (tolerance ${tolerance})`,
      );
      break;
    }

    case 'EXPLORED': {
      // Progress along the heading: toward the point (from where the player started), or in
      // the compass direction. The walk itself is bounded by maxDistance.
      if (!before.player.position.known || !after.player.position.known) {
        check('explored-progress', false, 'player position unknown before or after exploring');
        break;
      }
      const b = before.player.position.value;
      const a = after.player.position.value;
      const heading =
        typeof post.toward === 'string'
          ? COMPASS[post.toward]
          : { x: post.toward.x - b.x, z: post.toward.z - b.z };
      const length = Math.hypot(heading.x, heading.z);
      const progress =
        length < 1e-9 ? 0 : ((a.x - b.x) * heading.x + (a.z - b.z) * heading.z) / length;
      const moved = Math.hypot(a.x - b.x, a.z - b.z);
      const where =
        typeof post.toward === 'string' ? post.toward : `(${post.toward.x}, ${post.toward.z})`;
      check(
        'explored-progress',
        progress >= 1,
        `${progress.toFixed(1)} blocks farther toward ${where} (at least 1)`,
      );
      check(
        'explored-bounded',
        moved <= post.maxDistance + 0.5,
        `${moved.toFixed(1)} blocks from the start (maxDistance ${post.maxDistance})`,
      );
      break;
    }

    case 'TIME_ELAPSED':
      check(
        'time-elapsed',
        afterMs - beforeMs >= post.minMs,
        `${afterMs - beforeMs} ms elapsed, expected >= ${post.minMs}`,
      );
      break;

    case 'FOOD_CONSUMED': {
      const b = inv(before, post.item);
      const a = inv(after, post.item);
      check(
        'food-item-decreased',
        b !== null && a !== null && a === b - 1,
        `${post.item}: ${b} -> ${a}`,
      );
      const hb = before.player.hunger.known ? before.player.hunger.value : null;
      const ha = after.player.hunger.known ? after.player.hunger.value : null;
      check('hunger-not-lower', hb !== null && ha !== null && ha >= hb, `hunger ${hb} -> ${ha}`);
      break;
    }

    case 'CONTAINER_OPEN':
      check(
        'container-open',
        after.openContainerId === post.containerId,
        `open container: ${after.openContainerId}`,
      );
      break;

    case 'ITEMS_MOVED': {
      const sign = post.direction === 'player_to_container' ? -1 : 1;
      const b = inv(before, post.item);
      const a = inv(after, post.item);
      check(
        'player-inventory-delta',
        b !== null && a !== null && a - b === sign * post.quantity,
        `${post.item}: ${b} -> ${a}, expected change ${sign * post.quantity}`,
      );
      // Container side is checked only when observable both before and after.
      const cb = before.storage.find((s) => s.id === post.containerId);
      const ca = after.storage.find((s) => s.id === post.containerId);
      if (cb?.items.known && ca?.items.known) {
        const qb = cb.items.value[post.item] ?? 0;
        const qa = ca.items.value[post.item] ?? 0;
        check(
          'container-delta',
          qa - qb === -sign * post.quantity,
          `${post.containerId}: ${qb} -> ${qa}`,
        );
      }
      break;
    }

    case 'MACHINE_INSPECTED': {
      const m = after.machines.find((x) => x.id === post.machineId);
      const fresh =
        m?.lastInspectedAt != null && Date.parse(m.lastInspectedAt) >= Date.parse(action.timestamp);
      check('machine-inspected', fresh, `lastInspectedAt: ${m?.lastInspectedAt ?? 'missing'}`);
      break;
    }

    case 'GENERATOR_REFUELED': {
      const b = inv(before, post.fuelItem);
      const a = inv(after, post.fuelItem);
      check(
        'fuel-left-inventory',
        b !== null && a !== null && b - a === post.quantity,
        `${post.fuelItem}: ${b} -> ${a}, expected -${post.quantity}`,
      );
      const g = after.power.generators.find((x) => x.id === post.generatorId);
      check(
        'generator-has-fuel',
        g !== undefined && g.status !== 'out_of_fuel',
        `generator status: ${g?.status ?? 'missing'}`,
      );
      break;
    }

    case 'BLOCK_REMOVED': {
      const p = post.position;
      const where = formatPosition(p);
      if (!after.nearbyBlocks.known) {
        check(
          'block-removed',
          false,
          `nearby blocks unknown after digging: ${after.nearbyBlocks.reason}`,
        );
        break;
      }
      const blocks = after.nearbyBlocks.value;
      const same = (q: { x: number; y: number; z: number }): boolean =>
        q.x === p.x && q.y === p.y && q.z === p.z;
      const still = blocks.resources.find((r) => same(r.position));
      const removed = blocks.removed.some(same);
      check(
        'block-removed',
        still === undefined && removed,
        still !== undefined
          ? `${where} is still ${still.block}`
          : removed
            ? `${where} was observed turning into air`
            : `${where} was not observed turning into air (scan radius ${blocks.scanRadius})`,
      );
      break;
    }

    case 'BLOCK_PLACED': {
      const p = post.position;
      const where = formatPosition(p);
      if (!after.nearbyBlocks.known) {
        check(
          'block-placed',
          false,
          `nearby blocks unknown after placing: ${after.nearbyBlocks.reason}`,
        );
      } else {
        const placed = after.nearbyBlocks.value.placed.find(
          (q) => q.position.x === p.x && q.position.y === p.y && q.position.z === p.z,
        );
        check(
          'block-placed',
          placed?.block === post.block,
          placed === undefined
            ? `${where} was not observed turning into ${post.block}`
            : `${where} was observed turning into ${placed.block}`,
        );
      }
      // Exactly one item was used: none means the server did not take it, more means
      // something else happened.
      const b = inv(before, post.item);
      const a = inv(after, post.item);
      check(
        'item-used',
        b !== null && a !== null && b - a === 1,
        `${post.item}: ${b} -> ${a}, expected -1`,
      );
      break;
    }

    case 'ITEMS_CRAFTED': {
      if (!before.inventory.known || !after.inventory.known) {
        check('inventory-known', false, 'inventory unknown before or after crafting');
        break;
      }
      const b = before.inventory.value.items;
      const a = after.inventory.value.items;
      const total = (items: Record<string, number>, names: readonly string[]): number =>
        names.reduce((n, name) => n + (items[name] ?? 0), 0);
      const rb = b[post.result] ?? 0;
      const ra = a[post.result] ?? 0;
      check(
        'result-delta',
        ra - rb === post.quantity,
        `${post.result}: ${rb} -> ${ra}, expected +${post.quantity}`,
      );
      post.ingredients.forEach((group, i) => {
        const gb = total(b, group.anyOf);
        const ga = total(a, group.anyOf);
        check(
          `ingredient-delta-${i + 1}`,
          gb - ga === group.quantity,
          `${group.anyOf.length === 1 ? group.anyOf[0] : `${group.anyOf.length} kinds`}: ${gb} -> ${ga}, expected -${group.quantity}`,
        );
      });
      // Nothing else may change: no container items handed back, no surprise outputs.
      const involved = new Set([post.result, ...post.ingredients.flatMap((g) => g.anyOf)]);
      const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
        (name) => !involved.has(name) && (a[name] ?? 0) !== (b[name] ?? 0),
      );
      check(
        'other-items-unchanged',
        changed.length === 0,
        changed.length === 0
          ? 'no other item changed'
          : `also changed: ${changed
              .slice(0, 5)
              .map((name) => `${name} ${b[name] ?? 0} -> ${a[name] ?? 0}`)
              .join(', ')}`,
      );
      break;
    }

    case 'BLOCK_WINDOW_SEEN': {
      const w = windowAt(after, post.position);
      const listed = interactableAt(before, post.position);
      check(
        'window-seen',
        w !== null && Date.parse(w.observedAt) >= Date.parse(action.timestamp),
        w === null
          ? `no window of the block at ${formatPosition(post.position)} was seen`
          : `${w.block} (${w.opener}, ${w.slotCount} slots) seen at ${w.observedAt}`,
      );
      if (w !== null && listed !== undefined) {
        check(
          'window-profile',
          w.profile === listed.profile,
          `window profile ${w.profile ?? 'none (observe-only)'}, observed block ${listed.block} has ${listed.profile ?? 'none'}`,
        );
        // A profiled window stays open; an observe-only one is closed right after it is seen.
        check(
          'window-state',
          listed.profile === null ? !w.open : w.open,
          w.open ? 'the window is open' : 'the window was closed after it was seen',
        );
      }
      break;
    }

    case 'FURNACE_LOADED': {
      if (!before.inventory.known || !after.inventory.known) {
        check('inventory-known', false, 'inventory unknown before or after loading the furnace');
        break;
      }
      const expected = new Map<string, number>([[post.input, -post.quantity]]);
      if (post.fuelQuantity > 0) {
        expected.set(post.fuel, (expected.get(post.fuel) ?? 0) - post.fuelQuantity);
      }
      inventoryDeltas(before.inventory.value.items, after.inventory.value.items, expected, check);
      const w = windowAt(after, post.position);
      check(
        'furnace-open',
        w !== null && w.profile === 'furnace' && w.open,
        w === null ? 'no furnace window seen' : `${w.block}: ${w.open ? 'open' : 'closed'}`,
      );
      if (w !== null) {
        const input = w.slots.find((s) => s.role === 'input');
        const output = w.slots.find((s) => s.role === 'output');
        check(
          'furnace-holds-input',
          input?.item === post.input || output !== undefined,
          `input slot: ${input === undefined ? 'empty' : `${input.count} ${input.item}`}`,
        );
      }
      break;
    }

    case 'FURNACE_OUTPUT_TAKEN': {
      if (!before.inventory.known || !after.inventory.known) {
        check('inventory-known', false, 'inventory unknown before or after taking the output');
        break;
      }
      const taken = execution.data['taken'];
      const item = execution.data['item'];
      const valid = typeof taken === 'number' && Number.isInteger(taken) && taken >= 1;
      check(
        'client-took',
        valid && item === post.item,
        `client reported ${String(taken)} x ${String(item)}`,
      );
      if (valid) {
        inventoryDeltas(
          before.inventory.value.items,
          after.inventory.value.items,
          new Map([[post.item, taken]]),
          check,
        );
      }
      const w = windowAt(after, post.position);
      check(
        'furnace-open',
        w !== null && w.profile === 'furnace' && w.open,
        w === null ? 'no furnace window seen' : `${w.block}: ${w.open ? 'open' : 'closed'}`,
      );
      break;
    }

    case 'ENTITY_ATTACKED': {
      const id = post.entityId;
      if (!after.nearbyEntities.known) {
        check(
          'entity-attacked',
          false,
          `nearby entities unknown after the attack: ${after.nearbyEntities.reason}`,
        );
        break;
      }
      const startedMs = Date.parse(action.timestamp);
      const died = after.nearbyEntities.value.recentDeaths.find(
        (d) => d.id === id && Date.parse(d.at) >= startedMs,
      );
      if (died !== undefined) {
        check('entity-attacked', true, `${died.type} ${id} was observed dying`);
        break;
      }
      const now = after.nearbyEntities.value.entities.find((e) => e.id === id);
      const was = before.nearbyEntities.known
        ? before.nearbyEntities.value.entities.find((e) => e.id === id)
        : undefined;
      if (now === undefined) {
        check('entity-attacked', false, `entity ${id} is gone, but was not observed dying`);
        break;
      }
      if (now.health !== null && was !== undefined && was.health !== null) {
        check(
          'entity-attacked',
          now.health < was.health,
          `${now.type} ${id}: health ${was.health} -> ${now.health}`,
        );
        break;
      }
      // Health not known (no metadata yet): the server's hurt status is the only evidence.
      const hurt = now.lastHurtAt !== null && Date.parse(now.lastHurtAt) >= startedMs;
      check(
        'entity-attacked',
        hurt,
        hurt
          ? `${now.type} ${id} was observed taking a hit (its health is not known)`
          : `${now.type} ${id} was not observed taking damage`,
      );
      break;
    }

    case 'USER_NOTIFIED':
      check(
        'user-acknowledged',
        execution.data['acknowledged'] === true,
        'client acknowledged the pause',
      );
      break;
  }
  return done();
}

const samePosition = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** The block window an observation shows for this position, or null. */
function windowAt(s: GameState, p: { x: number; y: number; z: number }): GameState['blockWindow'] {
  const w = s.blockWindow;
  return w !== null && samePosition(w.position, p) ? w : null;
}

function interactableAt(
  s: GameState,
  p: { x: number; y: number; z: number },
): InteractableBlock | undefined {
  return s.interactables.known
    ? s.interactables.value.blocks.find((b) => samePosition(b.position, p))
    : undefined;
}

/** Exact inventory changes: each listed item by its delta, every other item unchanged. */
function inventoryDeltas(
  b: Readonly<Record<string, number>>,
  a: Readonly<Record<string, number>>,
  expected: ReadonlyMap<string, number>,
  check: (name: string, passed: boolean, detail: string) => void,
): void {
  for (const [item, delta] of expected) {
    const qb = b[item] ?? 0;
    const qa = a[item] ?? 0;
    check(
      `inventory-delta ${item}`,
      qa - qb === delta,
      `${item}: ${qb} -> ${qa}, expected ${delta > 0 ? '+' : ''}${delta}`,
    );
  }
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (name) => !expected.has(name) && (a[name] ?? 0) !== (b[name] ?? 0),
  );
  check(
    'other-items-unchanged',
    changed.length === 0,
    changed.length === 0
      ? 'no other item changed'
      : `also changed: ${changed
          .slice(0, 5)
          .map((name) => `${name} ${b[name] ?? 0} -> ${a[name] ?? 0}`)
          .join(', ')}`,
  );
}
