import type { Action, Postcondition } from '../domain/actions.ts';
import type { ClientActionResult } from '../bot/minecraft-client.ts';
import type { GameState } from '../domain/game-state.ts';
import { distance, formatPosition } from '../domain/geometry.ts';
import type { SafetyContext } from '../safety/safety-policy.ts';
import { verifyQuestBook } from './quest-book-checks.ts';

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

    case 'USER_NOTIFIED':
      check(
        'user-acknowledged',
        execution.data['acknowledged'] === true,
        'client acknowledged the pause',
      );
      break;

    case 'QUEST_COMPLETED':
    case 'QUEST_TASK_CHECKED':
    case 'QUEST_REWARD_CLAIMED':
      for (const c of verifyQuestBook(post, before, after)) check(c.name, c.passed, c.detail);
      break;
  }
  return done();
}
